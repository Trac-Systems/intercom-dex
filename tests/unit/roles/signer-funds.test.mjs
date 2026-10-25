import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TradeHost } from '../../../src/roles/host.js';
import { sellerFunds } from '../../../src/roles/signer-funds.js';
import { encodeKey } from '../../../src/core/keys.js';
import { simulation } from '../core/simulation.mjs';
import { hex } from '../core/helpers.mjs';

const sim = simulation({ holdSellerFunds: true });
function state({ base = 'RESET', amount = '100', seller, phase = 'checkingSellerFunds', feeTnk = '3' } = {}) {
  const s = structuredClone(sim.state('signer1'));
  s.tradeId = hex(); s.phase = phase; s.terms.base.id = base; s.terms.baseAmount = amount;
  if (seller) s.terms.seller.tracAddr = seller;
  if (phase === 'holding') s.sellerFundsReservation = { feeTnk };
  return s;
}
function store() {
  const records = new Map();
  return { records, put: (k, v) => records.set(k, structuredClone(v)), get: k => structuredClone(records.get(k)),
    list: prefix => [...records.keys()].filter(k => k.startsWith(prefix)) };
}
const record = (key, state) => ({ key, state, role: 'signer', lifetimeSec: 90000, outbox: {}, raw: [], buffer: [] });
const enough = { RESET: '200', TNK: '6', feeTnk: '3' };

test('base and TNK fee reservations apply across assets and identities sharing one seller address', () => {
  const disk = store(), s = state(), held = state({ phase: 'holding' });
  held.terms.seller.dexKey = hex();
  disk.put('trade-held', record('held', held));
  let r = sellerFunds({ state: s, balances: enough, store: disk, now: 101 });
  assert.equal(r.ok, true); assert.deepEqual(r.reserved, { RESET: '100', TNK: '3' });
  r = sellerFunds({ state: s, balances: { ...enough, RESET: '199' }, store: disk, now: 101 });
  assert.equal(r.ok, false); assert.equal(r.available.RESET, '99');
  assert.equal(sellerFunds({ state: s, balances: { ...enough, TNK: '5' }, store: disk, now: 101 }).ok, false);
  const tnk = state({ base: 'TNK', amount: '2' });
  r = sellerFunds({ state: tnk, balances: { ...enough, TNK: '8' }, store: disk, now: 101 });
  assert.equal(r.ok, true); assert.deepEqual(r.needed, { TNK: '5' }); assert.equal(r.reserved.TNK, '3');
  disk.put('trade-tnk', record('tnk', state({ base: 'TNK', amount: '2', phase: 'holding' })));
  assert.equal(sellerFunds({ state: s, balances: { ...enough, TNK: '10' }, store: disk, now: 101 }).ok, false);
});

test('reservations release at transferSent or sendBy plus grace, and old ack records still count', () => {
  const disk = store(), s = state(), held = state({ phase: 'holding' });
  delete held.sellerFundsReservation;
  const check = now => sellerFunds({ state: s, balances: { RESET: '100', TNK: '3', feeTnk: '3' }, store: disk, now });
  disk.put('trade-held', record('held', held));
  assert.equal(check(101).ok, false);
  assert.equal(check(held.terms.sendBy + held.terms.graceSec - 1).ok, false);
  assert.equal(check(held.terms.sendBy + held.terms.graceSec).ok, true);
  for (const phase of ['verifyingTransfer', 'persistingTransfer', 'published']) {
    disk.put('trade-held', record('held', { ...held, phase, txHash: hex() }));
    assert.equal(check(101).ok, true);
  }
  disk.put('trade-held', record('held', { ...held, terms: { ...held.terms, seller: { ...held.terms.seller, tracAddr: 'other seller' } } }));
  assert.equal(check(101).ok, true);
});

function setup(t, { disk = store(), balances = async () => enough } = {}) {
  const bridge = new EventEmitter(), sent = [], logs = [], clock = { now: 101 };
  bridge.join = bridge.leave = async () => {};
  bridge.send = async (ch, envelope) => { sent.push(envelope); };
  const host = new TradeHost({ bridge, store: disk, identity: { publicKey: encodeKey(sim.nodes.get('signer1').identity.publicKey),
    secretKey: sim.nodes.get('signer1').identity.secretKey }, trac: { balances }, now: () => clock.now, tickMs: 100000,
    log: (...args) => logs.push(args.join(' ')) });
  t.after(() => host.stop());
  return { host, sent, logs, disk, clock };
}
async function flush(host) {
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setImmediate(r));
    await Promise.all([...host.trades.values()].map(t => t.queue));
  }
}

test('simultaneous reads reserve durably before ack: only funded concurrent trades pass', async t => {
  const reads = [], f = setup(t, { balances: address => new Promise(resolve => reads.push({ address, resolve })) });
  const states = [state(), state(), state()];
  for (let i = 0; i < states.length; i++) await f.host.addTrade(record('t' + i, states[i]));
  await Promise.all(states.map((_, i) => f.host.deliver('t' + i, { type: 'resume' })));
  assert.equal(reads.length, 3);
  for (const read of reads) { assert.equal(read.address, states[0].terms.seller.tracAddr); read.resolve(enough); }
  await flush(f.host);
  assert.equal(f.sent.filter(m => m.kind === 'ack').length, 2);
  assert.equal(f.disk.get('trade-t2').state.phase, 'checkingSellerFunds');
  assert.deepEqual(f.disk.get('trade-t0').state.sellerFundsReservation, { feeTnk: '3' });
  assert.ok(f.logs.some(l => l.includes('seller funds refused') && l.includes('needed=') && l.includes('available=') && l.includes('reserved=')));
});

test('restart mid-check sees a later stored holding trade before that trade is installed', async t => {
  const disk = store(), waiting = state(), held = state({ phase: 'holding' });
  disk.put('trade-waiting', record('waiting', waiting)); disk.put('trade-held', record('held', held));
  const f = setup(t, { disk, balances: async () => ({ RESET: '100', TNK: '3', feeTnk: '3' }) });
  await f.host.start(); await flush(f.host);
  assert.equal(f.host.trades.get('waiting').state.phase, 'checkingSellerFunds');
  assert.ok(!f.sent.some(m => m.kind === 'ack' && m.body.tradeId === waiting.tradeId));
  assert.ok(f.logs.some(l => l.includes('reserved={"RESET":"100","TNK":"3"}')));
});

test('read failure fails closed while other sellers proceed; a later top-up passes', async t => {
  let failing = true;
  const s = state(), other = state({ seller: 'other seller' });
  const f = setup(t, { balances: async address => {
    if (address === s.terms.seller.tracAddr && failing) throw new Error('read unavailable');
    return enough;
  } });
  for (const [key, v] of [['failed', s], ['other', other]]) { await f.host.addTrade(record(key, v)); await f.host.deliver(key, { type: 'resume' }); }
  await flush(f.host);
  assert.equal(f.host.trades.get('failed').state.phase, 'checkingSellerFunds');
  assert.equal(f.host.trades.get('other').state.phase, 'holding');
  assert.ok(f.logs.some(l => l.includes('seller funds read failed') && l.includes(s.tradeId) && l.includes(s.terms.seller.tracAddr)));
  failing = false; f.clock.now += 10;
  await f.host.deliver('failed', { type: 'tick' }); await flush(f.host);
  assert.equal(f.host.trades.get('failed').state.phase, 'holding');
});

test('a slow read does not block another seller, and its eventual success cannot ack after the deadline', async t => {
  const s = state(), other = state({ seller: 'other seller' });
  let resolveSlow;
  const f = setup(t, { balances: address => address === s.terms.seller.tracAddr
    ? new Promise(resolve => { resolveSlow = resolve; }) : Promise.resolve(enough) });
  for (const [key, v] of [['slow', s], ['other', other]]) { await f.host.addTrade(record(key, v)); await f.host.deliver(key, { type: 'resume' }); }
  await flush(f.host);
  assert.equal(f.host.trades.get('other').state.phase, 'holding');
  f.clock.now = s.sellerFundsDeadline;
  await f.host.deliver('slow', { type: 'tick' });
  resolveSlow(enough); await flush(f.host);
  assert.equal(f.host.trades.get('slow').state.phase, 'aborted');
  assert.ok(!f.sent.some(m => m.kind === 'ack' && m.body.tradeId === s.tradeId));
});

test('non-Error adapter rejections also fail closed and leave the trade retryable', async t => {
  for (const rejection of [null, 'connection lost']) {
    const f = setup(t, { balances: async () => { throw rejection; } });
    await f.host.addTrade(record('one', state())); await f.host.deliver('one', { type: 'resume' }); await flush(f.host);
    assert.equal(f.host.trades.get('one').state.phase, 'checkingSellerFunds');
    assert.ok(!f.sent.some(m => m.kind === 'ack'));
    assert.ok(f.logs.some(l => l.includes('seller funds read failed')));
  }
});

test('restart after an ack preserves the reservation and repeats the promise without a new balance read', async t => {
  const disk = store(), s = state();
  const first = setup(t, { disk });
  await first.host.addTrade(record('one', s)); await first.host.deliver('one', { type: 'resume' }); await flush(first.host);
  first.host.stop();
  const restarted = setup(t, { disk, balances: () => { assert.fail('a committed trade must not recheck funds'); } });
  await restarted.host.start(); await flush(restarted.host);
  assert.equal(restarted.host.trades.get('one').state.phase, 'holding');
  assert.equal(restarted.sent.filter(m => m.kind === 'ack').length, 1);
  assert.deepEqual(disk.get('trade-one').state.sellerFundsReservation, { feeTnk: '3' });
});

test('failed reservation save sends no ack and recovers on the next funds tick', async t => {
  const f = setup(t), s = state(), put = f.disk.put;
  let fail = true;
  f.disk.put = (key, value) => {
    if (value.state?.phase === 'holding' && fail) throw new Error('disk full');
    return put(key, value);
  };
  await f.host.addTrade(record('one', s)); await f.host.deliver('one', { type: 'resume' }); await flush(f.host);
  assert.equal(f.host.trades.get('one').state.phase, 'checkingSellerFunds');
  assert.ok(!f.sent.some(m => m.kind === 'ack'));
  fail = false; f.clock.now += 10;
  await f.host.deliver('one', { type: 'tick' }); await flush(f.host);
  assert.equal(f.host.trades.get('one').state.phase, 'holding');
  assert.equal(f.sent.filter(m => m.kind === 'ack').length, 1);
});

test('invalid balance data or unreadable reservation records cannot authorize an ack', () => {
  const s = state(), disk = store();
  for (const balances of [null, {}, { ...enough, TNK: '-1' }, { ...enough, feeTnk: 3 }]) {
    assert.throws(() => sellerFunds({ state: s, balances, store: disk, now: 101 }));
  }
  disk.put('trade-held', record('held', state({ phase: 'holding', feeTnk: '-1' })));
  assert.throws(() => sellerFunds({ state: s, balances: enough, store: disk, now: 101 }));
});
