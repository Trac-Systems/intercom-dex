import test from 'node:test';
import assert from 'node:assert/strict';
import { stepFinalized as step } from '../../../src/core/trade-seller.js';
import { simulation } from './simulation.mjs';
import { hex } from './helpers.mjs';

const snapshot = phase => structuredClone(simulation({ capturePhases: true }).snapshots.get('seller:' + phase));

test('seller stays sending through receipts, missing transfers and timeouts, then advances only on finality', () => {
  let s = snapshot('transferring');
  const txHash = hex(), sentAt = s.now;
  const event = { type: 'transferSent', tradeId: s.tradeId, now: s.now, txHash, sentAt, ok: true };
  let r = step(s, event);
  assert.equal(r.state.phase, 'transferring'); assert.equal(r.state.transferUnknown, true);
  assert.equal(r.actions[0].kind, 'transferSent', 'signers can check the hash while the UI still waits');
  s = r.state;
  r = step(s, { ...event, now: s.now + 1, ok: false, unknown: true });
  assert.equal(r.state.phase, 'transferring'); assert.equal(r.actions.length, 0);
  s = r.state;
  assert.equal(step(s, { type: 'tick', now: s.transferRetryAt - 1 }).actions.length, 0);
  r = step(s, { type: 'tick', now: s.transferRetryAt });
  assert.equal(r.actions[0].type, 'sendTransfer'); assert.equal(r.actions[0].resume, true);
  s = r.state;
  assert.equal(step(s, { ...event, now: s.now, txHash: hex(), final: true }).state.phase, 'transferring');
  r = step(s, { ...event, now: s.now, final: true, finalizedAt: s.now });
  assert.equal(r.state.phase, 'awaitShares'); assert.equal(r.state.transferFinal, true);
  assert.equal(r.state.transferUnknown, false);
});

test('seller rechecks older awaitShares journals and keeps checking a broadcast after sendBy', () => {
  const old = snapshot('awaitShares');
  let r = step(old, { type: 'resume', now: old.terms.sendBy });
  assert.equal(r.state.phase, 'transferring');
  assert.ok(r.actions.some(a => a.type === 'sendTransfer' && a.resume));
  const s = r.state;
  r = step(s, { type: 'transferSent', now: s.now, tradeId: s.tradeId, txHash: s.txHash,
    sentAt: old.now, ok: false, unknown: true, reason: 'past_send_deadline' });
  assert.equal(r.state.phase, 'transferring');
  r = step(r.state, { type: 'transferSent', now: s.now + 1, tradeId: s.tradeId, txHash: s.txHash,
    sentAt: old.now, ok: true, final: true, finalizedAt: s.now + 1 });
  assert.equal(r.state.phase, 'awaitShares');
  assert.equal(step(r.state, { type: 'resume', now: s.now + 2 }).state.phase, 'awaitShares');
});

test('an unconfirmed seller reconciles a refund without claiming its coins arrived', () => {
  let s = snapshot('transferring');
  s = step(s, { type: 'transferSent', tradeId: s.tradeId, now: s.now, txHash: hex(), ok: false, unknown: true }).state;
  let r = step(s, { type: 'tick', now: s.terms.refundAfter });
  assert.ok(r.actions.some(a => a.type === 'checkEscrow' && a.purpose === 'settlement'));
  r = step(r.state, { type: 'escrowChecked', tradeId: s.tradeId, now: s.terms.refundAfter, hashHex: s.H,
    purpose: 'settlement', ok: true, status: 'refunded' });
  assert.equal(r.state.phase, 'lost'); assert.equal(r.state.transferUnknown, true);
});
