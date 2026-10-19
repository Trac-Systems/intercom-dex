import { STEP_BUDGET_MS } from './terms.js';
import { bytesToHex, hexToBytes, le32 } from './canonical.js';
import { boxPublic } from './keys.js';
import { checkDealShape, lockStatement, signerShareCheck } from './dealing.js';
import { hexKey } from './schemas.js';
import { tradeId, transferNonce, validateTerms } from './terms.js';
import { abortTransition, resumeActions, runStep, sendAction } from './trade-common.js';

export function createSigner({ terms, signerIndex, boxSecret, now, usedTx = {} }) {
  const t = validateTerms(terms);
  if (!Number.isSafeInteger(now) || now < 0 || now >= t.sendBy || !Number.isSafeInteger(signerIndex) ||
      signerIndex < 1 || signerIndex > t.committee.length || bytesToHex(boxPublic(boxSecret)) !== t.committee[signerIndex - 1].boxKey) throw new Error('Invalid signer configuration');
  if (!usedTx || Object.getPrototypeOf(usedTx) !== Object.prototype) throw new TypeError('Invalid used-tx snapshot');
  for (const [tx, id] of Object.entries(usedTx)) { hexKey.parse(tx); hexKey.parse(id); }
  return { role: 'signer', phase: 'awaitTermsSignatures', terms: t, tradeId: tradeId(t), signerIndex,
    self: t.committee[signerIndex - 1].dexKey, boxSecret: typeof boxSecret === 'string' ? boxSecret : bytesToHex(boxSecret),
    now, signatures: [], usedTx: { ...usedTx } };
}

const proofAction = s => ({ type: 'checkProof', tradeId: s.tradeId, statement: lockStatement(s.deal), proof: s.deal.proof });
const shareRecord = s => ({ type: 'persist', scope: 'signerShare', tradeId: s.tradeId,
  record: { terms: s.terms, signerIndex: s.signerIndex, share: s.share, H: s.H,
    commitments: s.deal.commitments, holdUntil: s.terms.refundAfter } });
const verifyAction = s => ({ type: 'verifyTransfer', tradeId: s.tradeId, txHash: s.txHash,
  asset: s.terms.base.id, from: s.terms.seller.tracAddr, to: s.terms.buyer.tracAddr,
  minAmount: s.terms.baseAmount, nonce: transferNonce(s.tradeId), finalBefore: s.terms.sendBy + s.terms.graceSec });
const reservationAction = s => ({ type: 'persist', scope: 'verifiedTransfer', tradeId: s.tradeId,
  record: { txHash: s.txHash, reservedFor: s.tradeId, ifUnused: true } });
const publicationAction = s => ({ type: 'publishShare', channels: ['intercom-dex:t:' + s.tradeId, 'intercom-dex:signers'],
  body: { tradeId: s.tradeId, H: s.H, signerIndex: s.signerIndex, share: s.share,
    commitments: s.deal.commitments } });

export function step(state, event) {
  return runStep(state, event, (s, e, m) => {
    const committed = ['holding', 'verifyingTransfer', 'persistingTransfer', 'published'].includes(s.phase);
    if (['aborted', 'expired'].includes(s.phase)) return null;
    if (s.phase === 'checkingProof' && e.now >= s.terms.sendBy + s.terms.graceSec) return abortTransition(s, 'Transfer verification window expired');
    if (e.type === 'resume') {
      if (s.phase === 'checkingProof') return resumeActions(s, [proofAction(s)]);
      if (s.phase === 'persistingShare') return resumeActions(s, [shareRecord(s)]);
      if (s.phase === 'verifyingTransfer') return resumeActions(s, [verifyAction(s)]);
      if (s.phase === 'persistingTransfer') {
        s.reserveRetryAt = null;
        return resumeActions(s, [reservationAction(s)]);
      }
      if (s.phase === 'published') return { state: s, actions: [publicationAction(s)] };
      return resumeActions(s);
    }
    if (e.type === 'error') {
      if (s.phase === 'persistingTransfer') {
        s.reserveRetryAt = e.now + 10;
        return { state: s, actions: [] };
      }
      return !committed && e.definite === true ? abortTransition(s, e.reason || 'Definite adapter failure') : null;
    }
    if (m?.kind === 'abort') return committed ? null : abortTransition(s, 'Trader aborted: ' + m.body.reason);
    if (m?.kind === 'working' && s.phase === 'awaitDeal') {
      s.dealBudgetMs = Math.min(STEP_BUDGET_MS.certificate, (s.dealBudgetMs ?? STEP_BUDGET_MS.deal) + STEP_BUDGET_MS.deal);
      return { state: s, actions: [] };
    }
    if (e.type === 'tick' && e.now >= s.terms.sendBy + s.terms.graceSec &&
        !['verifyingTransfer', 'persistingTransfer', 'published'].includes(s.phase)) {
      s.phase = 'expired';
      return { state: s, actions: [{ type: 'abort', tradeId: s.tradeId, reason: 'Transfer verification window expired' }] };
    }
    if (m && !committed && e.now >= s.terms.sendBy + s.terms.graceSec) return null;
    if (m?.kind === 'termsSig' && s.phase === 'awaitTermsSignatures') {
      if (s.signatures.includes(m.from)) return null;
      s.signatures.push(m.from);
      if (s.signatures.length === 2) s.phase = 'awaitDeal';
      return { state: s, actions: [] };
    }
    if (m?.kind === 'deal' && s.phase === 'awaitDeal') {
      if (!checkDealShape(m.body, s.terms)) return abortTransition(s, 'Invalid dealing');
      const result = signerShareCheck(m.body, s.signerIndex, hexToBytes(s.boxSecret, 32));
      if (!result.ok) return abortTransition(s, 'Invalid dealing');
      s.deal = m.body;
      s.H = m.body.H;
      s.share = bytesToHex(le32(result.share));
      s.phase = 'checkingProof';
      return { state: s, actions: [proofAction(s)] };
    }
    if (e.type === 'proofChecked' && s.phase === 'checkingProof' && e.tradeId === s.tradeId) {
      if (e.ok === false) return abortTransition(s, 'Invalid lock certificate');
      if (e.ok !== true) return null;
      s.phase = 'persistingShare';
      return { state: s, actions: [shareRecord(s)] };
    }
    if (e.type === 'persisted' && e.scope === 'signerShare' && s.phase === 'persistingShare') {
      if (e.tradeId !== s.tradeId) return null;
      if (e.ok === false && e.unknown !== true) return abortTransition(s, 'Share persistence failed');
      if (e.ok !== true || e.now >= s.terms.sendBy + s.terms.graceSec) return null;
      s.phase = 'holding';
      return { state: s, actions: [sendAction(s, 'ack', { tradeId: s.tradeId, H: s.H, holdUntil: s.terms.refundAfter })] };
    }
    if (m?.kind === 'transferSent' && s.phase === 'holding') {
      if (e.now >= s.terms.sendBy + s.terms.graceSec ||
          (s.usedTx[m.body.txHash] && s.usedTx[m.body.txHash] !== s.tradeId)) return null;
      s.txHash = m.body.txHash;
      s.phase = 'verifyingTransfer';
      return { state: s, actions: [verifyAction(s)] };
    }
    if (e.type === 'transferVerified' && s.phase === 'verifyingTransfer' && e.ok === false && e.tradeId === s.tradeId) {
      // A definitive mismatch, or no final transfer within the window: the share is never released.
      if (e.final !== true && e.now < s.terms.sendBy + s.terms.graceSec) return null;
      s.phase = 'expired';
      return { state: s, actions: [{ type: 'abort', tradeId: s.tradeId, reason: 'Transfer not verified: ' + (e.reason ?? 'not final in time') }] };
    }
    if (e.type === 'transferVerified' && s.phase === 'verifyingTransfer') {
      if (e.ok !== true || e.final !== true || e.tradeId !== s.tradeId || e.txHash !== s.txHash ||
          e.amount !== s.terms.baseAmount || e.from !== s.terms.seller.tracAddr || e.to !== s.terms.buyer.tracAddr ||
          e.asset !== s.terms.base.id || e.nonce !== transferNonce(s.tradeId) ||
          !Number.isSafeInteger(e.finalizedAt) || e.finalizedAt < 0 || e.finalizedAt > e.now ||
          e.finalizedAt >= s.terms.sendBy + s.terms.graceSec || (e.usedBy && e.usedBy !== s.tradeId)) return null;
      s.finalizedAt = e.finalizedAt;
      s.phase = 'persistingTransfer';
      return { state: s, actions: [reservationAction(s)] };
    }
    if (e.type === 'persisted' && e.scope === 'verifiedTransfer' && s.phase === 'persistingTransfer') {
      if (e.tradeId !== s.tradeId || (e.txHash !== undefined && e.txHash !== s.txHash)) return null;
      if (e.ok === false) {
        s.reserveRetryAt = e.now + 10;
        return { state: s, actions: [] };
      }
      if (e.ok !== true || e.tradeId !== s.tradeId || e.txHash !== s.txHash || e.reservedFor !== s.tradeId) return null;
      s.reserveRetryAt = null;
      s.usedTx[s.txHash] = s.tradeId;
      s.phase = 'published';
      return { state: s, actions: [publicationAction(s)] };
    }
    if (e.type === 'tick') {
      if (s.phase === 'persistingTransfer' && s.reserveRetryAt && e.now >= s.reserveRetryAt) {
        s.reserveRetryAt = null;
        return { state: s, actions: [reservationAction(s)] };
      }
      return { state: s, actions: [] };
    }
    return null;
  });
}
