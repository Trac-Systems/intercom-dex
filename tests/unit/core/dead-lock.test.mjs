import test from 'node:test';
import assert from 'node:assert/strict';
import { step, LOCK_OUTCOME_RETRY_SEC } from '../../../src/core/trade-buyer.js';
import { accountBalances } from '../../../src/wallets/accounting.js';
import { simulation } from './simulation.mjs';

const sim = simulation({ capturePhases: true });
const snapshot = phase => structuredClone(sim.snapshots.get(`buyer:${phase}`));
const event = (s, type, fields = {}) => step(s, { type, tradeId: s.tradeId, hashHex: s.H, now: s.now + 1, ...fields });
const polls = result => result.actions.filter(a => a.type === 'lockOutcome');
const unknown = () => event(snapshot('locking'), 'escrowLocked', { ok: false, unknown: true }).state;
const money = state => accountBalances({ balances: { USDC: '100000000' }, trades: [{ role: 'buyer', state }], offers: [] }).USDC;

test('unknown buyer locks poll once a minute before refundAfter and release the whole commitment on proof of absence', () => {
  const s = unknown(), before = money(s), due = s.nextLockOutcomeCheck;
  assert.equal(LOCK_OUTCOME_RETRY_SEC, 60); assert.ok(due < s.terms.refundAfter);
  assert.ok(BigInt(before.committed) > 0n);
  assert.equal(polls(event(s, 'tick', { now: due - 1 })).length, 0);
  const check = event(s, 'tick', { now: due });
  assert.deepEqual(polls(check), [{ type: 'lockOutcome', tradeId: s.tradeId, terms: s.terms, hashHex: s.H }]);
  assert.equal(check.state.nextLockOutcomeCheck, due + 60);
  const waiting = event(check.state, 'lockOutcome', { outcome: 'unknown' });
  assert.equal(waiting.state.lockUnknown, true); assert.equal(money(waiting.state).committed, before.committed);
  assert.equal(polls(event(waiting.state, 'tick', { now: due + 59 })).length, 0);
  const retry = event(waiting.state, 'tick', { now: due + 60 });
  assert.equal(polls(retry).length, 1);
  const ended = event(retry.state, 'lockOutcome', { outcome: 'none' });
  assert.equal(ended.state.phase, 'aborted'); assert.equal(ended.state.reason, 'Lock did not go through');
  for (const field of ['locked', 'lockUnknown', 'lockAttempted', 'settlementPending']) assert.equal(ended.state[field], false);
  assert.equal(money(ended.state).committed, '0'); assert.equal(money(ended.state).free, '100000000');
  assert.deepEqual(ended.actions.map(a => a.type), ['abort']);
  assert.equal(event(ended.state, 'escrowLocked', { ok: true }).state, ended.state, 'a delayed callback cannot revive an ended trade');
  assert.equal(event(ended.state, 'resume').state, ended.state);
});

test('a lock found on chain clears ambiguity and follows normal settlement without freeing its funds', () => {
  for (const s of [unknown(), snapshot('locking')]) {
    const landed = event(s, 'lockOutcome', { outcome: 'landed' });
    assert.equal(landed.state.phase, 'locked'); assert.equal(landed.state.locked, true);
    assert.equal(landed.state.lockUnknown, false); assert.ok(BigInt(money(landed.state).committed) > 0n);
    assert.equal(money(landed.state).breakdown.trades, '0');
    assert.equal(polls(event(landed.state, 'tick', { now: landed.state.now + 60 })).length, 0);
    assert.equal(event(landed.state, 'lockOutcome', { outcome: 'none' }).state, landed.state, 'a confirmed lock cannot be written off');
  }
});

test('an interrupted locking phase polls for expiry even after sendBy without trying another lock', () => {
  const s = snapshot('locking');
  const early = event(s, 'tick', { now: s.nextLockOutcomeCheck });
  assert.equal(polls(early).length, 1); assert.equal(early.state.phase, 'locking');
  for (const type of ['tick', 'resume']) {
    const resumed = event(s, type, { now: s.terms.sendBy });
    assert.equal(polls(resumed).length, 1);
    assert.ok(!resumed.actions.some(a => a.type === 'lockEscrow'));
    assert.equal(event(resumed.state, 'lockOutcome', { outcome: 'none' }).state.phase, 'aborted');
  }
});

test('restart resumes recovery immediately, including legacy locked records with no polling metadata', () => {
  for (const legacy of [false, true]) {
    const s = unknown();
    if (legacy) delete s.nextLockOutcomeCheck;
    else s.nextLockOutcomeCheck = s.now + 600;
    const restored = JSON.parse(JSON.stringify(s));
    const resumed = event(restored, 'resume');
    assert.equal(polls(resumed).length, 1);
    assert.equal(resumed.state.nextLockOutcomeCheck, resumed.state.now + 60);
    assert.equal(event(resumed.state, 'lockOutcome', { outcome: 'none' }).state.locked, false);
  }
});

test('missing escrow, RPC errors and unrelated outcome events never free a pending lock', () => {
  const s = { ...unknown(), settlementPending: true };
  const absent = event(s, 'escrowChecked', { purpose: 'settlement', status: 'missing', ok: false });
  assert.equal(absent.state.phase, 'locked'); assert.equal(absent.state.lockUnknown, true);
  for (const fields of [{ outcome: 'unknown' }, { outcome: 'none', hashHex: '00'.repeat(32) },
    { outcome: 'none', tradeId: '00'.repeat(32) }, { outcome: 'invalid' }]) {
    assert.equal(event(absent.state, 'lockOutcome', fields).state, absent.state);
  }
  const due = event(absent.state, 'tick', { now: absent.state.nextLockOutcomeCheck });
  const failed = event(due.state, 'error', { reason: 'lock-outcome: RPC unavailable' });
  assert.equal(failed.state.phase, 'locked'); assert.equal(money(failed.state).committed, money(s).committed);
  assert.equal(polls(event(failed.state, 'tick', { now: due.state.now + 60 })).length, 1);
});
