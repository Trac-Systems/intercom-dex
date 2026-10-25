import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, sha256Hex, stableJSON, utf8 } from './canonical.js';
import { hexKey, parseBody, registrySchema } from './schemas.js';
import { selectCommittee } from './committee.js';
import { RANDOMNESS, ACCEPT_SLOT_BEHIND, STEP_BUDGET_MS, tradeId, tradeRandomness, validateTerms } from './terms.js';
import { SOFTWARE, meetsVersion } from './software.js';
import { registryPair } from '../market/assets.js';
import { addressProofRequired, validTermsAddressProofs } from './address-proof.js';

export function seededRng(seed, domain) {
  const key = hexToBytes(seed, 32);
  if (typeof domain !== 'string' || !domain.length) throw new TypeError('Randomness domain required');
  let counter = 0;
  return length => {
    if (!Number.isSafeInteger(length) || length < 1 || length > 65536) throw new RangeError('Invalid random byte count');
    const out = new Uint8Array(length);
    for (let offset = 0; offset < length; offset += 32) {
      const block = hmac(sha256, key, utf8(domain + ':' + counter++));
      out.set(block.subarray(0, Math.min(32, length - offset)), offset);
    }
    return out;
  };
}

export function createTrader(role, { mode, offerId, terms, registry, nonce, entropy, now, networkId, requireAddressProof = addressProofRequired(registry) }) {
  if (!['buyer', 'seller'].includes(role) || !['maker', 'taker'].includes(mode) || !Number.isSafeInteger(now) || now < 0) throw new TypeError('Invalid trader configuration');
  const draft = validateTerms(terms), reg = registrySchema.parse(registry);
  if (!validTermsAddressProofs(draft, { networkId, now, required: requireAddressProof })) throw new Error('Invalid Trac address proof');
  const pair = registryPair(reg, draft.pair);
  if (!meetsVersion(SOFTWARE, reg.minSoftware)) throw new Error('update required');
  if (stableJSON(draft.base) !== stableJSON(pair.base) || BigInt(draft.baseAmount) < BigInt(pair.minBaseAmount)) throw new Error('Invalid registry pair');
  for (const key of [offerId, nonce, entropy]) hexKey.parse(key);
  if (draft.offerId !== offerId) throw new Error('Terms do not match offer');
  if (nonce === entropy) throw new Error('Private dealing entropy must differ from revealed nonce');
  if (draft.registryVersion !== reg.version || draft.k !== reg.params.k ||
      draft.committee.length !== reg.params.n || draft.graceSec !== reg.params.graceSec ||
      draft.fees.platformFeeBps !== reg.fee.platformFeeBps || draft.fees.tradeFeeBps !== reg.fee.tradeFeeBps || draft.fees.collector !== reg.fee.collector ||
      draft.fees.signerShareBps !== reg.fee.signerShareBps || now >= draft.sendBy) throw new Error('Terms do not match registry or time');
  return { role, mode, offerId, draft, registry: reg, nonce, entropy, now, phase: 'new',
    requireAddressProof,
    self: draft[role].dexKey, peer: draft[role === 'buyer' ? 'seller' : 'buyer'].dexKey,
    terms: null, tradeId: null, peerCommit: null, peerNonce: null, acks: [], shares: [], locked: false };
}

export function sendAction(state, kind, body) {
  return { type: 'send', ch: 'intercom-dex:t:' + (body.tradeId ?? state.offerId), kind, body: parseBody(kind, body) };
}

export function abortTransition(state, reason) {
  return { state: { ...state, phase: 'aborted', reason }, actions: [{ type: 'abort', tradeId: state.tradeId, reason }] };
}

export function refusalReason(state, reason) {
  if (reason === 'seller-struck') return state.role === 'seller'
    ? 'Signers refused: your wallet is paused after unsent trades; contact the venue'
    : 'The seller is paused after unsent trades; contact the venue';
  if (state.role !== 'seller') return 'The seller cannot deliver this trade right now';
  const t = state.terms ?? state.draft, scale = 10n ** BigInt(t.base.decimals), units = BigInt(t.baseAmount);
  const fraction = (units % scale).toString().padStart(t.base.decimals, '0').replace(/0+$/, '');
  return `Signers refused: your wallet does not hold ${units / scale}${fraction ? '.' + fraction : ''} ${t.base.id} + TNK fee (or its balance could not be read)`;
}

// The peer may hear the refusal first. Keep the local party's explanation when its courtesy abort arrives first.
export function peerAbortReason(state, reason) {
  if (/^(The seller cannot deliver this trade right now|Signers refused: your wallet does not hold )/.test(reason)) return refusalReason(state, 'seller-funds');
  if (/^(The seller is paused after unsent trades|Signers refused: your wallet is paused after unsent trades)/.test(reason)) return refusalReason(state, 'seller-struck');
  return 'Peer aborted: ' + reason;
}

export function eventState(state, event) {
  if (!event || !Number.isSafeInteger(event.now) || event.now < state.now) throw new Error('Invalid or regressing event time');
  return { ...structuredClone(state), now: event.now };
}

export function runStep(state, event, advance) {
  try {
    const s = eventState(state, event);
    if (event.type !== 'message' && event.tradeId !== undefined && event.tradeId !== state.tradeId) return { state, actions: [] };
    const message = verifiedMessage(s, event);
    const stage = budgetStage(s);
    const elapsed = Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0 ? event.elapsedMs : 0;
    if (stage) s.stepElapsedMs = Number.isFinite(event.stepElapsedMs) && event.stepElapsedMs >= 0 ? event.stepElapsedMs : (s.stepElapsedMs ?? 0) + elapsed;
    if (event.type === 'resume' && stage) {
      s.stepElapsedMs = 0; s.connectedAtMs = null;
      s.workingElapsedMs = 0;
    }
    if (s.phase === 'awaitAccept' && s.connectedAtMs == null && event.makerConnected === true) {
      s.connectedAtMs = Math.max(0, s.stepElapsedMs - (event.makerConnectedElapsedMs ?? 0));
    }
    const expired = () => stage && (s.stepElapsedMs >= budgetLimit(s, stage) ||
      (s.phase === 'awaitAccept' && s.connectedAtMs != null && s.stepElapsedMs - s.connectedAtMs >= STEP_BUDGET_MS.accept));
    const timedOut = expired();
    const timeoutState = timedOut ? structuredClone(s) : null;
    let result;
    if (['tick', 'resume'].includes(event.type) && timedOut) result = abortTransition(s, stage === 'acks' ? 'Signers did not confirm' : 'Timed out: ' + stage);
    else {
      result = advance(s, event, message);
      if (result && timedOut) result = abortTransition(timeoutState, stage === 'acks' ? 'Signers did not confirm' : 'Timed out: ' + stage);
    }
    if (!result && event.type === 'tick' && stage) result = { state: s, actions: [] };
    if (!result) return { state, actions: [] };
    const nextStage = budgetStage(result.state);
    if (nextStage !== stage) result.state.stepElapsedMs = 0;
    result.state.stepStage = nextStage;
    if (result.state.phase === 'awaitAccept' && result.state.connectedAtMs == null && event.makerConnected === true) result.state.connectedAtMs = 0;
    const sent = result.actions.filter(a => a.type === 'send');
    if (sent.length) result.state.lastMessages = structuredClone(sent);
    return result;
  } catch {
    // Malformed input and failed validation never cancel an existing trade.
    return { state, actions: [] };
  }
}

function budgetStage(s) {
  if (s.lockAttempted || s.locked) return null;
  if (['awaitTake', 'awaitAccept'].includes(s.phase)) return 'take/accept';
  if (['awaitReveal', 'awaitRandomness'].includes(s.phase)) return 'deciding block';
  if (['awaitTerms', 'awaitTermsSig', 'awaitTermsSignatures'].includes(s.phase)) return 'terms signatures';
  if (['awaitCertificate', 'preparingDeal', 'proving', 'awaitDeal'].includes(s.phase)) return 'deal';
  if (s.phase === 'awaitAcks') return 'acks';
  // Once the seller received the dealing, a lock can land: only sendBy or the buyer's abort ends the wait.
  return null;
}

function budgetLimit(s, stage) {
  return ({ 'take/accept': s.phase === 'awaitAccept' ? STEP_BUDGET_MS.connect : STEP_BUDGET_MS.accept,
    'deciding block': STEP_BUDGET_MS.randomness, 'terms signatures': s.role === 'signer' ? STEP_BUDGET_MS.terms : STEP_BUDGET_MS.termsExchange,
    deal: s.role === 'buyer' ? STEP_BUDGET_MS.certificate : s.dealBudgetMs ?? STEP_BUDGET_MS.deal, acks: STEP_BUDGET_MS.acks })[stage];
}

export function resumeActions(state, outstanding = []) {
  return { state, actions: [...structuredClone(state.lastMessages ?? []), ...outstanding] };
}

export function verifiedMessage(state, event) {
  if (event.type !== 'message') return null;
  // The runner must call envelope.open before delivering this event.
  const m = event.message;
  if (!m || m.v !== 1) throw new Error('Verified envelope required');
  hexKey.parse(m.from);
  if (m.kind !== 'deal') parseBody(m.kind, m.body);
  if (m.body.tradeId !== undefined && m.body.tradeId !== state.tradeId &&
      !(m.kind === 'abort' && m.body.tradeId === state.offerId)) throw new Error('Wrong trade id');
  if (m.body.offerId !== undefined && m.body.offerId !== state.offerId) throw new Error('Wrong offer id');
  const ch = 'intercom-dex:t:' + (m.body.tradeId ?? state.offerId);
  if (m.ch !== ch && !(m.kind === 'sharePublish' && m.ch === 'intercom-dex:signers')) throw new Error('Wrong trade channel');
  const terms = state.terms ?? state.draft;
  if (m.kind === 'sharePublish' && m.body.commitments.length !== terms.k) throw new Error('Invalid publication dimensions');
  let allowed = false;
  if (['take', 'accept', 'decline', 'reveal', 'terms'].includes(m.kind)) allowed = m.from === state.peer;
  if (m.kind === 'termsSig' || m.kind === 'abort') allowed = state.role === 'signer'
    ? [terms.buyer.dexKey, terms.seller.dexKey].includes(m.from) : m.from === state.peer;
  if (['deal', 'working', 'refunded'].includes(m.kind)) allowed = m.from === terms.buyer.dexKey;
  if (['transferSent', 'claimed'].includes(m.kind)) allowed = m.from === terms.seller.dexKey;
  if (['ack', 'refused'].includes(m.kind)) allowed = !!state.terms?.committee.some(member => member.dexKey === m.from);
  if (m.kind === 'sharePublish') allowed = state.terms?.committee[m.body.signerIndex - 1]?.dexKey === m.from;
  if (!allowed) throw new Error('Unauthorized message sender or kind');
  if (['accept', 'reveal'].includes(m.kind) &&
      m.body.takeCommitment !== (state.mode === 'taker' ? sha256Hex(hexToBytes(state.nonce, 32)) : state.peerCommit)) throw new Error('Wrong take commitment');
  if (m.kind === 'abort' && m.body.commitment &&
      m.body.commitment !== (state.mode === 'taker' ? sha256Hex(hexToBytes(state.nonce, 32)) : state.peerCommit)) throw new Error('Wrong take commitment');
  return m;
}

function participant(draft, role) {
  const p = draft[role];
  return { dexKey: p.dexKey, tracAddr: p.tracAddr, solAddr: p.solPayer ?? p.solRecipient,
    ...(p.tracProof ? { tracProof: p.tracProof } : {}) };
}

export function negotiationStep(state, event, message) {
  const s = structuredClone(state), actions = [];
  if (message?.kind === 'decline' && s.phase === 'awaitAccept' &&
      message.body.takeNonce === s.takeNonce) return abortTransition(s, message.body.reason);
  if (s.phase === 'awaitReveal' && event.type === 'tick' && freshChainView(event) &&
      event.tipSlot >= s.acceptSlot + RANDOMNESS.REVEAL_CUTOFF) return abortTransition(s, 'Reveal arrived too late');
  if (s.phase === 'new' && event.type === 'tick') {
    if (s.mode === 'maker') s.phase = 'awaitTake';
    else {
      if (event.eligibleOnline !== undefined && event.eligibleOnline < s.draft.k + 1) return abortTransition(s, 'Not enough signers online');
      s.phase = 'awaitAccept';
      actions.push(sendAction(s, 'take', { offerId: s.offerId, baseAmount: s.draft.baseAmount,
        pair: s.draft.pair, registryVersion: s.registry.version, software: SOFTWARE,
        taker: participant(s.draft, s.role), commitment: sha256Hex(hexToBytes(s.nonce, 32)),
        sendBy: s.draft.sendBy, refundAfter: s.draft.refundAfter }));
    }
    return { state: s, actions };
  }
  if (message && ['take', 'accept', 'reveal', 'terms', 'termsSig'].includes(message.kind)) {
    if (message.from !== s.peer) throw new Error('Unexpected negotiation sender');
    const b = message.body;
    if (['take', 'accept', 'reveal'].includes(message.kind) && b.offerId !== s.offerId) throw new Error('Wrong offer');
    if (['take', 'accept', 'reveal'].includes(message.kind) &&
        !freshChainView(event)) return null;
    if (message.kind === 'take') {
      if (s.phase !== 'awaitTake' || s.mode !== 'maker') throw new Error('Invalid take');
      // This maker trade exists only for this take, so a mismatching take ends it with a reason the taker receives.
      if (b.baseAmount !== s.draft.baseAmount ||
          b.pair !== s.draft.pair || b.registryVersion !== s.registry.version || !meetsVersion(b.software, s.registry.minSoftware) ||
          b.sendBy !== s.draft.sendBy || b.refundAfter !== s.draft.refundAfter ||
          stableJSON(b.taker) !== stableJSON(participant(s.draft, s.role === 'buyer' ? 'seller' : 'buyer'))) {
        s.peerCommit = b.commitment;
        return abortTransition(s, 'Invalid take');
      }
      if (event.eligibleOnline !== undefined && event.eligibleOnline < s.draft.k + 1) return abortTransition(s, 'Not enough signers online');
      s.peerCommit = b.commitment;
      // The newest slot, not the finalized one: on mainnet finalization trails the tip by about 32 slots, which would
      // leave the reveal only a few seconds before the cutoff.
      s.acceptSlot = event.tipSlot;
      s.phase = 'awaitReveal';
      actions.push(sendAction(s, 'accept', { offerId: s.offerId, takeCommitment: s.peerCommit, commitment: sha256Hex(hexToBytes(s.nonce, 32)), slot: s.acceptSlot }),
        sendAction(s, 'reveal', { offerId: s.offerId, takeCommitment: s.peerCommit, nonce: s.nonce }));
    } else if (message.kind === 'accept') {
      if (s.phase !== 'awaitAccept' || s.mode !== 'taker') throw new Error('Unexpected accept');
      // The accept slot must be a recent finalized slot (see RANDOMNESS in terms.js), not one chosen to make the
      // randomness block already known, nor so far ahead that the trade stalls.
      if (b.slot < event.observedSlot - ACCEPT_SLOT_BEHIND || b.slot > event.observedSlot + 150) return abortTransition(s, 'Accept slot outside the freshness window');
      if (event.tipSlot >= b.slot + RANDOMNESS.REVEAL_CUTOFF) return abortTransition(s, 'Accept arrived too late');
      s.peerCommit = b.commitment;
      s.acceptSlot = b.slot;
      s.phase = 'awaitReveal';
      actions.push(sendAction(s, 'reveal', { offerId: s.offerId, takeCommitment: sha256Hex(hexToBytes(s.nonce, 32)), nonce: s.nonce }));
    } else if (message.kind === 'reveal') {
      if (s.phase !== 'awaitReveal' || sha256Hex(hexToBytes(b.nonce, 32)) !== s.peerCommit) throw new Error('Invalid reveal');
      // A reveal accepted later could have been withheld until the randomness block existed; refuse it.
      if (event.tipSlot >= s.acceptSlot + RANDOMNESS.REVEAL_CUTOFF) return abortTransition(s, 'Reveal arrived too late');
      s.peerNonce = b.nonce;
      s.phase = 'awaitRandomness';
      actions.push({ type: 'persist', scope: 'reveals', tradeId: null, record: { offerId: s.offerId, acceptSlot: s.acceptSlot } });
    } else if (message.kind === 'terms') {
      if (s.phase !== 'awaitTerms' || stableJSON(b.terms) !== stableJSON(s.terms) || b.tradeId !== tradeId(b.terms)) throw new Error('Terms disagreement');
      if (event.onlineSigners && s.terms.committee.filter(c => event.onlineSigners.includes(c.dexKey)).length < s.terms.k + 1) {
        return abortTransition(s, 'Not enough committee signers online');
      }
      s.phase = 'awaitTermsSig';
      actions.push(sendAction(s, 'termsSig', { tradeId: s.tradeId }));
    } else {
      if (s.phase !== 'awaitTermsSig') throw new Error('Unexpected terms signature');
      s.phase = 'negotiated';
    }
    return { state: s, actions };
  }
  if (s.phase === 'awaitRandomness' && event.type === 'tick' && event.chain) {
    if (event.chain.acceptSlot !== s.acceptSlot || event.chain.firstFinalized !== true) throw new Error('Wrong committed randomness slot');
    const R = tradeRandomness({ ...event.chain, makerNonce: s.mode === 'maker' ? s.nonce : s.peerNonce,
      takerNonce: s.mode === 'taker' ? s.nonce : s.peerNonce });
    const committee = selectCommittee(s.registry, R, { n: s.registry.params.n, k: s.registry.params.k,
      quoteAmount: s.draft.quoteAmount, pair: s.draft.pair, exclude: [s.self, s.peer] }).map(({ dexKey, boxKey }) => ({ dexKey, boxKey }));
    s.terms = validateTerms({ ...s.draft, committee, R });
    s.tradeId = tradeId(s.terms);
    if (event.onlineSigners && committee.filter(c => event.onlineSigners.includes(c.dexKey)).length < s.terms.k + 1) {
      return abortTransition(s, 'Not enough committee signers online');
    }
    s.phase = 'awaitTerms';
    actions.push(sendAction(s, 'terms', { tradeId: s.tradeId, terms: s.terms }));
    return { state: s, actions };
  }
  return null;
}

// Negotiation messages are judged only against a fresh view of the chain: the latest finalized slot and the tip.
function freshChainView(e) {
  const fresh = (slot, age, maxAge) => Number.isSafeInteger(slot) && slot >= 0 && Number.isFinite(age) && age >= 0 && age < maxAge;
  return fresh(e.observedSlot, e.finalizedAgeMs, RANDOMNESS.FINALIZED_MAX_AGE_MS) && fresh(e.tipSlot, e.tipAgeMs, RANDOMNESS.TIP_MAX_AGE_MS);
}
