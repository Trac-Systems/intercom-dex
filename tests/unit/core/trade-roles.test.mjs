import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuyer, step as buyerStep } from '../../../src/core/trade-buyer.js';
import { createSeller, step as sellerStep } from '../../../src/core/trade-seller.js';
import { createSigner, step as signerStep } from '../../../src/core/trade-signer.js';
import { seededRng, createTrader, sendAction, abortTransition, eventState, verifiedMessage, negotiationStep } from '../../../src/core/trade-common.js';
import { seal, open, createReplayCache } from '../../../src/core/envelope.js';
import { prepareDeal, checkDealShape } from '../../../src/core/dealing.js';
import { tradeId } from '../../../src/core/terms.js';
import { fixture, hex, proofStub } from './helpers.mjs';
import { simulation } from './simulation.mjs';
import { sha256Hex, hexToBytes } from '../../../src/core/canonical.js';

function config(f) { return { mode: 'taker', offerId: f.offerId, terms: f.terms, registry: f.registry, nonce: hex(), entropy: hex(), now: 100 }; }
function message(kind, body, identity, id, now = 100) {
  return open(seal({ kind, body, ch: 'intercom-dex:t:' + id }, identity.secretKey, { ts: now, nonce: hex() }), { now, seen: createReplayCache() });
}

test('trader constructors enforce registry terms, role, deadlines and entropy', () => {
  const f = fixture(), c = config(f);
  for (const create of [createBuyer, createSeller]) {
    assert.equal(create(c).phase, 'new');
    for (const bad of [{ ...c, mode: 'other' }, { ...c, entropy: 'aa' }, { ...c, now: 1000 },
      { ...c, entropy: c.nonce },
      { ...c, terms: { ...f.terms, registryVersion: 2 } }]) assert.throws(() => create(bad));
  }
  assert.throws(() => createTrader('signer', c));
  assert.throws(() => createSigner({ terms: f.terms, signerIndex: 0, boxSecret: f.signers[0].box.secretKey, now: 100 }));
  assert.throws(() => createSigner({ terms: f.terms, signerIndex: 1, boxSecret: f.signers[1].box.secretKey, now: 100 }));
});
test('pure step functions ignore unexpected or regressing events and only abort definite precommit failures', () => {
  const f = fixture(), c = config(f);
  for (const [create, step] of [[createBuyer, buyerStep], [createSeller, sellerStep]]) {
    const state = create(c), before = structuredClone(state);
    assert.equal(step(state, { type: 'tick', now: 100 }).actions[0].kind, 'take');
    assert.ok(JSON.stringify(state) === JSON.stringify(before));
    assert.ok(step(state, { type: 'tick', now: 99 }).state === state);
    assert.ok(step(state, { type: 'unexpected', now: 100 }).state === state);
    assert.equal(step(state, { type: 'error', now: 100, definite: true, reason: 'adapter failure' }).state.reason, 'adapter failure');
  }
  const signer = createSigner({ terms: f.terms, signerIndex: 1, boxSecret: f.signers[0].box.secretKey, now: 100 });
  assert.ok(signerStep(signer, { type: 'unexpected', now: 100 }).state === signer);
});
test('bad reveal, wrong sender and incorrect finalized slot leave negotiation unchanged', () => {
  const f = fixture(), c = config(f), initial = createBuyer(c);
  const awaiting = buyerStep(initial, { type: 'tick', now: 100 }).state;
  const accept = message('accept', { offerId: f.offerId, takeCommitment: sha256Hex(hexToBytes(c.nonce, 32)), commitment: hex(), slot: 10 }, f.seller, f.offerId);
  const revealed = buyerStep(awaiting, { type: 'message', message: accept, now: 100, finalizedAgeMs: 0, observedSlot: 10, tipSlot: 42, tipAgeMs: 0 }).state;
  const reveal = message('reveal', { offerId: f.offerId, takeCommitment: sha256Hex(hexToBytes(c.nonce, 32)), nonce: hex() }, f.seller, f.offerId);
  assert.ok(buyerStep(revealed, { type: 'message', message: reveal, now: 101, finalizedAgeMs: 0, observedSlot: 10, tipSlot: 42, tipAgeMs: 0 }).state === revealed);
  assert.ok(buyerStep(awaiting, { type: 'message', message: { ...accept, from: hex() }, now: 101 }).state === awaiting);
  const waiting = { ...revealed, phase: 'awaitRandomness', peerNonce: hex(), acceptSlot: 10 };
  const chain = { finalized: true, firstFinalized: true, acceptSlot: 10, slot: 11, blockhash: hex() };
  assert.ok(buyerStep(waiting, { type: 'tick', now: 101, chain }).state === waiting);
});
test('seller rejects wrong-hash, short-held, duplicate or noncommittee acks', () => {
  const sim = simulation({ ackCount: 0 }), state = sim.state('seller');
  const signer = sim.nodes.get('signer1');
  const body = { tradeId: state.tradeId, H: state.H, holdUntil: state.terms.refundAfter };
  for (const [patch, identity] of [[{ H: hex() }, signer.identity], [{ holdUntil: 100 }, signer.identity], [{}, sim.f.service]]) {
    const msg = message('ack', { ...body, ...patch }, identity, state.tradeId);
    const result = sellerStep(state, { type: 'message', message: msg, now: 100 });
    assert.ok(result.state === state); assert.equal(result.actions.length, 0);
  }
  const valid = message('ack', body, signer.identity, state.tradeId);
  const once = sellerStep(state, { type: 'message', message: valid, now: 100 });
  assert.ok(sellerStep(once.state, { type: 'message', message: valid, now: 101 }).state === once.state);
});
test('signer cannot ack before persistence or publish before positive verification and atomic reservation', () => {
  const sim = simulation({ ackCount: 0 }), s = sim.state('signer1');
  assert.equal(s.phase, 'persistingShare');
  const no = signerStep(s, { type: 'persisted', now: 100, tradeId: s.tradeId, scope: 'signerShare', ok: false });
  assert.equal(no.state.phase, 'aborted'); assert.ok(!no.actions.some(a => a.kind === 'ack'));
  const early = signerStep(s, { type: 'transferVerified', now: 100, tradeId: s.tradeId, ok: true, final: true });
  assert.ok(early.state === s); assert.equal(early.actions.length, 0);
  const pending = simulation({ persistTransfer: false }).state('signer1');
  assert.equal(pending.phase, 'persistingTransfer');
  const bad = signerStep(pending, { type: 'persisted', now: 100, tradeId: pending.tradeId, scope: 'verifiedTransfer',
    txHash: pending.txHash, reservedFor: hex(), ok: true });
  assert.ok(bad.state === pending); assert.equal(bad.actions.length, 0);
  const late = signerStep(pending, { type: 'persisted', now: 1300, tradeId: pending.tradeId, scope: 'verifiedTransfer',
    txHash: pending.txHash, reservedFor: pending.tradeId, ok: true });
  assert.equal(late.state.phase, 'published'); assert.ok(late.actions.some(a => a.type === 'publishShare'));
});
test('common protocol helpers validate routing, dealing and deterministic entropy', () => {
  const f = fixture(), c = config(f), state = createBuyer(c);
  const seed = hex(); assert.ok(Buffer.from(seededRng(seed, 'a')(64)).equals(Buffer.from(seededRng(seed, 'a')(64))));
  assert.throws(() => seededRng('ff', 'a')); assert.throws(() => seededRng(seed, '')); assert.throws(() => seededRng(seed, 'a')(0));
  assert.equal(abortTransition(state, 'test').actions[0].reason, 'test');
  assert.throws(() => eventState(state, { now: 99 }));
  const msg = message('accept', { offerId: f.offerId, takeCommitment: sha256Hex(hexToBytes(c.nonce, 32)), commitment: hex(), slot: 10 }, f.seller, f.offerId);
  assert.equal(verifiedMessage(state, { type: 'message', message: msg }).kind, 'accept');
  assert.throws(() => verifiedMessage(state, { type: 'message', message: { ...msg, ch: 'other' } }));
  assert.equal(verifiedMessage(state, { type: 'tick' }), null);
  assert.throws(() => sendAction(state, 'missing', {}));
  assert.equal(negotiationStep(state, { type: 'noop' }, null), null);
  assert.equal(negotiationStep(state, { type: 'tick' }, null).state.phase, 'awaitAccept');
  assert.equal(state.phase, 'new');
  const { deal } = prepareDeal({ k: f.terms.k, committeeBoxKeys: f.terms.committee.map(x => x.boxKey), tradeId: tradeId(f.terms) });
  deal.proof = proofStub();
  assert.equal(checkDealShape(deal, f.terms), true);
  assert.equal(checkDealShape({ ...deal, tradeId: hex() }, f.terms), false);
});

test('a maker ends its negotiation with a reason when the take does not match the offer terms', () => {
  const t = simulation({ capturePhases: true });
  const state = structuredClone(t.snapshots.get('seller:awaitTake'));
  const body = structuredClone(t.log.find(x => x.name === 'buyer' && x.action.kind === 'take').action.body);
  const fresh = { type: 'message', now: state.now, observedSlot: 100, finalizedAgeMs: 0, tipSlot: 155, tipAgeMs: 0 };
  const mismatched = { kind: 'take', from: state.peer, body: { ...body, refundAfter: body.refundAfter + 1 } };
  const result = negotiationStep(state, { ...fresh, message: mismatched }, mismatched);
  assert.equal(result.state.phase, 'aborted'); assert.equal(result.state.reason, 'Invalid take');
  assert.equal(result.state.peerCommit, body.commitment);
  assert.deepEqual(result.actions.map(a => a.type), ['abort']);
  // A take in any other phase is still refused without ending the trade.
  assert.throws(() => negotiationStep({ ...state, phase: 'awaitReveal' }, { ...fresh, message: mismatched }, mismatched), /Invalid take/);
});
