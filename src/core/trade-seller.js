import { STEP_BUDGET_MS } from './terms.js';
import { bytesToHex, fromLe32, hexToBytes, le32, sha256Hex, stableJSON } from './canonical.js';
import { checkDealShape, lockStatement } from './dealing.js';
import { hexKey } from './schemas.js';
import { reconstruct, verifyShare } from './vss.js';
import { transferNonce } from './terms.js';
import { abortTransition, createTrader, negotiationStep, resumeActions, runStep, sendAction } from './trade-common.js';

export function createSeller(config) { return createTrader('seller', config); }

const proofAction = s => ({ type: 'checkProof', tradeId: s.tradeId, statement: lockStatement(s.deal), proof: s.deal.proof });
const checkAction = s => ({ type: 'checkEscrow', tradeId: s.tradeId, terms: s.terms, hashHex: s.H });
const reservationAction = s => ({ type: 'reserveEscrow', tradeId: s.tradeId, hashHex: s.H });
const settlementAction = s => ({ ...checkAction(s), purpose: 'settlement' });
const claimAction = s => ({ type: 'claim', tradeId: s.tradeId, terms: s.terms, hashHex: s.H, preimageHex: s.preimageHex });
const transferAction = s => ({ type: 'sendTransfer', tradeId: s.tradeId, asset: s.terms.base.id,
  from: s.terms.seller.tracAddr, to: s.terms.buyer.tracAddr, amount: s.terms.baseAmount, nonce: transferNonce(s.tradeId), sendBy: s.terms.sendBy });

function maybeSend(s) {
  const actions = [];
  if (s.phase === 'awaitReady' && s.escrowOk && s.acks.length >= s.terms.k && s.now < s.terms.sendBy) {
    s.phase = 'reservingEscrow';
    s.reserveRetryAt = null;
    actions.push(reservationAction(s));
  }
  return { state: s, actions };
}

export function step(state, event) {
  return runStep(state, event, (s, e, m) => {
    const committed = ['transferring', 'awaitShares', 'claiming', 'complete', 'lost'].includes(s.phase);
    if (s.phase === 'checkingProof' && e.now >= s.draft.sendBy) return abortTransition(s, 'Send deadline expired');
    if (e.type === 'resume') {
      if (s.phase === 'checkingProof') return resumeActions(s, [proofAction(s)]);
      if (['aborted', 'lost'].includes(s.phase)) return null;
      if (s.phase === 'awaitReady') {
        s.checkInFlight = true;
        s.escrowOk = false;
        return resumeActions(s, [checkAction(s)]);
      }
      if (s.phase === 'reservingEscrow') {
        if (e.now >= s.terms.sendBy) return abortTransition(s, 'Send deadline expired');
        s.reserveRetryAt = null;
        return resumeActions(s, [reservationAction(s)]);
      }
      if (s.phase === 'transferring') return resumeActions(s, [{ ...transferAction(s), resume: true }]);
      const outstanding = s.settlementPending && ['awaitShares', 'claiming'].includes(s.phase) ? [settlementAction(s)] : [];
      if (outstanding.length) s.nextSettlementCheck = e.now + 60;
      if (s.phase === 'claiming') {
        s.claimRetryAt = null;
        return resumeActions(s, [...outstanding, claimAction(s)]);
      }
      return resumeActions(s, outstanding);
    }
    if (['complete', 'lost', 'aborted'].includes(s.phase)) return null;
    if (e.type === 'error') {
      if (s.settlementPending && (e.purpose === 'settlement' || s.phase === 'awaitShares')) {
        s.settlementPending = false;
        return { state: s, actions: [] };
      }
      if (s.phase === 'reservingEscrow') {
        if (e.now >= s.terms.sendBy) return abortTransition(s, 'Send deadline expired');
        s.reserveRetryAt = e.now + 10;
        return { state: s, actions: [] };
      }
      if (s.phase === 'claiming') {
        s.claimRetryAt = e.now + 15;
        return { state: s, actions: [] };
      }
      // An adapter error may hide a submission: retry as a resume of the recorded transfer, never abandon it.
      if (s.phase === 'transferring') {
        s.transferRetryAt = e.now + 10;
        return { state: s, actions: [] };
      }
      return !committed && e.definite === true ? abortTransition(s, e.reason || 'Definite adapter failure') : null;
    }
    if (m?.kind === 'abort') return committed ? null : abortTransition(s, 'Peer aborted: ' + m.body.reason);
    if (m?.kind === 'working' && s.phase === 'awaitDeal') {
      s.dealBudgetMs = Math.min(STEP_BUDGET_MS.certificate, (s.dealBudgetMs ?? STEP_BUDGET_MS.deal) + STEP_BUDGET_MS.deal);
      return { state: s, actions: [] };
    }
    if (e.type === 'tick' && !committed && e.now >= s.draft.sendBy) return abortTransition(s, 'Send deadline expired');
    if (m && !committed && e.now >= s.draft.sendBy) return null;
    const negotiation = negotiationStep(s, e, m);
    if (negotiation) {
      if (negotiation.state.phase === 'negotiated') negotiation.state.phase = 'awaitDeal';
      return negotiation;
    }
    if (m?.kind === 'deal' && s.phase === 'awaitDeal') {
      if (!checkDealShape(m.body, s.terms)) return abortTransition(s, 'Invalid dealing');
      s.deal = m.body;
      s.H = m.body.H;
      s.phase = 'checkingProof';
      return { state: s, actions: [proofAction(s)] };
    }
    if (e.type === 'proofChecked' && s.phase === 'checkingProof' && e.tradeId === s.tradeId) {
      if (e.ok === false) return abortTransition(s, 'Invalid lock certificate');
      if (e.ok !== true) return null;
      s.phase = 'awaitReady';
      s.checkInFlight = true;
      return { state: s, actions: [checkAction(s)] };
    }
    if (m?.kind === 'ack' && s.phase === 'awaitReady') {
      if (m.body.H !== s.H || m.body.holdUntil < s.terms.refundAfter || s.acks.includes(m.from)) return null;
      s.acks.push(m.from);
      return maybeSend(s);
    }
    if (e.type === 'escrowChecked' && s.phase === 'awaitReady') {
      if (e.tradeId !== s.tradeId || e.hashHex !== s.H || !s.checkInFlight) return null;
      if (e.ok === false && (e.unknown === true || ['missing', 'pending'].includes(e.status))) {
        s.checkInFlight = false;
        return { state: s, actions: [] };
      }
      if (e.ok === false) return abortTransition(s, e.reason || 'Escrow verification failed');
      if (e.ok !== true || e.status !== 'active') return null;
      s.checkInFlight = false;
      s.escrowOk = true;
      return maybeSend(s);
    }
    if (e.type === 'escrowReserved' && s.phase === 'reservingEscrow') {
      if (e.tradeId !== s.tradeId || e.hashHex !== s.H || typeof e.ok !== 'boolean') return null;
      if (e.now >= s.terms.sendBy) return abortTransition(s, 'Send deadline expired');
      if (e.ok && e.reservedFor === s.tradeId) {
        s.phase = 'transferring';
        s.reserveRetryAt = null;
        s.transferStartedAt = e.now;
        return { state: s, actions: [transferAction(s)] };
      }
      if (e.ok === false && hexKey.safeParse(e.reservedFor).success && e.reservedFor !== s.tradeId) {
        return abortTransition(s, 'escrow already used by another trade');
      }
      s.reserveRetryAt = e.now + 10;
      return { state: s, actions: [] };
    }
    if (e.type === 'escrowChecked' && ['awaitShares', 'claiming'].includes(s.phase) && s.settlementPending &&
        e.tradeId === s.tradeId && e.hashHex === s.H && e.purpose === 'settlement') {
      if (typeof e.ok !== 'boolean') return null;
      s.settlementPending = false;
      if (e.ok === true && e.status === 'claimed') s.phase = 'complete';
      if (e.ok === true && e.status === 'refunded') s.phase = 'lost';
      return { state: s, actions: [] };
    }
    // Nothing recorded or submitted (a bare failure): retry while the deadline allows; after it nothing can be sent
    // any more, so the trade ends.
    if (s.phase === 'transferring' && e.type === 'transferSent' && e.tradeId === s.tradeId && e.ok === false && e.unknown !== true) {
      if (e.now >= s.terms.sendBy) return abortTransition(s, 'Transfer not sent before the deadline: ' + (e.reason ?? ''));
      s.transferRetryAt = e.now + 10;
      return { state: s, actions: [] };
    }
    if (e.type === 'transferSent' && s.phase === 'transferring') {
      if (e.tradeId !== s.tradeId || !hexKey.safeParse(e.txHash).success) return null;
      if (e.ok !== true && !(e.ok === false && e.unknown === true)) return null;
      if (e.ok === true && (!Number.isSafeInteger(e.sentAt) || e.sentAt < 0 || e.sentAt > e.now || e.sentAt >= s.terms.sendBy)) return null;
      s.txHash = e.txHash;
      s.transferUnknown = e.ok !== true;
      s.phase = 'awaitShares';
      return { state: s, actions: [sendAction(s, 'transferSent', { tradeId: s.tradeId, txHash: s.txHash })] };
    }
    if (m?.kind === 'sharePublish' && s.phase === 'awaitShares') {
      const b = m.body, share = fromLe32(hexToBytes(b.share, 32));
      if (b.H !== s.H || stableJSON(b.commitments) !== stableJSON(s.deal.commitments) || !verifyShare(b.signerIndex, share, s.deal.commitments) ||
          s.shares.some(p => p.id === b.signerIndex)) return null;
      s.shares.push({ id: b.signerIndex, share: b.share });
      const actions = [];
      if (s.shares.length >= s.terms.k) {
        const secret = reconstruct(s.shares.map(p => ({ id: p.id, share: fromLe32(hexToBytes(p.share, 32)) })), s.terms.k);
        if (sha256Hex(le32(secret)) !== s.H) return null;
        s.phase = 'claiming';
        s.preimageHex = bytesToHex(le32(secret));
        actions.push(claimAction(s));
      }
      return { state: s, actions };
    }
    if (e.type === 'claimed' && s.phase === 'claiming' && e.tradeId === s.tradeId) {
      if (e.status === 'refunded' && e.ok === false && e.unknown !== true) {
        s.phase = 'lost';
        return { state: s, actions: [] };
      }
      if (e.ok === true) {
        if (e.status !== undefined && e.status !== 'claimed') return null;
        const notification = sendAction(s, 'claimed', { tradeId: s.tradeId, claimSignature: e.claimSignature });
        s.phase = 'complete';
        return { state: s, actions: [notification] };
      }
      if (e.ok === false) {
        s.claimRetryAt = e.now + 15;
        return { state: s, actions: [] };
      }
      return null;
    }
    if (e.type === 'tick') {
      if (s.phase === 'reservingEscrow' && s.reserveRetryAt && e.now >= s.reserveRetryAt) {
        s.reserveRetryAt = null;
        return { state: s, actions: [reservationAction(s)] };
      }
      if (s.phase === 'transferring' && s.transferRetryAt && e.now >= s.transferRetryAt) {
        s.transferRetryAt = null;
        return { state: s, actions: [{ ...transferAction(s), resume: true }] };
      }
      const actions = [];
      if (['awaitShares', 'claiming'].includes(s.phase) && e.now >= s.terms.refundAfter &&
          !s.settlementPending && e.now >= (s.nextSettlementCheck ?? 0)) {
        s.settlementPending = true;
        s.nextSettlementCheck = e.now + 60;
        actions.push(settlementAction(s));
      }
      if (s.phase === 'claiming' && s.claimRetryAt && e.now >= s.claimRetryAt) {
        s.claimRetryAt = null;
        actions.push(claimAction(s));
      }
      if (s.phase === 'awaitReady' && !s.escrowOk && !s.checkInFlight) {
        s.checkInFlight = true;
        return { state: s, actions: [checkAction(s)] };
      }
      return { state: s, actions };
    }
    return null;
  });
}
