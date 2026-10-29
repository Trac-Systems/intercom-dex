import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TradeHost } from '../../../src/roles/host.js';
import { Trader } from '../../../src/roles/trader.js';
import { encodeKey } from '../../../src/core/keys.js';
import { stepFinalized } from '../../../src/core/trade-seller.js';
import { claimWarning } from '../../../src/core/claim-warning.js';
import { simulation } from '../core/simulation.mjs';

const sim = simulation({ capturePhases: true, pair: 'RESET/USDC' });
const snapshot = () => structuredClone(sim.snapshots.get('seller:claiming'));
const flush = async trade => { await new Promise(resolve => setImmediate(resolve)); await trade.queue; };

async function fixture(t) {
  const state = snapshot(), clock = { now: state.now }, records = new Map(), logs = [];
  const store = { list: prefix => [...records.keys()].filter(k => k.startsWith(prefix)),
    get: k => structuredClone(records.get(k)), put: (k, v) => records.set(k, structuredClone(v)) };
  const results = { value: { ok: false, reason: 'insufficient funds for rent' }, calls: 0, thrown: null };
  t.mock.method(globalThis, 'setInterval', () => 0); t.mock.method(globalThis, 'clearInterval', () => {});
  const make = () => {
    const bridge = new EventEmitter(); bridge.join = async () => {}; bridge.leave = async () => {}; bridge.send = async () => {};
    const host = new TradeHost({ bridge, store, now: () => clock.now, log: (...args) => logs.push(args.join(' ')),
      identity: { publicKey: encodeKey(sim.f.seller.publicKey), secretKey: sim.f.seller.secretKey },
      solana: { finalizedSlot: async () => 100, tipSlot: async () => 132,
        claim: async () => { results.calls++; if (results.thrown) throw results.thrown; return results.value; } } });
    t.after(() => host.stop()); return host;
  };
  const host = make(); await host.addTrade({ key: 'claim-test', role: 'seller', state, lifetimeSec: 176400 });
  const trade = host.trades.get('claim-test');
  const tick = async (host, seconds) => {
    clock.now += seconds; await host.deliver('claim-test', { type: 'tick' }); await flush(host.trades.get('claim-test'));
  };
  return { host, trade, records, logs, clock, results, make, tick };
}

test('failed claims persist, surface in status, log once per distinct reason across restart, retry, and clear on success', async t => {
  const f = await fixture(t);
  await f.host.deliver('claim-test', { type: 'resume' }); await flush(f.trade);
  assert.equal(f.trade.state.phase, 'claiming');
  assert.equal(f.trade.state.claimFailure.reason, f.results.value.reason);
  assert.deepEqual(f.records.get('trade-claim-test').state.claimFailure, f.trade.state.claimFailure);
  // Exercise the real status serializer with the host under test.
  const statusRole = { host: f.host, pruneOffers() {}, registry: {}, onlineSigners: () => [], certificates: { available: () => [] },
    offers: new Map(), mine: new Map(), book: new Map(), tickers: new Map(), readChat: () => [], network: { status: () => ({ reconnecting: false }) } };
  const warning = Trader.prototype.status.call(statusRole).trades[0].warning;
  assert.match(warning, /insufficient funds for rent/); assert.ok(warning.includes(f.trade.state.terms.seller.solRecipient));
  assert.match(warning, /SOL.*rent.*retries automatically/);
  await f.tick(f.host, 14); assert.equal(f.results.calls, 1);
  await f.tick(f.host, 1); assert.equal(f.results.calls, 2);
  assert.equal(f.logs.filter(x => x.startsWith('claim warning')).length, 1);
  f.results.value = { ok: false, reason: 'USDC account missing', unknown: true };
  await f.tick(f.host, 15);
  assert.equal(f.trade.state.claimFailure.reason, 'USDC account missing');
  f.results.value = { ok: false, reason: 'insufficient funds for rent' };
  await f.tick(f.host, 15);
  assert.equal(f.logs.filter(x => x.startsWith('claim warning')).length, 2);
  f.host.stop(); const restored = f.make(); await restored.start();
  const trade = restored.trades.get('claim-test'); await flush(trade);
  assert.equal(f.logs.filter(x => x.startsWith('claim warning')).length, 2);
  f.results.value = { ok: true, claimSignature: '3'.repeat(88) };
  await f.tick(restored, 15);
  assert.equal(trade.state.phase, 'complete'); assert.equal(trade.state.claimFailure, undefined);
  assert.equal(f.records.get('trade-claim-test').state.claimFailure, undefined);
  assert.equal(Trader.prototype.status.call({ ...statusRole, host: restored }).trades[0].warning, null);
});

test('thrown claim failures and missing reasons are warnings, with no repetitive background retry log', async t => {
  const f = await fixture(t); f.results.thrown = Error('RPC offline');
  await f.host.deliver('claim-test', { type: 'resume' }); await flush(f.trade);
  await f.tick(f.host, 15);
  assert.equal(f.trade.state.claimFailure.reason, 'RPC offline');
  assert.equal(f.logs.filter(x => x.startsWith('claim warning')).length, 1);
  assert.equal(f.logs.filter(x => x.startsWith('retry claim')).length, 0);
  f.results.thrown = null; f.results.value = undefined;
  await f.tick(f.host, 15);
  assert.equal(f.trade.state.claimFailure.reason, 'No reason returned by Solana');
});

test('settlement reconciliation clears a claim warning on success, while refund keeps a useful failure reason', () => {
  for (const status of ['claimed', 'refunded']) {
    const state = snapshot(); state.settlementPending = true;
    state.claimFailure = { reason: 'RPC offline', at: state.now };
    const next = stepFinalized(state, { type: 'escrowChecked', now: state.now + 1, tradeId: state.tradeId,
      hashHex: state.H, purpose: 'settlement', ok: true, status }).state;
    if (status === 'claimed') { assert.equal(next.phase, 'complete'); assert.equal(next.claimFailure, undefined); }
    else { assert.equal(next.phase, 'lost'); assert.match(claimWarning(next), /RPC offline.*cannot be retried/); }
  }
});
