import test from 'node:test';
import assert from 'node:assert/strict';
import { stepFinalized as step, DEAD_TRANSFER_GRACE_SEC, DEAD_TRANSFER_REASON, TRANSFER_CHECK_RETRY_SEC } from '../../../src/core/trade-seller.js';
import { accountBalances } from '../../../src/wallets/accounting.js';
import { releasesOfferAmount } from '../../../src/core/offer-inventory.js';
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
  assert.ok(r.actions.some(a => a.type === 'checkSellerTransfer'));
  assert.ok(r.actions.every(a => a.type !== 'sendTransfer'));
  const s = r.state;
  r = step(s, { type: 'transferSent', now: s.now, tradeId: s.tradeId, txHash: s.txHash,
    sentAt: old.now, ok: false, unknown: true, reason: 'past_send_deadline' });
  assert.equal(r.state.phase, 'transferring');
  r = step(r.state, { type: 'transferSent', now: s.now + 1, tradeId: s.tradeId, txHash: s.txHash,
    sentAt: old.now, ok: true, final: true, finalizedAt: s.now + 1 });
  assert.equal(r.state.phase, 'awaitShares');
  assert.equal(step(r.state, { type: 'resume', now: s.now + 2 }).state.phase, 'awaitShares');
});

const expired = (phase = 'transferring', pair = 'RESET/USDC') => {
  const s = structuredClone(simulation({ capturePhases: true, pair }).snapshots.get('seller:' + phase));
  s.txHash ??= hex();
  s.transferUnknown = true;
  delete s.transferFinal;
  return s;
};
const closeAt = s => s.terms.refundAfter + DEAD_TRANSFER_GRACE_SEC;
const settlement = (s, patch = {}) => ({ type: 'escrowChecked', tradeId: s.tradeId, now: s.now,
  hashHex: s.H, purpose: 'settlement', ok: true, status: 'active', ...patch });
const checked = (s, patch = {}) => ({ type: 'sellerTransferChecked', tradeId: s.tradeId, now: s.now,
  checkAt: s.transferCheck?.at, txHash: s.txHash, ok: false, final: false, notApplied: true, ...patch });
const beginClose = s => {
  const tick = step(s, { type: 'tick', now: closeAt(s) });
  assert.deepEqual(tick.actions.map(a => a.type), ['checkEscrow']);
  const read = step(tick.state, settlement(tick.state));
  assert.deepEqual(read.actions.map(a => a.type), ['checkSellerTransfer']);
  return read.state;
};

for (const pair of ['RESET/USDC', 'TNK/USDC']) {
  for (const phase of ['transferring', 'awaitShares']) {
    test(`${pair} unverified seller ${phase} closes after fresh non-application and releases its hold`, () => {
      let s = expired(phase, pair);
      const balance = state => accountBalances({ balances: { RESET: '100000000000', TNK: '100000000000000000000' },
        trades: [{ role: 'seller', state }], registry: () => s.registry, now: closeAt(s) })[s.terms.base.id];
      const before = balance(s);
      assert.equal(before.breakdown.trades, s.terms.baseAmount);
      s = beginClose(s);
      const r = step(s, checked(s));
      assert.equal(r.state.phase, 'aborted'); assert.equal(r.state.reason, DEAD_TRANSFER_REASON);
      assert.equal(r.state.txHash, s.txHash, 'keep the original transfer identity');
      assert.deepEqual(r.actions.map(a => a.type), ['abort']);
      assert.equal(balance(r.state).breakdown.trades, '0');
      assert.ok(BigInt(balance(r.state).committed) < BigInt(before.committed));
      assert.equal(releasesOfferAmount({ role: 'seller', state: r.state }), true);
      for (const type of ['tick', 'resume', 'transferSent', 'sellerTransferChecked']) {
        const later = step(r.state, { ...checked(s), type, now: s.now + 86400, ok: true, final: true });
        assert.equal(later.state.phase, 'aborted'); assert.deepEqual(later.actions, []);
      }
    });
  }
}

for (const reason of ['read_failed', 'timeout', 'verification_failed', 'reset_reader_required', 'wrong_amount']) {
  test(`seller close keeps an unverified transfer open on ${reason} and backs off`, () => {
    let s = beginClose(expired());
    s = step(s, checked(s, { notApplied: false, reason })).state;
    assert.equal(s.phase, 'transferring');
    assert.equal(s.transferRetryAt, s.now + TRANSFER_CHECK_RETRY_SEC);
    assert.deepEqual(step(s, { type: 'tick', now: s.now + TRANSFER_CHECK_RETRY_SEC - 1 }).actions, []);
    const tick = step(s, { type: 'tick', now: s.transferRetryAt });
    assert.deepEqual(tick.actions.map(a => a.type), ['checkEscrow']);
    const read = step(tick.state, settlement(tick.state));
    assert.deepEqual(read.actions.map(a => a.type), ['checkSellerTransfer']);
  });
}

test('seller checks at most once a minute after sendBy and cannot close before the grace boundary', () => {
  let s = expired();
  s.transferNoticeAt = closeAt(s);
  let r = step(s, { type: 'tick', now: s.terms.sendBy });
  assert.deepEqual(r.actions.map(a => a.type), ['checkSellerTransfer']);
  s = step(r.state, checked(r.state)).state;
  assert.equal(s.phase, 'transferring');
  assert.deepEqual(step(s, { type: 'tick', now: s.now + 59 }).actions, []);
  r = step(s, { type: 'tick', now: s.now + 60 });
  assert.equal(r.actions.filter(a => a.type === 'checkSellerTransfer').length, 1);
  r = step(r.state, checked(r.state));
  r = step(r.state, { type: 'tick', now: closeAt(s) - 1 });
  s = step(r.state, checked(r.state)).state;
  assert.equal(s.phase, 'transferring');
  s = step(s, settlement(s)).state;
  assert.equal(s.phase, 'transferring', 'a previous negative lookup is never used to close');
});

for (const phase of ['transferring', 'awaitShares']) {
  test(`seller ${phase} found final at the close check follows the finalized path`, () => {
    const s = beginClose(expired(phase));
    const r = step(s, checked(s, { ok: true, final: true, notApplied: false,
      amount: s.terms.baseAmount, finalizedAt: s.now }));
    assert.equal(r.state.phase, phase === 'claiming' ? 'claiming' : 'awaitShares');
    assert.equal(r.state.transferFinal, true); assert.equal(r.state.transferUnknown, false);
    assert.equal(r.actions.some(a => a.type === 'claim'), phase === 'claiming');
    assert.ok(r.actions.every(a => a.type !== 'abort' && a.type !== 'sendTransfer'));
  });
}

for (const [status, phase] of [['claimed', 'complete'], ['refunded', 'lost']]) {
  test(`seller close preserves ${status} settlement as ${phase} without a transfer lookup`, () => {
    const old = expired(), tick = step(old, { type: 'resume', now: closeAt(old) });
    const r = step(tick.state, settlement(tick.state, { status }));
    assert.equal(r.state.phase, phase); assert.deepEqual(r.actions, []);
  });
}

test('seller close waits for settlement errors, missing or malformed results and retries them', () => {
  const old = expired(), tick = step(old, { type: 'resume', now: closeAt(old) });
  for (const event of [settlement(tick.state, { ok: false, unknown: true, status: 'missing' }),
    settlement(tick.state, { ok: true, status: 'unexpected' }),
    { type: 'error', purpose: 'settlement', now: tick.state.now, reason: 'RPC timed out' }]) {
    const r = step(tick.state, event);
    assert.equal(r.state.phase, 'transferring'); assert.deepEqual(r.actions, []);
    assert.deepEqual(step(r.state, { type: 'tick', now: r.state.now + 60 }).actions.map(a => a.type), ['checkEscrow']);
  }
});

test('seller close rejects stale transfer checks and recovers a lookup exception on the next minute', () => {
  const s = beginClose(expired());
  assert.equal(step(s, checked(s, { checkAt: s.now - 1 })).state, s);
  assert.equal(step(s, checked(s, { tradeId: hex() })).state, s);
  assert.equal(step(s, checked(s, { txHash: hex() })).state, s);
  const r = step(s, { type: 'error', now: s.now, purpose: 'sellerTransfer', checkAt: s.transferCheck.at, reason: 'timeout' });
  assert.equal(r.state.transferCheck, undefined); assert.equal(r.state.phase, 'transferring');
  assert.deepEqual(step(r.state, { type: 'tick', now: s.now + 59 }).actions, []);
  assert.deepEqual(step(r.state, { type: 'tick', now: s.now + 60 }).actions.map(a => a.type), ['checkEscrow']);
});

test('seller close with no trade hash requires proof that no durable intent exists', () => {
  const old = expired(); delete old.txHash;
  const s = beginClose(old);
  assert.equal(step(s, checked(s)).state.phase, 'transferring');
  assert.equal(step(s, checked(s, { noIntent: true })).state.phase, 'aborted');
  const hash = hex(), r = step(s, checked(s, { txHash: hash }));
  assert.equal(r.state.phase, 'aborted'); assert.equal(r.state.txHash, hash);
});

test('seller never downgrades recorded finality or reuses a negative lookup spanning another settlement round', () => {
  const s = beginClose(expired());
  const tick = step(s, { type: 'tick', now: s.now + 60 });
  assert.deepEqual(tick.actions.map(a => a.type), ['checkEscrow']);
  assert.equal(tick.state.transferCheck.close, false);
  assert.equal(step(tick.state, checked(tick.state)).state.phase, 'transferring');
  const final = step(s, { type: 'transferSent', tradeId: s.tradeId, txHash: s.txHash, sentAt: s.terms.sendBy - 1,
    now: s.now, ok: true, final: true, finalizedAt: s.now }).state;
  assert.equal(final.transferFinal, true); assert.equal(final.transferCheck, undefined);
  assert.equal(step(final, checked(s)).state.phase, 'awaitShares');
  assert.ok(step(final, { type: 'tick', now: s.now + 60 }).actions.every(a => a.type !== 'checkSellerTransfer'));
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

test('a claiming seller is never closed by a transfer lookup and keeps retrying its claim', () => {
  const s = expired('claiming');
  s.claimRetryAt = closeAt(s);
  const r = step(s, { type: 'tick', now: closeAt(s) });
  assert.equal(r.state.phase, 'claiming');
  assert.ok(r.actions.some(a => a.type === 'claim'));
  assert.ok(!r.actions.some(a => a.type === 'checkSellerTransfer'));
  const read = step(r.state, settlement(r.state, { now: closeAt(s) }));
  assert.equal(read.state.phase, 'claiming');
  assert.ok(!read.actions.some(a => a.type === 'checkSellerTransfer'));
});
