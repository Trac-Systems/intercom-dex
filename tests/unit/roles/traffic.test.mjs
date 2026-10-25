import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TradeHost, tradeChannel } from '../../../src/roles/host.js';
import { simulation } from '../core/simulation.mjs';
import { seal } from '../../../src/core/envelope.js';
import { encodeKey } from '../../../src/core/keys.js';
import { hex } from '../core/helpers.mjs';
import Sidechannel from '../../../peer/features/sidechannel/index.js';
import { dexTransport } from '../../../peer/features/dex-transport.js';

const sim = simulation({ capturePhases: true });
async function host(t, role, state, identity) {
  const timers = [], sent = [], records = new Map(), clock = { now: state.now };
  t.mock.method(globalThis, 'setInterval', fn => { timers.push(fn); return timers.length; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const bridge = new EventEmitter(); bridge.join = async () => {}; bridge.send = async (ch, envelope) => sent.push({ ch, envelope });
  const store = { list: () => [], get: k => records.get(k), put: (k, v) => records.set(k, structuredClone(v)) };
  const h = new TradeHost({ bridge, store, identity: { secretKey: identity.secretKey, publicKey: encodeKey(identity.publicKey) },
    serviceKey: encodeKey(sim.f.service.publicKey), now: () => clock.now });
  await h.start(); t.after(() => h.stop());
  await h.addTrade({ key: 'trade', role, state: structuredClone(state), lifetimeSec: 172800 + 3600 });
  await new Promise(r => setImmediate(r)); sent.length = 0;
  const tr = h.trades.get('trade');
  const tick = async seconds => { clock.now += seconds; timers[0](); await tr.queue; await new Promise(r => setImmediate(r)); };
  const receive = async (from, kind, body, channel = tradeChannel(state.tradeId)) => {
    bridge.emit('message', channel, seal({ kind, body, ch: channel }, from.secretKey, { ts: clock.now, nonce: hex() }));
    await new Promise(r => setImmediate(r)); await tr.queue;
  };
  return { h, tr, clock, sent, tick, receive, records };
}

function outbox(transcript, role, identity) {
  const result = {};
  for (const { name, action: a } of transcript.log) {
    if (name !== role || a.type !== 'send' || ['claimed', 'refunded', 'abort'].includes(a.kind)) continue;
    (result[a.ch] ??= []).push(seal({ kind: a.kind, ch: a.ch, body: a.body }, identity.secretKey,
      { ts: 100, nonce: hex() }));
  }
  return result;
}

for (const phase of ['locking', 'locked']) test(`buyer ${phase} stops automatic outbox sends at sendBy but still answers present`, async t => {
  const state = sim.snapshots.get(`buyer:${phase}`), f = await host(t, 'buyer', state, sim.f.buyer);
  f.h.solana = { checkEscrow: async ({ hashHex }) => ({ ok: true, hashHex, status: 'active' }) };
  f.tr.outbox = outbox(sim, 'buyer', sim.f.buyer);
  const ch = tradeChannel(state.tradeId), batch = Object.values(f.tr.outbox).flat().length;
  assert.ok(f.tr.outbox[ch].some(e => e.kind === 'deal'));
  f.clock.now = state.terms.sendBy - 20;
  await f.tick(0); await f.tick(10);
  assert.equal(f.sent.length, batch, 'normal ten-second repeats continue before sendBy');
  f.sent.length = 0;
  await f.tick(10); await f.tick(10); await f.tick(3600);
  assert.equal(f.tr.state.phase, phase);
  assert.equal(f.sent.length, 0, 'no periodic sends at or after sendBy');
  for (const requester of [sim.f.seller, sim.nodes.get('signer1').identity]) {
    f.sent.length = 0;
    await f.receive(requester, 'present', { ref: state.tradeId });
    assert.deepEqual(f.sent.map(x => x.envelope), f.tr.outbox[ch], 'explicit recovery returns the unchanged outbox');
  }
});

test('buyer refund processing and retries continue after automatic outbox sends stop', async t => {
  const state = sim.snapshots.get('buyer:locked'), f = await host(t, 'buyer', state, sim.f.buyer);
  f.tr.outbox = outbox(sim, 'buyer', sim.f.buyer);
  let refunds = 0, checks = 0;
  f.h.solana = {
    refund: async () => { refunds++; return { ok: false, unknown: true }; },
    checkEscrow: async ({ hashHex }) => { checks++; return { ok: true, hashHex, status: 'active' }; },
  };
  f.clock.now = state.terms.sendBy;
  await f.tick(0);
  f.clock.now = state.terms.refundAfter;
  await f.tick(0); await f.tick(15); await f.tick(3600);
  assert.equal(f.tr.state.phase, 'refunding');
  assert.ok(refunds >= 2, 'refunds still retry');
  assert.ok(checks >= 1, 'settlement still reconciles');
  assert.equal(f.sent.length, 0, 'refund waits do not repeat the dealing');
  await f.receive(sim.f.seller, 'present', { ref: state.tradeId });
  assert.deepEqual(f.sent.map(x => x.envelope), f.tr.outbox[tradeChannel(state.tradeId)]);
});

for (const phase of ['transferring', 'awaitShares', 'claiming']) test(`seller ${phase} stops automatic outbox sends at the transfer verification cutoff`, async t => {
  const state = sim.snapshots.get(`seller:${phase}`), f = await host(t, 'seller', state, sim.f.seller);
  // A submitted transfer may remain in transferring while its finality is unknown.
  f.tr.state.txHash = sim.snapshots.get('seller:awaitShares').txHash;
  f.tr.outbox = outbox(sim, 'seller', sim.f.seller);
  f.h.solana = { checkEscrow: async ({ hashHex }) => ({ ok: true, hashHex, status: 'active' }) };
  const notices = () => f.sent.filter(x => x.envelope.kind !== 'shareRequest');
  const batch = Object.values(f.tr.outbox).flat().length;
  f.clock.now = state.terms.sendBy;
  await f.tick(0); await f.tick(10);
  assert.equal(notices().length, batch, 'transfer evidence still repeats during grace');
  f.clock.now = state.terms.sendBy + state.terms.graceSec - 10;
  await f.tick(0);
  assert.equal(notices().length, 2 * batch, 'the last repeat before the cutoff still allows recovery');
  f.sent.length = 0;
  await f.tick(10); await f.tick(10); await f.tick(3600);
  assert.equal(f.tr.state.phase, phase);
  assert.equal(notices().length, 0, 'old transfer and negotiation messages stop after grace');
  assert.equal(f.sent.some(x => x.envelope.kind === 'shareRequest'), phase === 'awaitShares', 'missing shares still get requested');
  f.sent.length = 0;
  await f.receive(sim.f.buyer, 'present', { ref: state.tradeId });
  assert.deepEqual(f.sent.map(x => x.envelope), f.tr.outbox[tradeChannel(state.tradeId)]);
  f.sent.length = 0;
  f.clock.now = state.terms.refundAfter;
  await f.tick(0); await f.tick(60);
  assert.equal(f.sent.length, 0, 'settlement waits remain quiet after refundAfter');
});

test('six stale locked buyers add no PoW jobs over ten minutes of ticks alongside fresh negotiations', async t => {
  const transcripts = Array.from({ length: 6 }, () => {
    const offerId = hex();
    return simulation({ neverSend: true, fixture: { ...sim.f, offerId, terms: { ...sim.f.terms, offerId } } });
  });
  const f = await host(t, 'buyer', transcripts[0].state('buyer'), sim.f.buyer);
  for (const [i, transcript] of transcripts.entries()) {
    const key = i === 0 ? 'trade' : `stale-${i}`;
    if (i > 0) await f.h.addTrade({ key, role: 'buyer', state: structuredClone(transcript.state('buyer')), lifetimeSec: 176400 });
    f.h.trades.get(key).outbox = outbox(transcript, 'buyer', sim.f.buyer);
  }
  await new Promise(r => setImmediate(r));
  f.h.solana = { checkEscrow: async ({ hashHex }) => ({ ok: true, hashHex, status: 'active' }) };
  f.clock.now = f.tr.state.terms.sendBy;
  const policy = dexTransport({ role: 'trader', servicePeerKey: encodeKey(sim.f.service.publicKey) }).sidechannel;
  const sc = new Sidechannel({}, policy), pending = [];
  sc._now = () => f.clock.now * 1000;
  const work = t.mock.method(sc, '_attachPow', sc._attachPow.bind(sc));
  f.sent.length = 0;
  f.h.bridge.send = (ch, envelope) => {
    f.sent.push({ ch, envelope });
    const job = sc._stampedPayload(ch, envelope);
    pending.push(job);
    return job;
  };
  const freshChannel = tradeChannel(hex());
  for (let second = 0; second <= 600; second++) {
    await f.tick(second === 0 ? 0 : 1);
    await Promise.all([...f.h.trades.values()].map(tr => tr.queue));
    if (second % 300 === 0) {
      for (const kind of ['accept', 'reveal']) {
        const payload = await sc._stampedPayload(freshChannel, { kind, round: second });
        assert.equal(sc._checkPow(payload, freshChannel), true, 'fresh negotiation gets a valid 20-bit stamp');
      }
    }
  }
  // Drain even when this regression fails, so no PoW work outlives the test.
  await Promise.all(pending);
  assert.equal(f.sent.length, 0, 'stale outboxes never reach the stamping queue');
  assert.equal(work.mock.callCount(), 6, 'only the six fresh negotiation messages require work');
  assert.ok(sc.powPending.every(n => n === 0));
  assert.ok([...f.h.trades.values()].every(tr => tr.state.phase === 'locked'));
  t.diagnostic('6 stale trades, 601 ticks, 0 stale sends/PoW jobs; 6 fresh messages stamped at 20 bits');
});

test('published signer repeats only publications at 10,20,40 ... 640 seconds, persists schedule, then only answers requests', async t => {
  const node = sim.nodes.get('signer1'), f = await host(t, 'signer', node.state, node.identity);
  const pub = sim.log.find(x => x.name === 'signer1' && x.action.type === 'publishShare').action;
  for (const ch of pub.channels) f.tr.outbox[ch] = [seal({ kind: 'ack', ch, body: { tradeId: node.state.tradeId, H: pub.body.H, holdUntil: node.state.terms.refundAfter } }, node.identity.secretKey, { ts: f.clock.now, nonce: hex() }),
    seal({ kind: 'sharePublish', ch, body: pub.body }, node.identity.secretKey, { ts: f.clock.now, nonce: hex() })];
  f.tr.publicationAt = f.clock.now; f.tr.publicationDelay = 10;
  for (const delay of [10, 20, 40, 80, 160, 320, 640]) {
    const n = f.sent.length; await f.tick(delay - 1); assert.equal(f.sent.length, n);
    await f.tick(1); assert.equal(f.sent.length, n + 2);
    assert.ok(f.sent.every(x => x.envelope.kind === 'sharePublish'));
  }
  assert.equal(f.records.get('trade-trade').publicationDelay, 1280);
  const count = f.sent.length; await f.tick(86400); assert.equal(f.sent.length, count);
});

test('publication recovery authenticates seller/service, rate limits each requester and does not exhaust the ordinary message cap', async t => {
  const node = sim.nodes.get('signer1'), f = await host(t, 'signer', node.state, node.identity), id = node.state.tradeId;
  const pub = sim.log.find(x => x.name === 'signer1' && x.action.type === 'publishShare').action;
  for (const ch of pub.channels) f.tr.outbox[ch] = [seal({ kind: 'sharePublish', ch, body: pub.body }, node.identity.secretKey, { ts: f.clock.now, nonce: hex() })];
  await f.receive(sim.f.buyer, 'shareRequest', { tradeId: id }); assert.equal(f.sent.length, 0);
  await f.receive(sim.f.seller, 'shareRequest', { tradeId: hex() }); assert.equal(f.sent.length, 0);
  f.tr.perSender.set(encodeKey(sim.f.seller.publicKey), 400);
  await f.receive(sim.f.seller, 'shareRequest', { tradeId: id }); assert.equal(f.sent.length, 1);
  await f.receive(sim.f.seller, 'shareRequest', { tradeId: id }); assert.equal(f.sent.length, 1);
  await f.receive(sim.f.service, 'shareRequest', { tradeId: id }, 'intercom-dex:signers'); assert.equal(f.sent.length, 2);
  f.clock.now += 29; await f.receive(sim.f.seller, 'shareRequest', { tradeId: id }); assert.equal(f.sent.length, 2);
  f.clock.now++; await f.receive(sim.f.seller, 'shareRequest', { tradeId: id }); assert.equal(f.sent.length, 3);
  await f.receive(sim.f.seller, 'present', { ref: id }); assert.equal(f.sent.length, 4);
  await f.receive(sim.f.seller, 'present', { ref: id }); assert.equal(f.sent.length, 4);
  f.clock.now = node.state.terms.refundAfter;
  await f.receive(sim.f.seller, 'shareRequest', { tradeId: id }); assert.equal(f.sent.length, 4);
});

test('seller requests missing valid shares every thirty seconds, stops at k or refund, and waiting outbox still repeats at ten seconds', async t => {
  const state = sim.snapshots.get('seller:awaitShares'), f = await host(t, 'seller', state, sim.f.seller);
  f.tr.outbox[tradeChannel(state.tradeId)] = [seal({ kind: 'transferSent', ch: tradeChannel(state.tradeId), body: { tradeId: state.tradeId, txHash: state.txHash } }, sim.f.seller.secretKey, { ts: f.clock.now, nonce: hex() })];
  await f.tick(0); await f.tick(10);
  assert.equal(f.sent.filter(x => x.envelope.kind === 'shareRequest').length, 1);
  assert.equal(f.sent.filter(x => x.envelope.kind === 'transferSent').length, 1);
  await f.tick(20); assert.equal(f.sent.filter(x => x.envelope.kind === 'shareRequest').length, 2);
  f.tr.state.shares = Array.from({ length: state.terms.k }, (_, i) => ({ id: i + 1, share: hex() }));
  await f.tick(30); assert.equal(f.sent.filter(x => x.envelope.kind === 'shareRequest').length, 2);
});

test('a restarted signer re-publishes only trades still inside the repeat schedule, and still answers requests', async t => {
  const node = sim.nodes.get('signer1'), pub = sim.log.find(x => x.name === 'signer1' && x.action.type === 'publishShare').action;
  const published = sim.state('signer1');
  for (const [delay, ago, expectSends] of [[1280, 5000, false], [600, 1300, false], [640, 600, true]]) {
    const timers = [], sent = [], records = new Map(), clock = { now: published.now };
    t.mock.method(globalThis, 'setInterval', fn => { timers.push(fn); return timers.length; });
    const outbox = Object.fromEntries(pub.channels.map(ch => [ch, [seal({ kind: 'sharePublish', ch, body: pub.body }, node.identity.secretKey, { ts: clock.now, nonce: hex() })]]));
    records.set('trade-trade', { key: 'trade', role: 'signer', state: structuredClone(published), lifetimeSec: 172800 + 3600, outbox, raw: [], buffer: [],
      publicationAt: clock.now - ago, publicationDelay: delay });
    const bridge = new EventEmitter(); bridge.join = async () => {}; bridge.send = async (ch, envelope) => sent.push({ ch, envelope });
    const store = { list: p => [...records.keys()].filter(k => k.startsWith(p)), get: k => records.get(k), put: (k, v) => records.set(k, structuredClone(v)) };
    const h = new TradeHost({ bridge, store, identity: { secretKey: node.identity.secretKey, publicKey: encodeKey(node.identity.publicKey) },
      serviceKey: encodeKey(sim.f.service.publicKey), now: () => clock.now });
    await h.start();
    const tr = h.trades.get('trade');
    for (let i = 0; i < 5; i++) { await tr.queue; await new Promise(r => setImmediate(r)); }
    assert.equal(sent.length > 0, expectSends, `delay ${delay}: ${sent.map(x => x.envelope.kind)}`);
    if (!expectSends) {
      bridge.emit('message', tradeChannel(published.tradeId), seal({ kind: 'shareRequest', ch: tradeChannel(published.tradeId), body: { tradeId: published.tradeId } },
        sim.f.seller.secretKey, { ts: clock.now, nonce: hex() }));
      for (let i = 0; i < 5; i++) { await tr.queue; await new Promise(r => setImmediate(r)); }
      assert.ok(sent.some(x => x.envelope.kind === 'sharePublish'), 'a share request is still answered');
    }
    h.stop(); t.mock.restoreAll();
  }
});

test('a signer joins channels only of trades it still runs or serves, and leaves a channel once serving ends', async t => {
  const node = sim.nodes.get('signer1'), published = sim.state('signer1'), refundAfter = published.terms.refundAfter;
  const timers = [], joins = [], leaves = [], records = new Map(), clock = { now: published.now };
  t.mock.method(globalThis, 'setInterval', fn => { timers.push(fn); return timers.length; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const stored = (key, phase, tradeId) => records.set(`trade-${key}`, { key, role: 'signer', state: { ...structuredClone(published), phase, tradeId },
    lifetimeSec: 172800 + 3600, outbox: {}, raw: [], buffer: [], publicationAt: clock.now - 5000, publicationDelay: 1280 });
  stored('serving', 'published', published.tradeId);
  for (const phase of ['aborted', 'expired']) stored(phase, phase, hex());
  const bridge = new EventEmitter(); bridge.join = async ch => { joins.push(ch); }; bridge.leave = async ch => { leaves.push(ch); };
  bridge.send = async () => {};
  const store = { list: p => [...records.keys()].filter(k => k.startsWith(p)), get: k => records.get(k), put: (k, v) => records.set(k, structuredClone(v)) };
  const h = new TradeHost({ bridge, store, identity: { secretKey: node.identity.secretKey, publicKey: encodeKey(node.identity.publicKey) },
    serviceKey: encodeKey(sim.f.service.publicKey), now: () => clock.now });
  await h.start(); t.after(() => h.stop());
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.deepEqual(joins, [tradeChannel(published.tradeId)], 'aborted and expired trades join nothing');
  timers[0](); await new Promise(r => setImmediate(r)); assert.deepEqual(leaves, []);
  clock.now = refundAfter; timers[0](); await new Promise(r => setImmediate(r));
  assert.deepEqual(leaves, [tradeChannel(published.tradeId)], 'serving ended: its channel is left once');
  timers[0](); await new Promise(r => setImmediate(r)); assert.equal(leaves.length, 1);
  assert.equal(Object.hasOwn(records.get('trade-serving'), 'channelsLeft'), false);
});

test('a signer still waiting for the dealing announces itself again every thirty seconds, and only while it waits', async t => {
  const state = sim.snapshots.get('signer1:awaitDeal'), node = sim.nodes.get('signer1');
  const f = await host(t, 'signer', state, node.identity), ch = tradeChannel(state.tradeId);
  const presents = () => f.sent.filter(x => x.envelope.kind === 'present' && x.ch === ch && x.envelope.body.ref === state.tradeId).length;
  await f.tick(0); await f.tick(29); assert.equal(presents(), 0);
  await f.tick(1); assert.equal(presents(), 1);
  await f.tick(15); assert.equal(presents(), 1);
  await f.tick(15); assert.equal(presents(), 2);
  f.tr.state = { ...f.tr.state, phase: 'holding' };
  await f.tick(30); assert.equal(presents(), 2);
});

test('a signer passes the buyer dealing on over the signers channel once, and a signer that missed it accepts that copy', async t => {
  const state = sim.snapshots.get('signer1:awaitDeal'), ch = tradeChannel(state.tradeId);
  const buyer = sim.nodes.get('buyer'), sent = sim.log.find(x => x.name === 'buyer' && x.action.type === 'send' && x.action.kind === 'deal');
  assert.ok(sent, 'the simulation recorded the dealing');
  const dealing = seal({ kind: 'deal', body: sent.action.body, ch }, buyer.identity.secretKey, { ts: state.now, nonce: hex() });
  // The signer that got it on the trade channel forwards the unchanged envelope once.
  const first = await host(t, 'signer', state, sim.nodes.get('signer1').identity);
  first.h.bridge.emit('message', ch, dealing); await new Promise(r => setImmediate(r)); await first.tr.queue;
  first.h.bridge.emit('message', ch, dealing); await new Promise(r => setImmediate(r)); await first.tr.queue;
  const forwarded = first.sent.filter(x => x.ch === 'intercom-dex:signers' && x.envelope.kind === 'deal');
  assert.equal(forwarded.length, 1); assert.deepEqual(forwarded[0].envelope, dealing);
  assert.notEqual(first.tr.state.phase, 'awaitDeal');
  // A signer that missed it on the trade channel takes the copy from the signers channel.
  const other = await host(t, 'signer', sim.snapshots.get('signer2:awaitDeal') ?? state, sim.nodes.get('signer2').identity);
  other.h.bridge.emit('message', 'intercom-dex:signers', dealing); await new Promise(r => setImmediate(r)); await other.tr.queue;
  assert.notEqual(other.tr.state.phase, 'awaitDeal');
  // A copy for another trade's channel, or a forged one, changes nothing.
  const third = await host(t, 'signer', sim.snapshots.get('signer2:awaitDeal') ?? state, sim.nodes.get('signer2').identity);
  third.h.bridge.emit('message', 'intercom-dex:signers', { ...dealing, ch: tradeChannel('f'.repeat(64)) });
  third.h.bridge.emit('message', 'intercom-dex:signers', seal({ kind: 'deal', body: sent.action.body, ch }, sim.nodes.get('seller').identity.secretKey, { ts: state.now, nonce: hex() }));
  await new Promise(r => setImmediate(r)); await third.tr.queue;
  assert.equal(third.tr.state.phase, 'awaitDeal');
});

test('a signer forwards authenticated seller transfer evidence once for venue monitoring', async t => {
  const state = sim.snapshots.get('signer1:holding'), ch = tradeChannel(state.tradeId);
  const f = await host(t, 'signer', state, sim.nodes.get('signer1').identity);
  f.h.trac = { verifyTransfer: async () => ({ ok: false, final: true, reason: 'test complete' }) };
  const body = { tradeId: state.tradeId, txHash: hex() };
  const envelope = who => seal({ kind: 'transferSent', body, ch }, sim.nodes.get(who).identity.secretKey, { ts: state.now, nonce: hex() });
  f.h.bridge.emit('message', ch, envelope('buyer'));
  await new Promise(r => setImmediate(r));
  assert.equal(f.sent.filter(x => x.ch === 'intercom-dex:signers').length, 0);
  const message = envelope('seller');
  f.h.bridge.emit('message', ch, message); await new Promise(r => setImmediate(r)); await f.tr.queue;
  f.h.bridge.emit('message', ch, message); await new Promise(r => setImmediate(r)); await f.tr.queue;
  const forwarded = f.sent.filter(x => x.ch === 'intercom-dex:signers' && x.envelope.kind === 'transferSent');
  assert.equal(forwarded.length, 1); assert.deepEqual(forwarded[0].envelope, message);
});

test('a trader joins no channel of a finished trade, leaves them when a trade finishes, and keeps an open offer channel', async t => {
  const timers = [], joins = [], leaves = [], records = new Map();
  const done = structuredClone(sim.snapshots.get('buyer:complete')), live = structuredClone(sim.snapshots.get('seller:claiming'));
  const clock = { now: live.now };
  t.mock.method(globalThis, 'setInterval', fn => { timers.push(fn); return timers.length; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const stored = (key, role, state) => records.set(`trade-${key}`, { key, role, state, lifetimeSec: 172800 + 3600, outbox: {}, raw: [], buffer: [] });
  done.tradeId = hex(); done.offerId = hex();   // another trade than the running one
  stored('done', 'buyer', done);
  stored('live', 'seller', live);
  const bridge = new EventEmitter(); bridge.join = async ch => { joins.push(ch); }; bridge.leave = async ch => { leaves.push(ch); };
  bridge.send = async () => {};
  const store = { list: p => [...records.keys()].filter(k => k.startsWith(p)), get: k => records.get(k), put: (k, v) => records.set(k, structuredClone(v)) };
  const offerChannel = tradeChannel(live.offerId);
  const node = sim.nodes.get('seller');
  const h = new TradeHost({ bridge, store, identity: { secretKey: node.identity.secretKey, publicKey: encodeKey(node.identity.publicKey) },
    serviceKey: encodeKey(sim.f.service.publicKey), now: () => clock.now, keepChannel: ch => ch === offerChannel });
  await h.start(); t.after(() => h.stop());
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.ok(!joins.includes(tradeChannel(done.tradeId)), 'a finished trade joins nothing at start');
  assert.ok(joins.includes(tradeChannel(live.tradeId)));
  h.trades.get('live').state.phase = 'complete';
  timers[0](); await new Promise(r => setImmediate(r));
  assert.deepEqual(leaves, [tradeChannel(live.tradeId)], 'the trade channel is left; the open offer channel is kept');
  timers[0](); await new Promise(r => setImmediate(r)); assert.equal(leaves.length, 1);
});

test("a published signer stops repeating and leaves the trade channel on the seller's claimed, and still answers the venue", async t => {
  const node = sim.nodes.get('signer1'), pub = sim.log.find(x => x.name === 'signer1' && x.action.type === 'publishShare').action;
  const published = sim.state('signer1'), ch = tradeChannel(published.tradeId), SIGNERS = 'intercom-dex:signers';
  const timers = [], sent = [], leaves = [], records = new Map(), clock = { now: published.now };
  t.mock.method(globalThis, 'setInterval', fn => { timers.push(fn); return timers.length; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const outbox = Object.fromEntries(pub.channels.map(c => [c, [seal({ kind: 'sharePublish', ch: c, body: pub.body }, node.identity.secretKey, { ts: clock.now, nonce: hex() })]]));
  records.set('trade-trade', { key: 'trade', role: 'signer', state: structuredClone(published), lifetimeSec: 172800 + 3600, outbox, raw: [], buffer: [],
    publicationAt: clock.now, publicationDelay: 10 });
  const bridge = new EventEmitter(); bridge.join = async () => {}; bridge.leave = async c => { leaves.push(c); };
  bridge.send = async (c, envelope) => sent.push({ ch: c, envelope });
  const store = { list: p => [...records.keys()].filter(k => k.startsWith(p)), get: k => records.get(k), put: (k, v) => records.set(k, structuredClone(v)) };
  const h = new TradeHost({ bridge, store, identity: { secretKey: node.identity.secretKey, publicKey: encodeKey(node.identity.publicKey) },
    serviceKey: encodeKey(sim.f.service.publicKey), now: () => clock.now });
  await h.start(); t.after(() => h.stop());
  const tr = h.trades.get('trade'), settle = async () => { for (let i = 0; i < 5; i++) { await tr.queue; await new Promise(r => setImmediate(r)); } };
  await settle();
  bridge.emit('message', ch, seal({ kind: 'claimed', ch, body: { tradeId: published.tradeId, claimSignature: 'x'.repeat(88) } }, sim.f.seller.secretKey, { ts: clock.now, nonce: hex() }));
  await settle();
  assert.equal(records.get('trade-trade').sellerClaimed, true, 'kept across a restart');
  sent.length = 0; clock.now += 20; timers[0](); await settle();
  assert.deepEqual(leaves, [ch]);
  assert.equal(sent.filter(x => x.envelope.kind === 'sharePublish').length, 0, 'no more repeats');
  bridge.emit('message', SIGNERS, seal({ kind: 'shareRequest', ch: SIGNERS, body: { tradeId: published.tradeId } }, sim.f.service.secretKey, { ts: clock.now, nonce: hex() }));
  await settle();
  assert.ok(sent.some(x => x.envelope.kind === 'sharePublish' && x.ch === SIGNERS), "the venue's request is answered on the signers channel");
});
