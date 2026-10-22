import test from 'node:test';
import assert from 'node:assert/strict';
import { MakerFunds } from '../../../src/market/funds.js';

const TNK = { pair: 'TNK/USDC', base: { kind: 'trac-native', id: 'TNK', decimals: 18 }, minBaseAmount: '10000000000000000', status: 'open' };
const RESET = { pair: 'RESET/USDC', base: { kind: 'trac-contract-token', id: 'RESET', decimals: 8 }, minBaseAmount: '10000', status: 'open' };
const FEE = '30000000000000000';
const offer = (side, n) => ({ side, price: '5', maker: { tracAddr: `trac${n}`, solAddr: `sol${n}` } });

function setup() {
  const clock = { t: 1000 }, wallets = new Map(), reads = [];
  const solana = { walletBalances: async a => { reads.push(a); if (!wallets.has(a)) throw new Error('rpc down'); return wallets.get(a); } };
  const trac = { balances: async a => { reads.push(a); if (!wallets.has(a)) throw new Error('peer busy'); return wallets.get(a); } };
  const funds = new MakerFunds({ solana, trac, now: () => clock.t, readsAtOnce: 2 });
  const settle = () => new Promise(r => setImmediate(r));
  return { clock, wallets, reads, funds, settle };
}

test('a maker without the smallest trade is left out once read; unread or unreadable wallets keep the offer', async () => {
  const { wallets, funds, settle } = setup();
  const empty = offer('sell', 1), funded = offer('sell', 2), buyer = offer('buy', 3), poor = offer('buy', 4), unknown = offer('sell', 5);
  wallets.set('trac1', { TNK: '0', RESET: '0', feeTnk: FEE });
  wallets.set('trac2', { TNK: '40000000000000000', RESET: '0', feeTnk: FEE });
  wallets.set('sol3', { SOL: '10000000', USDC: '50000' });
  wallets.set('sol4', { SOL: '2600000', USDC: '50000000' });
  assert.equal(funds.funded(empty, TNK), true, 'not read yet');
  funds.refresh([empty, funded]); funds.refresh([buyer, poor, unknown]); await settle();
  funds.refresh([buyer, poor, unknown]); await settle();
  assert.equal(funds.funded(empty, TNK), false);
  assert.equal(funds.funded(funded, TNK), true, 'min 0.01 TNK plus the 0.03 TNK fee');
  assert.equal(funds.funded(buyer, TNK), true, '0.01 TNK at 5 USDC = 0.05 USDC, and the 0.01 SOL reserve');
  assert.equal(funds.funded(poor, TNK), false, 'USDC but less than 0.01 SOL');
  assert.equal(funds.funded(unknown, TNK), true, 'a failed read hides nothing');
});

test('RESET sellers need the RESET and the TNK fee; funds that arrive bring the offer back after the TTL', async () => {
  const { clock, wallets, funds, settle, reads } = setup();
  const seller = offer('sell', 1);
  wallets.set('trac1', { TNK: '0', RESET: '20000', feeTnk: FEE });
  funds.refresh([seller]); await settle();
  assert.equal(funds.funded(seller, RESET), false, 'RESET but no TNK for the transfer fee');
  wallets.set('trac1', { TNK: FEE, RESET: '20000', feeTnk: FEE });
  funds.refresh([seller]); await settle(); assert.equal(reads.length, 1, 'no re-read inside the TTL');
  clock.t += 300; funds.refresh([seller]); await settle();
  assert.equal(funds.funded(seller, RESET), true);
  funds.forget(new Set()); assert.equal(funds.funded(seller, RESET), true);
});

test('reads run a few at a time and a broken balance or price never throws', async () => {
  const { wallets, funds, reads, settle } = setup();
  for (let i = 0; i < 5; i++) wallets.set(`sol${i}`, { SOL: '0', USDC: '0' });
  funds.refresh([0, 1, 2, 3, 4].map(i => offer('buy', i)));
  assert.equal(reads.length, 2); await settle();
  wallets.set('trac9', { TNK: 'x', RESET: '0', feeTnk: FEE });
  funds.refresh([offer('sell', 9)]); await settle();
  assert.equal(funds.funded(offer('sell', 9), TNK), true);
  assert.equal(funds.funded({ ...offer('buy', 0), price: 'bad' }, TNK), true);
});
