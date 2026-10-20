import test from 'node:test';
import assert from 'node:assert/strict';
import { step as buyerStep, LOCK_START_MARGIN_SEC } from '../../../src/core/trade-buyer.js';
import { step as sellerStep } from '../../../src/core/trade-seller.js';
import { registrySchema } from '../../../src/core/schemas.js';
import { prepareDeal, signerShareCheck } from '../../../src/core/dealing.js';
import { seededRng } from '../../../src/core/trade-common.js';
import { hex, fixture, proofStub } from './helpers.mjs';
import { simulation } from './simulation.mjs';

const sim = simulation({ capturePhases: true });
const snapshot = (name, phase) => structuredClone(sim.snapshots.get(name + ':' + phase));
const step = (s, type, extra = {}) => (s.role === 'buyer' ? buyerStep : sellerStep)(s, { type, now: s.now, tradeId: s.tradeId, ...extra });
const msg = (s, kind, body, from = s.peer, extra = {}) => step(s, 'message', {
  message: { v: 1, ch: 'intercom-dex:t:' + (body.tradeId ?? s.offerId), kind, from, body }, ...extra });
const ack = (s, i, patch = {}, extra = {}) => msg(s, 'ack', { tradeId: s.tradeId, H: s.H, holdUntil: s.terms.refundAfter, ...patch }, s.terms.committee[i].dexKey, extra);

test('buyer counts only distinct committee acks for this H and hold, in committee order, before locking', () => {
  const s = snapshot('buyer', 'awaitAcks');
  assert.equal(LOCK_START_MARGIN_SEC, 120);
  for (const patch of [{ H: hex() }, { holdUntil: s.terms.refundAfter - 1 }, { tradeId: hex() }]) assert.equal(ack(s, 0, patch).state, s);
  assert.equal(msg(s, 'ack', { tradeId: s.tradeId, H: s.H, holdUntil: s.terms.refundAfter }, hex()).state, s);
  const first = ack(s, 2); assert.equal(first.state.phase, 'awaitAcks'); assert.deepEqual(first.actions, []);
  assert.equal(ack(first.state, 2).state, first.state);
  const second = ack(first.state, 0); assert.deepEqual(second.state.acks, [s.terms.committee[0].dexKey, s.terms.committee[2].dexKey]);
  const last = ack(second.state, 1);
  assert.equal(last.state.phase, 'locking'); assert.equal(last.state.lockAttempted, true);
  assert.deepEqual(last.actions.map(a => a.type), ['lockEscrow']);
});

test('cutoff and ack budget never emit a first lock; a resumed ack wait preserves evidence and evaluates on tick', () => {
  const s = snapshot('buyer', 'awaitAcks'), cutoff = s.terms.sendBy - 120;
  const counted = ack(ack(s, 0).state, 1).state;
  for (const now of [cutoff, cutoff + 1, s.terms.sendBy]) {
    const result = ack(counted, 2, {}, { now });
    assert.equal(result.state.phase, 'aborted'); assert.equal(result.state.reason, 'Signers did not confirm');
    assert.ok(!result.state.lockAttempted); assert.ok(!result.actions.some(a => a.type === 'lockEscrow'));
    assert.equal(step(result.state, 'resume', { now }).actions.length, 0);
  }
  assert.equal(ack(counted, 2, {}, { now: cutoff - 1 }).state.phase, 'locking');
  const resumed = step(JSON.parse(JSON.stringify(counted)), 'resume', { now: cutoff });
  assert.deepEqual(resumed.state.acks, counted.acks); assert.equal(resumed.state.phase, 'awaitAcks');
  assert.equal(step(resumed.state, 'tick', { now: cutoff }).state.reason, 'Signers did not confirm');
  const quorum = { ...counted, acks: s.terms.committee.slice(0, 3).map(c => c.dexKey) };
  assert.equal(step(step(quorum, 'resume').state, 'tick').state.phase, 'locking');
  const late = ack(counted, 2, {}, { elapsedMs: 60000 });
  assert.equal(late.state.phase, 'aborted'); assert.ok(!late.state.lockAttempted); assert.equal(late.actions[0].type, 'abort');
  assert.equal(step(counted, 'tick', { elapsedMs: 60000 }).state.phase, 'aborted');
});

test('both traders abort before terms/signatures if fewer than k+1 committee signers are online', () => {
  for (const name of ['buyer', 'seller']) {
    const s = snapshot(name, 'awaitRandomness');
    const chain = { acceptSlot: s.acceptSlot, slot: s.acceptSlot + 96, blockhash: hex(), finalized: true, firstFinalized: true };
    const r = step(s, 'tick', { chain, onlineSigners: s.draft.committee.slice(0, 3).map(c => c.dexKey) });
    assert.equal(r.state.reason, 'Not enough committee signers online'); assert.deepEqual(r.actions.map(a => a.type), ['abort']);
    const terms = snapshot(name, 'awaitTerms');
    const failed = msg(terms, 'terms', { tradeId: terms.tradeId, terms: terms.terms }, terms.peer, { onlineSigners: [] });
    assert.equal(failed.state.reason, 'Not enough committee signers online');
    const passed = msg(terms, 'terms', { tradeId: terms.tradeId, terms: terms.terms }, terms.peer,
      { onlineSigners: terms.terms.committee.slice(0, 4).map(c => c.dexKey) });
    assert.equal(passed.state.phase, 'awaitTermsSig');
  }
});

test('online eligibility is checked again at take and accept transitions', () => {
  const buyer = { ...snapshot('buyer', 'awaitAccept'), phase: 'new' };
  assert.equal(step(buyer, 'tick', { eligibleOnline: 3 }).state.reason, 'Not enough signers online');
  const seller = snapshot('seller', 'awaitTake');
  const body = sim.log.find(x => x.name === 'buyer' && x.action.kind === 'take').action.body;
  const result = msg(seller, 'take', body, seller.peer, { eligibleOnline: 3, observedSlot: 100, finalizedAgeMs: 0, tipSlot: 132, tipAgeMs: 0 });
  assert.equal(result.state.reason, 'Not enough signers online'); assert.deepEqual(result.actions.map(a => a.type), ['abort']);
});

test('step budgets use elapsed monotonic time, survive serialization and never cancel an attempted lock', () => {
  for (const [phase, budget] of [['awaitAccept', 60000], ['awaitReveal', 120000], ['awaitRandomness', 120000], ['awaitTerms', 30000], ['proving', 150000]]) {
    let s = snapshot('buyer', phase);
    s = step(s, 'tick', { elapsedMs: budget - 1 }).state;
    assert.equal(s.phase, phase);
    const r = step(JSON.parse(JSON.stringify(s)), 'tick', { elapsedMs: 1 });
    assert.equal(r.state.phase, 'aborted'); assert.match(r.state.reason, /Timed out/);
  }
  for (const phase of ['locking', 'locked']) {
    const s = snapshot('buyer', phase), r = step(s, 'tick', { elapsedMs: 99999999 });
    assert.equal(r.state.phase, phase);
  }
});

test('working notes extend the seller deal budget only while live, never beyond 150 seconds; lock edge waits until sendBy', () => {
  const s = snapshot('seller', 'awaitDeal');
  assert.equal(step(s, 'tick', { elapsedMs: 60000 }).state.phase, 'aborted');
  let current = s;
  for (let i = 0; i < 14; i++) {
    current = msg(current, 'working', { tradeId: s.tradeId, step: 'certificate' }, s.peer, { elapsedMs: 10000 }).state;
    assert.equal(current.phase, 'awaitDeal');
  }
  assert.equal(current.dealBudgetMs, 150000);
  assert.equal(step(current, 'tick', { elapsedMs: 10000 }).state.phase, 'aborted');
  assert.equal(msg(s, 'working', { tradeId: s.tradeId, step: 'certificate' }, s.peer, { elapsedMs: 60000 }).state.phase, 'aborted');
  for (const phase of ['checkingProof', 'awaitReady']) {
    const ready = snapshot('seller', phase);
    assert.equal(step(ready, 'tick', { elapsedMs: 999999 }).state.phase, phase);
    assert.equal(step(ready, 'tick', { now: ready.terms.sendBy }).state.phase, 'aborted');
    assert.equal(msg(ready, 'abort', { tradeId: ready.tradeId, reason: 'Signers did not confirm' }).state.phase, 'aborted');
  }
});

test('proof working notes follow elapsed time even when wall time does not advance', () => {
  const s = snapshot('buyer', 'proving');
  const first = step(s, 'tick', { elapsedMs: 9999 }); assert.equal(first.actions.length, 0);
  const note = step(first.state, 'tick', { elapsedMs: 1 }); assert.equal(note.actions[0].kind, 'working');
  assert.equal(note.state.now, s.now);
  assert.equal(step(note.state, 'tick', { elapsedMs: 9999 }).actions.length, 0);
  assert.equal(step(note.state, 'tick', { elapsedMs: 10000 }).actions[0].kind, 'working');
});

test('registry rejects send windows below 300 and accepts the 48-hour refund window', () => {
  const f = fixture();
  for (const sendWindowSec of [0, 1, 299]) assert.equal(registrySchema.safeParse({ ...f.registry, params: { ...f.registry.params, sendWindowSec } }).success, false);
  assert.equal(registrySchema.parse({ ...f.registry, params: { ...f.registry.params, sendWindowSec: 300, refundSec: 172800 } }).params.refundSec, 172800);
});

test('48-hour terms retain shares through refundAfter and refund only at the full deadline', () => {
  const f = fixture(); f.registry.params.refundSec = 172800; f.terms.refundAfter = 172900;
  const long = simulation({ fixture: f, neverSend: true });
  for (const { action } of long.log.filter(x => x.action.scope === 'signerShare')) assert.equal(action.record.holdUntil, 172900);
  for (const { action } of long.log.filter(x => x.action.kind === 'ack')) assert.equal(action.body.holdUntil, 172900);
  long.dispatch('buyer', { type: 'tick', now: 100 + 86400 }); long.drain(); assert.equal(long.count('refund'), 0);
  long.dispatch('buyer', { type: 'tick', now: 172899 }); long.drain(); assert.equal(long.count('refund'), 0);
  long.dispatch('buyer', { type: 'tick', now: 172900 }); long.drain(); assert.equal(long.state('buyer').phase, 'refunded');
});

test('assigned certificate is recorded before building, replays the identical deal and skips proving', () => {
  const s = snapshot('buyer', 'awaitCertificate'), seed = sim.state('buyer');
  const certificate = { secretHex: seed.privateState.secretHex, H: seed.H, C0: seed.deal.commitments[0], proof: proofStub() };
  const assigned = step(s, 'certificateAssigned', { certificate });
  assert.equal(assigned.state.phase, 'preparingDeal'); assert.equal(assigned.state.H, certificate.H);
  assert.equal(assigned.state.deal, undefined); assert.deepEqual(assigned.actions.map(a => a.type), ['prepareDeal']);
  const restored = JSON.parse(JSON.stringify(assigned.state));
  assert.equal(step(restored, 'resume').actions.at(-1).type, 'prepareDeal');
  const first = step(restored, 'prepareDeal'), again = step(restored, 'prepareDeal');
  assert.equal(first.state.phase, 'awaitAcks'); assert.deepEqual(first.state.deal, again.state.deal);
  assert.deepEqual(first.actions.map(a => a.kind), ['deal']); assert.ok(!first.state.lockAttempted);
  const wrong = { ...restored, certificate: { ...certificate, H: hex() } };
  assert.equal(step(wrong, 'prepareDeal').state.reason, 'Invalid pool certificate');
  const empty = step(s, 'certificateAssigned', { certificate: null });
  const fallback = step(empty.state, 'prepareDeal');
  assert.equal(fallback.state.phase, 'proving'); assert.ok(fallback.actions.some(a => a.type === 'prove'));
  assert.ok(fallback.actions.some(a => a.kind === 'working'));
});

test('a pool secret fixes C0 and H while trade entropy deterministically builds the remaining polynomial and boxes', () => {
  const f = fixture(), s = sim.state('buyer'), tradeId = hex(), entropy = hex();
  const make = () => prepareDeal({ k: 3, committeeBoxKeys: f.terms.committee.map(c => c.boxKey), tradeId,
    secretHex: s.privateState.secretHex, rng: seededRng(entropy, 'pool-test') });
  const one = make(), two = make(); assert.deepEqual(one, two); assert.equal(one.deal.H, s.H);
  one.deal.proof = proofStub();
  for (let i = 0; i < f.signers.length; i++) assert.equal(signerShareCheck(one.deal, i + 1, f.signers[i].box.secretKey).ok, true);
  for (const secretHex of ['00'.repeat(32), 'ff'.repeat(32), 'bad']) assert.throws(() => prepareDeal({ k: 1, committeeBoxKeys: [f.terms.committee[0].boxKey], tradeId, secretHex }));
});
