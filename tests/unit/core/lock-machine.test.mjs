import test from 'node:test';
import assert from 'node:assert/strict';
import { step as buyerStep } from '../../../src/core/trade-buyer.js';
import { step as sellerStep } from '../../../src/core/trade-seller.js';
import { step as signerStep } from '../../../src/core/trade-signer.js';
import { prepareDeal, lockStatement } from '../../../src/core/dealing.js';
import { seededRng } from '../../../src/core/trade-common.js';
import { hex, proofStub } from './helpers.mjs';
import { simulation } from './simulation.mjs';

const sim = simulation({ capturePhases: true });
const snapshot = (name, phase) => structuredClone(sim.snapshots.get(name + ':' + phase));
const event = (s, type, extra = {}) => ({ type, now: s.now + 1, tradeId: s.tradeId, ...extra });
const message = (s, deal) => event(s, 'message', { message: { v: 1, kind: 'deal', from: s.terms.buyer.dexKey,
  ch: 'intercom-dex:t:' + s.tradeId, body: deal } });

test('buyer negotiates one deterministic dealing, proves, then sends deal before attempting the lock', () => {
  const s = snapshot('buyer', 'proving');
  const original = sim.log.find(x => x.action.type === 'prove').action;
  assert.deepEqual(original, { type: 'prove', tradeId: s.tradeId, secretHex: s.privateState.secretHex, statement: lockStatement(s.deal) });
  assert.equal(s.deal.proof, null); assert.equal(s.locked, false); assert.ok(!s.lockAttempted);
  const rebuilt = prepareDeal({ k: s.terms.k, committeeBoxKeys: s.terms.committee.map(x => x.boxKey), tradeId: s.tradeId,
    rng: seededRng(s.entropy, 'dealing:' + s.tradeId) });
  assert.deepEqual(rebuilt.deal, s.deal); assert.deepEqual(rebuilt.privateState, s.privateState);
  const resumed = buyerStep(JSON.parse(JSON.stringify(s)), event(s, 'resume'));
  assert.deepEqual(resumed.actions.find(a => a.type === 'prove'), original);
  const done = buyerStep(s, event(s, 'proved', { ok: true, proof: proofStub() }));
  assert.equal(done.state.phase, 'awaitAcks'); assert.ok(!done.state.lockAttempted);
  assert.deepEqual(done.actions.map(a => a.type), ['send']);
  assert.equal(done.actions[0].kind, 'deal');
  assert.equal(s.deal.proof, null, 'input was not mutated');
  for (const bad of [{ tradeId: hex(), ok: true, proof: proofStub() }, { ok: 'true', proof: proofStub() }, { ok: true, proof: {} }]) {
    const r = buyerStep(s, event(s, 'proved', bad)); assert.equal(r.state, s); assert.deepEqual(r.actions, []);
  }
});
test('failed proving and the deadline during proving never lock, including resume and late completion', () => {
  const s = snapshot('buyer', 'proving');
  for (const e of [event(s, 'proved', { ok: false, reason: 'test failure' }),
    ...['tick', 'resume', 'proved'].map(type => event(s, type, { now: s.draft.sendBy, ok: true, proof: proofStub() }))]) {
    const r = buyerStep(s, e);
    assert.equal(r.state.phase, 'aborted'); assert.equal(r.state.locked, false); assert.ok(!r.state.lockAttempted);
    assert.deepEqual(r.actions.map(a => a.type), ['abort']);
    assert.deepEqual(buyerStep(r.state, event(r.state, 'proved', { ok: true, proof: proofStub() })).actions, []);
  }
  const failure = simulation({ proveOk: false });
  assert.equal(failure.count('lockEscrow'), 0); assert.equal(failure.count('sendTransfer'), 0);
  assert.equal(failure.log.filter(x => x.action.kind === 'deal').length, 0);
});
test('seller and signer check and resume the same certificate, refusing false or unrelated callbacks', () => {
  for (const [name, step] of [['seller', sellerStep], ['signer1', signerStep]]) {
    const s = snapshot(name, 'awaitDeal'), deal = sim.state('seller').deal;
    const checked = step(s, message(s, deal));
    assert.equal(checked.state.phase, 'checkingProof');
    const action = { type: 'checkProof', tradeId: s.tradeId, statement: lockStatement(deal), proof: deal.proof };
    assert.deepEqual(checked.actions, [action]);
    const resumed = step(JSON.parse(JSON.stringify(checked.state)), event(checked.state, 'resume'));
    assert.deepEqual(resumed.actions.filter(a => a.type === 'checkProof'), [action]);
    for (const patch of [{ tradeId: hex(), ok: true }, { ok: 1 }, {}]) {
      assert.equal(step(checked.state, event(checked.state, 'proofChecked', patch)).state, checked.state);
    }
    const failed = step(checked.state, event(checked.state, 'proofChecked', { ok: false }));
    assert.equal(failed.state.phase, 'aborted'); assert.equal(failed.state.reason, 'Invalid lock certificate');
    assert.deepEqual(failed.actions.map(a => a.type), ['abort']);
    const success = step(checked.state, event(checked.state, 'proofChecked', { ok: true }));
    assert.equal(success.state.phase, name === 'seller' ? 'awaitReady' : 'persistingShare');
    assert.deepEqual(success.actions.map(a => a.type), [name === 'seller' ? 'checkEscrow' : 'persist']);
    const cutoff = s.terms.sendBy + (name === 'seller' ? 0 : s.terms.graceSec);
    for (const type of ['resume', 'proofChecked']) {
      const late = step(checked.state, event(checked.state, type, { now: cutoff, ok: true }));
      assert.equal(late.state.phase, 'aborted'); assert.deepEqual(late.actions.map(a => a.type), ['abort']);
    }
  }
});
test('invalid dealing aborts the seller and makes signers refuse before checking or acking', () => {
  const deal = sim.state('seller').deal;
  for (const [name, step] of [['seller', sellerStep], ['signer1', signerStep]]) {
    const s = snapshot(name, 'awaitDeal');
    for (const patch of [{ k: 2 }, { H: 'bad' }, { proof: null }, { commitments: ['ff'.repeat(32)] },
      { committeeBoxKeys: [...deal.committeeBoxKeys].reverse() }, { extra: true }]) {
      const r = step(s, message(s, { ...deal, ...patch }));
      assert.equal(r.state.phase, 'aborted'); assert.equal(r.state.reason, 'Invalid dealing');
      assert.deepEqual(r.actions.map(a => a.type), ['abort']);
    }
  }
  const badShare = structuredClone(deal); badShare.sealedShares[0].ciphertext = '00'.repeat(48);
  const s = snapshot('signer1', 'awaitDeal'), r = signerStep(s, message(s, badShare));
  assert.equal(r.state.reason, 'Invalid dealing'); assert.deepEqual(r.actions.map(a => a.type), ['abort']);
});
