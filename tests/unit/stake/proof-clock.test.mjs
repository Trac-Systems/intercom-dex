import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProofClock, applyProofClock, qualifyingLock, deliveryExcusesPenalty, canRetryOriginal } from '../../../src/stake/proof-clock.js';
import { signFact } from '../../../src/stake/certificates.js';
import { registryPolicy, secrets } from './helpers.mjs';
const h = n => n.toString(16).padStart(64, '0');
const context = { networkId: 1, venueKey: h(1), epoch: registryPolicy().epoch };
const create = () => createProofClock({ tradeId: h(2), reservationId: h(3), triggerAt: 100, windowSec: 3600 });
function certificate(prev, throughAt, healthyIntervals, pausedIntervals) {
  const body = { tradeId: prev.tradeId, reservationId: prev.reservationId, seq: prev.seq + 1, prevHash: prev.hash,
    throughAt, healthyIntervals, pausedIntervals, healthDigests: [h(4)], receiptHeads: [h(5), h(6), h(7)] };
  return secrets.slice(0, 3).map(s => signFact({ v: 1, networkId: 1, venueKey: h(1), epochId: context.epoch.id, kind: 'clock', body }, s));
}
test('late opening is paused; outage union extends proof time and survives restart', () => {
  const initial = create();
  const paused = applyProofClock(initial, certificate(initial, 10900, [], [{ from: 100, to: 10900 }]), context, 10900);
  assert.equal(paused.deadline, null); assert.equal(paused.remainingSec, 3600); assert.equal(paused.deadlineFloor, 14500);
  const running = applyProofClock(JSON.parse(JSON.stringify(paused)), certificate(paused, 14500,
    [{ from: 10900, to: 14500 }], [{ from: 100, to: 10900 }]), context, 14500);
  assert.equal(running.remainingSec, 0); assert.equal(running.pausedSec, 10800); assert.equal(running.deadline, 14500);
});
test('clock refuses gaps, overlaps, replay, future time and shortening a certified pause', () => {
  const initial = create();
  for (const [healthy, paused] of [[[{ from: 101, to: 200 }], []], [[{ from: 100, to: 200 }], [{ from: 100, to: 150 }]]])
    assert.throws(() => applyProofClock(initial, certificate(initial, 200, healthy, paused), context, 200));
  const cert = certificate(initial, 200, [], [{ from: 100, to: 200 }]);
  assert.throws(() => applyProofClock(initial, cert, context, 199));
  const p = applyProofClock(initial, cert, context, 200);
  assert.throws(() => applyProofClock(p, cert, context, 200));
  assert.throws(() => applyProofClock(p, certificate(p, 300, [{ from: 100, to: 300 }], []), context, 300), /pause/);
  const h1 = applyProofClock(initial, certificate(initial, 200, [{ from: 100, to: 200 }], []), context, 200);
  const corrected = applyProofClock(h1, certificate(h1, 200, [{ from: 100, to: 150 }], [{ from: 150, to: 200 }]), context, 200);
  assert.equal(corrected.remainingSec, 3550); assert.equal(corrected.deadlineFloor, 3750);
  assert.throws(() => createProofClock({ tradeId: h(1), reservationId: h(2), triggerAt: 0, windowSec: 0 }));
});
test('timely lock is strictly before cutoff, never inferred from a missing account', () => {
  const facts = { includedAt: 879, finalized: true, exact: true, historyComplete: true };
  assert.equal(qualifyingLock(facts, 1000, 120), true);
  assert.equal(qualifyingLock({ ...facts, includedAt: 880 }, 1000, 120), false);
  for (const key of ['finalized', 'exact', 'historyComplete']) assert.equal(qualifyingLock({ ...facts, [key]: false }, 1000, 120), false);
});
test('SB4 cancels only exact delivery within grace or a certified paused interval', () => {
  const expected = { from: 'seller', to: 'buyer', asset: 'RESET', amount: '100', nonce: h(3), networkId: 1 };
  const proof = { ...expected, status: 'delivered', finalizedTimeVerified: true, finalizedTime: 2800, txHash: h(4), evidenceDigest: h(5) };
  const check = p => deliveryExcusesPenalty({ expected, proof: p, sendBy: 1000, overdueDelaySec: 1800, clock: { pausedIntervals: [{ from: 3000, to: 4000 }] } });
  assert.equal(check(proof), true); assert.equal(check({ ...proof, finalizedTime: 2801 }), false);
  assert.equal(check({ ...proof, finalizedTime: 3000 }), true); assert.equal(check({ ...proof, finalizedTime: 4000 }), false);
  for (const override of [{ amount: '101' }, { amount: '99' }, { nonce: h(6) }, { finalizedTimeVerified: false }, { status: 'pending' }]) assert.equal(check({ ...proof, ...override }), false);
});
test('grace retries require the original pre-deadline send, never create a new transfer', () => {
  const args = { tradeId: h(1), nonce: h(2), sendBy: 1000, overdueDelaySec: 1800, now: 2800,
    intent: { tradeId: h(1), nonce: h(2), txHash: h(3), createdAt: 999 } };
  assert.equal(canRetryOriginal(args), true); assert.equal(canRetryOriginal({ ...args, now: 2801 }), false);
  assert.equal(canRetryOriginal({ ...args, intent: null }), false);
  assert.equal(canRetryOriginal({ ...args, intent: { ...args.intent, createdAt: 1000 } }), false);
  assert.equal(canRetryOriginal({ ...args, nonce: h(4) }), false);
});
