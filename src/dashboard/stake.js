// The RESET stake, rewards and trade deliveries from the trader's status (SB4 §6, src/stake/status.js), as amounts
// the page shows. RESET fields are base units (8 decimals), *Usd fields USDC base units (6 decimals); times are Unix
// seconds. The venue's stake settings (cap, wait, bond rate) are null while it has no stake policy.
import { amount } from './format.js';
import { stakeAdmissionRequired } from '../stake/prevention.js';

export const DELIVERY_STATES = ['delivery_sending', 'delivery_failed', 'delivery_overdue', 'delivery_confirming', 'delivered', 'penalty_paid'];
const BANNER = ['delivery_failed', 'delivery_overdue', 'delivery_confirming', 'penalty_collecting', 'penalty_paid'];
const link = value => (typeof value === 'string' && value.startsWith('https://') ? value : null);
const opt = (value, asset) => (value == null ? null : amount(value, asset));

// `draining`: the venue is moving its stakes to new signers (registry sellerBond.acceptNew false): no new stakes and no
// new bonded sales, while existing stake stays and can be withdrawn.
export function stakeView(s, { selling, bonded = true, draining = false }) {
  const reset = k => amount(s[k], 'RESET'), usd = k => opt(s[k], 'USDC');
  const short = s.coverageUsd == null ? 0n : BigInt(s.openOffersUsd) - BigInt(s.coverageUsd);
  const freeUsd = s.priceUsd ? resetUsd(BigInt(s.free), s.priceUsd) : null;
  return { offered: s.capUsd != null && !draining, draining, state: s.state, reason: s.reason ?? null, selling: selling || BigInt(s.reserved) > 0n,
    locked: reset('locked'), reserved: reset('reserved'), free: reset('free'), withdrawing: reset('withdrawing'), pending: reset('pending'),
    freeUsd: opt(freeUsd, 'USDC'), coverage: usd('coverageUsd'), openOffers: usd('openOffersUsd'), suggested: usd('suggestedUsd'), cap: usd('capUsd'),
    short: short > 0n ? amount(short, 'USDC') : null, withdrawDelaySec: s.withdrawDelaySec, withdrawingUntil: s.withdrawingUntil,
    penaltyBps: s.penaltyBps, minPenalty: usd('minPenaltyUsd'), price: s.priceUsd, busy: s.operationPending === true, bonded,
    // A running withdrawal (stake.withdrawal): what still backs a running sale and is returned after it closes, and
    // what went to a buyer instead.
    withdrawal: s.withdrawal?.pending ? { deferred: amount(s.withdrawal.deferred, 'RESET'), forfeited: amount(s.withdrawal.forfeited, 'RESET') } : null };
}

// RESET base units ↔ USDC base units at `price` (USD per RESET, up to 12 decimals).
const priceE12 = price => { const [w, f = ''] = price.split('.'); return BigInt(w + f.padEnd(12, '0').slice(0, 12)); };
export const resetUsd = (units, price) => units * priceE12(price) / 10n ** 14n;
export const usdReset = (usd, price) => usd * 10n ** 14n / priceE12(price);

export function rewardsView(r) {
  const reset = k => opt(r[k], 'RESET');
  return { unpaid: reset('unpaid'), paidTotal: reset('paidTotal'), ratePerDay: reset('ratePerDay'), poolBalance: reset('poolBalance'), dailyBudget: reset('dailyBudget'),
    lastPayout: r.lastPayout ? { amount: amount(r.lastPayout.amount, 'RESET'), tx: r.lastPayout.tx, link: link(r.lastPayout.link), at: r.lastPayout.atUnix } : null,
    weight: r.weight, activeWeightBps: r.activeWeightBps, poolState: r.poolState, forfeited: r.forfeited && r.forfeited !== '0' ? reset('forfeited') : null };
}

// `bond` is the trade's bondView. Until every piece is collected the core keeps reporting the delivery's own state
// (overdue, but also failed, sending, or even delivered after a late delivery); once a decision exists the page calls
// that state penalty_collecting. A buyer is shown only what concerns the seller's stake, and a trade without a bond
// (nothing at risk) shows none. `payments` are the verified RESET transfers of the bond to the buyer.
export function deliveryView(d, { buyer = false, bond = null } = {}) {
  if (!d || !DELIVERY_STATES.includes(d.state) || d.atRiskReset === '0') return null;
  const state = d.state !== 'penalty_paid' && bond?.state === 'decided-being-collected' ? 'penalty_collecting' : d.state;
  if (buyer && !['delivery_overdue', 'penalty_collecting', 'penalty_paid'].includes(state)) return null;
  // A delivered sale's reservation is free only once the signers have closed it (bond `released`).
  return { state, reason: d.reason ?? null, deadline: d.deadlineUnix, atRisk: { usd: amount(d.atRiskUsd, 'USDC'), reset: amount(d.atRiskReset, 'RESET') },
    tx: d.tx ?? null, link: link(d.link), buyer, released: bond?.state === 'released', payments: bond?.payments ?? [] };
}

// A trade's bond from the core's status (trades[].bond): the amount in its signed terms and where its reservation
// stands: reserving (until k signers confirm it), reserved, released (signers closed it: delivered, or the buyer never
// locked), decided-being-collected (decided for the buyer) or paid (every piece collected), with the RESET transfers
// to the buyer verified so far. Null for a trade without a bond.
export const bondView = b => (b ? { reset: amount(b.payoutReset, 'RESET'), usd: amount(b.payoutUsd, 'USDC'), state: b.state, payments: b.transactions } : null);

// The bond the core would put into the signed terms of a sale right now (role.bondPreview: `side` sell for the sell
// ticket and the take of a buy offer, buy for the take of a sell offer, which shows the seller's bond). Null while the
// venue does not bond sales; otherwise the amount, or the core's refusal code and when to ask again. While the venue
// drains, the core refuses every new bonded sale (as bond_setup_unavailable); the page says why (venue_draining).
export const BOND_REFUSALS = ['bond_not_reserved', 'bond_required', 'bond_stale', 'bond_price_unavailable', 'bond_setup_unavailable'];
export const draining = reg => reg?.sellerBond?.acceptNew === false;
export function saleBond(role, input, now) {
  const reg = role.registry.usable;
  if (!reg || !stakeAdmissionRequired(reg, now)) return null;
  if (draining(reg)) return { reset: null, usd: null, refused: 'venue_draining', retrySec: null };
  const r = role.bondPreview(input);
  if (r.ok) return { reset: amount(r.bond.payoutReset, 'RESET'), usd: amount(r.bond.payoutUsd, 'USDC'), refused: null, retrySec: null };
  return { reset: null, usd: null, refused: BOND_REFUSALS.includes(r.code) ? r.code : 'bond_not_reserved', retrySec: r.details?.retrySec ?? null };
}

// Whether this trader can buy where sales are bonded (the core refuses others with exactly "update the app").
export const buyerNeedsUpdate = (role, now) => stakeAdmissionRequired(role.registry.usable, now) && !role.stakeRuntime?.boxKey;

// Trades the page pins a banner for: failing, overdue or confirming sales, penalties being collected, and penalties
// paid since `since`. A buyer's late seller is in its trade row only.
export const bannerWorthy = (row, since) => !!row.delivery && BANNER.includes(row.delivery.state) && !(row.delivery.buyer && row.delivery.state === 'delivery_overdue') &&
  (row.delivery.state !== 'penalty_paid' || row.at >= since);
