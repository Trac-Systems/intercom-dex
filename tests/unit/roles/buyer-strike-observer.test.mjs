import test from 'node:test';
import assert from 'node:assert/strict';
import { BuyerStrikeObserver } from '../../../src/roles/buyer-strike-observer.js';
import { BuyerStrikes, STRIKE_READ_TIMEOUT_MS } from '../../../src/roles/signer-strikes.js';
const buyer = { dexKey: 'ab'.repeat(32), tracAddr: 'buyer', solPayer: 'payer' }, seller = { dexKey: 'cd'.repeat(32), tracAddr: 'seller' };
function setup(overrides = {}) {
  const data = new Map(), store = { get: k => structuredClone(data.get(k)), put: (k, v) => data.set(k, structuredClone(v)), list: p => [...data.keys()].filter(k => k.startsWith(p)) };
  const ledger = new BuyerStrikes({ enabled: true, store }), clock = { now: 1 }, saved = [];
  const solana = { walletBalances: async () => ({ USDC: '0', SOL: '0' }), chainTime: async () => clock.now,
    buyerPayment: async () => ({ ok: true, seen: false, chainTime: clock.now }) };
  const trac = { balances: async () => ({ TNK: '1000000', RESET: '1000000', feeTnk: '3' }), gatewayHealth: async () => ({ ok: true, eligible: 3 }) };
  const observer = new BuyerStrikeObserver({ ledger, solana, trac, store, now: () => clock.now, save: t => saved.push(structuredClone(t)),
    proven: () => true, health: () => true, stopped: () => false, ...overrides });
  const trade = key => ({ key, role: 'signer', state: { role: 'signer', tradeId: key, phase: 'awaitDeal', signatures: [buyer.dexKey, seller.dexKey],
    terms: { buyer, seller, base: { id: 'TNK' }, baseAmount: '100', sendBy: 300, graceSec: 30, refundAfter: 1000,
      committee: [{ dexKey: '01' }, { dexKey: '02' }, { dexKey: '03' }], k: 2 } } });
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
  const tick = async (t, now) => { clock.now = now; observer.tick(t); await settle(); };
  const observe = async t => { for (let now = 1; now < 330; now += 15) await tick(t, now); await tick(t, 336); };
  return { observer, ledger, solana, trac, clock, trade, tick, observe, settle, saved, store };
}

test('two signed accepted trades with no deal or payment strike once each; role-independent buyer identity refuses', async () => {
  const f = setup();
  for (const id of ['maker-bid', 'taker-ask']) { const t = f.trade(id); await f.observe(t); await f.tick(t, 351); }
  assert.equal(f.ledger.list(351).strikes.length, 2);
  assert.ok(f.ledger.refusal(buyer, 351));
});

test('a known deal requires k matching acks before the lock start deadline', async () => {
  for (const acknowledgements of [0, 1, 2]) {
    const f = setup(), t = f.trade('deal'); t.state.H = 'hash';
    for (let i = 0; i < acknowledgements; i++) f.observer.evidence(t, { kind: 'ack', from: `0${i + 1}`, ts: 1,
      body: { tradeId: 'deal', H: 'hash', holdUntil: 1000 } });
    await f.observe(t);
    assert.equal(f.ledger.list(336).strikes.length, acknowledgements === 2 ? 1 : 0);
  }
});

test('acceptance and proof are mandatory; seller shortages, venue/signer outages and chain/gateway errors exempt', async () => {
  for (const change of ['unaccepted', 'unproven', 'seller', 'venue', 'rpc', 'solana', 'clock', 'gateway', 'unknown-gateway']) {
    const f = setup(), t = f.trade(change);
    if (change === 'unaccepted') t.state.signatures.pop();
    if (change === 'unproven') f.observer.proven = () => false;
    if (change === 'seller') f.trac.balances = async () => ({ TNK: '0', feeTnk: '3' });
    if (change === 'venue') f.observer.health = () => false;
    if (change === 'rpc') f.solana.walletBalances = async () => { throw Error('read failed'); };
    if (change === 'solana') f.solana.walletBalances = async () => ({ USDC: 'bad', SOL: '0' });
    if (change === 'clock') f.solana.chainTime = async () => -100;
    if (change.includes('gateway')) { t.state.terms.base.id = 'RESET'; f.trac.gatewayHealth = async () => ({ ok: change === 'unknown-gateway' }); }
    await f.observe(t); assert.deepEqual(f.ledger.list(336).strikes, [], change);
  }
});

test('no absence verdict, a read failure, a chain behind the cutoff or any matching payment prevents a strike', async () => {
  for (const result of [null, { ok: false }, { ok: false, reason: 'chain-behind' }, { ok: true, seen: true, chainTime: 336 },
    { ok: true, seen: false, chainTime: 329 }, 'throw']) {
    const f = setup(), t = f.trade('read');
    f.solana.buyerPayment = async () => { if (result === 'throw') throw Error('RPC failed'); return result; };
    await f.observe(t); assert.deepEqual(f.ledger.list(336).strikes, [], JSON.stringify(result));
  }
});

test('offline gaps, restarts, disabled windows and late observers are never struck retrospectively', async () => {
  for (const mode of ['gap', 'restart', 'disabled', 'late']) {
    const f = setup(), t = f.trade(mode);
    if (mode === 'disabled') f.ledger.enabled = false;
    if (mode === 'restart') f.observer.install(t, true);
    if (mode === 'late') { await f.tick(t, 290); await f.tick(t, 336); }
    else if (mode === 'gap') { await f.tick(t, 1); await f.tick(t, 336); }
    else await f.observe(t);
    assert.deepEqual(f.ledger.list(336).strikes, [], mode);
  }
});

test('late payment and authenticated transfer/refund evidence cancel strikes; ordinary nonpayment aborts do not', async () => {
  for (const mode of ['scan', 'transferSent', 'refunded', 'outage', 'insufficient']) {
    const f = setup(), t = f.trade(mode); await f.observe(t);
    assert.equal(f.ledger.list(336).strikes.length, 1);
    if (mode === 'scan') { f.solana.buyerPayment = async () => ({ ok: true, seen: true, chainTime: 351 }); await f.tick(t, 351); }
    else f.observer.evidence(t, { kind: ['outage', 'insufficient'].includes(mode) ? 'abort' : mode,
      from: mode === 'transferSent' ? seller.dexKey : buyer.dexKey, ts: 90,
      body: { tradeId: mode, reason: mode === 'outage' ? 'Signers did not confirm' : 'Insufficient token balance' } });
    assert.equal(f.ledger.list(351).strikes.length, mode === 'insufficient' ? 1 : 0, mode);
  }
});

test('operator clear suppresses pending absence results and never re-records old trades', async () => {
  const f = setup(), t = f.trade('pending'); let release;
  f.solana.buyerPayment = () => new Promise(resolve => { release = resolve; });
  await f.observe(t); assert.ok(release);
  f.observer.clear(buyer, [t]); release({ ok: true, seen: false, chainTime: 336 }); await f.settle();
  await f.tick(t, 351); assert.deepEqual(f.ledger.list(351).strikes, []);
});

test('a chain read hanging across the cutoff times out with an exemption and cannot race a strike', async tctx => {
  tctx.mock.timers.enable({ apis: ['setTimeout'] });
  const f = setup(), t = f.trade('timeout');
  for (let now = 1; now < 321; now += 15) await f.tick(t, now);
  f.solana.walletBalances = () => new Promise(() => {});
  await f.tick(t, 321); await f.tick(t, 336);
  assert.deepEqual(f.ledger.list(336).strikes, []);
  tctx.mock.timers.tick(STRIKE_READ_TIMEOUT_MS); await f.settle();
  assert.equal(t.buyerStrikeExemption.reason, 'infrastructure-read-failed');
});

test('disabling strikes retains completed evidence for inspection and restores no refusal while disabled', async () => {
  const f = setup(), t = f.trade('keep'); await f.observe(t);
  assert.equal(f.ledger.list(336).strikes.length, 1);
  f.ledger.enabled = false; await f.tick(t, 351);
  assert.equal(f.ledger.list(351).strikes.length, 1);
  assert.equal(f.ledger.refusal(buyer, 351), null);
});

test('delayed acks observed only after the lock-start cutoff cannot blame the buyer', async () => {
  const f = setup(), t = f.trade('late-acks'); t.state.H = 'hash';
  f.clock.now = 200;
  for (const from of ['01', '02']) f.observer.evidence(t, { kind: 'ack', from, ts: 1, body: { tradeId: t.state.tradeId, H: 'hash', holdUntil: 1000 } });
  await f.observe(t); assert.deepEqual(f.ledger.list(336).strikes, []);
});
