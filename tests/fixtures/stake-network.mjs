// Socket-free integration fixture: real sidechannel encoding, signatures, PoW,
// rates and relay dispatch over in-memory duplex streams, never TCP or UDP.
import { EventEmitter } from 'node:events';
import { duplexPair } from 'node:stream';
import Protomux from '../../peer/node_modules/protomux/index.js';
import Sidechannel from '../../peer/features/sidechannel/index.js';
import { dexTransport } from '../../peer/features/dex-transport.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { STAKE_CHANNEL } from '../../src/stake/transport.js';
export const turn = () => new Promise(resolve => setImmediate(resolve));
export const identity = n => { const secretKey = new Uint8Array(32).fill(n); return { secretKey, publicKey: Buffer.from(ed25519.getPublicKey(secretKey)).toString('hex') }; };

const peerIdentity = index => identity(81 + index);

export function stakeNetwork({ pow = false, legacySidechannel = Sidechannel, legacyDexTransport = dexTransport } = {}) {
  const nodes = [], streams = [], frames = [], venuePeer = identity(80);
  function node(identity, role, { legacy = false } = {}) {
    const peer = role === 'service' ? venuePeer : peerIdentity(nodes.length), bridge = new EventEmitter(), received = [], bandwidth = [];
    const config = (legacy ? legacyDexTransport : dexTransport)({ role, servicePeerKey: venuePeer.publicKey }).sidechannel;
    if (legacy) delete config.stakeRouting;
    const sc = new (legacy ? legacySidechannel : Sidechannel)({ wallet: { publicKey: peer.publicKey, sign: bytes => Buffer.from(ed25519.sign(bytes, peer.secretKey)) } },
      { ...config, powEnabled: pow, channels: ['intercom-dex', 'intercom-dex:signers', STAKE_CHANNEL],
        bandwidth: { add() {}, sidechannel: (ch, payload, direction, bytes) => bandwidth.push({ ch, payload, direction, bytes }) },
        onMessage: (ch, payload) => { received.push(payload); bridge.emit('message', ch, payload.message); } });
    sc.rateDrops = 0;
    const checkRate = sc._checkRate.bind(sc);
    sc._checkRate = (connection, bytes) => { const ok = checkRate(connection, bytes); if (!ok) sc.rateDrops++; return ok; };
    bridge.join = async () => {};
    bridge.send = async (ch, m) => { frames.push({ node: identity.publicKey, message: m, at: performance.now() }); return sc.broadcast(ch, m); };
    const n = { identity, peer, bridge, sc, received, bandwidth }; nodes.push(n); return n;
  }
  async function connect(a, b) {
    const [left, right] = duplexPair(); streams.push(left, right);
    for (const [source, target, connection] of [[a, b, left], [b, a, right]]) {
      connection.remotePublicKey = Buffer.from(target.peer.publicKey, 'hex'); connection.userData = Protomux.from(connection);
      for (const entry of source.sc.channels.values()) source.sc._openChannelForConnection(connection, entry);
    }
    await Promise.all([[a, left], [b, right]].flatMap(([n, c]) => [...n.sc.connections.get(c).values()].filter(r => r.channel).map(r => r.channel.fullyOpened())));
    await turn(); await turn(); return [left, right];
  }
  async function close() { for (const stream of streams) stream.destroy(); for (const n of nodes) await n.sc.stop(); }
  return { node, connect, nodes, frames, close };
}
