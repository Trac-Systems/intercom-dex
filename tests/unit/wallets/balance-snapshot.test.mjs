import test from 'node:test';
import assert from 'node:assert/strict';
import { WalletManager } from '../../../src/wallets/manager.js';
import { accountBalances, accountLockBalances } from '../../../src/wallets/accounting.js';
import { step as stepBuyer } from '../../../src/core/trade-buyer.js';
import { step as stepSeller } from '../../../src/core/trade-seller.js';
import { fixture } from '../core/helpers.mjs';
import { position, party, registry as lockRegistry } from '../locks-products/helpers.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const funds = { SOL: '1000000000', USDC: '100000000', TNK: '10000000000000000000', RESET: '10000000000', feeTnk: '30000000000000000' };

function setup() {
  const f = fixture({ pair: 'RESET/USDC' }), records = new Map();
  const store = { list: prefix => [...records.keys()].filter(k => k.startsWith(prefix)), get: k => structuredClone(records.get(k)),
    put: (k, v) => records.set(k, structuredClone(v)) };
  const role = { mine: new Map(), offers: new Map(), host: { trades: new Map() }, registry: { snapshot: () => f.registry } };
  const manager = new WalletManager({ config: { role: 'trader' }, role, store, addresses: { solana: 'wallet', trac: 'wallet' },
    solana: { walletBalances: async () => ({ SOL: funds.SOL, USDC: funds.USDC }), chainTime: async () => Math.floor(Date.now() / 1000) },
    trac: { balances: async () => ({ TNK: funds.TNK, RESET: funds.RESET, feeTnk: funds.feeTnk }) } });
  const terms = { ...f.terms, baseAmount: '100000000', quoteAmount: '1000000' };
  const offer = { offerId: f.offerId, side: 'sell', pair: 'RESET/USDC', baseAmount: '300000000', price: '1',
    registryVersion: 1, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  const trade = (role = 'seller', state = {}) => ({ role, state: { phase: 'awaitAcks', mode: 'taker', draft: terms, ...state } });
  const account = (state = manager.state(), positionId = null) => {
    let rows = accountBalances({ balances: funds, ...state, feeTnk: funds.feeTnk, registry: role.registry.snapshot });
    if (role.locks) rows = accountLockBalances(rows, state.locks.filter(p => p.positionId !== positionId), role.locks.me.lockKey, funds.feeTnk);
    return rows;
  };
  let reads = 0;
  const duringRead = change => {
    const raw = manager.raw.bind(manager);
    manager.raw = async () => { reads++; const result = await raw(); await turn(); change(reads); return result; };
  };
  return { manager, role, store, terms, offer, trade, account, duringRead, reads: () => reads };
}

test('trade clock ticks and market refreshes leave available funds unchanged during a balance read', async () => {
  const f = setup(), buyer = f.trade('buyer', { now: 100, terms: f.terms, acks: [], stepElapsedMs: 0, stepStage: 'acks' });
  f.role.mine.set(f.offer.offerId, f.offer);
  f.role.host.trades.set('buyer', buyer);
  const expected = f.account();
  f.duringRead(n => {
    const before = buyer.state;
    buyer.state = stepBuyer(before, { type: 'tick', now: before.now + 1, stepElapsedMs: n * 1000 }).state;
    assert.equal(buyer.state.now, before.now + 1);
    assert.equal(buyer.state.stepElapsedMs, n * 1000);
    f.role.offers.set(f.offer.offerId, { offer: f.offer, firstSeen: 100, lastSeen: 100 + n });
  });
  assert.deepEqual(await f.manager.balances(), expected);
  assert.equal(f.reads(), 1);
  await f.manager.requireFunds({ role: 'seller', base: f.terms.base, baseAmount: '1' });
  await f.manager.requireFunds({ role: 'buyer', ...f.terms });
  assert.equal(f.reads(), 3, 'each admission reads once');
});

test('trades waiting for settlement can tick every second without blocking a new offer', async () => {
  for (const role of ['buyer', 'seller']) {
    const f = setup(), trade = f.trade(role, { now: 100, terms: f.terms, shares: [],
      phase: role === 'buyer' ? 'locked' : 'awaitShares', locked: role === 'buyer', escrowOk: true });
    f.role.host.trades.set('waiting', trade);
    const expected = f.account();
    f.duringRead(() => {
      const before = trade.state;
      trade.state = (role === 'buyer' ? stepBuyer : stepSeller)(before, { type: 'tick', now: before.now + 1 }).state;
      assert.equal(trade.state.now, before.now + 1);
      assert.equal(trade.state.phase, before.phase);
    });
    assert.deepEqual(await f.manager.balances(), expected);
    await f.manager.requireFunds({ role: 'seller', base: f.terms.base, baseAmount: '1' });
    assert.equal(f.reads(), 2);
  }
});

test('non-wallet trades and withdrawal or lock progress do not interrupt balance reads', async () => {
  const f = setup(), me = party(), p = position('loan', me, lockRegistry());
  f.role.locks = { me, positions: new Map([[p.positionId, p]]) };
  f.role.host.trades.set('signer', f.trade('signer', { phase: 'holding', now: 100 }));
  f.store.put('withdraw-one', { asset: 'USDC', amount: '30', status: 'unconfirmed' });
  const expected = f.account();
  f.duringRead(n => {
    f.role.host.trades.get('signer').state.now++;
    f.store.put('withdraw-one', { ...f.store.get('withdraw-one'), reason: `Still awaiting confirmation ${n}` });
    p.votes[n] = { counted: n };
  });
  assert.deepEqual(await f.manager.balances(), expected);
  assert.equal(f.reads(), 1);
});

test('reservation increases and decreases retain the larger wallet hold for each asset', async () => {
  const f = setup(), sell = f.trade();
  f.role.mine.set(f.offer.offerId, f.offer);
  f.store.put('withdraw-one', { asset: 'USDC', amount: '7000000', status: 'unconfirmed' });
  const before = f.account();
  f.duringRead(() => {
    f.offer.baseAmount = '500000000';
    f.role.host.trades.set('seller', sell);
    f.store.put('withdraw-one', { asset: 'USDC', amount: '7000000', status: 'confirmed' });
  });
  const result = await f.manager.balances(), after = f.account();
  assert.deepEqual(result.RESET, after.RESET, 'newly reserved base stays held');
  assert.deepEqual(result.USDC, before.USDC, 'a withdrawal completing during the read stays held');
  assert.deepEqual(result.SOL, after.SOL);
  assert.deepEqual(result.TNK, after.TNK);
  assert.equal(f.reads(), 1);
});

test('offer-to-trade handoffs keep one reservation and reservation releases cannot admit reserved funds', async () => {
  for (const phase of ['awaitAcks', 'complete', 'lost']) {
    const f = setup(); f.role.mine.set(f.offer.offerId, f.offer);
    const expected = f.account();
    f.duringRead(() => {
      f.role.mine.delete(f.offer.offerId);
      f.role.host.trades.set('maker', f.trade('seller', { phase, mode: 'maker', offerId: f.offer.offerId,
        terms: { ...f.terms, baseAmount: f.offer.baseAmount } }));
    });
    const row = (await f.manager.balances()).RESET;
    assert.equal(row.free, expected.RESET.free);
    assert.equal(row.committed, expected.RESET.committed);
    assert.equal(f.reads(), 1);
  }
  const f = setup(); f.role.mine.set(f.offer.offerId, f.offer);
  f.duringRead(() => f.role.mine.clear());
  await assert.rejects(f.manager.requireFunds({ role: 'seller', base: f.terms.base, baseAmount: funds.RESET }), /Insufficient free balance/);
});

test('pending buyer locks remain reserved across finality, including in-place state updates', async () => {
  for (const reverse of [false, true]) {
    const f = setup(), buyer = f.trade('buyer', { phase: 'locking', locked: reverse, lockUnknown: !reverse, lockAttempted: true });
    f.role.host.trades.set('buyer', buyer);
    f.duringRead(() => { buyer.state.locked = !reverse; buyer.state.lockUnknown = reverse; });
    const result = await f.manager.balances();
    assert.equal(result.USDC.breakdown.trades, '1006000');
    assert.equal(result.USDC.breakdown.escrow, '0');
    assert.equal(result.USDC.free, '98994000');
    assert.equal(f.reads(), 1);
  }
});

test('lock funding and releases keep pending funds held and respect the excluded position', async () => {
  for (const transition of ['funded', 'released', 'added']) {
    const f = setup(), me = party(), p = position('loan', me, lockRegistry());
    f.role.locks = { me, positions: new Map(transition === 'added' ? [] : [[p.positionId, p]]) };
    const expected = f.account({ ...f.manager.state(), locks: [p] });
    f.duringRead(() => {
      if (transition === 'added') f.role.locks.positions.set(p.positionId, p);
      else if (transition === 'funded') { p.funded = true; p.operations['fund:RESET'] = { status: 'confirmed' }; }
      else p.state = 'released';
    });
    const result = await f.manager.balances();
    assert.deepEqual(result.RESET, expected.RESET);
    assert.deepEqual(result.TNK, expected.TNK);
    assert.equal(f.reads(), 1);
    assert.equal((await f.manager.balances({ positionId: p.positionId })).RESET.free, funds.RESET);
  }
});

test('real chain read errors still fail admission without retries or zero balances', async () => {
  for (const chain of ['solana', 'trac']) {
    const f = setup(); let reads = 0;
    f.manager[chain][chain === 'solana' ? 'walletBalances' : 'balances'] = async () => { reads++; throw Error(`${chain} unavailable`); };
    await assert.rejects(f.manager.requireFunds({ role: 'seller', base: f.terms.base, baseAmount: '1' }), new RegExp(`${chain} unavailable`));
    assert.equal(reads, 1);
  }
});

test('non-wallet trades cannot consume own offers, and foreign lock positions hold no funds', async () => {
  const f = setup(), me = party(), p = position('loan', party(), lockRegistry());
  f.role.mine.set(f.offer.offerId, f.offer);
  const expected = f.account();
  f.role.host.trades.set('signer', f.trade('signer', { mode: 'maker', offerId: f.offer.offerId }));
  f.role.locks = { me, positions: new Map([[p.positionId, p]]) };
  const result = await f.manager.balances();
  assert.equal(result.RESET.free, expected.RESET.free);
  assert.equal(result.RESET.breakdown.offers, f.offer.baseAmount);
  assert.equal(result.RESET.breakdown.locks, '0');
});

test('holds exceeding the wallet still select the larger reservation, using exact integers', async () => {
  const f = setup(), amount = '90071992547409930000';
  f.offer.baseAmount = amount; f.role.mine.set(f.offer.offerId, f.offer);
  f.duringRead(() => { f.offer.baseAmount = (BigInt(amount) - 1n).toString(); });
  const result = await f.manager.balances();
  assert.equal(result.RESET.free, '0');
  assert.equal(result.RESET.committed, amount);
  assert.equal(f.reads(), 1);
});

test('serialized admissions cannot reuse the funds of an earlier admission', async () => {
  const f = setup();
  f.duringRead(() => {});
  const admit = () => f.manager.exclusive(async () => {
    await f.manager.requireFunds({ role: 'seller', base: f.terms.base, baseAmount: funds.RESET });
    f.role.mine.set(f.offer.offerId, { ...f.offer, baseAmount: funds.RESET });
  });
  const results = await Promise.allSettled([admit(), admit()]);
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected']);
  assert.match(results[1].reason.message, /Insufficient free balance/);
  assert.equal(f.reads(), 2);
});
