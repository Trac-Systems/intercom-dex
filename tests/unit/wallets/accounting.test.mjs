import test from 'node:test';
import assert from 'node:assert/strict';
import { amountUnits, withdrawalDestination, validatePayout, accountBalances, MIN_SOL, MIN_TNK, MSB_FEE } from '../../../src/wallets/accounting.js';
import { fixture, SOL, SOL2, BASES } from '../core/helpers.mjs';

const balances = { USDC: '100000000', SOL: '1000000000', TNK: '10000000000000000000', RESET: '10000000000' };
const f = fixture();
const reg = () => f.registry;
const args = patch => ({ balances, registry: reg, now: 1, ...patch });
const terms = { base: BASES.RESET, baseAmount: '100000000', quoteAmount: '1000000', fees: { platformFeeBps: 10, tradeFeeBps: 50 } };
const trade = (role, state = {}) => ({ role, state: { phase: 'awaitAcks', draft: terms, ...state } });
const offer = (side, pair = 'RESET/USDC') => ({ offerId: side, pair, side, price: '1', baseAmount: '200000000', registryVersion: 1, expiresAt: 100 });

test('minimum fees, decimal conversion and destination locks use exact integer amounts and checksums', () => {
  assert.equal(MIN_SOL, '10000000'); assert.equal(MIN_TNK, '60000000000000000'); assert.equal(MSB_FEE, '30000000000000000');
  for (const [asset, value, units] of [['USDC', '1.000001', 1000001n], ['SOL', '0.000000001', 1n], ['TNK', '0.000000000000000001', 1n], ['RESET', '0.00000001', 1n]]) assert.equal(amountUnits(asset, value), units);
  for (const bad of ['0', '-1', '01', '1e3', '1.0000001', ' 1', '1\n', '1.', 'all', '18446744073709551616']) assert.throws(() => amountUnits('USDC', bad));
  assert.throws(() => amountUnits('BTC', '1'));
  assert.equal(withdrawalDestination('USDC', SOL, {}), SOL);
  assert.equal(withdrawalDestination('SOL', undefined, { solana: SOL }), SOL);
  assert.throws(() => withdrawalDestination('USDC', SOL2, { solana: SOL }), /payout lock/);
  const trac = f.terms.seller.tracAddr;
  assert.equal(withdrawalDestination('TNK', trac, {}), trac);
  assert.equal(withdrawalDestination('RESET', undefined, { trac }), trac);
  for (const to of [undefined, '', 'trac1bad', trac.slice(0, -1) + (trac.endsWith('q') ? 'p' : 'q')]) assert.throws(() => withdrawalDestination('TNK', to, {}));
  for (const payout of [null, [], { other: SOL }, { solana: 'bad' }]) assert.throws(() => validatePayout(payout));
});

test('open buys include quote fees; sells reserve base; maker reservations are not counted twice', () => {
  const buy = offer('buy'), sell = offer('sell');
  const rows = accountBalances(args({ offers: [buy, sell] }));
  assert.equal(rows.USDC.breakdown.offers, '2012000'); assert.equal(rows.RESET.breakdown.offers, '200000000');
  const running = trade('seller', { mode: 'maker', offerId: 'sell' });
  const active = accountBalances(args({ offers: [sell], trades: [running] }));
  assert.equal(active.RESET.breakdown.offers, '100000000'); assert.equal(active.RESET.breakdown.trades, '100000000');
  const complete = accountBalances(args({ offers: [sell], trades: [trade('seller', { ...running.state, phase: 'complete' })] }));
  assert.equal(complete.RESET.breakdown.offers, '100000000'); assert.equal(complete.RESET.breakdown.trades, '0');
  const aborted = accountBalances(args({ offers: [sell], trades: [trade('seller', { ...running.state, phase: 'aborted' })] }));
  assert.equal(aborted.RESET.breakdown.offers, '200000000');
  assert.equal(accountBalances(args({ offers: [{ ...sell, expiresAt: 0 }] })).RESET.committed, '0');
  assert.equal(accountBalances(args({ offers: [] })).RESET.committed, '0');
});

test('running trades, unknown locks, confirmed escrow until claim/refund, pending withdrawals and fee reserves', () => {
  const pending = accountBalances(args({ trades: [trade('buyer'), trade('seller')] }));
  assert.equal(pending.USDC.breakdown.trades, '1006000'); assert.equal(pending.RESET.breakdown.trades, '100000000');
  assert.equal(pending.SOL.committed, '20000000'); assert.equal(pending.TNK.committed, '90000000000000000');
  const locked = accountBalances(args({ balances: { ...balances, USDC: '98994000' }, trades: [trade('buyer', { phase: 'locked', locked: true })] }));
  assert.equal(locked.USDC.balance, '100000000'); assert.equal(locked.USDC.committed, '1006000'); assert.equal(locked.USDC.free, '98994000');
  assert.equal(accountBalances(args({ trades: [trade('buyer', { locked: true, lockUnknown: true })] })).USDC.breakdown.escrow, '0');
  for (const phase of ['complete', 'refunded', 'aborted']) assert.equal(accountBalances(args({ trades: [trade('buyer', { phase })] })).USDC.committed, '0');
  const withheld = accountBalances(args({ withdrawals: [{ asset: 'RESET', amount: '99', status: 'unconfirmed' }] }));
  assert.equal(withheld.RESET.committed, '99'); assert.equal(withheld.RESET.free, '9999999901');
  const empty = accountBalances(args({ balances: {}, trader: false })); assert.equal(empty.SOL.free, '0'); assert.equal(empty.TNK.committed, '0');
  const tnk = accountBalances(args({ trades: [trade('seller', { draft: { ...terms, base: BASES.TNK, baseAmount: '1000000000000000000' } })] }));
  assert.equal(tnk.TNK.committed, '1090000000000000000'); assert.equal(tnk.TNK.free, '8910000000000000000');
});
