import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Trader, REPORT_POLL_MS, REPORT_SPACING_SEC, REPORT_MAX_AGE_SEC } from '../../../src/roles/trader.js';
import { Service, REPORT_ACK_SEC, REPORT_ACKS_PER_MINUTE } from '../../../src/roles/service.js';
import { encodeKey } from '../../../src/core/keys.js';
import { seal } from '../../../src/core/envelope.js';
import { buildTerms, tradeId } from '../../../src/core/terms.js';
import { selectCommittee } from '../../../src/core/committee.js';
import { fixture, hex, SIG } from '../core/helpers.mjs';

const MAIN = 'intercom-dex', OFFERS = 'intercom-dex:offers';
function memoryStore() {
  const records = new Map();
  return {
    get: name => structuredClone(records.get(name) ?? null),
    put: (name, value) => records.set(name, structuredClone(value)),
    list: (prefix = '') => [...records.keys()].filter(name => name.startsWith(prefix)).sort(),
    delete: name => records.delete(name),
  };
}

class Bridge extends EventEmitter {
  sent = [];
  async join() {}
  async setRelays() {}
  async send(ch, envelope) { this.sent.push({ ch, envelope }); await this.deliver?.(ch, envelope); }
}

function setup(t) {
  const clock = { now: 2_000_000 }, f = fixture();
  t.mock.method(Date, 'now', () => clock.now * 1000);
  t.mock.method(globalThis, 'setInterval', (fn, ms) => ({ fn, ms }));
  t.mock.method(globalThis, 'clearInterval', () => {});
  const identity = raw => ({ publicKey: encodeKey(raw.publicKey), secretKey: encodeKey(raw.secretKey) });
  const body = () => {
    const R = hex(), committee = selectCommittee(f.registry, R, { ...f.registry.params, quoteAmount: f.terms.quoteAmount,
      pair: f.terms.pair, exclude: [f.terms.seller.dexKey, f.terms.buyer.dexKey] }).map(({ dexKey, boxKey }) => ({ dexKey, boxKey }));
    const terms = buildTerms({ ...f.terms, R, committee, sendBy: clock.now + 900, refundAfter: clock.now + 86400 });
    return { offerId: terms.offerId, tradeId: tradeId(terms), terms, hashHex: hex(), txHash: hex() };
  };
  const envelope = (raw, kind, b, ch) => seal({ kind, ch, body: b }, raw.secretKey, { ts: clock.now, nonce: hex() });
  const seller = async (store = memoryStore()) => {
    const bridge = new Bridge(), role = new Trader({ bridge, identity: identity(f.seller), store,
      solana: null, trac: null, me: { ...f.terms.seller, solAddr: f.terms.seller.solRecipient },
      serviceKey: encodeKey(f.service.publicKey), proof: { zkey: '/unused.zkey', pool: 0 }, log: () => {} });
    role.registry.current = f.registry;
    await role.start(); t.after(() => role.stop());
    assert.equal(role.reports.ms, REPORT_POLL_MS);
    const complete = async b => {
      const trade = { key: b.tradeId, role: 'seller', raw: [], outbox: {}, state: { phase: 'complete', mode: 'maker',
        offerId: b.offerId, tradeId: b.tradeId, terms: b.terms, H: b.hashHex, txHash: b.txHash, now: clock.now } };
      role.host.trades.set(trade.key, trade);
      await role.host.hooks.afterStep[0](trade, { phase: 'claiming' });
      return trade;
    };
    return { role, store, bridge, complete, tick: () => role.reports.fn(),
      sent: () => bridge.sent.filter(x => x.envelope.kind === 'settled') };
  };
  const venue = async (store = memoryStore()) => {
    const bridge = new Bridge(), calls = { escrow: 0, transfer: 0 };
    const role = new Service({ bridge, store, identity: identity(f.service), registryInput: f.registry, firstLaunch: true,
      solana: { assertFeeConfig: async () => {}, checkEscrow: async () => { calls.escrow++; return { ok: true, status: 'claimed' }; },
        settlementSignature: async () => ({ status: 'claimed', signature: SIG }) },
      trac: { verifyTransfer: async () => { calls.transfer++; return { ok: true, final: true }; } },
      now: () => clock.now, log: () => {} });
    await role.start(); role.stop();
    return { role, store, bridge, calls,
      report: (b, from = f.seller) => role.host.hooks.unrouted[0](OFFERS, envelope(from, 'settled', b, OFFERS)),
      sent: () => bridge.sent.filter(x => x.envelope.kind === 'tradeLog') };
  };
  return { clock, f, body, envelope, seller, venue };
}

test('duplicate reports re-send the saved tradeLog once per ten minutes, including across a restart', async t => {
  const h = setup(t), v = await h.venue(), b = h.body();
  await v.report(b);
  const original = v.sent()[0].envelope.body, payouts = v.role.payouts;
  await Promise.all(Array.from({ length: 20 }, () => v.report(b)));
  assert.equal(v.sent().length, 2);
  assert.deepEqual(v.sent()[1].envelope.body, original);
  assert.equal(v.calls.escrow, 1); assert.equal(v.calls.transfer, 1);
  assert.deepEqual(v.role.payouts, payouts); assert.equal(v.role.trades.length, 1);
  const restarted = await h.venue(v.store);
  h.clock.now += REPORT_ACK_SEC - 1; await restarted.report(b);
  assert.equal(restarted.sent().length, 0);
  h.clock.now++; await restarted.report(b);
  assert.equal(restarted.sent().length, 1);
  assert.deepEqual(restarted.sent()[0].envelope.body, original);
  assert.equal(restarted.calls.escrow, 0);
});

test('duplicate acknowledgements have a global rolling-minute bound that survives restart', async t => {
  const h = setup(t), v = await h.venue(), reports = Array.from({ length: REPORT_ACKS_PER_MINUTE + 3 }, h.body);
  for (const b of reports) await v.report(b);
  v.bridge.sent.length = 0;
  await Promise.all(reports.map(b => v.report(b)));
  assert.equal(v.sent().length, REPORT_ACKS_PER_MINUTE);
  const restarted = await h.venue(v.store), waiting = reports.slice(REPORT_ACKS_PER_MINUTE);
  h.clock.now += 59;
  for (const b of waiting) await restarted.report(b);
  assert.equal(restarted.sent().length, 0);
  h.clock.now++;
  for (const b of waiting) await restarted.report(b);
  assert.equal(restarted.sent().length, waiting.length);
});

test('failed duplicate acknowledgements consume both limits before the bridge returns', async t => {
  const h = setup(t), v = await h.venue(), reports = Array.from({ length: REPORT_ACKS_PER_MINUTE + 1 }, h.body);
  for (const b of reports) await v.report(b);
  v.bridge.sent.length = 0;
  v.bridge.deliver = async () => { throw Error('Bridge timeout: send'); };
  for (const b of reports.slice(0, REPORT_ACKS_PER_MINUTE)) await assert.rejects(v.report(b), /Bridge timeout/);
  await v.report(reports[0]); await v.report(reports.at(-1));
  assert.equal(v.sent().length, REPORT_ACKS_PER_MINUTE);
  h.clock.now += 60; await assert.rejects(v.report(reports.at(-1)), /Bridge timeout/);
  await v.report(reports[0]);
  assert.equal(v.sent().length, REPORT_ACKS_PER_MINUTE + 1);
});

test('only the authenticated seller can request a logged acknowledgement; pending and rejected stay unchanged', async t => {
  const h = setup(t), v = await h.venue(), b = h.body();
  await v.report(b); v.bridge.sent.length = 0;
  await v.report(b, h.f.buyer);
  await v.report({ ...b, terms: { ...b.terms, R: hex() } });
  assert.equal(v.sent().length, 0);
  for (const status of ['pending', 'rejected']) {
    v.role.settlements.set(b.tradeId, { ...v.role.settlements.get(b.tradeId), status });
    await v.report(b);
    assert.equal(v.sent().length, 0); assert.equal(v.calls.escrow, 1);
    assert.equal(v.role.settlements.get(b.tradeId).status, status);
  }
});

test('seller retry delays are 55 seconds, 2, 4, 8, 16 and then 30 minutes', async t => {
  const h = setup(t), s = await h.seller(), b = h.body();
  await s.complete(b);
  assert.equal(s.sent().length, 0, 'completion only records the report');
  await s.tick();
  const delays = [55, 120, 240, 480, 960, 1800, 1800];
  for (const [i, delay] of delays.entries()) {
    assert.equal(s.store.get(`report-${b.tradeId}`).nextAt, h.clock.now + delay);
    h.clock.now += delay - 1; await s.tick(); assert.equal(s.sent().length, i + 1);
    h.clock.now++; await s.tick(); assert.equal(s.sent().length, i + 2);
  }
});

test('seven-day reports are retained as abandoned and never recreated by completion or restart', async t => {
  const h = setup(t), s = await h.seller(), b = h.body();
  const trade = await s.complete(b), firstAt = h.clock.now;
  h.clock.now += REPORT_MAX_AGE_SEC - 1; await s.tick(); assert.equal(s.sent().length, 1);
  h.clock.now++; await s.tick();
  const saved = s.store.get(`report-${b.tradeId}`);
  assert.equal(saved.abandoned, true); assert.equal(saved.firstAt, firstAt); assert.deepEqual(saved.body, b);
  await s.role.host.hooks.afterStep[0](trade, { phase: 'claiming' });
  h.clock.now += 86400; await s.tick(); assert.equal(s.sent().length, 1);
  s.role.stop();
  const again = await h.seller(s.store);
  await again.complete(b); await again.tick();
  assert.equal(again.sent().length, 0); assert.deepEqual(again.store.get(`report-${b.tradeId}`), saved);
});

test('75 simultaneous completions spread across send slots without starving older reports', async t => {
  const h = setup(t), s = await h.seller(), reports = Array.from({ length: 75 }, h.body);
  await Promise.all(reports.map(s.complete));
  assert.equal(s.sent().length, 0);
  for (let i = 0; i < 75; i++) {
    const before = s.sent().length;
    await Promise.all(Array.from({ length: 10 }, s.tick));
    assert.equal(s.sent().length, before + 1);
    h.clock.now += REPORT_SPACING_SEC - 1; await s.tick(); assert.equal(s.sent().length, before + 1);
    h.clock.now++;
  }
  assert.equal(new Set(s.sent().map(x => x.envelope.body.tradeId)).size, 75);
  const times = s.sent().map(x => x.envelope.ts);
  for (const at of times) assert.ok(times.filter(time => time >= at && time < at + 60).length <= 3);
});

test('slow or failing report sends cannot overlap or reset backoff, including after restart', async t => {
  const h = setup(t), s = await h.seller(), b = h.body();
  await s.complete(b);
  let release;
  s.bridge.deliver = () => new Promise(resolve => { release = resolve; });
  const sending = s.tick();
  h.clock.now += 60; await Promise.all([s.tick(), s.tick()]);
  assert.equal(s.sent().length, 1);
  release(); await sending;
  s.bridge.deliver = async () => { throw Error('Bridge timeout: send'); };
  await s.tick(); assert.equal(s.sent().length, 2);
  const saved = s.store.get(`report-${b.tradeId}`);
  assert.equal(saved.attempts, 2); assert.equal(saved.nextAt, h.clock.now + 120);
  s.role.stop();
  const again = await h.seller(s.store);
  assert.equal(again.sent().length, 0);
  h.clock.now += 119; await again.tick(); assert.equal(again.sent().length, 0);
  h.clock.now++; await again.tick(); assert.equal(again.sent().length, 1);
});

test('restart retains the shared send spacing even when other reports are due', async t => {
  const h = setup(t), s = await h.seller();
  await s.complete(h.body()); await s.complete(h.body()); await s.tick(); s.role.stop();
  const again = await h.seller(s.store);
  assert.equal(again.sent().length, 0);
  h.clock.now += REPORT_SPACING_SEC - 1; await again.tick(); assert.equal(again.sent().length, 0);
  h.clock.now++; await again.tick(); assert.equal(again.sent().length, 1);
});

test('old report journals need no new fields and expired or delivered records never send', async t => {
  const h = setup(t), store = memoryStore(), b = h.body(), expired = h.body();
  store.put(`report-${b.tradeId}`, { body: b, firstAt: h.clock.now - 100, lastSentAt: h.clock.now - 54 });
  store.put(`report-${expired.tradeId}`, { body: expired, firstAt: h.clock.now - REPORT_MAX_AGE_SEC, lastSentAt: h.clock.now - 1800 });
  store.put(`report-${hex()}`, { delivered: true });
  const s = await h.seller(store);
  assert.equal(s.sent().length, 0); assert.equal(store.get(`report-${expired.tradeId}`).abandoned, true);
  h.clock.now++; await s.tick();
  assert.equal(s.sent().length, 1); assert.equal(s.sent()[0].envelope.body.tradeId, b.tradeId);
  assert.equal(store.get(`report-${b.tradeId}`).attempts, 2);
  assert.equal(store.get(`report-${b.tradeId}`).nextAt, h.clock.now + 120);
});

test('startup reconstructs a missing report from an old completed trade without a fresh retry budget', async t => {
  const h = setup(t), store = memoryStore(), b = h.body(), completedAt = h.clock.now - REPORT_MAX_AGE_SEC;
  store.put(`trade-${b.tradeId}`, { key: b.tradeId, role: 'seller', lifetimeSec: 90000, raw: [], outbox: {}, buffer: [],
    state: { role: 'seller', phase: 'complete', mode: 'maker', offerId: b.offerId, tradeId: b.tradeId,
      terms: b.terms, H: b.hashHex, txHash: b.txHash, now: completedAt } });
  const s = await h.seller(store);
  const saved = store.get(`report-${b.tradeId}`);
  assert.equal(saved.firstAt, completedAt); assert.equal(saved.abandoned, true);
  assert.deepEqual(saved.body, b); assert.equal(s.sent().length, 0);
});

test('a seller missing the original broadcast is delivered by the venue resend during its next report', async t => {
  const h = setup(t), v = await h.venue(), s = await h.seller(), b = h.body();
  s.bridge.deliver = (ch, m) => v.role.host.hooks.unrouted[0](ch, m);
  await s.complete(b); await s.tick();
  assert.equal(v.sent().length, 1); assert.ok(!s.store.get(`report-${b.tradeId}`).delivered);
  v.bridge.deliver = (ch, m) => s.role.host.hooks.unrouted[0](ch, m);
  h.clock.now += 55; await s.tick();
  assert.equal(v.sent().length, 2);
  assert.equal(s.store.get(`report-${b.tradeId}`).delivered, true, 'ack arriving during send is not overwritten');
  assert.deepEqual(s.store.get(`report-${b.tradeId}`).body, b);
  h.clock.now += 1800; await s.tick();
  assert.equal(s.sent().length, 2);
  s.role.stop(); const again = await h.seller(s.store);
  assert.equal(again.sent().length, 0);
});

test('abandoned reports still accept a late venue tradeLog', async t => {
  const h = setup(t), v = await h.venue(), s = await h.seller(), b = h.body();
  await s.complete(b); h.clock.now += REPORT_MAX_AGE_SEC; await s.tick();
  assert.equal(s.store.get(`report-${b.tradeId}`).abandoned, true);
  await v.report(b);
  const m = v.sent()[0];
  await s.role.host.hooks.unrouted[0](MAIN, m.envelope);
  assert.equal(s.store.get(`report-${b.tradeId}`).delivered, true);
  assert.equal(s.sent().length, 0);
});
