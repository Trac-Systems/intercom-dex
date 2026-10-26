import test from 'node:test';
import assert from 'node:assert/strict';
import { step } from '../../../src/core/trade-signer.js';
import { transferNonce } from '../../../src/core/terms.js';
import { simulation } from './simulation.mjs';
import { hex } from './helpers.mjs';

const sim = simulation({ capturePhases: true });
const holding = () => structuredClone(sim.snapshots.get('signer1:holding'));
const apply = (s, type, extra = {}) => step(s, { type, now: s.now, tradeId: s.tradeId, ...extra });
const notice = (s, txHash) => ({ type: 'message', now: s.now, message: { v: 1, kind: 'transferSent',
  from: s.terms.seller.dexKey, ch: 'intercom-dex:t:' + s.tradeId, body: { tradeId: s.tradeId, txHash } } });

test('holding starts a durable 30 second wait, then searches every 15 seconds with exact verification terms', () => {
  let s = holding();
  assert.equal(s.holdingSince, s.now);
  assert.deepEqual(apply(s, 'tick', { now: s.holdingSince + 29 }).actions, []);
  const found = apply(s, 'tick', { now: s.holdingSince + 30 });
  assert.equal(found.state.phase, 'holding');
  const { terms: t, tradeId } = s;
  assert.deepEqual(found.actions, [{ type: 'findTransfer', tradeId, txHash: undefined, asset: t.base.id,
    from: t.seller.tracAddr, to: t.buyer.tracAddr, minAmount: t.baseAmount, nonce: transferNonce(tradeId),
    finalBefore: t.sendBy + t.graceSec, since: s.holdingSince - 120 }]);
  s = apply(JSON.parse(JSON.stringify(found.state)), 'resume').state;
  assert.equal(s.holdingSince, found.state.holdingSince);
  assert.deepEqual(apply(s, 'tick', { now: s.holdingSince + 44 }).actions, []);
  assert.equal(apply(s, 'tick', { now: s.holdingSince + 45 }).actions[0].type, 'findTransfer');
});

test('old holding snapshots use their saved time and do not restart the wait on every tick', () => {
  const old = holding(); delete old.holdingSince;
  let s = apply(old, 'resume', { now: old.now + 10 }).state;
  s = apply(s, 'tick', { now: old.now + 29 }).state;
  assert.equal(s.holdingSince, old.now);
  assert.equal(apply(s, 'tick', { now: old.now + 30 }).actions[0].type, 'findTransfer');
});

test('transferFound has the same deadline and used-tx guards as a notice; first arrival wins', () => {
  const s = holding(), txHash = hex(), other = hex();
  const discovery = { type: 'transferFound', now: s.now, tradeId: s.tradeId, txHash };
  const message = notice(s, txHash);
  const found = step(s, discovery), sent = step(s, message);
  assert.deepEqual(found, sent);
  assert.equal(found.state.phase, 'verifyingTransfer');
  assert.deepEqual(found.actions.map(a => a.type), ['verifyTransfer']);
  assert.deepEqual(step(found.state, notice(s, other)).actions, []);
  assert.deepEqual(step(sent.state, { ...discovery, txHash: other }).actions, []);
  for (const e of [discovery, message]) {
    const reserved = { ...s, usedTx: { [txHash]: other } };
    assert.equal(step(reserved, e).state, reserved);
    assert.equal(step(s, { ...e, now: s.terms.sendBy + s.terms.graceSec }).state, s);
  }
  for (const patch of [{ tradeId: other }, { tradeId: undefined }, { txHash: 'bad' }]) {
    assert.equal(step(s, { ...discovery, ...patch }).state, s);
  }
  const expired = apply(s, 'tick', { now: s.terms.sendBy + s.terms.graceSec });
  assert.equal(expired.state.phase, 'expired');
  assert.deepEqual(expired.actions.map(a => a.type), ['abort']);
  assert.equal(step(expired.state, { ...discovery, now: expired.state.now }).state, expired.state);
});

test('discovered transfers still require exact final proof and durable reservation before publication', () => {
  const s = holding(), txHash = hex();
  const verifying = apply(s, 'transferFound', { txHash }).state;
  const proof = { txHash, ok: true, final: true, from: s.terms.seller.tracAddr, to: s.terms.buyer.tracAddr,
    asset: s.terms.base.id, amount: s.terms.baseAmount, nonce: transferNonce(s.tradeId), finalizedAt: s.now };
  for (const patch of [{ amount: '1' }, { to: s.terms.seller.tracAddr }, { nonce: hex() }, { final: false }]) {
    assert.equal(apply(verifying, 'transferVerified', { ...proof, ...patch }).state, verifying);
  }
  const verified = apply(verifying, 'transferVerified', proof);
  assert.equal(verified.state.phase, 'persistingTransfer');
  assert.deepEqual(verified.actions.map(a => a.type), ['persist']);
  const published = apply(verified.state, 'persisted', { scope: 'verifiedTransfer', ok: true, txHash, reservedFor: s.tradeId });
  assert.equal(published.state.phase, 'published');
  assert.deepEqual(published.actions.map(a => a.type), ['publishShare']);
});
