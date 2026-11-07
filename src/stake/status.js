import { z } from 'zod';
import { settingsSchema } from './settings.js';

export const DELIVERY_STATES = Object.freeze(['delivery_sending', 'delivery_failed', 'delivery_overdue', 'delivery_confirming', 'delivered', 'penalty_paid']);
export const DELIVERY_REASONS = Object.freeze(['coin_short', 'tnk_short', 'gateway_paused', 'offline', 'send_failed', 'confirmation_pending']);
export const STAKE_REASONS = Object.freeze(['price_unavailable', 'over_cap', 'tnk_short']);
// An app without a sell offer renews its certified price and reward status once a minute. Status keeps showing the
// last reading for three rounds so it does not blink out between two renewals; bonds still need a fresh price.
export const STAKE_SHOWN_SEC = 180;
const deliveryMessages = {
  coin_short: 'The wallet does not have enough of the sold coin to deliver',
  tnk_short: 'The wallet needs more TNK to pay the delivery fee',
  gateway_paused: 'The transfer gateway is unavailable',
  offline: 'The app is offline',
  send_failed: 'The transfer could not be sent',
  confirmation_pending: 'The transfer is awaiting final confirmation',
};
const units = z.string().regex(/^(0|[1-9][0-9]{0,30})$(?![\s\S])/);
const payoutSchema = z.object({ amount: units, tx: z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/),
  link: z.string().url().refine(url => { const u = new URL(url); return u.protocol === 'https:' && !u.username && !u.password; }).optional(),
  at: z.string().datetime(), atUnix: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() }).strict();
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,22})(\.[0-9]{1,8})?$(?![\s\S])/).refine(x => /[1-9]/.test(x), 'Amount must be positive');
export const stakeRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('deposit'), amount: decimal }).strict(),
  z.object({ action: z.literal('withdraw'), amount: z.union([decimal, z.literal('all')]).optional() }).strict(),
  z.object({ action: z.literal('status') }).strict(),
]);
export const rewardsRequestSchema = z.object({ action: z.literal('status') }).strict();
export const retryDeliverySchema = z.object({ tradeId: z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/) }).strict();

export function formatAmount(value, decimals) {
  units.parse(value);
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('Invalid decimals');
  if (decimals === 0) return value;
  const text = value.padStart(decimals + 1, '0'), fraction = text.slice(-decimals).replace(/0+$/, '');
  return text.slice(0, -decimals) + (fraction ? '.' + fraction : '');
}
const formatted = (obj, fields, decimals) => Object.fromEntries(fields.map(k => [k, obj[k] == null ? null : formatAmount(obj[k], decimals)]));
const ceil = (n, d) => (n + d - 1n) / d;

export function stakeStatus({ pieces = [], pending = '0', openOffersUsd = '0', coverageUsd = null, settings = null, price = null, reason } = {}) {
  units.parse(pending); units.parse(openOffersUsd);
  if (reason !== undefined && !STAKE_REASONS.includes(reason)) throw new Error('Invalid stake status reason');
  const policy = settings && settingsSchema.parse(settings);
  let free = 0n, reserved = 0n, withdrawing = 0n, locked = 0n;
  for (const p of pieces) {
    const amount = BigInt(units.parse(p.returnReset ?? p.descriptor.principalReset));
    if (p.state === 'retired') continue;
    locked += amount;
    if (p.state === 'free') free += amount;
    if (['reserved', 'evidence-pending'].includes(p.state)) reserved += amount;
    if (['withdrawing', 'decided-seller', 'funding-return'].includes(p.state)) withdrawing += amount;
  }
  if (coverageUsd !== null) units.parse(coverageUsd);
  let priceUsd = null;
  if (price && /^[1-9][0-9]*$/.test(price.numerator) && /^[1-9][0-9]*$/.test(price.denominator)) {
    const value = BigInt(price.numerator) * 1000000n / BigInt(price.denominator);
    if (value > 0n) priceUsd = formatAmount(value.toString(), 12);
  }
  if (!reason && policy) {
    if (!priceUsd) reason = 'price_unavailable';
    else if (ceil(locked * BigInt(price.numerator), 100000000n * BigInt(price.denominator)) > BigInt(policy.stake.maxUsdPerAddress)) reason = 'over_cap';
  }
  const maturity = pieces.filter(p => ['withdrawing', 'decided-seller'].includes(p.state)).map(p => p.availableAt);
  const withdrawingUntil = maturity.length && maturity.every(Number.isSafeInteger) ? Math.max(...maturity) : null;
  const result = { withdrawDelaySec: policy?.stake.withdrawDelaySec ?? null, withdrawingUntil, penaltyBps: policy?.penaltyBps ?? null,
    minPenaltyUsd: policy?.minPenaltyUsd ?? null, priceUsd, locked: locked.toString(), reserved: reserved.toString(), free: free.toString(), withdrawing: withdrawing.toString(), pending,
    coverageUsd, openOffersUsd, suggestedUsd: policy ? ceil(BigInt(openOffersUsd) * BigInt(policy.penaltyBps) * BigInt(policy.stake.suggestBufferBps), 100000000n).toString() : null,
    capUsd: policy?.stake.maxUsdPerAddress ?? null,
    state: withdrawing > 0n ? 'withdrawing' : locked > 0n ? 'active' : BigInt(pending) > 0n ? 'pending' : 'none', ...(reason ? { reason } : {}) };
  return { ...result, formatted: { ...formatted(result, ['locked', 'reserved', 'free', 'withdrawing', 'pending'], 8),
    ...formatted(result, ['coverageUsd', 'openOffersUsd', 'suggestedUsd', 'capUsd'], 6) } };
}

export function withdrawalStatus(operation, pieces) {
  if (operation?.kind !== 'withdraw' || !operation.targets) return null;
  let deferred = 0n, withdrawing = 0n, returned = 0n, forfeited = 0n;
  for (const target of operation.targets) {
    const amount = BigInt(target.amount);
    if (target.forfeited) forfeited += amount;
    else if (target.done) returned += amount;
    else if (pieces.find(p => p.unitId === target.unitId)?.state === 'reserved') deferred += amount;
    else withdrawing += amount;
  }
  const result = { operationId: operation.operationId, requested: operation.amount, pending: !operation.done,
    deferred: deferred.toString(), withdrawing: withdrawing.toString(), returned: returned.toString(), forfeited: forfeited.toString() };
  return { ...result, formatted: formatted(result, ['deferred', 'withdrawing', 'returned', 'forfeited'], 8) };
}

export function rewardsStatus({ unpaid = '0', paidTotal = '0', lastPayout, weight = 'none', ratePerDay = '0',
  poolState = 'unknown', poolBalance = null, dailyBudget = null, activeWeightBps = null, forfeited } = {}) {
  for (const value of [unpaid, paidTotal, ratePerDay, poolBalance, dailyBudget, forfeited].filter(v => v != null)) units.parse(value);
  if (!['active', 'idle', 'none'].includes(weight) || !['active', 'empty', 'unknown'].includes(poolState)) throw new Error('Invalid rewards status');
  let payout;
  if (lastPayout !== undefined) {
    const { formatted: _formatted, ...publicPayout } = lastPayout;
    const p = payoutSchema.parse(publicPayout), atUnix = Date.parse(p.at) / 1000;
    if (!Number.isSafeInteger(atUnix) || atUnix < 0 || p.atUnix !== undefined && p.atUnix !== atUnix) throw new Error('Payout clocks disagree');
    payout = { ...p, atUnix, formatted: { amount: formatAmount(p.amount, 8) } };
  }
  if (activeWeightBps !== null && (!Number.isSafeInteger(activeWeightBps) || activeWeightBps < 10000 || activeWeightBps > 50000)) throw new Error('Invalid active reward weight');
  const result = { activeWeightBps, unpaid, paidTotal, ...(payout ? { lastPayout: payout } : {}), weight, ratePerDay, poolState, poolBalance, dailyBudget,
    ...(forfeited !== undefined ? { forfeited } : {}) };
  return { ...result, formatted: formatted(result, ['unpaid', 'paidTotal', 'ratePerDay', 'poolBalance', 'dailyBudget', ...(forfeited !== undefined ? ['forfeited'] : [])], 8) };
}

export function deliveryStatus(trade, now) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid delivery clock');
  const s = trade.state, terms = s?.terms;
  if (!terms || !Number.isSafeInteger(terms.sendBy) || !s.tradeId) return null;
  // Negotiation and unfunded buyer attempts carry no delivery obligation.
  if (!s.escrowOk && !s.locked && !s.lockAttempted && !s.transferStartedAt && !s.txHash && !['awaitShares', 'claiming', 'complete'].includes(s.phase)) return null;
  const bond = terms.bond;
  const deadlineUnix = terms.sendBy + (bond?.overdueDelaySec ?? 0);
  const atRiskReset = bond?.payoutReset ?? '0', atRiskUsd = bond?.payoutUsd ?? '0';
  units.parse(atRiskReset); units.parse(atRiskUsd);
  let state, reason;
  if (s.penaltyPaid === true) state = 'penalty_paid';
  else if (s.transferFinal === true || s.finalizedAt != null || ['claiming', 'complete'].includes(s.phase)) state = 'delivered';
  else if (now >= deadlineUnix) state = 'delivery_overdue';
  else if (s.txHash || s.transferUnknown) { state = 'delivery_confirming'; reason = 'confirmation_pending'; }
  else if (s.gatewayPaused || s.deliveryFailure) { state = 'delivery_failed'; reason = s.gatewayPaused ? 'gateway_paused' :
    s.deliveryFailure === 'gateway_unavailable' ? 'gateway_paused' : DELIVERY_REASONS.includes(s.deliveryFailure) ? s.deliveryFailure : 'send_failed'; }
  else state = 'delivery_sending';
  return { state, ...(reason ? { reason } : {}), deadline: new Date(deadlineUnix * 1000).toISOString(), deadlineUnix, atRiskUsd, atRiskReset,
    ...(s.txHash ? { tx: s.txHash } : {}), ...(safeExplorerLink(s.deliveryLink) ? { link: s.deliveryLink } : {}), formatted: { atRiskUsd: formatAmount(atRiskUsd, 6), atRiskReset: formatAmount(atRiskReset, 8) } };
}

export function deliveryWarnings(trades, now) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid delivery clock');
  return trades.flatMap(t => {
    const d = deliveryStatus(t, now);
    if (!d || !['delivery_failed', 'delivery_overdue'].includes(d.state)) return [];
    const what = d.state === 'delivery_overdue' ? 'Delivery is overdue' : deliveryMessages[d.reason];
    return [{ code: d.state, severity: 'red', tradeId: t.state.tradeId,
      message: `${what}. ${d.formatted.atRiskReset} RESET ($${d.formatted.atRiskUsd}) at risk. Fix by ${d.deadline}.`,
      deadline: d.deadline, deadlineUnix: d.deadlineUnix, atRiskUsd: d.atRiskUsd, atRiskReset: d.atRiskReset }];
  });
}

export function safeExplorerLink(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; }
}
