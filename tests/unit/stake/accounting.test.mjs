import test from 'node:test';
import assert from 'node:assert/strict';
import { stakeWalletHolds, accountStakeBalances } from '../../../src/stake/accounting.js';

test('stake funding holds principal, reserve and every outstanding wallet fee until exact finality', () => {
  const op = { kind: 'deposit', pieces: [{ descriptor: { principalReset: '25000', tnkReserve: '120' }, funding: {} }] };
  assert.deepEqual(stakeWalletHolds(op, '30'), { RESET: '25000', TNK: '180' });
  const balances = Object.fromEntries(['RESET', 'TNK'].map(asset => [asset, { free: '100', committed: '20', breakdown: { fees: '20' } }]));
  const held = accountStakeBalances(balances, op, '30');
  assert.equal(held.RESET.free, '0'); assert.equal(held.TNK.committed, '200'); assert.equal(held.RESET.breakdown.stake, '25000');
  assert.equal(balances.RESET.free, '100');
  op.pieces[0].funding.TNK = 'confirmed';
  assert.deepEqual(stakeWalletHolds(op, '30'), { RESET: '25000', TNK: '30' });
  op.pieces[0].funding.RESET = 'confirmed';
  assert.deepEqual(stakeWalletHolds(op, '30'), { RESET: '0', TNK: '0' });
  assert.deepEqual(stakeWalletHolds({ ...op, kind: 'withdraw' }, '30'), { RESET: '0', TNK: '0' });
});
