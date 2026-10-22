import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TradeHost, tradeChannel } from '../../../src/roles/host.js';
import { simulation } from '../core/simulation.mjs';
import { seal } from '../../../src/core/envelope.js';
import { encodeKey } from '../../../src/core/keys.js';
import { hex } from '../core/helpers.mjs';

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

test('a signer still waiting for the dealing announces itself again every ten seconds, and only while it waits', async t => {
  const state = sim.snapshots.get('signer1:awaitDeal'), node = sim.nodes.get('signer1');
  const f = await host(t, 'signer', state, node.identity), ch = tradeChannel(state.tradeId);
  const presents = () => f.sent.filter(x => x.envelope.kind === 'present' && x.ch === ch && x.envelope.body.ref === state.tradeId).length;
  await f.tick(0); await f.tick(9); assert.equal(presents(), 0);
  await f.tick(1); assert.equal(presents(), 1);
  await f.tick(5); assert.equal(presents(), 1);
  await f.tick(5); assert.equal(presents(), 2);
  f.tr.state = { ...f.tr.state, phase: 'holding' };
  await f.tick(30); assert.equal(presents(), 2);
});
