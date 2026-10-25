import { STEP_BUDGET_MS } from './terms.js';
import { lockStatement, prepareDeal } from './dealing.js';
import { abortTransition, createTrader, negotiationStep, peerAbortReason, refusalReason, resumeActions, runStep, seededRng, sendAction } from './trade-common.js';

export function createBuyer(config) { return createTrader('buyer', config); }
export const LOCK_START_MARGIN_SEC = 120;
export const LOCK_OUTCOME_RETRY_SEC = 60;

export function ackRejectionReason(s, m) {
  if (s.phase !== 'awaitAcks') return `phase ${s.phase} does not count acks`;
  if (m.body.H !== s.H) return 'hash mismatch';
  if (m.body.holdUntil < s.terms.refundAfter) return 'holdUntil before refundAfter';
  if (s.acks.includes(m.from)) return 'already counted';
  return null;
}

function maybeLock(s) {
  if (s.now >= s.terms.sendBy - LOCK_START_MARGIN_SEC) return abortTransition(s, 'Signers did not confirm');
  if (s.acks.length < s.terms.k) return { state: s, actions: [] };
  s.phase = 'locking';
  s.lockAttempted = true;
  s.nextLockOutcomeCheck = s.now + LOCK_OUTCOME_RETRY_SEC;
  return { state: s, actions: [lockAction(s)] };
}

function sendDeal(s) {
  s.phase = 'awaitAcks';
  return { state: s, actions: [sendAction(s, 'deal', s.deal)] };
}

const proveAction = s => ({ type: 'prove', tradeId: s.tradeId, secretHex: s.privateState.secretHex, statement: lockStatement(s.deal) });
const lockAction = s => ({ type: 'lockEscrow', tradeId: s.tradeId, terms: s.terms, hashHex: s.H });
const refundAction = s => ({ type: 'refund', tradeId: s.tradeId, terms: s.terms, hashHex: s.H });
const settlementAction = s => ({ type: 'checkEscrow', purpose: 'settlement', tradeId: s.tradeId, terms: s.terms, hashHex: s.H });

function pollLockOutcome(s, resume = false) {
  if (!(s.phase === 'locking' || s.lockUnknown && ['locked', 'refunding'].includes(s.phase)) ||
      !resume && s.now < (s.nextLockOutcomeCheck ?? 0)) return [];
  s.nextLockOutcomeCheck = s.now + LOCK_OUTCOME_RETRY_SEC;
  return [{ type: 'lockOutcome', tradeId: s.tradeId, terms: s.terms, hashHex: s.H }];
}

function pollSettlement(s) {
  const actions = [];
  if (s.locked && ['locked', 'refunding'].includes(s.phase) && !s.settlementPending &&
      s.now >= (s.nextSettlementCheck ?? 0) &&
      (s.phase === 'refunding' || s.txHash || s.sellerClaimed || s.now >= s.terms.sendBy + s.terms.graceSec)) {
    s.settlementPending = true;
    s.nextSettlementCheck = s.now + 30;
    actions.push(settlementAction(s));
  }
  return { state: s, actions };
}

export function step(state, event) {
  return runStep(state, event, (s, e, m) => {
    const terminal = ['complete', 'refunded'].includes(s.phase);
    if (s.phase === 'aborted') return null;
    if (!terminal && ['tick', 'resume'].includes(e.type) && (s.locked || s.phase === 'locking') &&
        e.now >= s.terms.refundAfter && s.phase !== 'refunding') {
      if (s.phase === 'locking') { s.locked = true; s.lockUnknown = true; }
      s.lockRetryAt = null;
      s.phase = 'refunding';
      const actions = [refundAction(s), ...pollLockOutcome(s, e.type === 'resume')];
      if (e.type === 'resume' && s.settlementPending) {
        s.nextSettlementCheck = e.now + 30;
        actions.push(settlementAction(s));
      }
      return { state: s, actions };
    }
    if (['awaitCertificate', 'preparingDeal', 'proving'].includes(s.phase) && e.now >= s.draft.sendBy) return abortTransition(s, 'Negotiation deadline expired');
    if (s.phase === 'awaitAcks' && e.type === 'tick' &&
        e.now >= s.terms.sendBy - LOCK_START_MARGIN_SEC) return abortTransition(s, 'Signers did not confirm');
    if (e.type === 'resume') {
      if (s.phase === 'awaitCertificate') return resumeActions(s, [{ type: 'acquireCertificate', tradeId: s.tradeId }]);
      if (s.phase === 'preparingDeal') return resumeActions(s, [{ type: 'prepareDeal', tradeId: s.tradeId }]);
      if (s.phase === 'proving') return resumeActions(s, [proveAction(s)]);
      // Only the adapter may retry the journaled bytes; outcome checks continue after the sending window.
      if (s.phase === 'locking') {
        s.lockRetryAt = null;
        return resumeActions(s, [...(e.now < s.terms.sendBy ? [lockAction(s)] : []), ...pollLockOutcome(s, true)]);
      }
      const outstanding = s.settlementPending && !terminal ? [settlementAction(s)] : [];
      if (outstanding.length) s.nextSettlementCheck = e.now + 30;
      outstanding.push(...pollLockOutcome(s, true));
      if (s.phase === 'refunding') {
        s.refundRetryAt = null;
        return resumeActions(s, [refundAction(s), ...outstanding]);
      }
      if (outstanding.length) return resumeActions(s, outstanding);
      return resumeActions(s);
    }
    if (terminal) return null;
    if (e.type === 'tick') {
      if (s.phase === 'locking' && s.lockRetryAt && e.now >= s.lockRetryAt && e.now < s.terms.sendBy) {
        s.lockRetryAt = null;
        return { state: s, actions: [lockAction(s), ...pollLockOutcome(s)] };
      }
      if (!s.locked && !['locking', 'aborted'].includes(s.phase) && e.now >= s.draft.sendBy) {
        return abortTransition(s, 'Negotiation deadline expired');
      }
    }
    if (e.type === 'error') {
      if (s.settlementPending && (e.purpose === 'settlement' || s.phase === 'locked')) {
        s.settlementPending = false;
        return { state: s, actions: [] };
      }
      if (s.phase === 'locking') {
        s.lockRetryAt = e.now + 30;
        return { state: s, actions: [] };
      }
      if (s.phase === 'refunding') {
        s.refundRetryAt = e.now + 15;
        return { state: s, actions: [] };
      }
      return !s.lockAttempted && !s.locked && e.definite === true
        ? abortTransition(s, e.reason || 'Definite adapter failure') : null;
    }
    if (m?.kind === 'abort') {
      return !s.lockAttempted && !s.locked ? abortTransition(s, peerAbortReason(s, m.body.reason)) : null;
    }
    if (m?.kind === 'refused') return !s.lockAttempted && !s.locked
      ? abortTransition(s, refusalReason(s, m.body.reason)) : null;
    if (e.type === 'escrowLocked' && s.phase === 'locking') {
      if (e.tradeId !== s.tradeId || (e.hashHex !== undefined && e.hashHex !== s.H)) return null;
      if (e.ok === false && e.unknown !== true) {
        s.lockAttempted = false;
        s.lockRetryAt = null;
        return abortTransition(s, e.reason || 'Escrow lock failed');
      }
      if (e.ok !== true && !(e.ok === false && e.unknown === true)) return null;
      if (e.ok === true && e.hashHex !== s.H) return null;
      s.locked = true;
      s.lockUnknown = e.ok !== true;
      s.lockRetryAt = null;
      s.phase = 'locked';
      return { state: s, actions: [{ type: 'persist', scope: 'locked', tradeId: s.tradeId,
        record: { hashHex: s.H, terms: s.terms, unknown: s.lockUnknown } }, ...pollSettlement(s).actions, ...pollLockOutcome(s)] };
    }
    if (m?.kind === 'ack' && s.phase === 'awaitAcks') {
      if (ackRejectionReason(s, m)) return null;
      s.acks.push(m.from);
      s.acks.sort((a, b) => s.terms.committee.findIndex(c => c.dexKey === a) - s.terms.committee.findIndex(c => c.dexKey === b));
      return maybeLock(s);
    }
    if (m && !s.locked && s.phase !== 'locking' && e.now >= s.draft.sendBy) return null;
    const negotiation = negotiationStep(s, e, m);
    if (negotiation) {
      s = negotiation.state;
      if (s.phase === 'negotiated') {
        s.phase = 'awaitCertificate';
        negotiation.actions.push({ type: 'acquireCertificate', tradeId: s.tradeId });
      }
      return negotiation;
    }
    if (e.type === 'certificateAssigned' && s.phase === 'awaitCertificate' && e.tradeId === s.tradeId) {
      if (e.certificate !== null && (!e.certificate?.secretHex || !e.certificate?.proof)) return null;
      s.certificate = e.certificate;
      s.H = e.certificate?.H ?? null;
      s.phase = 'preparingDeal';
      // The host persists this assignment before deleting the pool entry or building the dealing.
      return { state: s, actions: [{ type: 'prepareDeal', tradeId: s.tradeId }] };
    }
    if (e.type === 'prepareDeal' && s.phase === 'preparingDeal' && e.tradeId === s.tradeId) {
      const { privateState, deal } = prepareDeal({ k: s.terms.k, secretHex: s.certificate?.secretHex,
        committeeBoxKeys: s.terms.committee.map(x => x.boxKey), tradeId: s.tradeId, rng: seededRng(s.entropy, 'dealing:' + s.tradeId) });
      s.privateState = privateState; s.deal = deal; s.H = deal.H;
      if (s.certificate) {
        if (s.H !== s.certificate.H || deal.commitments[0] !== s.certificate.C0) return abortTransition(s, 'Invalid pool certificate');
        s.deal.proof = s.certificate.proof;
        return sendDeal(s);
      }
      s.phase = 'proving'; s.workingElapsedMs = s.stepElapsedMs ?? 0;
      return { state: s, actions: [sendAction(s, 'working', { tradeId: s.tradeId, step: 'certificate' }), proveAction(s)] };
    }
    if (e.type === 'proved' && s.phase === 'proving' && e.tradeId === s.tradeId) {
      if (e.ok === false) return abortTransition(s, e.reason || 'Lock proof failed');
      if (e.ok !== true) return null;
      s.deal.proof = e.proof;
      return sendDeal(s);
    }
    if (m?.kind === 'transferSent' && ['locking', 'locked'].includes(s.phase)) {
      if (s.txHash) return null;
      s.txHash = m.body.txHash;
      return pollSettlement(s);
    }
    if (m?.kind === 'claimed' && ['locking', 'locked', 'refunding'].includes(s.phase)) {
      if (s.sellerClaimed) return null;
      s.sellerClaimed = true;
      return pollSettlement(s);
    }
    if (e.type === 'escrowChecked' && s.locked && s.settlementPending && e.tradeId === s.tradeId &&
        e.hashHex === s.H && e.purpose === 'settlement') {
      if (typeof e.ok !== 'boolean') return null;
      s.settlementPending = false;
      if (e.ok === true && e.status === 'claimed') { s.phase = 'complete'; return { state: s, actions: [] }; }
      if (e.ok === true && e.status === 'refunded') { s.phase = 'refunded'; return { state: s, actions: [] }; }
      if (e.ok === true && e.status === 'active') s.lockUnknown = false;
      // Missing escrow alone is insufficient, including before refundAfter: ask the durable transaction journal.
      if (e.ok === false && e.unknown !== true && e.status === 'missing' && s.lockUnknown) {
        return { state: s, actions: pollLockOutcome(s) };
      }
      return { state: s, actions: [] };
    }
    if (e.type === 'lockOutcome' && (s.phase === 'locking' || s.locked && s.lockUnknown) && e.tradeId === s.tradeId &&
        (e.hashHex === undefined || e.hashHex === s.H)) {
      if (e.outcome === 'none') {
        s.locked = false;
        s.lockUnknown = false;
        s.lockAttempted = false;
        s.lockRetryAt = null;
        s.nextLockOutcomeCheck = null;
        s.refundRetryAt = null;
        s.settlementPending = false;
        return abortTransition(s, 'Lock did not go through');
      }
      if (e.outcome === 'landed') {
        s.locked = true;
        s.lockUnknown = false;
        s.lockRetryAt = null;
        if (s.phase === 'locking') s.phase = 'locked';
        return pollSettlement(s);
      }
    }
    if (e.type === 'refunded' && s.phase === 'refunding' && e.tradeId === s.tradeId) {
      if (e.ok === false) {
        // Find out why: the seller may have claimed, an earlier refund may have landed, or the lock never did.
        s.refundRetryAt = e.now + 15;
        return pollSettlement(s);
      }
      if (e.ok !== true) return null;
      const notification = sendAction(s, 'refunded', { tradeId: s.tradeId, refundSignature: e.refundSignature });
      s.phase = 'refunded';
      return { state: s, actions: [notification] };
    }
    if (e.type === 'tick') {
      if (s.phase === 'awaitAcks') return maybeLock(s);
      if (s.phase === 'proving' && (s.stepElapsedMs ?? 0) - (s.workingElapsedMs ?? 0) >= STEP_BUDGET_MS.working) {
        s.workingElapsedMs = s.stepElapsedMs;
        return { state: s, actions: [sendAction(s, 'working', { tradeId: s.tradeId, step: 'certificate' })] };
      }
      const result = pollSettlement(s);
      result.actions.push(...pollLockOutcome(s));
      if (s.phase === 'refunding' && s.refundRetryAt && e.now >= s.refundRetryAt) {
        s.refundRetryAt = null;
        result.actions.push(refundAction(s));
      }
      return result;
    }
    return null;
  });
}
