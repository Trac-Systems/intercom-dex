import test from 'node:test';
import assert from 'node:assert/strict';
import { step, SELLER_FUNDS_RETRY_SEC } from '../../../src/core/trade-signer.js';
import { simulation } from './simulation.mjs';
import { hex } from './helpers.mjs';

const sim = simulation({ holdSellerFunds: true, capturePhases: true, buyerMaker: true });
const pending = () => structuredClone(sim.state('signer1'));
const event = (s, type, extra = {}) => ({ type, now: s.now, tradeId: s.tradeId, ...extra });

test('signer saves its share then asks to read the exact terms seller before its first ack', () => {
  const s = sim.snapshots.get('signer1:persistingShare');
  const r = step(s, event(s, 'persisted', { scope: 'signerShare', ok: true }));
  assert.equal(r.state.phase, 'checkingSellerFunds');
  assert.deepEqual(r.actions, [{ type: 'checkSellerFunds', tradeId: s.tradeId, seller: s.terms.seller.tracAddr }]);
  assert.equal(sim.count('lockEscrow'), 0);
  assert.equal(sim.count('sendTransfer'), 0);
});

test('funded seller reserves the fee in holding state and receives the unchanged ack', () => {
  const s = pending(), r = step(s, event(s, 'sellerFunds', { ok: true, feeTnk: '30' }));
  assert.equal(r.state.phase, 'holding');
  assert.deepEqual(r.state.sellerFundsReservation, { feeTnk: '30' });
  assert.deepEqual(r.actions, [{ type: 'send', ch: 'intercom-dex:t:' + s.tradeId, kind: 'ack',
    body: { tradeId: s.tradeId, H: s.H, holdUntil: s.terms.refundAfter } }]);
  assert.equal(s.phase, 'checkingSellerFunds');
  assert.deepEqual(step(r.state, event(r.state, 'sellerFunds', { ok: false })).actions, []);
});

test('unfunded, already reserved and unreadable wallets retry without ack; a top-up can pass', () => {
  for (const reason of ['insufficient', 'reserved by earlier ack', 'Trac read failed']) {
    const s = pending(), r = step(s, event(s, 'sellerFunds', { ok: false, reason }));
    assert.equal(r.state.phase, 'checkingSellerFunds');
    assert.equal(r.actions[0].kind, 'refused'); assert.equal(r.actions[0].body.reason, 'seller-funds');
    assert.deepEqual(step(r.state, event(r.state, 'tick', { now: s.now + SELLER_FUNDS_RETRY_SEC - 1 })).actions, []);
    const retry = step(r.state, event(r.state, 'tick', { now: s.now + SELLER_FUNDS_RETRY_SEC }));
    assert.equal(retry.actions[0].type, 'checkSellerFunds');
    const funded = step(retry.state, event(retry.state, 'sellerFunds', { ok: true, feeTnk: '30' }));
    assert.equal(funded.actions[0].kind, 'ack');
  }
});

test('read errors never abort another trade or remove the funds retry', () => {
  const s = pending(), r = step(s, event(s, 'error', { definite: true, reason: 'offline' }));
  assert.equal(r.state.phase, 'checkingSellerFunds');
  assert.equal(step(r.state, event(r.state, 'tick', { now: r.state.sellerFundsRetryAt })).actions[0].type, 'checkSellerFunds');
});

test('restart mid-check repeats the read without extending its deadline; holding resumes its ack', () => {
  const s = pending(), resumed = step(JSON.parse(JSON.stringify(s)), event(s, 'resume', { now: s.now + 5 }));
  assert.equal(resumed.actions[0].type, 'checkSellerFunds');
  assert.equal(resumed.state.sellerFundsDeadline, s.sellerFundsDeadline);
  const funded = step(resumed.state, event(resumed.state, 'sellerFunds', { ok: true, feeTnk: '30' }));
  const held = step(JSON.parse(JSON.stringify(funded.state)), event(funded.state, 'resume'));
  assert.deepEqual(held.actions, funded.actions);
  assert.deepEqual(held.state.sellerFundsReservation, { feeTnk: '30' });
});

test('deadline, late read, restart after deadline and malformed approvals never ack', () => {
  const s = pending();
  for (const type of ['tick', 'resume', 'sellerFunds']) {
    const r = step(s, event(s, type, { now: s.sellerFundsDeadline, ok: true, feeTnk: '30' }));
    assert.equal(r.state.phase, 'aborted'); assert.ok(!r.actions.some(a => a.kind === 'ack'));
  }
  for (const patch of [{ tradeId: hex(), ok: true, feeTnk: '30' }, { ok: true }, { ok: true, feeTnk: '-1' }, { ok: 'true', feeTnk: '30' }]) {
    const r = step(s, event(s, 'sellerFunds', patch));
    assert.equal(r.state, s); assert.deepEqual(r.actions, []);
  }
  const aborted = step(s, event(s, 'tick', { now: s.sellerFundsDeadline })).state;
  assert.deepEqual(step(aborted, event(aborted, 'sellerFunds', { ok: true, feeTnk: '30' })).actions, []);
});

test('a buyer on a buy offer aborts an unfunded taker immediately without locking or transferring', () => {
  const s = simulation({ buyerMaker: true, sellerFundsOk: false });
  assert.equal(s.state('buyer').reason, 'The seller cannot deliver this trade right now');
  assert.match(s.state('seller').reason, /^Signers refused: your wallet does not hold /);
  assert.equal(s.count('lockEscrow'), 0); assert.equal(s.count('sendTransfer'), 0);
});
