import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateIdentity, encodeKey } from '../../../src/core/keys.js';
import { seal } from '../../../src/core/envelope.js';
import { openStore } from '../../../src/roles/store.js';
import { randomBytes } from 'node:crypto';
const KEY = randomBytes(32);
import { Trader } from '../../../src/roles/trader.js';
import { offerIdOf, nowSec, random32 } from '../../../src/roles/common.js';
import { tradeId as termsTradeId } from '../../../src/core/terms.js';
import { fixture, tracAddress, SOL, SOL2, MINT } from '../core/helpers.mjs';
import { SIGNER_ONLINE_SEC, DECLINES_PER_MINUTE } from '../../../src/roles/trader.js';
import { sha256Hex, hexToBytes } from '../../../src/core/canonical.js';
import { WalletManager } from '../../../src/wallets/manager.js';
import { controlHandler } from '../../../src/roles/control.js';

const OFFERS = 'intercom-dex:offers';

function party() {
  const id = generateIdentity(), dexKey = encodeKey(id.publicKey);
  return { identity: { secretKey: encodeKey(id.secretKey), publicKey: dexKey }, me: { dexKey, tracAddr: tracAddress(dexKey), solAddr: SOL } };
}

class FakeBridge extends EventEmitter {
  constructor() { super(); this.sent = []; this.joined = new Set(); }
  async info() { return { info: { swarmPublicKey: random32() } }; }
  async peerPresent() { return false; }
  async setRelays(keys) { this.relays = keys; }
  async join(ch) { this.joined.add(ch); }
  async send(ch, envelope) { this.sent.push({ ch, envelope }); }
}

async function trader(p, { dir = mkdtempSync(join(tmpdir(), 'dex-trader-')), registry, serviceKey = random32() } = {}) {
  const bridge = new FakeBridge();
  const t = new Trader({ proof: { zkey: "/unit-test-unused.zkey" }, bridge, identity: p.identity, store: openStore(dir, KEY), solana: null, trac: null, me: p.me,
    serviceKey, mint: MINT, platformCollector: SOL2, log: () => {} });
  await t.start();
  t.stop();
  if (registry) { t.registry.current = registry; for (const s of registry.signers) t.heartbeats.set(s.dexKey, { at: performance.now(), software: '0.1.0' }); }
  return { t, bridge, dir };
}

const post = (bridge, from, kind, body) => {
  bridge.emit('message', OFFERS, seal({ kind, ch: OFFERS, body }, from.identity.secretKey, { ts: nowSec(), nonce: random32() }));
  return new Promise(resolve => setImmediate(resolve));
};

test('an offer id is bound to its content; a different offer under the same id is ignored', async () => {
  const { registry } = fixture(), alice = party(), mallory = party(), bob = party();
  const { t } = await trader(alice, { registry });
  const { t: taker, bridge } = await trader(bob, { registry });
  const offer = await t.makeOffer({ pair: 'TNK/USDC', side: 'sell', baseAmount: '1000', price: '1' });
  assert.equal(offer.offerId, offerIdOf(offer));
  await post(bridge, alice, 'offer', offer);
  const swapped = { ...offer, price: '100', maker: mallory.me };
  await post(bridge, mallory, 'offer', swapped);
  assert.equal(taker.offers.get(offer.offerId).offer.price, '1');
  const forged = { ...swapped, offerId: offerIdOf(swapped) };
  await post(bridge, mallory, 'offer', { ...forged, price: '2' });
  assert.equal(taker.offers.has(forged.offerId), false, 'an id that does not match the content is dropped');
});

test('a take must name the offer price and stay within the offer size', async () => {
  const { registry } = fixture(), alice = party(), bob = party();
  const { t: maker } = await trader(alice, { registry });
  const { t: taker, bridge } = await trader(bob, { registry });
  const offer = await maker.makeOffer({ pair: 'TNK/USDC', side: 'sell', baseAmount: '2000000000000000000', price: '1' });
  await post(bridge, alice, 'offer', offer);
  await assert.rejects(taker.takeOffer(offer.offerId), /Offer price is 1/);
  await assert.rejects(taker.takeOffer(offer.offerId, undefined, '0.5'), /Offer price is 1/);
  await assert.rejects(taker.takeOffer(offer.offerId, '2000000000000000001', '1'), /offer size/);
  await assert.rejects(taker.takeOffer(offer.offerId, '0', '1'), /offer size/);
  const taken = await taker.takeOffer(offer.offerId, '1000000000000000000', '1');
  assert.equal(taken.baseAmount, '1000000000000000000');
});

test('maker inventory is held by running trades, kept when filled, released when a trade ends before funds move', async () => {
  const { registry } = fixture(), alice = party();
  const { t } = await trader(alice, { registry });
  const offer = await t.makeOffer({ pair: 'TNK/USDC', side: 'sell', baseAmount: '1000', price: '1' });
  const add = (key, phase, baseAmount, role = 'seller') =>
    t.host.trades.set(key, { key, role, state: { offerId: offer.offerId, mode: 'maker', phase, draft: { baseAmount } } });
  add('a', 'awaitDeal', '300');
  add('b', 'complete', '200');
  add('c', 'aborted', '400');
  add('d', 'refunded', '100', 'buyer');
  const mine = t.status().mine[0];
  assert.deepEqual([mine.reserved, mine.filled, mine.available], ['300', '200', '500']);
});

test('own offers survive a restart; cancelled ones do not', async () => {
  const { registry } = fixture(), alice = party();
  const { t, dir } = await trader(alice, { registry });
  const kept = await t.makeOffer({ pair: 'TNK/USDC', side: 'sell', baseAmount: '1000', price: '1' });
  const gone = await t.makeOffer({ pair: 'TNK/USDC', side: 'sell', baseAmount: '1000', price: '1' });
  assert.notEqual(kept.offerId, gone.offerId, 'identical offers get distinct ids');
  // The control API and MCP answer with this value.
  assert.deepEqual(await t.cancelOffer(gone.offerId), { offerId: gone.offerId, cancelled: true });
  const { t: again, bridge } = await trader(alice, { dir, registry });
  assert.deepEqual([...again.mine.keys()], [kept.offerId]);
  assert.ok(bridge.joined.has(`intercom-dex:t:${kept.offerId}`));
});

test('a completed sale is reported to the venue after a restart, without a claim signature, until the venue logs it', async () => {
  const f = fixture(), seller = party(), service = party(), dir = mkdtempSync(join(tmpdir(), 'dex-trader-'));
  const terms = f.terms, tradeId = termsTradeId(terms), key = `${terms.offerId}-x-1`;
  openStore(dir, KEY).put(`trade-${key}`, { key, role: 'seller', lifetimeSec: 3600, outbox: {}, raw: [], buffer: [],
    state: { role: 'seller', mode: 'maker', phase: 'complete', offerId: terms.offerId, tradeId, terms, H: random32(), txHash: random32(), now: nowSec() } });
  const { t, bridge } = await trader(seller, { dir, registry: f.registry, serviceKey: service.identity.publicKey });
  const reports = bridge.sent.filter(x => x.envelope.kind === 'settled');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].envelope.body.tradeId, tradeId);
  assert.equal(reports[0].envelope.body.claimSignature, undefined);
  bridge.emit('message', 'intercom-dex', seal({ kind: 'tradeLog', ch: 'intercom-dex', body: { tradeId, registryVersion: terms.registryVersion, pair: terms.pair, baseAmount: terms.baseAmount,
    quoteAmount: terms.quoteAmount, price: '5', seller: { tracAddr: terms.seller.tracAddr, solAddr: terms.seller.solRecipient },
    buyer: { tracAddr: terms.buyer.tracAddr, solAddr: terms.buyer.solPayer }, ts: nowSec(), termsHash: random32(), escrowAddress: SOL2, claimSignature: '3'.repeat(88), tracTxHash: random32() } },
    service.identity.secretKey, { ts: nowSec(), nonce: random32() }));
  await new Promise(r => setTimeout(r, 20));
  assert.equal(t.store.get(`report-${tradeId}`).delivered, true);
});

async function channelPost(t, bridge, from, kind, body, ch) {
  const secret = from.identity?.secretKey ?? from.secretKey;
  const nonce = random32();
  bridge.emit('message', ch, seal({ kind, ch, body }, secret, { ts: nowSec(), nonce }));
  for (let i = 0; i < 5; i++) { await new Promise(r => setImmediate(r)); await t.takeQueue; await Promise.all([...t.host.trades.values()].map(x => x.queue)); }
  return nonce;
}

test('traders accept only authenticated listed active heartbeats, use receive time and expire after 90 seconds', async ctx => {
  let ms = 100000; ctx.mock.method(performance, 'now', () => ms);
  const f = fixture(), service = party(), { t, bridge } = await trader(party(), { registry: f.registry, serviceKey: service.me.dexKey });
  t.heartbeats.clear(); assert.equal(SIGNER_ONLINE_SEC, 90); assert.ok(bridge.joined.has('intercom-dex:signers'));
  const heartbeat = { registryVersion: 1, software: '0.1.0', status: 'online', holdCount: 0 }, ch = 'intercom-dex:signers';
  await channelPost(t, bridge, party(), 'heartbeat', heartbeat, ch);
  assert.equal(t.heartbeats.size, 0);
  const first = f.registry.signers[0].dexKey;
  await channelPost(t, bridge, f.signers[0], 'heartbeat', heartbeat, ch);
  assert.deepEqual(t.onlineSigners(), [first]); assert.equal(t.eligibleOnline('1000000000', 'TNK/USDC').length, 1);
  assert.equal(t.eligibleOnline('1000000001', 'TNK/USDC').length, 0);
  ms += 90000; assert.equal(t.onlineSigners().length, 1); ms++; assert.equal(t.onlineSigners().length, 0);
  const forged = seal({ kind: 'heartbeat', ch, body: heartbeat }, f.signers[1].identity.secretKey, { ts: nowSec(), nonce: random32() });
  forged.sig = '00'.repeat(64); bridge.emit('message', ch, forged); await new Promise(r => setImmediate(r));
  assert.equal(t.heartbeats.has(f.registry.signers[1].dexKey), false);
  const removed = { ...f.registry, version: 2, signers: f.registry.signers.slice(1).map((s, i) => ({ ...s, status: i === 0 ? 'inactive' : s.status })),
    removed: [{ dexKey: first, removedAt: nowSec(), reason: 'removed' }] };
  await channelPost(t, bridge, service, 'registry', removed, 'intercom-dex');
  await channelPost(t, bridge, f.signers[0], 'heartbeat', heartbeat, ch);
  await channelPost(t, bridge, f.signers[1], 'heartbeat', heartbeat, ch);
  assert.deepEqual(t.onlineSigners(), []);
  await channelPost(t, bridge, f.signers[2], 'heartbeat', heartbeat, ch);
  assert.equal(t.onlineSigners().length, 1);
  await channelPost(t, bridge, f.signers[2], 'heartbeat', { ...heartbeat, status: 'offline' }, ch);
  assert.equal(t.onlineSigners().length, 0);
  const wrongChannel = seal({ kind: 'heartbeat', ch, body: heartbeat }, f.signers[3].identity.secretKey, { ts: nowSec(), nonce: random32() });
  bridge.emit('message', 'intercom-dex', wrongChannel); await new Promise(r => setImmediate(r)); assert.equal(t.onlineSigners().length, 0);
});

test('take refusal emits no take or trade; maker without k+1 online sends a correlated decline and reserves nothing', async () => {
  const f = fixture(), alice = party(), bob = party();
  const { t: maker, bridge: mb } = await trader(alice, { registry: f.registry });
  const { t: taker, bridge: tb } = await trader(bob, { registry: f.registry });
  const offer = await maker.makeOffer({ pair: 'TNK/USDC', side: 'sell', baseAmount: '2000000000000000000', price: '1' });
  await post(tb, alice, 'offer', offer);
  taker.heartbeats.clear();
  await assert.rejects(taker.takeOffer(offer.offerId, '1000000000000000000', '1'), /Not enough signers online/);
  assert.equal(taker.host.trades.size, 0); assert.ok(!tb.sent.some(x => x.envelope.kind === 'take'));
  for (const s of f.registry.signers) taker.heartbeats.set(s.dexKey, { at: performance.now(), software: '0.1.0' });
  const taken = await taker.takeOffer(offer.offerId, '1000000000000000000', '1');
  maker.heartbeats.clear();
  const take = tb.sent.find(x => x.envelope.kind === 'take'); mb.emit('message', take.ch, take.envelope);
  await new Promise(r => setImmediate(r)); await maker.takeQueue;
  const abort = mb.sent.find(x => x.envelope.kind === 'decline');
  assert.equal(abort.envelope.body.reason, 'signers');
  assert.equal(abort.envelope.body.takeNonce, take.envelope.nonce);
  assert.equal(maker.host.trades.size, 0); assert.equal(maker.status().mine[0].reserved, '0');
  tb.emit('message', abort.ch, abort.envelope); await new Promise(r => setImmediate(r)); await taker.host.trades.get(taken.key).queue;
  assert.equal(taker.host.trades.get(taken.key).state.phase, 'aborted');
});

test('maker admits takes in order up to size and three pre-lock slots, declines every excess and releases aborted reservations', async () => {
  const f = fixture(), maker = party(), { t, bridge } = await trader(maker, { registry: f.registry });
  const offer = await t.makeOffer({ pair: 'TNK/USDC', side: 'sell', baseAmount: '10000000000000000000', price: '1' });
  const peers = Array.from({ length: 4 }, party), commitments = Array.from({ length: 4 }, random32);
  const body = i => ({ offerId: offer.offerId, pair: offer.pair, registryVersion: offer.registryVersion, software: '0.1.0', baseAmount: '1000000000000000000', taker: peers[i].me, commitment: commitments[i],
    sendBy: nowSec() + f.registry.params.sendWindowSec, refundAfter: nowSec() + f.registry.params.refundSec });
  const ch = 'intercom-dex:t:' + offer.offerId;
  let lastTakeNonce;
  for (let i = 0; i < 4; i++) lastTakeNonce = await channelPost(t, bridge, peers[i], 'take', body(i), ch);
  assert.equal(t.host.trades.size, 3); assert.equal(t.status().mine[0].reserved, '3000000000000000000');
  const declines = bridge.sent.filter(x => x.envelope.kind === 'decline');
  assert.equal(declines.length, 1); assert.equal(declines[0].envelope.body.takeNonce, lastTakeNonce);
  assert.equal(declines[0].envelope.body.reason, 'busy');
  // End one negotiation on its own clock; the next take can reserve that slot and amount.
  const first = [...t.host.trades.values()][0];
  await t.host.deliver(first.key, { type: 'error', definite: true, reason: 'test cancelled' });
  await channelPost(t, bridge, peers[3], 'take', body(3), ch);
  assert.equal(t.host.trades.size, 4); assert.equal(t.status().mine[0].reserved, '3000000000000000000');
  // A fresh envelope for the same take is a retransmission, not another reservation.
  await channelPost(t, bridge, peers[3], 'take', body(3), ch); assert.equal(t.host.trades.size, 4);
});

test('three negotiations per taker across offers and exact remaining size are enforced', async () => {
  const f = fixture(), { t, bridge } = await trader(party(), { registry: f.registry }), peer = party();
  const take = async (offer, who = peer, amount = '1000000000000000000') => channelPost(t, bridge, who, 'take', {
    offerId: offer.offerId, pair: offer.pair, registryVersion: offer.registryVersion, software: '0.1.0', baseAmount: amount, taker: who.me, commitment: random32(),
    sendBy: nowSec() + 900, refundAfter: nowSec() + 86400 }, 'intercom-dex:t:' + offer.offerId);
  for (let i = 0; i < 4; i++) {
    const offer = await t.makeOffer({ pair: 'TNK/USDC', side: 'sell', baseAmount: '1000000000000000000', price: '1' });
    await take(offer);
    if (i === 0) await take(offer, party());
  }
  assert.equal(t.host.trades.size, 3);
  const reasons = bridge.sent.filter(x => x.envelope.kind === 'decline').map(x => x.envelope.body.reason);
  assert.deepEqual(reasons, ['insufficient', 'busy']);
});

test('concurrent takes on the same offer route accept/reveal by take commitment', async () => {
  const f = fixture(), alice = party(), bob = party();
  const { t: maker, bridge: mb } = await trader(alice, { registry: f.registry });
  const { t: taker, bridge: tb } = await trader(bob, { registry: f.registry });
  const offer = await maker.makeOffer({ pair: 'TNK/USDC', side: 'sell', baseAmount: '3000000000000000000', price: '1' });
  await post(tb, alice, 'offer', offer);
  for (const t of [maker, taker]) Object.assign(t.host, { slot: 100, tip: 132, slotAt: performance.now(), tipAt: performance.now() });
  const a = await taker.takeOffer(offer.offerId, '1000000000000000000', '1'), b = await taker.takeOffer(offer.offerId, '1000000000000000000', '1');
  assert.notEqual(a.key, b.key);
  for (const { ch, envelope } of tb.sent.filter(x => x.envelope.kind === 'take')) mb.emit('message', ch, envelope);
  await new Promise(r => setImmediate(r)); await maker.takeQueue;
  for (const { ch, envelope } of mb.sent.filter(x => ['accept', 'reveal'].includes(x.envelope.kind)).reverse()) tb.emit('message', ch, envelope);
  await new Promise(r => setImmediate(r)); await Promise.all([...taker.host.trades.values()].map(x => x.queue));
  for (const tr of taker.host.trades.values()) {
    assert.equal(tr.state.phase, 'awaitRandomness');
    const commitment = sha256Hex(hexToBytes(tr.state.nonce, 32));
    const match = [...maker.host.trades.values()].find(x => x.state.peerCommit === commitment);
    assert.equal(tr.state.peerNonce, match.state.nonce);
  }
});

test('two taker identities choosing the same commitment cannot overwrite a reservation', async () => {
  const f = fixture(), { t, bridge } = await trader(party(), { registry: f.registry });
  const offer = await t.makeOffer({ pair: 'TNK/USDC', side: 'sell', baseAmount: '3000000000000000000', price: '1' }), commitment = random32();
  for (const peer of [party(), party()]) await channelPost(t, bridge, peer, 'take', {
    offerId: offer.offerId, pair: offer.pair, registryVersion: offer.registryVersion, software: '0.1.0', taker: peer.me, commitment, baseAmount: '1000000000000000000',
    sendBy: nowSec() + 900, refundAfter: nowSec() + 86400 }, 'intercom-dex:t:' + offer.offerId);
  assert.equal(t.host.trades.size, 2); assert.equal(t.status().mine[0].reserved, '2000000000000000000');
});

test('maker emits strict decline reasons once per nonce, and never answers invalid, unparseable or unrelated takes', async () => {
  const f = fixture(), { t, bridge } = await trader(party(), { registry: f.registry });
  const offer = await t.makeOffer({ pair: 'TNK/USDC', side: 'sell', baseAmount: '1000000000000000000', price: '1' });
  const ch = 'intercom-dex:t:' + offer.offerId;
  const base = peer => ({ offerId: offer.offerId, pair: offer.pair, registryVersion: 1, software: '0.1.0', baseAmount: offer.baseAmount,
    taker: peer.me, commitment: random32(), sendBy: nowSec() + 900, refundAfter: nowSec() + 86400 });
  for (const [patch, reason] of [[{ software: '0.0.9' }, 'version'], [{ baseAmount: '1000000000000000001' }, 'insufficient']]) {
    const peer = party(), nonce = await channelPost(t, bridge, peer, 'take', { ...base(peer), ...patch }, ch);
    const last = bridge.sent.at(-1).envelope;
    assert.equal(last.kind, 'decline'); assert.deepEqual(last.body, { offerId: offer.offerId, takeNonce: nonce, reason });
  }
  // Takes that fail authentication or basic validity get no answer at all.
  let count = bridge.sent.length;
  for (const patch of [{ sendBy: nowSec() - 1 }, { pair: 'RESET/USDC' }, { registryVersion: 2 }, { refundAfter: nowSec() + 86401 }, { taker: party().me }]) {
    const peer = party(); await channelPost(t, bridge, peer, 'take', { ...base(peer), ...patch }, ch);
  }
  assert.equal(bridge.sent.length, count);
  t.heartbeats.clear();
  const peer = party(), nonce = random32(), raw = seal({ kind: 'take', ch, body: base(peer) }, peer.identity.secretKey, { ts: nowSec(), nonce });
  for (let i = 0; i < 3; i++) { bridge.emit('message', ch, raw); await new Promise(r => setImmediate(r)); await t.takeQueue; }
  assert.equal(bridge.sent.filter(x => x.envelope.kind === 'decline' && x.envelope.body.takeNonce === nonce).length, 1);
  assert.equal(bridge.sent.at(-1).envelope.body.reason, 'signers');
  await t.cancelOffer(offer.offerId);
  const late = party();
  await channelPost(t, bridge, late, 'take', base(late), ch); assert.equal(bridge.sent.at(-1).envelope.body.reason, 'expired');
  count = bridge.sent.length;
  const other = party();
  await channelPost(t, bridge, other, 'take', { ...base(other), offerId: random32() }, ch);
  bridge.emit('message', ch, { ...raw, body: { offerId: offer.offerId } });
  await new Promise(r => setImmediate(r)); await t.takeQueue;
  assert.equal(bridge.sent.length, count);
});

test('a stranger take flood gets one decline per sender and DECLINES_PER_MINUTE in total; markers are pruned after the take window', async () => {
  const f = fixture(), { t, bridge, dir } = await trader(party(), { registry: f.registry });
  const offer = await t.makeOffer({ pair: 'TNK/USDC', side: 'sell', baseAmount: '1000000000000000000', price: '1' });
  const ch = 'intercom-dex:t:' + offer.offerId;
  const take = peer => channelPost(t, bridge, peer, 'take', { offerId: offer.offerId, pair: offer.pair, registryVersion: 1, software: '0.1.0',
    baseAmount: '1000000000000000001', taker: peer.me, commitment: random32(), sendBy: nowSec() + 900, refundAfter: nowSec() + 86400 }, ch);
  const repeat = party(), repeated = [];
  for (let i = 0; i < 3; i++) repeated.push(await take(repeat));
  for (let i = 0; i < 2 * DECLINES_PER_MINUTE; i++) await take(party());
  const declines = bridge.sent.filter(x => x.envelope.kind === 'decline');
  assert.equal(declines.length, DECLINES_PER_MINUTE);
  assert.equal(declines.filter(x => repeated.includes(x.envelope.body.takeNonce)).length, 1);
  assert.ok(declines.every(x => x.envelope.body.reason === 'insufficient'));
  assert.equal(t.store.list('decline-').length, DECLINES_PER_MINUTE);
  const [kept, ...old] = t.store.list('decline-');
  for (const name of old) t.store.put(name, { ...t.store.get(name), at: nowSec() - 301 });
  const { t: again } = await trader(party(), { dir, registry: f.registry });
  assert.deepEqual(again.store.list('decline-'), [kept]);
});

test('four concurrent takers reserve exactly two fills when size allows two, with immediate declines for the others', async () => {
  const f = fixture(), { t, bridge } = await trader(party(), { registry: f.registry });
  Object.assign(t.host, { slot: 100, tip: 132, slotAt: performance.now(), tipAt: performance.now() });
  const offer = await t.makeOffer({ pair: 'TNK/USDC', side: 'sell', baseAmount: '2000000000000000000', price: '1' });
  const peers = Array.from({ length: 4 }, party), ch = 'intercom-dex:t:' + offer.offerId;
  await Promise.all(peers.map(peer => channelPost(t, bridge, peer, 'take', { offerId: offer.offerId, pair: offer.pair,
    registryVersion: 1, software: '0.1.0', baseAmount: '1000000000000000000', taker: peer.me, commitment: random32(),
    sendBy: nowSec() + 900, refundAfter: nowSec() + 86400 }, ch)));
  assert.deepEqual([...t.host.trades.values()].map(x => x.state.peer), peers.slice(0, 2).map(p => p.me.dexKey));
  assert.equal(bridge.sent.filter(x => x.envelope.kind === 'accept').length, 2);
  assert.deepEqual(bridge.sent.filter(x => x.envelope.kind === 'decline').map(x => x.envelope.body.reason), ['insufficient', 'insufficient']);
  assert.equal(t.status().mine[0].available, '0');
  for (const tr of t.host.trades.values()) await t.host.deliver(tr.key, { type: 'error', definite: true, reason: 'done before lock' });
  assert.equal(t.status().mine[0].available, offer.baseAmount); assert.equal(t.status().mine[0].reserved, '0');
});

test('a maker whose clock is off from Solana declines takes as busy and starts no trade', async () => {
  const f = fixture(), { t, bridge } = await trader(party(), { registry: f.registry });
  Object.assign(t.host, { slot: 100, tip: 132, slotAt: performance.now(), tipAt: performance.now() });
  const offer = await t.makeOffer({ pair: 'TNK/USDC', side: 'sell', baseAmount: '1000000000000000000', price: '1' });
  t.wallets = new WalletManager({ config: { role: 'trader' }, role: t, store: t.store, solana: { chainTime: async () => nowSec() - 120 } });
  const peer = party(), ch = 'intercom-dex:t:' + offer.offerId;
  await channelPost(t, bridge, peer, 'take', { offerId: offer.offerId, pair: offer.pair, registryVersion: 1, software: '0.1.0',
    baseAmount: offer.baseAmount, taker: peer.me, commitment: random32(), sendBy: nowSec() + 900, refundAfter: nowSec() + 86400 }, ch);
  await t.takeQueue;
  assert.equal(t.host.trades.size, 0);
  assert.deepEqual(bridge.sent.filter(x => x.envelope.kind === 'decline').map(x => x.envelope.body.reason), ['busy']);
});

test('slow or failed sends do not hold maker admission or its wallet lock', async () => {
  for (const failed of [false, true]) {
    const f = fixture(), { t, bridge } = await trader(party(), { registry: f.registry });
    Object.assign(t.host, { slot: 100, tip: 132, slotAt: performance.now(), tipAt: performance.now() });
    const offer = await t.makeOffer({ pair: 'TNK/USDC', side: 'sell', baseAmount: '2000000000000000000', price: '1' });
    t.wallets = new WalletManager({ config: { role: 'trader' }, role: t, store: t.store, solana: { chainTime: async () => nowSec() } });
    let release;
    const held = new Promise(resolve => { release = resolve; });
    bridge.send = async (ch, envelope) => {
      bridge.sent.push({ ch, envelope });
      await held;
      if (failed) throw Error('transport unavailable');
    };
    const ch = 'intercom-dex:t:' + offer.offerId, peers = Array.from({ length: 4 }, party);
    const bodies = peers.map(peer => ({ offerId: offer.offerId, pair: offer.pair, registryVersion: 1, software: '0.1.0',
      baseAmount: '1000000000000000000', taker: peer.me, commitment: random32(), sendBy: nowSec() + 900, refundAfter: nowSec() + 86400 }));
    const emit = i => bridge.emit('message', ch, seal({ kind: 'take', ch, body: bodies[i] }, peers[i].identity.secretKey, { ts: nowSec(), nonce: random32() }));
    try {
      for (let i = 0; i < peers.length; i++) emit(i);
      for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
      assert.equal(t.host.trades.size, 2, 'reserve both fills before any send completes');
      assert.equal(t.status().mine[0].reserved, offer.baseAmount);
      assert.equal(bridge.sent.filter(x => x.envelope.kind === 'accept').length, 2);
      assert.deepEqual(bridge.sent.filter(x => x.envelope.kind === 'decline').map(x => x.envelope.body.reason), ['insufficient', 'insufficient']);
      emit(0); // A retransmission also cannot hold the admission queue while its outbox sends.
      let unlocked = false;
      t.takeQueue.then(() => t.wallets.exclusive(() => { unlocked = true; }));
      for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
      assert.equal(unlocked, true);
      assert.equal(t.host.trades.size, 2);
    } finally {
      release();
      await t.takeQueue;
      await Promise.all([...t.host.trades.values()].map(trade => trade.queue));
    }
  }
});

test('new offers/takes obey paused pairs, unsupported kinds and minimum software without affecting stored trades', async () => {
  const f = fixture(), alice = party(), bob = party();
  const { t: maker } = await trader(alice, { registry: f.registry }), { t, bridge } = await trader(bob, { registry: f.registry });
  const offer = await maker.makeOffer({ pair: 'TNK/USDC', side: 'sell', baseAmount: '1000000000000000000', price: '1' });
  await post(bridge, alice, 'offer', offer);
  t.store.put('registry-v1', f.registry);
  t.registry.current = { ...structuredClone(f.registry), version: 2 };
  t.registry.current.pairs[0].status = 'paused';
  await assert.rejects(t.takeOffer(offer.offerId, offer.baseAmount, '1'), /paused/);
  await assert.rejects(t.makeOffer({ pair: offer.pair, side: 'sell', baseAmount: offer.baseAmount, price: '1' }), /paused/);
  const unknown = { pair: 'NEW/USDC', base: { kind: 'new-kind', id: 'NEW', decimals: 8 }, minBaseAmount: '1', status: 'open' };
  t.registry.current.pairs.push(unknown);
  assert.equal(t.status().pairs.at(-1).availability, 'needs a newer version');
  await assert.rejects(t.makeOffer({ pair: unknown.pair, side: 'sell', baseAmount: '100', price: '1' }), /newer version/);
  t.registry.current.pairs[0].status = 'open'; t.registry.current.minSoftware = '0.2.0';
  assert.equal(t.status().message, 'update required'); assert.equal(t.status().updateRequired, true);
  await assert.rejects(t.takeOffer(offer.offerId, offer.baseAmount, '1'), /update required/);
  await assert.rejects(t.makeOffer({ pair: offer.pair, side: 'sell', baseAmount: offer.baseAmount, price: '1' }), /update required/);
  assert.equal(t.host.trades.size, 0);
});

test('insufficient asset-capable or up-to-date signers decline before reserving funds', async () => {
  for (const failure of ['asset', 'registry-version', 'heartbeat-version']) {
    const f = fixture(), { t, bridge } = await trader(party(), { registry: f.registry }), peer = party();
    const offer = await t.makeOffer({ pair: 'TNK/USDC', side: 'sell', baseAmount: '1000000000000000000', price: '1' });
    if (failure === 'asset') f.registry.signers[0].assets = ['RESET'];
    if (failure === 'registry-version') f.registry.signers[0].software = '0.0.9';
    if (failure === 'heartbeat-version') for (const signer of f.registry.signers.slice(0, 2)) t.heartbeats.set(signer.dexKey, { at: performance.now(), software: '0.0.9' });
    await channelPost(t, bridge, peer, 'take', { offerId: offer.offerId, pair: offer.pair, registryVersion: 1, software: '0.1.0',
      baseAmount: offer.baseAmount, taker: peer.me, commitment: random32(), sendBy: nowSec() + 900, refundAfter: nowSec() + 86400 }, 'intercom-dex:t:' + offer.offerId);
    assert.equal(bridge.sent.at(-1).envelope.body.reason, 'signers', failure);
    assert.equal(t.host.trades.size, 0); assert.equal(t.status().mine[0].reserved, '0');
  }
});

test('service version announcements are displayed as data and trigger no sends or trades', async () => {
  const f = fixture(), service = party(), { t, bridge } = await trader(party(), { registry: f.registry, serviceKey: service.me.dexKey });
  const sent = bridge.sent.length, latest = { version: '9.0.0', commit: 'a'.repeat(40), sha256: random32() };
  await channelPost(t, bridge, service, 'status', { software: '0.1.0', status: 'online', ts: nowSec(), message: '', latest }, 'intercom-dex');
  assert.deepEqual(t.status().serviceStatus.latest, latest);
  assert.equal(bridge.sent.length, sent); assert.equal(t.host.trades.size, 0);
});

test('maker reannounces at 120 seconds; traders rebuild service books but still require a maker-signed offer to trade', async t => {
  const timers = []; t.mock.method(globalThis, 'setInterval', (fn, ms) => { timers.push({ fn, ms }); return timers.length; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const f = fixture(), service = party(), { t: traderRole, bridge } = await trader(party(), { registry: f.registry, serviceKey: service.me.dexKey });
  const o = await traderRole.makeOffer({ pair: 'TNK/USDC', side: 'sell', baseAmount: '1000000000000000000', price: '1' });
  const before = bridge.sent.filter(x => x.envelope.kind === 'offer').length;
  assert.ok(timers.some(x => x.ms === 120000)); assert.ok(!timers.some(x => x.ms === 30000));
  timers.find(x => x.ms === 120000).fn(); await new Promise(r => setImmediate(r));
  assert.equal(bridge.sent.filter(x => x.envelope.kind === 'offer').length, before + 1);
  const ts = nowSec(), full = { pair: o.pair, registryVersion: 1, seq: 7, ts: ts - 10, levels: [{ side: 'sell', price: '1', baseAmount: '100', offers: 1 }] };
  await channelPost(traderRole, bridge, party(), 'book', full, 'intercom-dex'); assert.equal(traderRole.book.size, 0);
  await channelPost(traderRole, bridge, service, 'book', full, 'intercom-dex'); assert.equal(traderRole.book.size, 1);
  await channelPost(traderRole, bridge, service, 'bookDelta', { pair: o.pair, seq: 7, removes: [], upserts: [{ side: 'sell', price: '1', baseAmount: '200', offers: 2 }] }, 'intercom-dex');
  assert.equal(traderRole.status().book[o.pair].levels[0].baseAmount, '200');
  await assert.rejects(traderRole.takeOffer(random32(), '100', '1'), /no longer announced by its maker/);
  await traderRole.cancelOffer(o.offerId); const count = bridge.sent.length;
  timers.find(x => x.ms === 120000).fn(); await new Promise(r => setImmediate(r)); assert.equal(bridge.sent.length, count);
});

test('only the buyer summons with both signatures, repeats while waiting, and stops at k acks', async () => {
  const f = fixture(), { t, bridge } = await trader(party(), { registry: f.registry });
  const id = termsTradeId(f.terms), ch = 'intercom-dex:t:' + id;
  const sig = identity => seal({ kind: 'termsSig', ch, body: { tradeId: id } }, identity.secretKey, { ts: nowSec(), nonce: random32() });
  const state = { terms: f.terms, tradeId: id, phase: 'awaitAcks', peer: encodeKey(f.seller.publicKey), acks: [] };
  const buyer = { role: 'buyer', state, outbox: { [ch]: [sig(f.buyer)] }, raw: [sig(f.seller)] };
  const seller = { role: 'seller', state: { ...state, phase: 'awaitDeal', peer: encodeKey(f.buyer.publicKey) }, outbox: { [ch]: [sig(f.seller)] }, raw: [sig(f.buyer)] };
  const hook = t.host.hooks.afterStep[0], count = () => bridge.sent.filter(x => x.envelope.kind === 'summon').length;
  await hook(seller); assert.equal(count(), 0);
  await hook(buyer); assert.equal(count(), 1);
  await hook(buyer); assert.equal(count(), 1);
  buyer.summonedAt -= 20; await hook(buyer); assert.equal(count(), 2);
  buyer.summonedAt -= 20; buyer.state.acks = Array(f.terms.k).fill({}); await hook(buyer); assert.equal(count(), 2);
});

test('trader pushes cached relay keys on restart and replaces them after a signed removal registry', async () => {
  const f = fixture(), service = party(), me = party(), a = await trader(me, { serviceKey: service.me.dexKey });
  const reg = { ...f.registry, serviceRelayKey: random32(), issuedAt: nowSec(), signers: f.registry.signers.map((s, i) => ({ ...s, ...(i === 0 ? { relayKey: random32() } : {}) })) };
  await channelPost(a.t, a.bridge, service, 'registry', reg, 'intercom-dex');
  assert.deepEqual(a.bridge.relays, [reg.serviceRelayKey, reg.signers[0].relayKey].sort());
  const restarted = await trader(me, { dir: a.dir, serviceKey: service.me.dexKey });
  assert.deepEqual(restarted.bridge.relays, a.bridge.relays);
  const next = { ...reg, version: 2, signers: reg.signers.slice(1), removed: [{ dexKey: reg.signers[0].dexKey, removedAt: nowSec(), reason: 'removed' }] };
  await channelPost(restarted.t, restarted.bridge, service, 'registry', next, 'intercom-dex');
  assert.deepEqual(restarted.bridge.relays, [reg.serviceRelayKey]);
  await channelPost(restarted.t, restarted.bridge, party(), 'registry', { ...next, version: 3, serviceRelayKey: random32() }, 'intercom-dex');
  assert.deepEqual(restarted.bridge.relays, [reg.serviceRelayKey]);
});

test('verified announcements refresh lastSeen; status and takes expire at 300 seconds and reannouncement restores them', async ctx => {
  let ms = Date.now(); ctx.mock.method(Date, 'now', () => ms);
  const { registry } = fixture(), alice = party(), bob = party();
  const { t: maker } = await trader(alice, { registry }), { t: taker, bridge } = await trader(bob, { registry });
  const offer = await maker.makeOffer({ pair: 'TNK/USDC', side: 'sell', baseAmount: '2000000000000000000', price: '1' });
  await post(bridge, alice, 'offer', offer);
  const first = taker.offers.get(offer.offerId).firstSeen;
  assert.equal(taker.offers.get(offer.offerId).lastSeen, first);
  ms += 290000; await post(bridge, alice, 'offer', offer);
  assert.equal(taker.offers.get(offer.offerId).firstSeen, first);
  assert.equal(taker.offers.get(offer.offerId).lastSeen, first + 290);
  const ch = OFFERS, forged = seal({ kind: 'offer', ch, body: offer }, alice.identity.secretKey, { ts: nowSec(), nonce: random32() });
  forged.sig = '00'.repeat(64);
  ms += 299000; bridge.emit('message', ch, forged); await new Promise(r => setImmediate(r));
  assert.equal(taker.status().offers.length, 1);
  ms += 1000;
  const sent = bridge.sent.length;
  await assert.rejects(taker.takeOffer(offer.offerId, undefined, '1'), /This offer is no longer announced by its maker\./);
  assert.equal(taker.offers.has(offer.offerId), false); assert.equal(taker.status().offers.length, 0);
  assert.equal(taker.host.trades.size, 0); assert.equal(bridge.sent.length, sent);
  await post(bridge, alice, 'offer', offer); assert.equal(taker.status().offers.length, 1);
  await assert.rejects(maker.takeOffer(offer.offerId, undefined, '1'), /Own offer/);
  assert.equal(maker.status().offers.length, 0, 'own offers have their separate mine list');
  assert.equal(maker.status().mine.length, 1);
});

test('full-book remainder survives deltas, limits takes and disappears from control/MCP status when gone', async () => {
  const { registry } = fixture(), alice = party(), service = party();
  const { t: maker } = await trader(alice, { registry });
  const { t: taker, bridge } = await trader(party(), { registry, serviceKey: service.me.dexKey });
  const offer = await maker.makeOffer({ pair: 'TNK/USDC', side: 'sell', baseAmount: '2000000000000000000', price: '1' });
  await post(bridge, alice, 'offer', offer);
  const ts = nowSec(), remainder = '500000000000000000';
  const full = { pair: offer.pair, registryVersion: 1, seq: 10, ts, levels: [{ side: 'sell', price: '1', baseAmount: remainder, offers: 1 }],
    remaining: [{ offerId: offer.offerId, amount: remainder }] };
  await channelPost(taker, bridge, service, 'book', full, 'intercom-dex');
  assert.equal(taker.status().offers[0].baseAmount, remainder);
  assert.equal(taker.offers.get(offer.offerId).offer.baseAmount, offer.baseAmount, 'maker-signed amount is immutable');
  await assert.rejects(taker.takeOffer(offer.offerId, offer.baseAmount, '1'), /offer size/);
  assert.equal((await taker.takeOffer(offer.offerId, undefined, '1')).baseAmount, remainder);
  taker.bookView.delta({ pair: offer.pair, seq: 10, upserts: [{ side: 'sell', price: '1', baseAmount: '300000000000000000', offers: 1 }], removes: [] }, ts + 1);
  assert.equal(taker.book.get(offer.pair).remaining, undefined, 'deltas keep their protocol shape');
  assert.equal(taker.status().offers[0].baseAmount, '300000000000000000');
  taker.bookView.delta({ pair: offer.pair, seq: 10, upserts: [], removes: [{ side: 'sell', price: '1' }] }, ts + 2);
  assert.deepEqual(taker.status().offers, []);
  await assert.rejects(taker.takeOffer(offer.offerId, '1', '1'), /no longer announced/);
  await channelPost(taker, bridge, service, 'book', { ...full, seq: 11, ts: ts + 3, levels: [], remaining: [] }, 'intercom-dex');
  await post(bridge, alice, 'offer', offer);
  assert.deepEqual(taker.status().offers, [], 'reannouncing the original signed amount cannot undo a known fill');
});

test('freshness and size are checked again after a slow wallet check, before a trade starts', async () => {
  const { registry } = fixture(), alice = party(), { t: maker } = await trader(alice, { registry });
  const { t: taker, bridge } = await trader(party(), { registry });
  const offer = await maker.makeOffer({ pair: 'TNK/USDC', side: 'sell', baseAmount: '2000000000000000000', price: '1' });
  await post(bridge, alice, 'offer', offer);
  taker.wallets = { exclusive: fn => fn(), requireFunds: async () => { taker.offers.get(offer.offerId).lastSeen -= 300; } };
  await assert.rejects(taker.takeOffer(offer.offerId, undefined, '1'), /no longer announced/);
  assert.equal(taker.host.trades.size, 0);
  assert.ok(!bridge.sent.some(m => m.envelope.kind === 'take'));
});

test('the regular announcement timer prunes other makers without removing own persisted offers', async ctx => {
  const timers = []; ctx.mock.method(globalThis, 'setInterval', (fn, ms) => { timers.push({ fn, ms }); return timers.length; });
  ctx.mock.method(globalThis, 'clearInterval', () => {});
  const { registry } = fixture(), alice = party(), { t: maker } = await trader(alice, { registry });
  const { t: taker, bridge } = await trader(party(), { registry });
  const offer = await maker.makeOffer({ pair: 'TNK/USDC', side: 'sell', baseAmount: '2000000000000000000', price: '1' });
  const own = await taker.makeOffer({ pair: 'TNK/USDC', side: 'buy', baseAmount: '1000000000000000000', price: '1' });
  await post(bridge, alice, 'offer', offer);
  taker.offers.get(offer.offerId).lastSeen -= 300;
  timers.filter(t => t.ms === 120000).at(-1).fn(); await new Promise(r => setImmediate(r));
  assert.equal(taker.offers.has(offer.offerId), false);
  assert.ok(taker.mine.has(own.offerId)); assert.ok(taker.store.get('offer-' + own.offerId));
});

test('the HTTP status and take paths used by MCP share the trader freshness and remaining-size rules', async () => {
  const { registry } = fixture(), alice = party(), { t: maker } = await trader(alice, { registry });
  const { t: taker, bridge } = await trader(party(), { registry });
  const offer = await maker.makeOffer({ pair: 'TNK/USDC', side: 'sell', baseAmount: '2000000000000000000', price: '1' });
  await post(bridge, alice, 'offer', offer);
  const handler = controlHandler({ token: 'unit-test', role: taker });
  const call = (method, url, body) => new Promise(resolve => {
    const req = Object.assign(new EventEmitter(), { method, url, headers: { authorization: 'Bearer unit-test' } });
    let status;
    handler(req, { writeHead: code => { status = code; }, end: data => resolve({ status, value: JSON.parse(data) }) });
    if (body) req.emit('data', JSON.stringify(body));
    req.emit('end');
  });
  const pair = offer.pair, remainder = '500000000000000000';
  taker.bookView.full({ pair, registryVersion: 1, seq: 1, ts: nowSec(), levels: [{ side: 'sell', price: '1', baseAmount: remainder, offers: 1 }],
    remaining: [{ offerId: offer.offerId, amount: remainder }] });
  assert.equal((await call('GET', '/status')).value.offers[0].baseAmount, remainder);
  const tooMuch = await call('POST', '/take', { offerId: offer.offerId, price: '1', baseAmount: offer.baseAmount });
  assert.equal(tooMuch.status, 400); assert.match(tooMuch.value.error, /offer size/);
  taker.offers.get(offer.offerId).lastSeen -= 300;
  assert.deepEqual((await call('GET', '/status')).value.offers, []);
  const stale = await call('POST', '/take', { offerId: offer.offerId, price: '1' });
  assert.deepEqual(stale, { status: 400, value: { error: 'This offer is no longer announced by its maker.' } });
  assert.equal(taker.host.trades.size, 0);
});
