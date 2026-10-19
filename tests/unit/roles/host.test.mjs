import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TradeHost } from '../../../src/roles/host.js';
import { encodeKey } from '../../../src/core/keys.js';
import { seal } from '../../../src/core/envelope.js';
import { simulation } from '../core/simulation.mjs';
import { hex } from '../core/helpers.mjs';

const transcript = simulation({ capturePhases: true });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function hostFixture(t, solana, clock) {
  t.mock.method(performance, 'now', () => clock.ms);
  const timers = [];
  t.mock.method(globalThis, 'setInterval', (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const bridge = new EventEmitter(); bridge.join = async () => {}; bridge.send = async () => {};
  const records = new Map(), store = { list: () => [], get: name => records.get(name), put: (name, value) => records.set(name, structuredClone(value)) };
  const host = new TradeHost({ bridge, store, solana, trac: null, now: () => 106,
    identity: { publicKey: encodeKey(transcript.f.buyer.publicKey), secretKey: transcript.f.buyer.secretKey } });
  t.after(() => host.stop());
  return { host, refresh: () => timers.find(timer => timer.ms === 2000).fn() };
}

test('request at 100.01 and receipt at 106.91 is stale; fresh observations release the buffered reveal', async t => {
  const clock = { ms: 100010 }, finalized = deferred(), tip = deferred();
  const solana = { finalizedSlot: () => finalized.promise, tipSlot: () => tip.promise };
  const { host, refresh } = hostFixture(t, solana, clock);
  const starting = host.start();
  clock.ms = 106910; finalized.resolve(100); tip.resolve(155); await starting;
  assert.equal(host.slotAt, 100010); assert.equal(host.tipAt, 100010);
  const state = structuredClone(transcript.snapshots.get('buyer:awaitReveal'));
  const body = transcript.log.find(x => x.name === 'seller' && x.action.kind === 'reveal').action.body;
  await host.addTrade({ key: state.offerId, role: 'buyer', state, lifetimeSec: 86400 });
  const env = seal({ kind: 'reveal', ch: `intercom-dex:t:${state.offerId}`, body }, transcript.f.seller.secretKey, { ts: 106, nonce: hex() });
  await host.inject(state.offerId, env);
  const trade = host.trades.get(state.offerId);
  assert.equal(trade.state.phase, 'awaitReveal'); assert.equal(trade.buffer.length, 1);
  let event;
  host.hooks.afterStep.push((_trade, _before, received) => { if (received.type === 'message') event = received; });
  solana.finalizedSlot = async () => 100; solana.tipSlot = async () => 155;
  await refresh(); await trade.queue;
  assert.equal(trade.state.phase, 'awaitRandomness'); assert.equal(trade.buffer.length, 0);
  assert.equal(event.finalizedAgeMs, 0); assert.equal(event.tipAgeMs, 0);
});

test('observation dates are monotonic, independent and cannot be replaced by a slower older request', async t => {
  const clock = { ms: 100010 }, solana = { finalizedSlot: async () => 100, tipSlot: async () => 132 };
  const { host, refresh } = hostFixture(t, solana, clock); await host.start();
  const oldFinal = deferred(), oldTip = deferred();
  solana.finalizedSlot = () => oldFinal.promise; solana.tipSlot = () => oldTip.promise;
  clock.ms = 101020; const old = refresh();
  solana.finalizedSlot = async () => 102; solana.tipSlot = async () => 134;
  t.mock.method(Date, 'now', () => -1_000_000); // a wall-clock adjustment cannot rejuvenate an observation
  clock.ms = 102030; await refresh();
  oldFinal.resolve(101); oldTip.resolve(133); await old;
  assert.equal(host.slot, 102); assert.equal(host.tip, 134);
  assert.equal(host.slotAt, 102030); assert.equal(host.tipAt, 102030);
  clock.ms = 103040;
  solana.finalizedSlot = async () => { throw Error('RPC unavailable'); }; solana.tipSlot = async () => 135;
  await refresh();
  assert.equal(host.slotAt, 102030); assert.equal(host.tipAt, 103040);
});

test('deciding-block timeout ticks while the chain request is pending, independently of wall-clock time', async t => {
  const clock = { ms: 100000 }, timers = [];
  t.mock.method(performance, 'now', () => clock.ms);
  t.mock.method(globalThis, 'setInterval', (fn, ms) => { timers.push({ fn, ms }); return timers.length; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const bridge = new EventEmitter(), sent = []; bridge.join = async () => {}; bridge.send = async (_ch, m) => sent.push(m);
  const records = new Map(), store = { list: () => [], get: n => records.get(n), put: (n, v) => records.set(n, structuredClone(v)) };
  const solana = { finalizedSlot: async () => 100, tipSlot: async () => 132, firstFinalizedBlockAtLeast: () => new Promise(() => {}) };
  const host = new TradeHost({ bridge, store, solana, now: () => 100,
    identity: { publicKey: encodeKey(transcript.f.buyer.publicKey), secretKey: transcript.f.buyer.secretKey } });
  t.after(() => host.stop()); await host.start();
  const state = structuredClone(transcript.snapshots.get('buyer:awaitRandomness'));
  await host.addTrade({ key: 'budget', role: 'buyer', state, lifetimeSec: 176400 });
  const tick = timers.find(x => x.ms === 1000).fn;
  tick(); await host.trades.get('budget').queue;
  assert.ok(host.trades.get('budget').busy.has('randomness'));
  clock.ms += 120000; tick(); await host.trades.get('budget').queue;
  assert.equal(host.trades.get('budget').state.phase, 'aborted');
  assert.equal(records.get('trade-budget').state.reason, 'Timed out: deciding block');
  assert.ok(sent.some(m => m.kind === 'abort'));
});

test('host starts the 20 second accept clock only for the maker peer on the offer channel', async t => {
  const clock = { ms: 1000 }, timers = [];
  t.mock.method(performance, 'now', () => clock.ms);
  t.mock.method(globalThis, 'setInterval', (fn, ms) => { timers.push({ fn, ms }); return timers.length; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const bridge = new EventEmitter(), sent = [], queries = [];
  let connected = false;
  bridge.join = async () => {}; bridge.send = async (ch, envelope) => sent.push(envelope);
  bridge.peerPresent = async (ch, key) => { queries.push({ ch, key }); return connected; };
  const store = { list: () => [], put: () => {} };
  const host = new TradeHost({ bridge, store, now: () => 106, identity: { publicKey: encodeKey(transcript.f.buyer.publicKey), secretKey: transcript.f.buyer.secretKey } });
  await host.start(); t.after(() => host.stop());
  const state = structuredClone(transcript.snapshots.get('buyer:awaitAccept')), makerPeer = hex();
  await host.addTrade({ key: 'connecting', role: 'buyer', state, makerPeer, lifetimeSec: 86400 });
  const tick = async () => { timers.find(x => x.ms === 1000).fn(); await new Promise(r => setImmediate(r)); await host.trades.get('connecting').queue; };
  clock.ms = 36000; await tick();
  assert.equal(host.trades.get('connecting').state.phase, 'awaitAccept');
  assert.ok(queries.every(q => q.key === makerPeer && q.ch === 'intercom-dex:t:' + state.offerId));
  connected = true; await tick();
  clock.ms += 19999; await tick(); assert.equal(host.trades.get('connecting').state.phase, 'awaitAccept');
  clock.ms++; await tick(); assert.equal(host.trades.get('connecting').state.phase, 'aborted');
  assert.equal(sent.filter(m => m.kind === 'abort').length, 1);
});

test('a stalled channel join cannot suppress the total 60 second accept budget', async t => {
  const clock = { ms: 0 }, timers = [], joined = deferred();
  t.mock.method(performance, 'now', () => clock.ms);
  t.mock.method(globalThis, 'setInterval', (fn, ms) => { timers.push({ fn, ms }); return timers.length; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const bridge = new EventEmitter(); bridge.join = () => joined.promise; bridge.send = async () => {};
  bridge.peerPresent = async () => false;
  const host = new TradeHost({ bridge, store: { list: () => [], put: () => {} }, now: () => 106,
    identity: { publicKey: encodeKey(transcript.f.buyer.publicKey), secretKey: transcript.f.buyer.secretKey } });
  await host.start(); t.after(() => host.stop());
  const state = structuredClone(transcript.snapshots.get('buyer:awaitAccept'));
  await host.addTrade({ key: 'stalled', role: 'buyer', state, makerPeer: hex(), lifetimeSec: 86400 });
  clock.ms = 60000; timers.find(x => x.ms === 1000).fn();
  await host.trades.get('stalled').queue;
  assert.equal(host.trades.get('stalled').state.phase, 'aborted');
  joined.resolve();
});

test('host restart discards elapsed step time and maker presence, retaining the take envelope nonce', async t => {
  let ms = 500000;
  t.mock.method(performance, 'now', () => ms);
  const state = { ...structuredClone(transcript.snapshots.get('buyer:awaitAccept')), stepElapsedMs: 59999, connectedAtMs: 1, takeNonce: hex() };
  const ch = 'intercom-dex:t:' + state.offerId;
  const take = seal({ kind: 'take', ch, body: state.lastMessages.find(a => a.kind === 'take').body }, transcript.f.buyer.secretKey, { ts: 106, nonce: state.takeNonce });
  const record = { key: 'restart', role: 'buyer', state, lifetimeSec: 86400, outbox: { [ch]: [take] }, raw: [], buffer: [] };
  const records = new Map([['trade-restart', record]]);
  const store = { list: () => [...records.keys()], get: k => structuredClone(records.get(k)), put: (k, v) => records.set(k, structuredClone(v)) };
  const bridge = new EventEmitter(); bridge.join = async () => {}; bridge.send = async () => {};
  const host = new TradeHost({ bridge, store, now: () => 106,
    identity: { publicKey: encodeKey(transcript.f.buyer.publicKey), secretKey: transcript.f.buyer.secretKey } });
  await host.start(); t.after(() => host.stop());
  const trade = host.trades.get('restart'); await trade.queue;
  assert.equal(trade.state.stepElapsedMs, 0); assert.equal(trade.makerConnectedAt, null); assert.equal(trade.state.takeNonce, state.takeNonce);
  ms += 59000; await host.deliver('restart', { type: 'tick' }); assert.equal(trade.state.phase, 'awaitAccept');
  ms += 1000; await host.deliver('restart', { type: 'tick' }); assert.equal(trade.state.phase, 'aborted');
});
