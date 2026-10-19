// Local sockets only; run explicitly. Real HyperDHT, Noise, blind relay, sidechannel and trade machines.
// Chain adapters and lock-proof computation are stubbed; tests/e2e/stack.mjs relay uses real local chains/proofs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { EventEmitter } from 'node:events';
import DHT from '../../../peer/node_modules/hyperdht/index.js';
import createTestnet from '../../../peer/node_modules/hyperdht/testnet.js';
import Protomux from '../../../peer/node_modules/protomux/index.js';
import BlindRelay from '../../../peer/features/blind-relay/index.js';
import Sidechannel from '../../../peer/features/sidechannel/index.js';
import { relayFaults } from './relay-faults.mjs';
import { RegistryRelays } from '../../../src/net/relays.js';
import { RegistryView } from '../../../src/roles/common.js';
import { createBuyer } from '../../../src/core/trade-buyer.js';
import { createSeller } from '../../../src/core/trade-seller.js';
import { createSigner } from '../../../src/core/trade-signer.js';
import { seal, open, createReplayCache } from '../../../src/core/envelope.js';
import { encodeKey } from '../../../src/core/keys.js';
import { fixture, hex, SIG } from '../../unit/core/helpers.mjs';
import { dexTransport } from '../../../peer/features/dex-transport.js';

const requirePeer = createRequire(new URL('../../../peer/node_modules/trac-peer/package.json', import.meta.url));
const Hyperswarm = requirePeer('hyperswarm');
const hook = registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context);
  return result.url.endsWith('/src/proof/lockproof.js') ? { ...result, url: new URL('./proof-stub.mjs', import.meta.url).href } : result;
} });
const { TradeHost } = await import('../../../src/roles/host.js'); hook.deregister();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, ms = 90000) {
  const end = Date.now() + ms;
  while (!await check()) { if (Date.now() > end) throw Error('Relay integration timed out'); await sleep(20); }
}

for (const enabled of [false, true]) test(`forced isolation ${enabled ? 'completes through registry relay' : 'fails before lock without relay'}`, { timeout: 180000 }, async t => {
  const net = await createTestnet(3, { host: '127.0.0.1' }), peers = [], hosts = [], f = fixture();
  const isolated = DHT.keyPair(), servicePeer = DHT.keyPair();
  const isolationKey = isolated.publicKey.toString('hex');
  t.after(async () => {
    for (const h of hosts) h.stop();
    for (const p of peers) { await p.sidechannel.stop(); await p.blindRelay.stop(); await p.swarm.destroy(); }
    await net.destroy();
  });
  async function peer(keyPair = DHT.keyPair(), capture = false) {
    // Keep loopback NAT probes from advertising a public direct path.
    const dht = net.createNode({ quickFirewall: false }); await dht.fullyBootstrapped();
    assert.equal(dht.remoteAddress(), null);
    const swarm = new Hyperswarm({ dht, keyPair, backoffs: [50, 100, 200], jitter: 0 }); await swarm.listen();
    const p = { swarm, wallet: { publicKey: keyPair.publicKey.toString('hex') }, bridge: new EventEmitter() };
    swarm.on('connection', c => { c.on('error', () => {}); c.userData = Protomux.from(c); });
    p.audit = relayFaults(p, isolationKey, { capture });
    p.blindRelay = new BlindRelay(p, { serve: capture, directTimeoutMs: 250, relayTimeoutMs: 10000 }); await p.blindRelay.start();
    p.sidechannel = new Sidechannel(p, { ...dexTransport({ role: 'trader', servicePeerKey: servicePeer.publicKey.toString('hex') }).sidechannel,
      // Difficulty behavior is covered by unit tests; this integration is about routing, not CPU benchmarking.
      powDifficulty: 4, onMessage: (ch, payload) => p.bridge.emit('message', ch, payload.message) });
    p.bridge.join = async ch => { p.sidechannel.openChannels.add(ch); await p.sidechannel.addChannel(ch); };
    p.bridge.send = (ch, message) => p.sidechannel.broadcast(ch, message);
    p.bridge.setRelays = async keys => p.blindRelay.setRelays(keys);
    peers.push(p); await p.sidechannel.start(); return p;
  }
  const signerPeers = [];
  for (let i = 0; i < 5; i++) signerPeers.push(await peer(DHT.keyPair(), i === 0));
  const sellerPeer = await peer(), buyerPeer = await peer(isolated);
  if (enabled) f.registry.signers[0].relayKey = signerPeers[0].swarm.keyPair.publicKey.toString('hex');
  const signed = seal({ kind: 'registry', ch: 'intercom-dex', body: f.registry }, f.service.secretKey, { ts: 100, nonce: hex() });
  for (const p of peers) {
    const view = new RegistryView(encodeKey(f.service.publicKey));
    assert.equal(view.offer(open(signed, { now: 100, seen: createReplayCache() }), 100), true);
    await new RegistryRelays(p.bridge).update(view.current);
  }
  let lockCount = 0, transferCount = 0, claimed = false, locked = null;
  const blockhash = hex(), started = performance.now();
  const now = () => 100 + Math.floor((performance.now() - started) / 1000);
  const solana = { finalizedSlot: async () => 100, tipSlot: async () => 132,
    firstFinalizedBlockAtLeast: async () => ({ slot: 196, blockhash }),
    lockEscrow: async a => { lockCount++; locked = a.hashHex; return { ok: true, hashHex: locked }; },
    checkEscrow: async ({ hashHex }) => locked ? { ok: true, hashHex: locked, status: claimed ? 'claimed' : 'active' } : { ok: false, hashHex, status: 'missing' },
    claim: async () => { claimed = true; return { ok: true, claimSignature: SIG }; } };
  const trac = { sendTransfer: async () => { transferCount++; return { ok: true, sentAt: 100, txHash: hex() }; },
    verifyTransfer: async a => ({ ok: true, final: true, txHash: a.txHash, amount: a.minAmount, from: a.from, to: a.to, nonce: a.nonce, asset: a.asset, finalizedAt: 100 }),
    reserveTx: async ({ tradeId }) => ({ ok: true, reservedFor: tradeId }) };
  async function host(p, role, state, identity) {
    const records = new Map();
    const h = new TradeHost({ bridge: p.bridge, identity: { publicKey: encodeKey(identity.publicKey), secretKey: identity.secretKey },
      store: { list: () => [], get: k => records.get(k), put: (k, v) => records.set(k, structuredClone(v)) },
      solana: role === 'signer' ? null : solana, trac, now, tickMs: 100,
      serviceKey: encodeKey(f.service.publicKey), onlineSigners: () => f.registry.signers.map(s => s.dexKey), eligibleOnline: () => f.registry.signers });
    hosts.push(h); await h.start(); await h.addTrade({ key: 'trade', role, state, lifetimeSec: 86400 }); return h;
  }
  const config = mode => ({ mode, offerId: f.offerId, terms: f.terms, registry: f.registry, nonce: hex(), entropy: hex(), now: 100 });
  const seller = await host(sellerPeer, 'seller', createSeller(config('maker')), f.seller);
  const buyer = await host(buyerPeer, 'buyer', createBuyer(config('taker')), f.buyer);
  // Force a dial even when discovery timing differs; the feature must try direct and then the registry relay.
  buyerPeer.swarm.joinPeer(sellerPeer.swarm.keyPair.publicKey);
  if (!enabled) {
    await until(() => buyer.trades.get('trade').state.phase === 'aborted', 75000);
    assert.equal(lockCount, 0); assert.equal(transferCount, 0); assert.equal(claimed, false);
    assert.deepEqual(buyerPeer.audit().direct, []); assert.deepEqual(buyerPeer.audit().relayed, []);
    assert.deepEqual(buyerPeer.audit().paths, []); assert.equal(signerPeers[0].audit().ciphertextBytes, 0); return;
  }
  await until(() => buyer.trades.get('trade').state.terms && seller.trades.get('trade').state.terms);
  const terms = buyer.trades.get('trade').state.terms;
  for (let index = 0; index < terms.committee.length; index++) {
    const at = f.signers.findIndex(s => encodeKey(s.identity.publicKey) === terms.committee[index].dexKey), member = f.signers[at];
    const h = await host(signerPeers[at], 'signer', createSigner({ terms, signerIndex: index + 1, boxSecret: member.box.secretKey, now: 100 }), member.identity);
    // Summon evidence is two real trader signatures; all deal/ack/transfer/share traffic uses the transport.
    await until(() => [seller, buyer].every(x => Object.values(x.trades.get('trade').outbox).flat().some(e => e.kind === 'termsSig')));
    for (const trader of [seller, buyer]) {
      const sig = Object.values(trader.trades.get('trade').outbox).flat().find(e => e.kind === 'termsSig'); await h.inject('trade', sig);
    }
  }
  await until(() => [buyer, seller].every(h => h.trades.get('trade').state.phase === 'complete'), 120000);
  assert.equal(lockCount, 1); assert.equal(transferCount, 1); assert.equal(claimed, true);
  const audit = buyerPeer.audit(), relay = signerPeers[0].audit();
  assert.deepEqual(audit.direct, []); assert.ok(audit.relayed.includes(sellerPeer.swarm.keyPair.publicKey.toString('hex')));
  assert.ok(audit.blocked + sellerPeer.audit().blocked > 0);
  assert.ok(relay.ciphertextBytes > 0); assert.equal(relay.plaintextMatches, 0);
  assert.ok(relay.relay.pairs_relayed > 0);
  // Match actual UDX endpoints, including migrations, independently of the requested relay route.
  const incoming = path => relay.forwarding.find(link => link.id === path.remoteId && link.remoteId === path.id
    && link.localPort === path.remotePort && link.localHost === path.remoteHost
    && link.remotePort === path.localPort && link.remoteHost === path.localHost);
  const buyerPaths = audit.paths.filter(path => path.peer === sellerPeer.wallet.publicKey);
  const sellerPaths = sellerPeer.audit().paths.filter(path => path.peer === buyerPeer.wallet.publicKey);
  assert.ok(buyerPaths.length > 0); assert.ok(sellerPaths.length > 0);
  for (const path of [...audit.paths, ...sellerPaths]) assert.ok(incoming(path), 'isolated traffic must terminate at a relay forwarding stream');
  assert.ok(buyerPaths.some(path => {
    const fromBuyer = incoming(path), toSeller = relay.forwarding.find(link => link.id === fromBuyer.destinationId);
    return fromBuyer.bytes > 0 && toSeller?.bytes > 0 && toSeller.destinationId === fromBuyer.id
      && sellerPaths.some(other => incoming(other) === toSeller);
  }), 'the buyer/seller pair must forward ciphertext in both directions');
});
