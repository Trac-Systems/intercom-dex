import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TradeHost } from '../../../src/roles/host.js';
import { encodeKey } from '../../../src/core/keys.js';
import { simulation } from '../core/simulation.mjs';
import { hex } from '../core/helpers.mjs';
import { DEAD_TRANSFER_GRACE_SEC, DEAD_TRANSFER_REASON } from '../../../src/core/trade-seller.js';
import { accountBalances } from '../../../src/wallets/accounting.js';

const sim = simulation({ capturePhases: true, pair: 'RESET/USDC' });
const snapshot = phase => structuredClone(sim.snapshots.get(`seller:${phase}`));
const flush = async trade => {
  await new Promise(resolve => setImmediate(resolve));
  await trade.queue;
};

async function restore(t, state, checkEscrow, { sendTransfer = () => new Promise(() => {}),
  checkSellerTransfer = () => new Promise(() => {}), claim = () => new Promise(() => {}),
  now = state.terms.refundAfter, extraStates = [] } = {}) {
  const timers = [], sent = [], events = [], logs = [], clock = { now };
  t.mock.method(globalThis, 'setInterval', (fn, ms) => { timers.push({ fn, ms }); return timers.length; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  // Serialization drops undefined fields exactly as the existing JSON journal does; no migration is involved.
  const record = JSON.parse(JSON.stringify({ key: 'seller', role: 'seller', state, lifetimeSec: 176400, outbox: {}, raw: [], buffer: [] }));
  const records = new Map([['trade-seller', record]]);
  extraStates.forEach((state, i) => {
    const key = 'seller' + i;
    records.set('trade-' + key, JSON.parse(JSON.stringify({ ...record, key, state })));
  });
  const store = { list: prefix => [...records.keys()].filter(k => k.startsWith(prefix)),
    get: k => structuredClone(records.get(k)), put: (k, v) => records.set(k, structuredClone(v)) };
  const bridge = new EventEmitter();
  bridge.join = async () => {}; bridge.leave = async () => {}; bridge.send = async (ch, envelope) => sent.push({ ch, envelope });
  const host = new TradeHost({ bridge, store, now: () => clock.now,
    solana: { finalizedSlot: async () => 100, tipSlot: async () => 132, checkEscrow, claim },
    trac: { sendTransfer, checkSellerTransfer }, log: (...args) => logs.push(args),
    identity: { secretKey: sim.f.seller.secretKey, publicKey: encodeKey(sim.f.seller.publicKey) } });
  host.hooks.afterStep.push((_trade, _before, event) => events.push(event));
  t.after(() => host.stop());
  await host.start();
  const trade = host.trades.get('seller');
  const flushAll = async () => { for (const item of host.trades.values()) await flush(item); };
  await flushAll();
  const tick = async seconds => { clock.now += seconds; timers.find(t => t.ms === 1000).fn(); await flushAll(); };
  return { host, trade, tick, clock, records, events, sent, logs };
}

for (const phase of ['awaitShares', 'transferring', 'claiming']) {
  for (const [status, expected] of [['refunded', 'lost'], ['claimed', 'complete']]) {
    test(`restored seller ${phase} becomes ${expected} immediately even with a stalled transfer adapter`, async t => {
      const state = snapshot(phase);
      delete state.transferNoticeAt;
      let reads = 0;
      const f = await restore(t, state, async ({ hashHex, purpose }) => {
        reads++;
        assert.equal(purpose, 'settlement');
        return { ok: true, hashHex, purpose, status };
      });
      assert.equal(reads, 1);
      assert.equal(f.trade.state.phase, expected);
      assert.equal(f.records.get('trade-seller').state.phase, expected);
      assert.equal(f.sent.filter(x => x.envelope.kind === 'transferSent').length, 0);
      await f.tick(120);
      assert.equal(reads, 1, 'terminal sellers stop checking');
    });
  }
}

test('host settlement exceptions preserve purpose, clear pending, and retry after transfer finality', async t => {
  // Only speed up the host's adapter retries, leaving its tick clock under test control.
  t.mock.method(globalThis, 'setTimeout', fn => setImmediate(fn));
  const state = snapshot('awaitShares');
  delete state.transferNoticeAt;
  delete state.transferFinal;
  state.settlementPending = true;
  let reads = 0, failing = true;
  const f = await restore(t, state, async ({ hashHex, purpose }) => {
    reads++;
    if (failing) throw Error('RPC unavailable');
    return { ok: true, hashHex, purpose, status: 'refunded' };
  });
  for (let i = 0; i < 8 && !f.events.some(e => e.type === 'error'); i++) await flush(f.trade);
  assert.equal(reads, 3, 'the original check exhausted its adapter retries');
  const error = f.events.find(e => e.type === 'error');
  assert.equal(error.purpose, 'settlement');
  assert.equal(error.hashHex, state.H);
  assert.equal(f.trade.state.settlementPending, false);
  await f.host.deliver('seller', { type: 'transferSent', tradeId: state.tradeId, ok: true, final: true,
    txHash: state.txHash, sentAt: state.now, finalizedAt: state.now });
  assert.equal(f.trade.state.phase, 'awaitShares');
  failing = false;
  await f.tick(59);
  assert.equal(reads, 3);
  await f.tick(1);
  assert.equal(reads, 4);
  assert.equal(f.trade.state.phase, 'lost');
  assert.equal(f.records.get('trade-seller').state.phase, 'lost');
});

test('five 0.1.44-shaped seller journals close on startup, release holds and never send again across restart', async t => {
  const states = Array.from({ length: 5 }, () => ({ ...snapshot('transferring'), tradeId: hex(), txHash: hex(), transferUnknown: true }));
  const now = states[0].terms.refundAfter + DEAD_TRANSFER_GRACE_SEC;
  let sends = 0, reads = 0, settlements = 0;
  const checkEscrow = async ({ hashHex, purpose }) => {
    settlements++;
    return { ok: true, hashHex, purpose, status: 'active' };
  };
  const options = {
    now, extraStates: states.slice(1),
    sendTransfer: async () => { sends++; throw Error('A closed trade must never send'); },
    checkSellerTransfer: async ({ tradeId, txHash }) => {
      reads++;
      assert.ok(states.some(s => s.tradeId === tradeId && s.txHash === txHash));
      return { ok: false, final: false, txHash, notApplied: true };
    }
  };
  const balance = trades => accountBalances({ balances: { RESET: '100000000000' }, trades,
    registry: () => states[0].registry, now }).RESET;
  assert.notEqual(balance(states.map(state => ({ role: 'seller', state }))).breakdown.trades, '0');
  const f = await restore(t, states[0], checkEscrow, options);
  await f.tick(0);
  assert.equal(reads, 5); assert.equal(settlements, 5); assert.equal(sends, 0);
  assert.equal(balance([...f.host.trades.values()]).breakdown.trades, '0');
  for (const trade of f.host.trades.values()) {
    assert.equal(trade.state.phase, 'aborted'); assert.equal(trade.state.reason, DEAD_TRANSFER_REASON);
    assert.equal(f.records.get('trade-' + trade.key).state.phase, 'aborted');
    await f.host.deliver(trade.key, { type: 'transferSent', ok: false, unknown: true, txHash: trade.state.txHash });
    assert.equal(trade.state.phase, 'aborted');
  }
  await f.tick(86400);
  assert.equal(reads, 5); assert.equal(settlements, 5); assert.equal(sends, 0);
  await f.host.stop();
  const saved = [...f.records.values()].map(r => r.state);
  const restarted = await restore(t, saved[0], checkEscrow, { ...options, extraStates: saved.slice(1) });
  await restarted.tick(60);
  assert.equal(reads, 5); assert.equal(settlements, 5); assert.equal(sends, 0);
  assert.ok([...restarted.host.trades.values()].every(t => t.state.phase === 'aborted'));
});

for (const failure of ['read_failed', 'timeout', 'bridge exception']) {
  test(`resumed seller stays open on ${failure}, retries once a minute, then closes on a fresh negative`, async t => {
    const state = { ...snapshot('transferring'), txHash: hex(), transferUnknown: true };
    let reads = 0, failing = true, sends = 0;
    const f = await restore(t, state, async ({ hashHex, purpose }) => ({ ok: true, hashHex, purpose, status: 'active' }), {
      now: state.terms.refundAfter + DEAD_TRANSFER_GRACE_SEC,
      sendTransfer: async () => { sends++; assert.fail('Recovery must not send'); },
      checkSellerTransfer: async ({ txHash }) => {
        reads++;
        if (failing && failure === 'bridge exception') throw Error('bridge timed out');
        return { ok: false, final: false, txHash, ...(failing ? { reason: failure } : { notApplied: true }) };
      }
    });
    assert.equal(reads, 1); assert.equal(f.trade.state.phase, 'transferring');
    for (let i = 0; i < 59; i++) await f.tick(1);
    assert.equal(reads, 1); assert.equal(f.trade.state.phase, 'transferring');
    await f.tick(1);
    assert.equal(reads, 2); assert.equal(f.trade.state.phase, 'transferring');
    failing = false;
    await f.tick(60);
    assert.equal(reads, 3); assert.equal(f.trade.state.phase, 'aborted');
    await f.tick(600);
    assert.equal(reads, 3); assert.equal(sends, 0);
  });
}

test('resumed claiming seller keeps the existing claim flow without a transfer lookup', async t => {
  const state = snapshot('claiming'); delete state.transferFinal;
  let claims = 0, reads = 0;
  const f = await restore(t, state, async ({ hashHex, purpose }) => ({ ok: true, hashHex, purpose, status: 'active' }), {
    now: state.terms.refundAfter + DEAD_TRANSFER_GRACE_SEC,
    checkSellerTransfer: async ({ txHash, terms }) => {
      reads++;
      return { ok: true, final: true, txHash, amount: terms.baseAmount, finalizedAt: state.now };
    },
    claim: async () => { claims++; return { ok: true, claimSignature: '2'.repeat(88) }; }
  });
  await flush(f.trade);
  assert.equal(reads, 0); assert.equal(claims, 1); assert.equal(f.trade.state.phase, 'complete');
});

for (const [status, expected] of [['claimed', 'complete'], ['refunded', 'lost']]) {
  test(`seller still reconciles ${status} while its close-time transfer lookup is stalled`, async t => {
    const state = { ...snapshot('transferring'), txHash: hex(), transferUnknown: true };
    let reads = 0;
    const f = await restore(t, state, async ({ hashHex, purpose }) => {
      reads++;
      return { ok: true, hashHex, purpose, status: reads === 1 ? 'active' : status };
    }, { now: state.terms.refundAfter + DEAD_TRANSFER_GRACE_SEC });
    assert.equal(f.trade.state.phase, 'transferring');
    await f.tick(60);
    assert.equal(reads, 2); assert.equal(f.trade.state.phase, expected);
  });
}
