import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import { randomBytes } from 'node:crypto';
import DHT from '../../../peer/node_modules/hyperdht/index.js';
import createTestnet from '../../../peer/node_modules/hyperdht/testnet.js';
import Hyperswarm from '../../../peer/node_modules/hyperswarm/index.js';
import Protomux from '../../../peer/node_modules/protomux/index.js';
import Sidechannel from '../../../peer/features/sidechannel/index.js';
import { dexTransport } from '../../../peer/features/dex-transport.js';
import BlindRelay from '../../../peer/features/blind-relay/index.js';
import { Bandwidth } from '../../../peer/runtime/bandwidth.js';

const loader = registerHooks({ resolve: (name, context, next) => next(name === 'bare-ws' ? 'ws' : name, context) });
const { default: DexBridge } = await import('../../../peer/features/dex-bridge.js');
loader.deregister();

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(label, check, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await sleep(20); }
  throw new Error('Take-cap timeout: ' + label);
}

// Real loopback DHT/Noise/Protomux links. The small reply handler isolates transport from settlement and PoW work.
export async function takeCapFixture({ connections } = {}) {
  const network = await createTestnet(3, { host: '127.0.0.1', port: 0 }), nodes = [], errors = [];
  const topic = randomBytes(32), channel = 'intercom-dex:t:' + randomBytes(32).toString('hex');
  let bridge;
  const close = async () => {
    bridge?.stop();
    await Promise.all(nodes.map(async node => {
      await node.sc.stop(); await node.relay.stop(); await node.swarm.destroy(); await node.bandwidth.close();
    }));
    await network.destroy();
  };
  const create = async limits => {
    const dht = new DHT({ bootstrap: network.bootstrap, host: '127.0.0.1', port: 0 });
    const transport = dexTransport({ role: 'trader', servicePeerKey: 'a'.repeat(64) });
    const swarm = new Hyperswarm({ dht, ...(limits ?? transport.connections) });
    const bandwidth = new Bandwidth(), received = [], peer = { swarm };
    const relay = new BlindRelay(peer, transport.relay);
    const sc = new Sidechannel(peer, { ...transport.sidechannel, channels: [], powEnabled: false, bandwidth,
      onMessage: (ch, payload) => received.push({ channel: ch, message: payload.message }) });
    const node = { swarm, sc, relay, bandwidth, received, key: swarm.keyPair.publicKey.toString('hex') };
    nodes.push(node); bandwidth.trackSwarm(swarm, 'peer');
    swarm.on('connection', connection => {
      connection.on('error', error => errors.push(error.message));
      connection.userData = Protomux.from(connection);
    });
    await swarm.listen(); await relay.start(); await sc.start();
    return node;
  };
  try {
    const taker = await create(connections);
    // Every filling connection is inbound: maxPeers, not just maxClientConnections, must be exercised.
    await taker.swarm.join(topic, { server: true, client: false }).flushed();
    for (let i = 0; i < 8; i++) {
      const dummy = await create();
      await dummy.swarm.join(topic, { server: false, client: true }).flushed();
    }
    await until('inbound slots filled', () => taker.swarm.connections.size === 8);
    const maker = await create();
    maker.sc.openChannels.add(channel);
    await maker.sc.addChannel(channel);
    await maker.swarm.join(maker.sc.channels.get(channel).topic, { server: true, client: true }).flushed();
    maker.sc.onMessage = (ch, payload) => {
      maker.received.push({ channel: ch, message: payload.message });
      if (payload.message.kind === 'take') void maker.sc.broadcast(ch, { kind: 'decline', body: { reason: 'busy' } }).catch(error => errors.push(error.message));
    };
    bridge = new DexBridge({ swarm: taker.swarm }, { requireAuth: true });
    bridge.attachSidechannel(taker.sc);
    const client = { authed: true, socket: new EventEmitter() };
    let sequence = 0;
    const requests = new Map();
    bridge._broadcastToClient = (_client, response) => {
      const pending = requests.get(response.id);
      if (!pending) return;
      requests.delete(response.id); response.type === 'error' ? pending.reject(new Error(response.error)) : pending.resolve(response);
    };
    const request = body => new Promise((resolve, reject) => {
      const id = ++sequence; requests.set(id, { resolve, reject });
      bridge._handleClientMessage(client, { id, ...body });
    });
    return { errors, close,
      join: (pin = false) => request({ type: 'dex_join', channel, ...(pin ? { makerPeer: maker.key } : {}) }),
      send: kind => taker.sc.broadcast(channel, { kind, body: {} }),
      stats: () => ({ connections: taker.swarm.connections.size, inbound: taker.swarm._serverConnections,
        directAttempts: taker.swarm.stats.connects.client.attempted,
        outbound: taker.swarm._clientConnections, makerDiscovered: taker.swarm.peers.has(maker.key),
        makerExplicit: taker.swarm.peers.get(maker.key)?.explicit ?? false,
        makerConnected: [...taker.swarm.connections].some(c => c.remotePublicKey.toString('hex') === maker.key),
        takesAtMaker: maker.received.filter(r => r.message.kind === 'take').length,
        repliesAtTaker: taker.received.filter(r => ['accept', 'decline', 'abort'].includes(r.message.kind)).length,
        relay: taker.relay.stats(), errors: [...errors] }),
    };
  } catch (error) { await close(); throw error; }
}
