import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TradeHost } from '../../../src/roles/host.js';
import { encodeKey } from '../../../src/core/keys.js';
import { simulation } from '../core/simulation.mjs';

const sim = simulation({ capturePhases: true, pair: 'RESET/USDC' });
const snapshot = phase => structuredClone(sim.snapshots.get(`seller:${phase}`));
const flush = async trade => {
  await new Promise(resolve => setImmediate(resolve));
  await trade.queue;
};

async function restore(t, state, checkEscrow, { sendTransfer = () => new Promise(() => {}) } = {}) {
  const timers = [], sent = [], events = [], logs = [], clock = { now: state.terms.refundAfter };
  t.mock.method(globalThis, 'setInterval', (fn, ms) => { timers.push({ fn, ms }); return timers.length; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  // Serialization drops undefined fields exactly as the existing JSON journal does; no migration is involved.
  const record = JSON.parse(JSON.stringify({ key: 'seller', role: 'seller', state, lifetimeSec: 176400, outbox: {}, raw: [], buffer: [] }));
  const records = new Map([['trade-seller', record]]);
  const store = { list: prefix => [...records.keys()].filter(k => k.startsWith(prefix)),
    get: k => structuredClone(records.get(k)), put: (k, v) => records.set(k, structuredClone(v)) };
  const bridge = new EventEmitter();
  bridge.join = async () => {}; bridge.leave = async () => {}; bridge.send = async (ch, envelope) => sent.push({ ch, envelope });
  const host = new TradeHost({ bridge, store, now: () => clock.now,
    solana: { finalizedSlot: async () => 100, tipSlot: async () => 132, checkEscrow, claim: () => new Promise(() => {}) },
    trac: { sendTransfer }, log: (...args) => logs.push(args),
    identity: { secretKey: sim.f.seller.secretKey, publicKey: encodeKey(sim.f.seller.publicKey) } });
  host.hooks.afterStep.push((_trade, _before, event) => events.push(event));
  t.after(() => host.stop());
  await host.start();
  const trade = host.trades.get('seller');
  await flush(trade);
  const tick = async seconds => { clock.now += seconds; timers.find(t => t.ms === 1000).fn(); await flush(trade); };
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
