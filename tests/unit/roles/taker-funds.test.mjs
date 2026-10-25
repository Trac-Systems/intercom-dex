import test from 'node:test';
import assert from 'node:assert/strict';
import { takerFunded } from '../../../src/roles/taker-funds.js';
import { MIN_SOL } from '../../../src/wallets/accounting.js';
import { fixture } from '../core/helpers.mjs';

test('seller takers need the base amount and a TNK fee, including when the base is TNK', async () => {
  for (const base of ['RESET', 'TNK']) {
    const terms = fixture().terms;
    terms.base.id = base; terms.baseAmount = '100';
    for (const [balance, ok] of [[{ RESET: '100', TNK: '103', feeTnk: '3' }, true],
      [{ RESET: '99', TNK: '102', feeTnk: '3' }, false], [{ RESET: '100', TNK: '2', feeTnk: '3' }, false]]) {
      const trac = { balances: async address => { assert.equal(address, terms.seller.tracAddr); return balance; } };
      assert.equal(await takerFunded({ terms, role: 'seller', trac }), ok);
    }
  }
});

test('buyer takers need USDC including both fees and MIN_SOL at the payer address', async () => {
  const terms = fixture().terms;
  terms.quoteAmount = '1000000'; terms.fees.platformFeeBps = 10; terms.fees.tradeFeeBps = 50;
  for (const [USDC, SOL, ok] of [['1006000', MIN_SOL, true], ['1005999', MIN_SOL, false],
    ['1006000', (BigInt(MIN_SOL) - 1n).toString(), false]]) {
    const solana = { walletBalances: async address => { assert.equal(address, terms.buyer.solPayer); return { USDC, SOL }; } };
    assert.equal(await takerFunded({ terms, role: 'buyer', solana }), ok);
  }
});

test('failed, malformed and hung reads keep admission possible', async () => {
  const terms = fixture().terms;
  for (const balances of [async () => { throw null; }, async () => ({}), async () => ({ TNK: '-1', feeTnk: '0' }), () => new Promise(() => {})]) {
    assert.equal(await takerFunded({ terms, role: 'seller', trac: { balances }, timeoutMs: 5 }), null);
  }
  assert.equal(await takerFunded({ terms, role: 'buyer', solana: { walletBalances: async () => { throw Error('offline'); } } }), null);
});
