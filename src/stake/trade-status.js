import { bondAck } from './admission.js';
import { verifyCertificate } from './certificates.js';
import { stableJSON } from '../core/canonical.js';
import { formatAmount } from './status.js';

export const BOND_STATES = Object.freeze(['reserving', 'reserved', 'released', 'decided-being-collected', 'paid']);

// Terms/acks come from the authenticated reducer; recovery results still need their original quorum.
export function tradeBondStatus(trade, result, policy = trade.state?.registry?.sellerBond) {
  const s = trade.state, b = s?.terms?.bond;
  if (!b) return null;
  const members = new Set(s.terms.committee.map(m => m.dexKey));
  const count = new Set((s.acks ?? []).filter(key => members.has(key))).size;
  const reservationId = s.H ? bondAck(s.terms, s.H).reservationId : null;
  let state = reservationId && count >= s.terms.k ? 'reserved' : 'reserving', outcome;
  const transactions = [];
  if (reservationId && policy?.epoch.id === b.epochId) {
    const context = { networkId: policy.networkId, venueKey: policy.venueKey, epoch: policy.epoch };
    const bound = body => body.reservationId === reservationId && stableJSON(body.pieces) === stableJSON(b.pieces);
    try {
      const closure = verifyCertificate(result?.resolved, context, 'resolved').body;
      if (bound(closure) && ['delivered', 'unfunded'].includes(closure.outcome)) { state = 'released'; outcome = closure.outcome; }
    } catch { /* Unverified or incomplete pickup is not a closure. */ }
    try {
      const decision = verifyCertificate(result?.decision, context, 'decision').body;
      if (bound(decision) && decision.outcome === 'buyer-no-show' && decision.winnerAddress === s.terms.buyer.tracAddr && decision.winnerBoxKey === s.terms.buyer.boxKey) {
        state = 'decided-being-collected'; outcome = decision.outcome;
        for (const ref of b.pieces) try {
          const collected = verifyCertificate(result?.collections?.[ref.unitId], context, 'collected').body;
          if (collected.unitId === ref.unitId && collected.generation === ref.generation && collected.decisionId === decision.decisionId && /^[0-9a-f]{64}$/.test(collected.txHash))
            transactions.push(collected.txHash);
        } catch { /* An award can be only partly collected. */ }
        if (transactions.length === b.pieces.length) state = 'paid';
      }
    } catch { /* A decision alone never means money arrived. */ }
  }
  return { state, reservationId, targetReset: b.targetReset, payoutReset: b.payoutReset, payoutUsd: b.payoutUsd,
    ...(outcome ? { outcome } : {}), transactions, ...(state === 'paid' && transactions.length === 1 ? { tx: transactions[0] } : {}),
    formatted: { targetReset: formatAmount(b.targetReset, 8), payoutReset: formatAmount(b.payoutReset, 8), payoutUsd: formatAmount(b.payoutUsd, 6) } };
}
