import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuyer, step as buyerStep } from '../../../src/core/trade-buyer.js';
import { step as sellerStep } from '../../../src/core/trade-seller.js';
import { step as signerStep, rescueTrade, RESCUE_MARGIN_SEC } from '../../../src/core/trade-signer.js';
import { runStep, resumeActions } from '../../../src/core/trade-common.js';
import { seal, open, createReplayCache } from '../../../src/core/envelope.js';
import { sha256Hex, hexToBytes } from '../../../src/core/canonical.js';
import { parseBody } from '../../../src/core/schemas.js';
import { buildTerms, tradeRandomness, transferNonce } from '../../../src/core/terms.js';
import { buildRegistry } from '../../../src/core/registry.js';
import { fixture, hex, SIG } from './helpers.mjs';
import { simulation } from './simulation.mjs';

const steps = { buyer: buyerStep, seller: sellerStep, signer: signerStep };
function signed(identity, kind, body, id = body.tradeId ?? body.offerId, now = 101) {
  return open(seal({ kind, body, ch: 'intercom-dex:t:' + id }, identity.secretKey, { ts: now, nonce: hex() }),
    { now, seen: createReplayCache() });
}
function unchanged(state, event) {
  const result = steps[state.role](state, event);
  assert.ok(result.state === state, 'Ignored input must preserve the original state, including its clock');
  assert.equal(result.actions.length, 0);
}
function snap(sim, name, phase) {
  const value = sim.snapshots.get(name + ':' + phase);
  assert.ok(value, 'Missing phase snapshot: ' + name + ':' + phase);
  return structuredClone(value);
}

test('buyer-signed foreign-trade ack after payment changes nothing and the trade still settles', () => {
  const sim = simulation({ holdVerify: true }), seller = sim.state('seller');
  const before = new Map([...sim.nodes].map(([name, node]) => [name, node.state]));
  sim.deliver('buyer', 'ack', { tradeId: hex(), H: seller.H, holdUntil: seller.terms.refundAfter }, 'intercom-dex:t:' + seller.tradeId);
  sim.drain();
  for (const [name, state] of before) assert.ok(sim.state(name) === state, name + ' changed');
  sim.releaseVerifications();
  assert.equal(sim.state('seller').phase, 'complete');
  assert.equal(sim.state('buyer').phase, 'complete');
  assert.equal(sim.count('publishShare'), 5);
  assert.equal(sim.count('abort'), 0);
});

test('malformed, misrouted, wrong-sender, unrelated and wrong-phase messages are harmless in every captured phase', () => {
  const sim = simulation({ capturePhases: true });
  for (const state of sim.snapshots.values()) {
    const ref = state.tradeId ?? state.offerId;
    const b = { tradeId: state.tradeId ?? hex(), H: hex(), holdUntil: 90000 };
    const wrongSender = signed(sim.f.buyer, 'ack', b, ref);
    const wrongTrade = signed(sim.f.seller, 'abort', { tradeId: hex(), reason: 'foreign' }, ref);
    for (const message of [null, {}, wrongSender, wrongTrade, { ...wrongSender, body: { ...b, extra: true } },
      { ...wrongSender, ch: 'wrong-channel' }, { ...wrongSender, kind: 'unknown' }]) {
      unchanged(state, { type: 'message', now: state.now + 1, message });
    }
    unchanged(state, { type: 'unexpected', now: state.now + 1 });
    unchanged(state, { type: 'claimed', now: state.now + 1, tradeId: hex(), ok: true, claimSignature: SIG });
  }
});

test('sender authority is exact for dealings, transfers, settlement and indexed shares', () => {
  const sim = simulation({ capturePhases: true });
  const seller = snap(sim, 'seller', 'awaitShares'), buyer = snap(sim, 'buyer', 'locked');
  const signer = snap(sim, 'signer1', 'holding'), id = seller.tradeId;
  const samples = [
    [snap(sim, 'seller', 'awaitDeal'), sim.f.seller, 'deal', seller.deal],
    [snap(sim, 'signer1', 'awaitDeal'), sim.f.seller, 'deal', seller.deal],
    [signer, sim.f.buyer, 'transferSent', { tradeId: id, txHash: hex() }],
    [buyer, sim.f.buyer, 'claimed', { tradeId: id, claimSignature: SIG }],
    [signer, sim.f.seller, 'refunded', { tradeId: id, refundSignature: SIG }],
    [snap(sim, 'seller', 'awaitReady'), sim.f.buyer, 'ack', { tradeId: id, H: seller.H, holdUntil: seller.terms.refundAfter }],
    [seller, sim.nodes.get('signer2').identity, 'sharePublish', { tradeId: id, H: seller.H, signerIndex: 1, share: signer.share, commitments: seller.deal.commitments }],
  ];
  for (const [state, identity, kind, body] of samples) unchanged(state, { type: 'message', now: 101, message: signed(identity, kind, body) });
  const validShare = signed(sim.nodes.get('signer1').identity, 'sharePublish', { tradeId: id, H: seller.H, signerIndex: 1, share: signer.share, commitments: seller.deal.commitments });
  const once = sellerStep(seller, { type: 'message', now: 101, message: validShare });
  assert.equal(once.state.shares.length, 1);
  unchanged(once.state, { type: 'message', now: 102, message: validShare });
  const invalidShare = signed(sim.nodes.get('signer2').identity, 'sharePublish', { tradeId: id, H: seller.H, signerIndex: 2, share: 'ff'.repeat(32), commitments: seller.deal.commitments });
  unchanged(once.state, { type: 'message', now: 102, message: invalidShare });
});

test('peer aborts and definite failures terminate only before each role commits', () => {
  const sim = simulation({ capturePhases: true });
  for (const [name, phase, identity] of [['buyer', 'proving', sim.f.seller], ['seller', 'awaitReady', sim.f.buyer], ['signer1', 'persistingShare', sim.f.buyer]]) {
    const s = snap(sim, name, phase), abort = signed(identity, 'abort', { tradeId: s.tradeId, reason: 'cancel' });
    assert.equal(steps[s.role](s, { type: 'message', now: 101, message: abort }).state.phase, 'aborted');
    assert.equal(steps[s.role](s, { type: 'error', now: 101, tradeId: s.tradeId, definite: true, reason: 'definite' }).state.phase, 'aborted');
    unchanged(s, { type: 'error', now: 101, tradeId: s.tradeId, unknown: true, reason: 'ambiguous' });
  }
  for (const [name, phase, identity] of [['buyer', 'locked', sim.f.seller], ['seller', 'transferring', sim.f.buyer], ['signer1', 'holding', sim.f.buyer]]) {
    const s = snap(sim, name, phase), abort = signed(identity, 'abort', { tradeId: s.tradeId, reason: 'cancel' });
    unchanged(s, { type: 'message', now: 101, message: abort });
    if (name === 'seller') {
      const r = sellerStep(s, { type: 'error', now: 101, tradeId: s.tradeId, definite: true, reason: 'late failure' });
      assert.equal(r.state.phase, 'transferring'); assert.equal(r.state.transferRetryAt, 111);
    } else unchanged(s, { type: 'error', now: 101, tradeId: s.tradeId, definite: true, reason: 'late failure' });
  }
});

test('a transfer that was never submitted is retried as a resume until the deadline, then the seller ends', () => {
  const sim = simulation({ capturePhases: true }), s = snap(sim, 'seller', 'transferring'), sendBy = s.terms.sendBy;
  const bare = { type: 'transferSent', tradeId: s.tradeId, ok: false, reason: 'gateway down' };
  const waiting = sellerStep(s, { ...bare, now: sendBy - 30 }).state;
  assert.equal(waiting.phase, 'transferring');
  const retry = sellerStep(waiting, { type: 'tick', now: sendBy - 20 });
  assert.deepEqual(retry.actions.map(a => [a.type, a.resume]), [['sendTransfer', true]]);
  const late = sellerStep(s, { ...bare, now: sendBy });
  assert.equal(late.state.phase, 'aborted'); assert.match(late.state.reason, /not sent before the deadline/);
});

test('resume restores every outstanding action and retransmits the last protocol messages', () => {
  const sim = simulation({ capturePhases: true });
  const refund = simulation({ neverSend: true, capturePhases: true });
  refund.dispatch('buyer', { type: 'tick', now: refund.state('buyer').terms.refundAfter }); refund.drain();
  const cases = [
    [snap(sim, 'buyer', 'proving'), 'prove'], [snap(sim, 'seller', 'checkingProof'), 'checkProof'],
    [snap(sim, 'signer1', 'checkingProof'), 'checkProof'],
    [snap(sim, 'buyer', 'locking'), 'lockEscrow'], [snap(refund, 'buyer', 'refunding'), 'refund'],
    [snap(sim, 'seller', 'awaitReady'), 'checkEscrow'], [snap(sim, 'seller', 'transferring'), 'sendTransfer'],
    [snap(sim, 'seller', 'claiming'), 'claim'], [snap(sim, 'signer1', 'persistingShare'), 'persist'],
    [snap(sim, 'signer1', 'verifyingTransfer'), 'verifyTransfer'], [snap(sim, 'signer1', 'persistingTransfer'), 'persist'],
    [snap(sim, 'signer1', 'published'), 'publishShare'],
  ];
  for (const [original, type] of cases) {
    const s = JSON.parse(JSON.stringify(original)), before = JSON.stringify(s);
    const result = steps[s.role](s, { type: 'resume', now: s.now + 1 });
    const action = result.actions.find(a => a.type === type);
    assert.ok(action, s.role + ':' + s.phase + ' did not resume ' + type);
    assert.equal(result.state.phase, s.phase);
    assert.ok(JSON.stringify(s) === before, 'Resume mutated its input');
    if (type === 'sendTransfer') assert.equal(action.resume, true);
    if (type === 'claim') assert.ok(action.preimageHex === s.preimageHex);
    if (type === 'checkEscrow') { assert.equal(result.state.checkInFlight, true); assert.equal(result.state.escrowOk, false); }
    if (s.phase !== 'published') assert.deepEqual(result.actions.filter(a => a.type === 'send'), s.lastMessages ?? []);
    else assert.deepEqual(action.channels, ['intercom-dex:t:' + s.tradeId, 'intercom-dex:signers']);
  }
  for (const [name, phase] of [['buyer', 'awaitAccept'], ['seller', 'awaitReveal'], ['buyer', 'awaitTermsSig'],
    ['signer1', 'holding'], ['seller', 'awaitShares']]) {
    const s = snap(sim, name, phase), result = steps[s.role](s, { type: 'resume', now: 101 });
    assert.ok(result.actions.some(a => a.type === 'send'), phase + ' did not retransmit');
    assert.deepEqual(result.actions, s.lastMessages);
  }
});

test('resumed transfer intent reconciles instead of authorizing a fresh payment', () => {
  const sim = simulation({ neverSend: true });
  const s = sim.state('seller'), deadline = s.terms.refundAfter;
  const resumed = sellerStep(JSON.parse(JSON.stringify(s)), { type: 'resume', now: deadline + 1 });
  const action = resumed.actions.find(a => a.type === 'sendTransfer');
  assert.equal(action.resume, true);
  assert.equal(action.tradeId, s.tradeId);
  assert.equal(action.sendBy, s.terms.sendBy);
  assert.equal(resumed.state.phase, 'transferring');
});

test('ambiguous transfer submission posts its known hash and still completes', () => {
  const sim = simulation({ transferUnknown: true });
  assert.equal(sim.state('seller').transferUnknown, true);
  assert.equal(sim.state('seller').phase, 'complete');
  assert.equal(sim.count('sendTransfer'), 1);
  assert.equal(sim.count('publishShare'), 5);
  const sent = sim.log.find(x => x.name === 'seller' && x.action.kind === 'transferSent');
  assert.equal(sent.action.body.txHash, sim.state('seller').txHash);
});

test('ambiguous escrow lock arms refund even without a hash in the result', () => {
  const sim = simulation({ lockUnknown: true, neverSend: true });
  const s = sim.state('buyer');
  assert.equal(s.phase, 'locked'); assert.equal(s.locked, true); assert.equal(s.lockUnknown, true);
  sim.dispatch('buyer', { type: 'tick', now: s.terms.refundAfter }); sim.drain();
  assert.equal(sim.state('buyer').phase, 'refunded'); assert.equal(sim.count('refund'), 1);
});

test('malformed/foreign ambiguous callbacks are ignored and definite precommit lock failure aborts', () => {
  const sim = simulation({ capturePhases: true }), buyer = snap(sim, 'buyer', 'locking'), seller = snap(sim, 'seller', 'transferring');
  for (const e of [{ type: 'escrowLocked', tradeId: hex(), ok: false, unknown: true },
    { type: 'escrowLocked', tradeId: buyer.tradeId, hashHex: hex(), ok: false, unknown: true }]) unchanged(buyer, { ...e, now: 101 });
  for (const e of [{ type: 'transferSent', tradeId: seller.tradeId, ok: false, unknown: true },
    { type: 'transferSent', tradeId: hex(), ok: false, unknown: true, txHash: hex() }]) unchanged(seller, { ...e, now: 101 });
  assert.equal(buyerStep(buyer, { type: 'escrowLocked', now: 101, tradeId: buyer.tradeId, ok: false }).state.phase, 'aborted');
});

test('maker signs accept.slot before either reveal, and reveal cannot carry a replacement slot', () => {
  const sim = simulation({ capturePhases: true });
  const messages = sim.log.filter(x => x.action.type === 'send');
  const acceptIndex = messages.findIndex(x => x.action.kind === 'accept');
  assert.equal(messages[acceptIndex].action.body.slot, 132);
  assert.ok(messages.every((x, i) => x.action.kind !== 'reveal' || i > acceptIndex));
  for (const x of messages.filter(x => x.action.kind === 'reveal')) {
    assert.equal(Object.hasOwn(x.action.body, 'slot'), false);
    assert.throws(() => parseBody('reveal', { ...x.action.body, slot: 999 }));
  }
  assert.equal(sim.state('buyer').acceptSlot, 132);
  assert.equal(sim.state('seller').acceptSlot, 132);
});

test('taker only accepts a slot whose randomness block is still ahead (-50 .. +150) and ignores malformed accept messages', () => {
  const f = fixture(), config = { mode: 'taker', offerId: f.offerId, terms: f.terms, registry: f.registry, nonce: hex(), entropy: hex(), now: 100 };
  const initial = createBuyer(config), s = buyerStep(initial, { type: 'tick', now: 100 }).state;
  for (const [slot, expected] of [[949, 'aborted'], [950, 'awaitReveal'], [1000, 'awaitReveal'], [1150, 'awaitReveal'], [1151, 'aborted']]) {
    const m = signed(f.seller, 'accept', { offerId: f.offerId, takeCommitment: sha256Hex(hexToBytes(s.nonce, 32)), commitment: hex(), slot });
    const r = buyerStep(s, { type: 'message', now: 101, finalizedAgeMs: 0, observedSlot: 1000, tipSlot: 1002, tipAgeMs: 0, message: m });
    assert.equal(r.state.phase, expected);
    if (expected === 'awaitReveal') assert.equal(r.state.acceptSlot, slot);
    else assert.match(r.state.reason, /freshness window/);
  }
  // Inside the window but too old for the reveal cutoff at the taker's tip: still refused.
  const old = signed(f.seller, 'accept', { offerId: f.offerId, takeCommitment: sha256Hex(hexToBytes(s.nonce, 32)), commitment: hex(), slot: 976 });
  assert.equal(buyerStep(s, { type: 'message', now: 101, finalizedAgeMs: 0, observedSlot: 1000, tipSlot: 1032, tipAgeMs: 0, message: old }).state.reason, 'Accept arrived too late');
  const m = signed(f.seller, 'accept', { offerId: f.offerId, takeCommitment: sha256Hex(hexToBytes(s.nonce, 32)), commitment: hex(), slot: 1000 });
  unchanged(s, { type: 'message', now: 101, message: m });
  unchanged(s, { type: 'message', now: 101, finalizedAgeMs: 0, observedSlot: -1, tipSlot: 31, tipAgeMs: 0, message: m });
  const { slot, ...oldBody } = m.body;
  unchanged(s, { type: 'message', now: 101, finalizedAgeMs: 0, observedSlot: 1000, tipSlot: 1032, tipAgeMs: 0, message: { ...m, body: oldBody } });
  const late = { ...s, phase: 'locked', locked: true, terms: f.terms };
  unchanged(late, { type: 'message', now: 101, finalizedAgeMs: 0, observedSlot: 1, tipSlot: 33, tipAgeMs: 0, message: m });
});

test('the maker refuses a taker reveal that arrives when the randomness block is nearly final', () => {
  const sim = simulation({ capturePhases: true }), s = snap(sim, 'seller', 'awaitReveal'), nonce = hex();
  s.peerCommit = sha256Hex(hexToBytes(nonce, 32));
  const reveal = signed(sim.f.buyer, 'reveal', { offerId: s.offerId, takeCommitment: s.peerCommit, nonce });
  assert.equal(sellerStep(s, { type: 'message', now: 101, finalizedAgeMs: 0, observedSlot: s.acceptSlot + 23, tipSlot: s.acceptSlot + 23 + 32, tipAgeMs: 0, message: reveal }).state.phase, 'awaitRandomness');
  const late = sellerStep(s, { type: 'message', now: 101, finalizedAgeMs: 0, observedSlot: s.acceptSlot + 24, tipSlot: s.acceptSlot + 24 + 32, tipAgeMs: 0, message: reveal }).state;
  assert.equal(late.phase, 'aborted'); assert.match(late.reason, /too late/);
});

test('only the committed slot +96 or later can supply randomness, and a reveal cannot replace it', () => {
  const sim = simulation({ capturePhases: true }), s = snap(sim, 'buyer', 'awaitRandomness');
  const chain = { acceptSlot: s.acceptSlot, slot: s.acceptSlot + 96, blockhash: hex(), firstFinalized: true, finalized: true };
  for (const bad of [{ ...chain, acceptSlot: s.acceptSlot + 1 }, { ...chain, slot: s.acceptSlot + 95 },
    { ...chain, firstFinalized: false }, { ...chain, finalized: false }]) unchanged(s, { type: 'tick', now: 101, chain: bad });
  const ready = buyerStep(s, { type: 'tick', now: 101, chain });
  assert.equal(ready.state.phase, 'awaitTerms');
  assert.equal(buyerStep(s, { type: 'tick', now: 101, chain: { ...chain, slot: chain.slot + 2 } }).state.phase, 'awaitTerms');
  assert.throws(() => tradeRandomness({ makerNonce: hex(), takerNonce: hex(), blockhash: hex(), slot: 42, acceptSlot: 10, finalized: true }));
  const awaiting = snap(sim, 'buyer', 'awaitReveal');
  const nonce = hex(), known = { ...awaiting, peerCommit: sha256Hex(hexToBytes(nonce)) };
  const reveal = signed(sim.f.seller, 'reveal', { offerId: known.offerId, takeCommitment: sha256Hex(hexToBytes(known.nonce, 32)), nonce });
  const revealed = buyerStep(known, { type: 'message', now: 101, finalizedAgeMs: 0, observedSlot: 999999, tipSlot: 1000031, tipAgeMs: 0, message: reveal });
  assert.equal(revealed.state.acceptSlot, known.acceptSlot);
  assert.equal(revealed.state.phase, 'aborted');
});

test('terms and registry require at least 600 seconds after transfer finality cutoff', () => {
  const f = fixture();
  for (const margin of [599, 600, 601]) {
    const terms = { ...f.terms, refundAfter: f.terms.sendBy + f.terms.graceSec + margin };
    const registry = { ...f.registry, params: { ...f.registry.params, refundSec: f.registry.params.sendWindowSec + f.registry.params.graceSec + margin } };
    if (margin < 600) { assert.throws(() => buildTerms(terms)); assert.throws(() => buildRegistry(registry)); }
    else { assert.doesNotThrow(() => buildTerms(terms)); assert.doesNotThrow(() => buildRegistry(registry)); }
  }
});

test('eligible verification survives late callbacks, reservation and publication', () => {
  const sim = simulation({ holdVerify: true, persistTransfer: false }), s = sim.state('signer1'), cutoff = s.terms.sendBy + s.terms.graceSec;
  sim.dispatch('signer1', { type: 'tick', now: cutoff + 1 }); sim.drain();
  assert.equal(sim.state('signer1').phase, 'verifyingTransfer');
  sim.releaseVerifications({ now: cutoff + 2, finalizedAt: cutoff - 1 });
  for (let i = 1; i <= 5; i++) {
    const name = 'signer' + i, pending = sim.state(name);
    assert.equal(pending.phase, 'persistingTransfer'); assert.equal(pending.finalizedAt, cutoff - 1);
    sim.dispatch(name, { type: 'persisted', now: cutoff + 10, tradeId: pending.tradeId, scope: 'verifiedTransfer',
      txHash: pending.txHash, reservedFor: pending.tradeId, ok: true });
  }
  sim.drain();
  assert.equal(sim.count('publishShare'), 5); assert.equal(sim.state('seller').phase, 'complete');
  const published = sim.state('signer1');
  assert.ok(signerStep(published, { type: 'resume', now: published.terms.refundAfter + 1 }).actions.some(a => a.type === 'publishShare'));
});

test('cutoff expires waiting for a transfer, but never destroys an eligible reservation', () => {
  const sim = simulation({ capturePhases: true }), holding = snap(sim, 'signer1', 'holding');
  const cutoff = holding.terms.sendBy + holding.terms.graceSec;
  const expired = signerStep(holding, { type: 'tick', now: cutoff });
  assert.equal(expired.state.phase, 'expired');
  const pending = snap(sim, 'signer1', 'persistingTransfer');
  assert.equal(signerStep(pending, { type: 'tick', now: cutoff + 1 }).state.phase, 'persistingTransfer');
});

test('late proof results cannot start funding; late network messages cannot start sending', () => {
  const sim = simulation({ capturePhases: true }), buyer = snap(sim, 'buyer', 'proving');
  const late = buyerStep(buyer, { type: 'proved', now: buyer.draft.sendBy, tradeId: buyer.tradeId, ok: true, proof: sim.state('seller').deal.proof });
  assert.equal(late.state.phase, 'aborted'); assert.ok(!late.actions.some(a => a.type === 'lockEscrow'));
  assert.equal(buyerStep(buyer, { type: 'tick', now: buyer.draft.sendBy }).state.phase, 'aborted');
  const seller = snap(sim, 'seller', 'awaitReady');
  const ack = signed(sim.nodes.get('signer1').identity, 'ack', { tradeId: seller.tradeId, H: seller.H, holdUntil: seller.terms.refundAfter });
  unchanged(seller, { type: 'message', now: seller.draft.sendBy, message: ack });
  const signer = snap(sim, 'signer1', 'checkingProof');
  const expired = signerStep(signer, { type: 'proofChecked', now: signer.terms.sendBy + signer.terms.graceSec, tradeId: signer.tradeId, ok: true });
  assert.equal(expired.state.phase, 'aborted'); assert.ok(!expired.actions.some(a => a.kind === 'ack'));
});

test('seller keeps claiming after refundAfter while the escrow is active', () => {
  const sim = simulation({ claimFailures: 2 }), s = sim.state('seller');
  assert.equal(s.phase, 'claiming');
  sim.dispatch('seller', { type: 'tick', now: s.terms.refundAfter + 1 }); sim.drain();
  assert.equal(sim.state('seller').phase, 'claiming');
  sim.dispatch('seller', { type: 'tick', now: s.terms.refundAfter + 20 }); sim.drain();
  assert.equal(sim.state('seller').phase, 'complete');
  assert.equal(sim.state('buyer').phase, 'complete');
  assert.equal(sim.count('claim'), 3); assert.equal(sim.count('abort'), 0);
});

test('only the claim adapter can report refunded escrow and move a committed seller to lost', () => {
  const sim = simulation({ claimFailures: 1 }), s = sim.state('seller');
  const notification = signed(sim.f.buyer, 'refunded', { tradeId: s.tradeId, refundSignature: SIG });
  unchanged(s, { type: 'message', now: 101, message: notification });
  unchanged(s, { type: 'claimed', now: 101, tradeId: s.tradeId, ok: true, status: 'refunded', claimSignature: SIG });
  assert.equal(sellerStep(s, { type: 'claimed', now: 101, tradeId: s.tradeId, ok: false, unknown: true, status: 'refunded' }).state.phase, 'claiming');
  const retry = sellerStep(s, { type: 'claimed', now: 101, tradeId: s.tradeId, ok: false, status: 'active' });
  assert.equal(retry.state.phase, 'claiming'); assert.equal(retry.state.claimRetryAt, 116);
  const lost = sellerStep(retry.state, { type: 'claimed', now: 102, tradeId: s.tradeId, ok: false, status: 'refunded' });
  assert.equal(lost.state.phase, 'lost'); assert.equal(lost.actions.length, 0);
  unchanged(lost.state, { type: 'tick', now: 200000 });
  unchanged(lost.state, { type: 'resume', now: 200000 });
});

test('step/recovery helpers preserve original state on validation failures and clone retransmissions', () => {
  const state = { now: 1, phase: 'waiting', lastMessages: [{ type: 'send', kind: 'test', body: { value: 1 } }] };
  assert.ok(runStep(state, { type: 'tick', now: 0 }, () => null).state === state);
  assert.ok(runStep(state, { type: 'tick', now: 2 }, () => { throw new Error('bad input'); }).state === state);
  assert.ok(runStep(state, { type: 'tick', now: 2 }, () => null).state === state);
  const resumed = resumeActions(state, [{ type: 'checkEscrow' }]);
  resumed.actions[0].body.value = 2;
  assert.equal(state.lastMessages[0].body.value, 1);
  assert.equal(resumed.actions[1].type, 'checkEscrow');
  assert.equal(resumeActions({}).actions.length, 0);
  assert.throws(() => resumeActions(state, null));
});

test('a signer never releases its share for an unverified transfer and ends once that is definite or too late', () => {
  const sim = simulation({ capturePhases: true }), s = snap(sim, 'signer1', 'verifyingTransfer');
  const cutoff = s.terms.sendBy + s.terms.graceSec, failed = { type: 'transferVerified', tradeId: s.tradeId, txHash: s.txHash, ok: false };
  unchanged(s, { ...failed, final: false, now: cutoff - 1 });
  for (const e of [{ ...failed, final: true, now: cutoff - 1 }, { ...failed, final: false, now: cutoff }]) {
    const r = signerStep(s, e);
    assert.equal(r.state.phase, 'expired');
    assert.ok(!r.actions.some(a => a.type === 'publishShare'));
  }
});

test('a failed refund is resolved from the escrow: claimed means complete, an unconfirmed lock that never landed ends the trade', () => {
  const sim = simulation({ capturePhases: true }), base = snap(sim, 'buyer', 'locked'), after = base.terms.refundAfter;
  const refunding = buyerStep(base, { type: 'tick', now: after }).state;
  assert.equal(refunding.phase, 'refunding');
  const failed = buyerStep(refunding, { type: 'refunded', now: after + 1, tradeId: base.tradeId, ok: false, reason: 'Cannot refund escrow: claimed' });
  assert.deepEqual(failed.actions.map(a => [a.type, a.purpose]), [['checkEscrow', 'settlement']]);
  const check = { type: 'escrowChecked', now: after + 2, tradeId: base.tradeId, hashHex: base.H, purpose: 'settlement' };
  assert.equal(buyerStep(failed.state, { ...check, ok: true, status: 'claimed' }).state.phase, 'complete');
  assert.equal(buyerStep(failed.state, { ...check, ok: false, status: 'missing' }).state.phase, 'refunding', 'a confirmed lock is never written off');
  const unsure = buyerStep(failed.state, { ...check, ok: false, status: 'missing' }).state;
  unsure.lockUnknown = true; unsure.settlementPending = true;
  const asked = buyerStep(unsure, { ...check, ok: false, status: 'missing' });
  assert.deepEqual(asked.actions.map(a => a.type), ['lockOutcome'], 'absence alone never ends it: the journal is asked');
  const outcome = { type: 'lockOutcome', now: after + 3, tradeId: base.tradeId };
  for (const o of ['unknown', 'landed']) assert.equal(buyerStep(asked.state, { ...outcome, outcome: o }).state.phase, 'refunding');
  const ended = buyerStep(asked.state, { ...outcome, outcome: 'none' }).state;
  assert.equal(ended.phase, 'aborted'); assert.equal(ended.locked, false);
});

test('an operator rescue re-checks a transfer that became final after the cutoff, until shortly before the refund', () => {
  const sim = simulation({ capturePhases: true }), verifying = snap(sim, 'signer1', 'verifyingTransfer');
  const t = verifying.terms, cutoff = t.sendBy + t.graceSec, until = t.refundAfter - RESCUE_MARGIN_SEC;
  const event = (now, patch = {}) => ({ type: 'transferVerified', now, tradeId: verifying.tradeId, txHash: verifying.txHash, asset: t.base.id,
    amount: t.baseAmount, from: t.seller.tracAddr, to: t.buyer.tracAddr, nonce: transferNonce(verifying.tradeId), ...patch });
  const expired = signerStep(verifying, event(cutoff + 100, { ok: false, final: true, finalizedAt: cutoff + 90, reason: 'finality_deadline' })).state;
  assert.equal(expired.phase, 'expired');
  assert.equal(rescueTrade(verifying, cutoff + 200), null, 'only expired trades');
  assert.equal(rescueTrade(expired, until), null, 'not within the margin before the refund');
  const rescued = rescueTrade(expired, cutoff + 200);
  assert.equal(rescued.phase, 'verifyingTransfer'); assert.equal(rescued.rescueUntil, until);
  const verify = signerStep(rescued, { type: 'resume', now: cutoff + 200 }).actions.find(a => a.type === 'verifyTransfer');
  assert.equal(verify.finalBefore, until);
  const phase = e => signerStep(rescued, e)?.state.phase ?? rescued.phase;
  assert.equal(phase(event(cutoff + 210, { ok: false, final: false })), 'verifyingTransfer', 'keeps waiting');
  assert.equal(phase(event(cutoff + 210, { ok: true, final: true, finalizedAt: until })), 'verifyingTransfer', 'final too late is not accepted');
  assert.equal(phase(event(cutoff + 210, { ok: true, final: true, finalizedAt: cutoff + 90, amount: '1' })), 'verifyingTransfer', 'wrong amount is not accepted');
  const pending = signerStep(rescued, event(cutoff + 210, { ok: true, final: true, finalizedAt: cutoff + 90 })).state;
  assert.equal(pending.phase, 'persistingTransfer');
  assert.equal(signerStep(rescued, event(until, { ok: false, final: false })).state.phase, 'expired', 'expires again at the rescue deadline');
});
