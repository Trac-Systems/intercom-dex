import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetForUsd, usdForReset, penaltyTarget, splitDeposit, allocatePieces } from '../../../src/stake/amounts.js';
import { defaultSettings } from '../../../src/stake/settings.js';
const q = { numerator: '20000000', denominator: '1' };
const inventory = amounts => amounts.map((amount, i) => ({ unitId: (i + 1).toString(16).padStart(64, '0'), principalReset: String(amount), expiresAt: 1000 + i }));

test('exact rational prices round only in the specified direction', () => {
  assert.equal(resetForUsd('500000', q), '2500000'); assert.equal(usdForReset('2500000', q), '500000');
  assert.equal(resetForUsd('1', { numerator: '3', denominator: '2' }), '66666667');
  assert.equal(usdForReset('1', q), '0'); assert.equal(usdForReset('1', q, true), '1');
  for (const bad of ['-1', '01', '1.1', '1\n']) assert.throws(() => resetForUsd(bad, q));
  assert.throws(() => resetForUsd('1', { numerator: '0', denominator: '1' }));
});
test('penalty includes separately floored fees and RESET percentage exception', () => {
  const terms = { base: { id: 'TNK' }, baseAmount: '100000000', quoteAmount: '300000000', fees: { platformFeeBps: 10, tradeFeeBps: 50 } };
  assert.deepEqual(penaltyTarget(terms, q, defaultSettings()), { paymentBasis: '301800000', targetUsd: '9054000', targetReset: '45270000' });
  const reset = penaltyTarget({ ...terms, base: { id: 'RESET' } }, q, defaultSettings());
  assert.equal(reset.targetReset, '3000000');
  assert.equal(penaltyTarget({ ...terms, quoteAmount: '1' }, q, defaultSettings()).targetReset, '2500000');
  assert.throws(() => penaltyTarget({ ...terms, baseAmount: '0' }, q, defaultSettings()));
});
test('deposit examples conserve every atom including tiny residuals', () => {
  for (const [amount, count] of [['100000000', 13], ['200000000', 17], ['25000000', 10], ['100000', 1], ['1', 1], ['100000001', 14]]) {
    const pieces = splitDeposit(amount, q); assert.equal(pieces.length, count);
    assert.equal(pieces.reduce((n, p) => n + BigInt(p.principalReset), 0n).toString(), amount);
  }
  assert.equal(splitDeposit('2000000', { numerator: '1000000000', denominator: '1' }).length, 13);
  assert.throws(() => splitDeposit('0', q)); assert.throws(() => splitDeposit('100000000', q, 3), /setup_unavailable/);
});
test('allocator finds least overshoot, then fewest pieces, then expiry and id', () => {
  assert.equal(allocatePieces(inventory([8, 6, 4]), '10').payoutReset, '10');
  assert.equal(allocatePieces(inventory([3, 3, 6]), '6').pieces.length, 1);
  assert.equal(allocatePieces(inventory([6, 6]), '6').pieces[0].expiresAt, 1000);
  assert.equal(allocatePieces(inventory([3, 4]), '8'), null);
  assert.equal(allocatePieces(inventory([6, 4, 11]), '10', { maxPieces: 1 }).payoutReset, '11');
  assert.throws(() => allocatePieces(inventory([1, 2, 4]), '8', { maxStates: 2 }), /setup_unavailable/);
  assert.throws(() => allocatePieces(inventory([1, 2, 4]), '8', { maxSteps: 1 }), /setup_unavailable/);
  assert.throws(() => allocatePieces([inventory([1])[0], inventory([1])[0]], '1'), /Duplicate/);
});
test('allocator matches exhaustive optimum for fragmented small inventories', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const amounts = Array.from({ length: 9 }, (_, i) => (seed * (i + 7) * 13) % 23 + 1), target = seed + 20;
    let best = Infinity, fewest = Infinity;
    for (let mask = 1; mask < 512; mask++) {
      let sum = 0, count = 0; for (let i = 0; i < 9; i++) if (mask & (1 << i)) { sum += amounts[i]; count++; }
      if (sum >= target && (sum < best || sum === best && count < fewest)) { best = sum; fewest = count; }
    }
    const result = allocatePieces(inventory(amounts), String(target));
    if (best === Infinity) assert.equal(result, null);
    else { assert.equal(Number(result.payoutReset), best); assert.equal(result.pieces.length, fewest); }
  }
});
