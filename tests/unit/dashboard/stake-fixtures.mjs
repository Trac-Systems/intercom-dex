// SB4 §6 status fields built by the core's own builders (src/stake/status.js), so the dashboard is tested against
// exactly what Trader.status() returns: RESET in base units (8 decimals), *Usd in USDC base units (6 decimals).
import * as core from '../../../src/stake/status.js';
import { defaultSettings } from '../../../src/stake/settings.js';
import { signFact } from '../../../src/stake/certificates.js';
import { StakeLedger, unitId } from '../../../src/stake/ledger.js';
import { admissionInventory, bondAck } from '../../../src/stake/admission.js';
import { StakeAdmission } from '../../../src/stake/admission-runtime.js';
import { stableJSON } from '../../../src/core/canonical.js';
import { registryPolicy, secrets, memoryStore } from '../stake/helpers.mjs';
import { tracAddress } from '../core/helpers.mjs';

const hex64 = n => n.toString(16).padStart(64, '0');

export const piece = (state, principalReset, extra = {}) => ({ state, descriptor: { principalReset }, ...extra });
// $250 per RESET: USDC base units per whole RESET.
export const PRICE = { numerator: '250000000', denominator: '1' };

// An active seller: 1.2 RESET at $250 ($300), a little reserved for one open sale, nothing on its way.
export function stakeStatus(input = {}) {
  return core.stakeStatus({ pieces: [piece('free', '119800000'), piece('reserved', '200000')], openOffersUsd: '4400000',
    settings: defaultSettings(), price: PRICE, ...input });
}

export function rewardsStatus(now, input = {}) {
  return core.rewardsStatus({ unpaid: '3120000', paidTotal: '41500000', weight: 'active', ratePerDay: '1250000', poolState: 'active',
    poolBalance: '180000000000', dailyBudget: '500000000', activeWeightBps: 20000,
    lastPayout: { amount: '10000000', tx: 'c4'.repeat(32), at: new Date((now - 2 * 86400) * 1000).toISOString(), link: `https://explorer.trac.network/tx/${'c4'.repeat(32)}` },
    ...input });
}

// A sale in each delivery state, due 20 minutes from `now` (overdue: due 1 minute ago). `extra` goes into the trade state.
export function deliveryStatus(state, now, extra = {}) {
  const due = state === 'delivery_overdue' ? now - 60 : now + 1200;
  const facts = { delivery_sending: {}, delivery_failed: { deliveryFailure: 'tnk_short' }, delivery_overdue: {}, delivery_confirming: { txHash: 'e5'.repeat(32) },
    delivered: { transferFinal: true }, penalty_paid: { penaltyPaid: true, txHash: 'd7'.repeat(32), deliveryLink: `https://explorer.trac.network/tx/${'d7'.repeat(32)}` } }[state];
  return core.deliveryStatus({ state: { tradeId: 'ab'.repeat(32), escrowOk: true, phase: 'transferring',
    terms: { sendBy: due - 900, bond: { overdueDelaySec: 900, payoutReset: '200000', payoutUsd: '500000' } }, ...facts, ...extra } }, now);
}

export { PAUSE_CODES } from '../../../src/stake/prevention.js';

// A venue that bonds every sale, and the trader's own seller stake (pieces of `pieces` RESET base units) certified by
// the venue's signers at `now`, built with the core's own builders (src/stake/ledger.js, admission.js,
// admission-runtime.js). The RESET price is $2,000, so the $0.50 minimum bond is 0.00025 RESET.
export function bondedVenue({ me, registry, now, pieces = ['25000'], boxKey = 'b1'.repeat(32) }) {
  const policy = registryPolicy(), context = { networkId: policy.networkId, venueKey: policy.venueKey, epoch: policy.epoch };
  const q = { numerator: '2000000000', denominator: '1' }, owner = { dexKey: me.dexKey, tracAddr: me.tracAddr, boxKey };
  const cert = (kind, body) => secrets.slice(0, 3).map(secret => signFact({ v: 1, networkId: context.networkId, venueKey: context.venueKey, epochId: context.epoch.id, kind, body }, secret));
  const store = memoryStore(), ledger = new StakeLedger({ store, context, address: me.tracAddr });
  pieces.forEach((principalReset, i) => {
    const d = { networkId: context.networkId, venueKey: context.venueKey, epochId: context.epoch.id, batchId: hex64(i + 1), nonce: hex64(100 + i), owner, purpose: 'seller',
      principalReset, tnkReserve: '90000000000000000', createdAt: now - 3600, expiresAt: now + 30 * 86400 };
    ledger.admitFunded(cert('funded', { descriptor: d, unitId: unitId(d), address: tracAddress(hex64(70 + i)), fundingDigest: hex64(80 + i) }),
      { settings: policy.economics.active.settings, price: q, now });
  });
  const priceReference = { cutoffAt: now, q }, priceCheckpoint = { head: hex64(23) };
  const priceLog = { verifyReference(reference, checkpoint, at) {
    if (stableJSON(reference) !== stableJSON(priceReference) || stableJSON(checkpoint) !== stableJSON(priceCheckpoint) || at - reference.cutoffAt > 60) throw new Error('bond_price_unavailable');
    return q;
  } };
  const venue = { ...registry, sellerBond: policy };
  const admission = new StakeAdmission({ store, registry: () => venue, price: { log: () => priceLog }, trader: true });
  admission.cache.set(me.dexKey, { inventoryCertificate: cert('admission-inventory', admissionInventory(ledger.read(), owner, now, context.epoch.id)), priceCheckpoint, priceReference });
  // A sale's terms as this trader signs them when it sells: with both receiving keys and the bond it proposes.
  const bonded = terms => { const t = { ...terms, seller: { ...terms.seller, ...owner }, buyer: { ...terms.buyer, boxKey: 'b2'.repeat(32) } }; return { ...t, bond: admission.propose(t, now) }; };
  return { registry: venue, runtime: { admission, boxKey }, bonded, cert };
}

// The penalty result the core's runtime keeps for a bonded trade (stake-trade-penalty-<tradeId>), certified by the
// venue's signers: closed (`resolved` 'delivered' or 'unfunded'), or decided for the buyer with `collected` pieces paid.
export function penaltyResult(v, trade, { resolved = null, decided = false, collected = 0 } = {}) {
  const terms = trade.state.terms, reservationId = bondAck(terms, trade.state.H).reservationId, decisionId = hex64(33), out = {};
  if (resolved) out.resolved = v.cert('resolved', { reservationId, pieces: terms.bond.pieces, outcome: resolved, evidenceDigest: hex64(50) });
  if (decided) {
    out.decision = v.cert('decision', { reservationId, decisionId, pieces: terms.bond.pieces, outcome: 'buyer-no-show', winnerAddress: terms.buyer.tracAddr, winnerBoxKey: terms.buyer.boxKey });
    out.collections = Object.fromEntries(terms.bond.pieces.slice(0, collected).map((p, i) => [p.unitId, v.cert('collected', { ...p, decisionId, txHash: (0xd7 + i).toString(16).repeat(32) })]));
  }
  return out;
}

// Turns a trader fixture's venue into one that bonds sales, with the trader's stake as in bondedVenue.
export function armBonds(fx, { now = Math.floor(Date.now() / 1000), pieces } = {}) {
  const v = bondedVenue({ me: fx.role.me, registry: fx.f.registry, now, pieces });
  fx.role.registry = { ...fx.role.registry, usable: v.registry, current: v.registry, snapshot: () => v.registry };
  fx.role.stakeRuntime = v.runtime;
  // Where sales are bonded, other traders announce their offers with their receiving key (Trader #participant).
  for (const [id, seen] of fx.role.offers) if (seen.offer.maker.dexKey !== fx.role.me.dexKey) fx.role.offers.set(id, { ...seen, offer: { ...seen.offer, maker: { ...seen.offer.maker, boxKey: 'b2'.repeat(32) } } });
  return v;
}
