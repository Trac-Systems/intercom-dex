import { z } from 'zod';
import { settingsSchema } from './settings.js';
import { calculateFees } from '../solana/escrow.js';

const unit = z.string().regex(/^(0|[1-9][0-9]{0,30})$(?![\s\S])/);
const positive = unit.refine(x => BigInt(x) > 0n);
const priceSchema = z.object({ numerator: positive, denominator: positive }).strict();
const ceil = (a, b) => (a + b - 1n) / b;
const atom = 100000000n;
function price(q) { const p = priceSchema.parse(q); return [BigInt(p.numerator), BigInt(p.denominator)]; }

export function resetForUsd(usd, q) {
  unit.parse(usd); const [n, d] = price(q); return ceil(BigInt(usd) * atom * d, n).toString();
}
export function usdForReset(reset, q, roundUp = false) {
  unit.parse(reset); const [n, d] = price(q), value = BigInt(reset) * n, scale = atom * d;
  return (roundUp ? ceil(value, scale) : value / scale).toString();
}
export function penaltyTarget({ base, baseAmount, quoteAmount, fees }, q, settings) {
  const p = settingsSchema.parse(settings); positive.parse(baseAmount); positive.parse(quoteAmount);
  const paymentBasis = calculateFees(quoteAmount, fees.platformFeeBps, fees.tradeFeeBps).totalAmount.toString();
  const percentageUsd = ceil(BigInt(paymentBasis) * BigInt(p.penaltyBps), 10000n);
  const targetUsd = percentageUsd > BigInt(p.minPenaltyUsd) ? percentageUsd : BigInt(p.minPenaltyUsd);
  const minimum = BigInt(resetForUsd(p.minPenaltyUsd, q));
  let target = base.id === 'RESET' ? ceil(BigInt(baseAmount) * BigInt(p.penaltyBps), 10000n) : BigInt(resetForUsd(targetUsd.toString(), q));
  if (target < minimum) target = minimum;
  return { paymentBasis, targetUsd: usdForReset(target.toString(), q, true), targetReset: target.toString() };
}

// Exact funding amount; denomination budgets are in principal units at the frozen rational price.
export function splitDeposit(amount, q, maxPieces = 100) {
  positive.parse(amount);
  if (!Number.isSafeInteger(maxPieces) || maxPieces < 1 || maxPieces > 100) throw new Error('Invalid piece cap');
  const sizes = ['500000', '5000000', '50000000'].map(u => BigInt(resetForUsd(u, q)));
  let left = BigInt(amount); const pieces = [];
  const take = (size, count, nominalTargetUsd) => {
    for (let i = 0; i < count && left >= size; i++) {
      if (pieces.length === maxPieces) throw new Error('bond_setup_unavailable');
      pieces.push({ principalReset: size.toString(), nominalTargetUsd }); left -= size;
    }
  };
  take(sizes[0], 10, '500000');
  if (sizes[1] !== sizes[0]) take(sizes[1], 10, '5000000');
  for (const i of [2, 1, 0]) {
    if (sizes.indexOf(sizes[i]) !== i) continue;
    take(sizes[i], maxPieces + 1, ['500000', '5000000', '50000000'][i]);
  }
  if (left > 0n) { if (pieces.length === maxPieces) throw new Error('bond_setup_unavailable'); pieces.push({ principalReset: left.toString(), nominalTargetUsd: null }); }
  return pieces;
}

const pieceSchema = z.object({ unitId: z.string().regex(/^[0-9a-f]{64}$/), principalReset: positive,
  expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).passthrough();
const order = (a, b) => a.expiresAt - b.expiresAt || a.unitId.localeCompare(b.unitId);
function preferred(a, b) {
  if (!b || a.length !== b.length) return !b || a.length < b.length;
  for (let i = 0; i < a.length; i++) { const c = order(a[i], b[i]); if (c) return c < 0; }
  return false;
}

// All retained sums are exact. Exhausting the work bound refuses instead of returning a greedy approximation.
export function allocatePieces(inventory, target, { maxPieces = 100, maxStates = 1000000, maxSteps = 10000000 } = {}) {
  positive.parse(target);
  if (!Array.isArray(inventory) || inventory.length > 200 || !Number.isSafeInteger(maxPieces) || maxPieces < 1 || maxPieces > 100 ||
      !Number.isSafeInteger(maxStates) || maxStates < 1 || maxStates > 1000000 || !Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 10000000) throw new Error('Invalid allocation bounds');
  const pieces = inventory.map(p => pieceSchema.parse(p)).sort(order);
  if (new Set(pieces.map(p => p.unitId)).size !== pieces.length) throw new Error('Duplicate stake piece');
  const need = BigInt(target); let best = null, steps = 0;
  const sums = new Map([[0n, []]]);
  for (const piece of pieces) {
    for (const [sum, chosen] of [...sums]) {
      if (++steps > maxSteps) throw new Error('bond_setup_unavailable');
      if (chosen.length === maxPieces) continue;
      const total = sum + BigInt(piece.principalReset), next = [...chosen, piece];
      if (total >= need) {
        if (!best || total < best.total || total === best.total && preferred(next, best.pieces)) best = { total, pieces: next };
      } else if (preferred(next, sums.get(total))) {
        sums.set(total, next);
        if (sums.size > maxStates) throw new Error('bond_setup_unavailable');
      }
    }
  }
  if (!best) return null;
  return { pieces: best.pieces, payoutReset: best.total.toString(), overshootReset: (best.total - need).toString() };
}
