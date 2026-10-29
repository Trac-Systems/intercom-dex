import { STEP_BUDGET_MS } from './terms.js';
import { bytesToHex, fromLe32, hexToBytes, le32, sha256Hex, stableJSON } from './canonical.js';
import { checkDealShape, lockStatement } from './dealing.js';
import { hexKey } from './schemas.js';
import { reconstruct, verifyShare } from './vss.js';
import { transferNonce } from './terms.js';
import { recordClaimFailure } from './claim-warning.js';
import { RESET_PAUSED_MESSAGE } from '../market/gateway-status.js';
import { abortTransition, createTrader, negotiationStep, peerAbortReason, refusalReason, resumeActions, runStep, sendAction } from './trade-common.js';

export function createSeller(config) { return createTrader('seller', config); }

// Same ten-second cadence as the host's acks and SELLER_FUNDS_RETRY_SEC.
export const TRANSFER_NOTICE_RETRY_SEC = 10;
export const DEAD_TRANSFER_GRACE_SEC = 6 * 60 * 60;
export const TRANSFER_CHECK_RETRY_SEC = 60;
export const DEAD_TRANSFER_REASON = "Transfer never landed; closed after the buyer's refund window";

// A claiming seller already holds the released secret, which signers only publish after the transfer landed. It
// keeps the existing claim/settlement flow and is never closed by a transfer lookup.
const unverifiedTransfer = s => ['transferring', 'awaitShares'].includes(s.phase) && (s.transferFinal !== true || s.transferUnknown === true);
const canCloseDeadTransfer = s => unverifiedTransfer(s) && s.transferFinal !== true &&
  s.now >= s.terms.refundAfter + DEAD_TRANSFER_GRACE_SEC;
const transferCheckAction = (s, close = false) => {
  s.transferCheck = { at: s.now, close };
  s.transferRetryAt = s.now + TRANSFER_CHECK_RETRY_SEC;
  return { type: 'checkSellerTransfer', tradeId: s.tradeId, txHash: s.txHash, checkAt: s.now };
};

function claimWithShares(s) {
  if (s.shares.length < s.terms.k) return [];
  const secret = reconstruct(s.shares.map(p => ({ id: p.id, share: fromLe32(hexToBytes(p.share, 32)) })), s.terms.k);
  if (sha256Hex(le32(secret)) !== s.H) throw new Error('Invalid reconstructed preimage');
  s.phase = 'claiming';
  s.preimageHex = bytesToHex(le32(secret));
  return [claimAction(s)];
}

// Runtime seller flow. Retain the original reducer for callers replaying older event journals.
export function stepFinalized(state, event) {
  if (!event || !Number.isSafeInteger(event.now) || event.now < state.now ||
      (event.type !== 'message' && event.tradeId !== undefined && event.tradeId !== state.tradeId)) return { state, actions: [] };
  if (event.type === 'resume' && state.phase === 'awaitShares' && state.transferFinal !== true) {
    state = { ...state, phase: 'transferring', transferUnknown: true };
  }
  if (unverifiedTransfer(state) && event.now >= state.terms.sendBy &&
      !(state.gatewayPaused && !state.txHash && !state.transferUnknown)) {
    if (['tick', 'resume'].includes(event.type)) return runStep(state, event, (s, e) => {
      if (e.type === 'resume') {
        // In-flight work did not survive a restart. Old journals need no additional fields to reconcile now.
        delete s.transferCheck;
        s.settlementPending = false;
        s.nextSettlementCheck = 0;
        s.transferRetryAt = 0;
      }
      const actions = [];
      if (e.now >= s.terms.refundAfter && !s.settlementPending &&
          e.now >= (s.nextSettlementCheck ?? 0) && (!canCloseDeadTransfer(s) || e.now >= (s.transferRetryAt ?? 0))) {
        // Settlement remains independent of a stalled transfer reader. A lookup spanning another settlement
        // round cannot close the trade using the earlier round's active result.
        if (s.transferCheck) s.transferCheck.close = false;
        s.settlementPending = true;
        s.nextSettlementCheck = e.now + TRANSFER_CHECK_RETRY_SEC;
        actions.push(settlementAction(s));
      }
      // Once closure is possible, the settlement result starts the fresh lookup. Never close while a settlement
      // read is failing or still in flight, and never reuse a negative lookup from before the refund window.
      if (!canCloseDeadTransfer(s) && !s.transferCheck && e.now >= (s.transferRetryAt ?? 0)) actions.push(transferCheckAction(s));
      if (e.type === 'resume') return resumeSeller(s, actions);
      if (s.phase === 'awaitShares' && canAnnounceTransfer(s) && e.now >= (s.transferNoticeAt ?? 0)) actions.push(transferNotice(s));
      return { state: s, actions };
    });
    if (event.type === 'sellerTransferChecked') return runStep(state, event, (s, e) => {
      if (!s.transferCheck || e.checkAt !== s.transferCheck.at || e.tradeId !== s.tradeId ||
          s.txHash && e.txHash !== s.txHash) return null;
      const close = s.transferCheck.close;
      delete s.transferCheck;
      s.transferRetryAt = e.now + TRANSFER_CHECK_RETRY_SEC;
      if (e.ok === true && e.final === true && e.amount === s.terms.baseAmount && hexKey.safeParse(e.txHash).success &&
          Number.isSafeInteger(e.finalizedAt) && e.finalizedAt >= 0 && e.finalizedAt <= e.now) {
        s.txHash = e.txHash;
        s.transferFinal = true;
        s.transferUnknown = false;
        s.finalizedAt = e.finalizedAt;
        s.phase = 'awaitShares';
        const actions = claimWithShares(s);
        if (canAnnounceTransfer(s)) actions.push(transferNotice(s));
        return { state: s, actions };
      }
      if (hexKey.safeParse(e.txHash).success) { s.txHash = e.txHash; s.transferUnknown = true; }
      if (close && canCloseDeadTransfer(s) && e.ok === false && e.notApplied === true &&
          (hexKey.safeParse(e.txHash).success || e.noIntent === true && !s.txHash)) {
        delete s.claimFailure;
        return abortTransition(s, DEAD_TRANSFER_REASON);
      }
      return { state: s, actions: [] };
    });
    if (event.type === 'error' && event.purpose === 'sellerTransfer') return runStep(state, event, (s, e) => {
      if (e.checkAt !== s.transferCheck?.at) return null;
      delete s.transferCheck;
      s.transferRetryAt = e.now + TRANSFER_CHECK_RETRY_SEC;
      return { state: s, actions: [] };
    });
    if (event.type === 'escrowChecked' && state.settlementPending && event.purpose === 'settlement' &&
        event.hashHex === state.H && event.tradeId === state.tradeId && event.ok === true && event.status === 'active') {
      const result = step(state, event);
      if (canCloseDeadTransfer(result.state) && !result.state.transferCheck && event.now >= (result.state.transferRetryAt ?? 0)) {
        result.actions.push(transferCheckAction(result.state, true));
      }
      return result;
    }
  }
  if (state.phase !== 'transferring') return step(state, event);
  if (event.type === 'transferSent' && hexKey.safeParse(event.txHash).success) {
    return runStep(state, event, (s, e) => {
      if (s.txHash && s.txHash !== e.txHash) return null;
      if (e.ok !== true && !(e.ok === false && e.unknown === true)) return null;
      if (e.ok === true && e.final === true) {
        if (!Number.isSafeInteger(e.finalizedAt) || e.finalizedAt < 0 || e.finalizedAt > e.now) return null;
        const result = step(s, e);
        if (result.state.phase !== 'awaitShares') return null;
        result.state.transferFinal = true;
        result.state.finalizedAt = e.finalizedAt;
        delete result.state.transferCheck;
        return result;
      }
      const announce = !s.txHash;
      delete s.gatewayPaused;
      s.txHash = e.txHash;
      s.transferUnknown = true;
      s.transferRetryAt = e.now + (e.now >= s.terms.sendBy ? TRANSFER_CHECK_RETRY_SEC : 10);
      return { state: s, actions: announce && canAnnounceTransfer(s) ? [transferNotice(s)] : [] };
    });
  }
  return step(state, event);
}

const proofAction = s => ({ type: 'checkProof', tradeId: s.tradeId, statement: lockStatement(s.deal), proof: s.deal.proof });
const checkAction = s => ({ type: 'checkEscrow', tradeId: s.tradeId, terms: s.terms, hashHex: s.H });
const reservationAction = s => ({ type: 'reserveEscrow', tradeId: s.tradeId, hashHex: s.H });
const settlementAction = s => ({ ...checkAction(s), purpose: 'settlement' });
const claimAction = s => ({ type: 'claim', tradeId: s.tradeId, terms: s.terms, hashHex: s.H, preimageHex: s.preimageHex });
const transferAction = s => ({ type: 'sendTransfer', tradeId: s.tradeId, asset: s.terms.base.id,
  from: s.terms.seller.tracAddr, to: s.terms.buyer.tracAddr, amount: s.terms.baseAmount, nonce: transferNonce(s.tradeId), sendBy: s.terms.sendBy });
const awaitingSettlement = s => ['transferring', 'awaitShares', 'claiming'].includes(s.phase);
const canAnnounceTransfer = s => ['transferring', 'awaitShares'].includes(s.phase) && hexKey.safeParse(s.txHash).success &&
  s.shares.length < s.terms.k && s.now < s.terms.sendBy + s.terms.graceSec;
// Each repeat waits twice as long (10 s, 20 s, 40 s, … at most 2 min): a handful of notices per trade, never a stream.
export const TRANSFER_NOTICE_MAX_SEC = 120;
const transferNotice = s => {
  s.transferNotices = (s.transferNotices ?? 0) + 1;
  s.transferNoticeAt = s.now + Math.min(TRANSFER_NOTICE_RETRY_SEC * 2 ** (s.transferNotices - 1), TRANSFER_NOTICE_MAX_SEC);
  return sendAction(s, 'transferSent', { tradeId: s.tradeId, txHash: s.txHash });
};

function resumeSeller(s, outstanding = []) {
  const result = resumeActions(s, outstanding);
  // Old journals may lack lastMessages, or retain a transfer notice after collecting k shares.
  result.actions = result.actions.filter(a => a.kind !== 'transferSent');
  if (canAnnounceTransfer(s)) result.actions.unshift(transferNotice(s));
  return result;
}

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
      if (s.phase === 'transferring' && s.gatewayPaused && e.now >= s.terms.sendBy) return abortTransition(s, 'Transfer not sent before the deadline: ' + RESET_PAUSED_MESSAGE);
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
      // Restarted checks no longer have a live adapter call. Reconcile immediately, even if an old journal never
      // scheduled a check, and independently of a resumed transfer's finality lookup.
      const outstanding = awaitingSettlement(s) && (s.settlementPending || e.now >= s.terms.refundAfter) ? [settlementAction(s)] : [];
      if (outstanding.length) { s.settlementPending = true; s.nextSettlementCheck = e.now + 60; }
      if (s.phase === 'transferring') {
        delete s.gatewayPaused;
        return resumeSeller(s, [...outstanding, { ...transferAction(s), resume: true }]);
      }
      if (s.phase === 'claiming') {
        s.claimRetryAt = null;
        return resumeSeller(s, [...outstanding, claimAction(s)]);
      }
      return resumeSeller(s, outstanding);
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
        recordClaimFailure(s, e.reason);
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
    if (m?.kind === 'abort') return committed ? null : abortTransition(s, peerAbortReason(s, m.body.reason));
    if (m?.kind === 'refused') return committed || s.escrowOk || s.phase === 'reservingEscrow'
      ? null : abortTransition(s, refusalReason(s, m.body.reason));
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
    if (e.type === 'escrowChecked' && awaitingSettlement(s) && s.settlementPending &&
        e.tradeId === s.tradeId && e.hashHex === s.H && e.purpose === 'settlement') {
      if (typeof e.ok !== 'boolean') return null;
      s.settlementPending = false;
      if (e.ok === true && e.status === 'claimed') { s.phase = 'complete'; delete s.claimFailure; }
      if (e.ok === true && e.status === 'refunded') s.phase = 'lost';
      return { state: s, actions: [] };
    }
    // Nothing recorded or submitted (a bare failure): retry while the deadline allows; after it nothing can be sent
    // any more, so the trade ends.
    if (s.phase === 'transferring' && e.type === 'transferSent' && e.tradeId === s.tradeId && e.ok === false && e.unknown !== true) {
      if (e.now >= s.terms.sendBy) return abortTransition(s, 'Transfer not sent before the deadline: ' + (e.reason ?? ''));
      if (e.reason === RESET_PAUSED_MESSAGE && !s.txHash && !s.transferUnknown) s.gatewayPaused = true;
      s.transferRetryAt = e.now + 10;
      return { state: s, actions: [] };
    }
    if (e.type === 'transferSent' && s.phase === 'transferring') {
      if (e.tradeId !== s.tradeId || !hexKey.safeParse(e.txHash).success) return null;
      if (e.ok !== true && !(e.ok === false && e.unknown === true)) return null;
      if (e.ok === true && (!Number.isSafeInteger(e.sentAt) || e.sentAt < 0 || e.sentAt > e.now || e.sentAt >= s.terms.sendBy)) return null;
      s.txHash = e.txHash;
      delete s.gatewayPaused;
      s.transferUnknown = e.ok !== true;
      s.phase = 'awaitShares';
      return { state: s, actions: canAnnounceTransfer(s) ? [transferNotice(s)] : [] };
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
        recordClaimFailure(s, e.reason);
        s.phase = 'lost';
        return { state: s, actions: [] };
      }
      if (e.ok === true) {
        if (e.status !== undefined && e.status !== 'claimed') return null;
        const notification = sendAction(s, 'claimed', { tradeId: s.tradeId, claimSignature: e.claimSignature });
        s.phase = 'complete';
        delete s.claimFailure;
        return { state: s, actions: [notification] };
      }
      if (e.ok === false) {
        recordClaimFailure(s, e.reason);
        s.claimRetryAt = e.now + 15;
        return { state: s, actions: [] };
      }
      return null;
    }
    if (e.type === 'tick') {
      const actions = [];
      if (s.phase === 'transferring' && s.gatewayPaused && e.now >= s.terms.sendBy) return abortTransition(s, 'Transfer not sent before the deadline: ' + RESET_PAUSED_MESSAGE);
      if (s.phase === 'reservingEscrow' && s.reserveRetryAt && e.now >= s.reserveRetryAt) {
        s.reserveRetryAt = null;
        return { state: s, actions: [reservationAction(s)] };
      }
      if (s.phase === 'transferring' && s.transferRetryAt && e.now >= s.transferRetryAt) {
        s.transferRetryAt = null;
        delete s.gatewayPaused;
        actions.push({ ...transferAction(s), resume: true });
      }
      if (s.phase === 'awaitShares' && canAnnounceTransfer(s) && e.now >= (s.transferNoticeAt ?? 0)) {
        actions.push(transferNotice(s));
      }
      if (awaitingSettlement(s) && e.now >= s.terms.refundAfter &&
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
