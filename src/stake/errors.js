import { z } from 'zod';
import { formatAmount } from './status.js';

const units = z.string().regex(/^(0|[1-9][0-9]{0,30})$(?![\s\S])/), time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hex = z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/);
export const errorDetails = Object.freeze({
  bond_insufficient: z.object({ need: units, free: units, addReset: units }).strict(),
  bond_in_use: z.object({ freeAt: time.optional(), addReset: units }).strict(),
  bond_pending: z.object({ etaSec: time }).strict(), bond_required: z.object({}).strict(),
  bond_stale: z.object({ retrySec: time }).strict(),
  bond_price_unavailable: z.object({ retrySec: time }).strict(), bond_fee_tnk: z.object({ need: units, have: units }).strict(),
  bond_setup_unavailable: z.object({ retrySec: time }).strict(), bond_cooldown: z.object({ availableAt: time }).strict(),
  bond_reserved: z.object({ reserved: units, tradeIds: z.array(hex).max(8) }).strict(),
  bond_expiring: z.object({ expiresAt: time }).strict(), bond_not_reserved: z.object({}).strict(),
  bond_evidence_pending: z.object({ checkUntil: time }).strict(), update_required: z.object({ minVersion: z.string().regex(/^\d+\.\d+\.\d+$/) }).strict(),
});
const moneySchema = z.array(z.object({ asset: z.enum(['RESET', 'TNK', 'USDC', 'SOL']), amount: units,
  state: z.enum(['none', 'submitted', 'confirmed', 'unknown']), direction: z.enum(['incoming', 'outgoing']),
  tx: z.string().max(128).optional() }).strict()).max(400);
const iso = t => new Date(t * 1000).toISOString();
const describe = {
  bond_insufficient: d => `This sale needs ${formatAmount(d.need, 8)} RESET of free stake; you have ${formatAmount(d.free, 8)}. Add ${formatAmount(d.addReset, 8)} RESET.`,
  bond_in_use: d => `Your stake is backing other sales. Wait${d.freeAt === undefined ? '' : ' until ' + iso(d.freeAt)}${d.addReset === '0' ? '.' : ' or add ' + formatAmount(d.addReset, 8) + ' RESET.'}`,
  bond_pending: d => `Your stake update is still being confirmed. Check again in about ${d.etaSec} seconds.`,
  bond_required: () => 'Add RESET stake before selling.',
  bond_stale: d => `The stake check is out of date. Check again in ${d.retrySec} seconds.`,
  bond_price_unavailable: d => `A usable RESET price is unavailable. Check again in ${d.retrySec} seconds.`,
  bond_fee_tnk: d => `This stake action needs ${formatAmount(d.need, 18)} TNK for fees and reserves; you have ${formatAmount(d.have, 18)}. Add TNK.`,
  bond_setup_unavailable: d => `Stake setup is temporarily unavailable. Check again in ${d.retrySec} seconds.`,
  bond_cooldown: d => `Your withdrawal is waiting until ${iso(d.availableAt)}.`,
  bond_reserved: d => `${formatAmount(d.reserved, 8)} RESET is reserved for these trades. Its return must wait for them to finish.`,
  bond_expiring: d => `This stake expires at ${iso(d.expiresAt)} and cannot cover this sale. Add RESET for new sales.`,
  bond_not_reserved: () => 'The seller’s stake was not reserved. This trade stopped before payment.',
  bond_evidence_pending: d => `Delivery proof is awaiting submission or verification; check again by ${iso(d.checkUntil)}.`,
  update_required: d => `Update to ${d.minVersion} or later to start new trades.`,
};

export function stakeError(code, details, { money = [], pending = false, operationId, tradeId } = {}) {
  if (!Object.hasOwn(errorDetails, code)) throw new Error('Unknown stake error code');
  const d = errorDetails[code].parse(details), legs = moneySchema.parse(money);
  if (operationId !== undefined) hex.parse(operationId); if (tradeId !== undefined) hex.parse(tradeId);
  const moved = legs.filter(l => l.state !== 'none');
  const movement = moved.length ? moved.map(l => `${formatAmount(l.amount, l.asset === 'TNK' ? 18 : l.asset === 'SOL' ? 9 : l.asset === 'USDC' ? 6 : 8)} ${l.asset} ${l.direction}: ${l.state}.`).join(' ') +
    (moved.some(l => l.state === 'unknown') ? ' Transfer confirmation is unknown; money may have moved. Do not repeat this deposit.' : '') :
    'No buyer payment was sent. This request moved no money.';
  if (code === 'bond_not_reserved' && moved.length) throw new Error('A submitted payment is recovery, not a pre-payment refusal');
  const message = describe[code](d) + ' ' + movement;
  return Object.assign(new Error(message), { code, result: { ok: pending, code, error: message, message, details: d, money: legs,
    ...(pending ? { state: 'pending' } : {}), ...(operationId ? { operationId } : {}), ...(tradeId ? { tradeId } : {}) } });
}
