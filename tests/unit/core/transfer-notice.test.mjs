import test from 'node:test';
import assert from 'node:assert/strict';
import { step, stepFinalized, TRANSFER_NOTICE_RETRY_SEC } from '../../../src/core/trade-seller.js';
import { step as signerStep, SELLER_FUNDS_RETRY_SEC } from '../../../src/core/trade-signer.js';
import { step as buyerStep } from '../../../src/core/trade-buyer.js';
import { createReplayCache, open, seal } from '../../../src/core/envelope.js';
import { simulation } from './simulation.mjs';
import { hex } from './helpers.mjs';

const sim = simulation({ capturePhases: true, pair: 'RESET/USDC' });
const snapshot = (name, phase) => structuredClone(sim.snapshots.get(`${name}:${phase}`));
const notices = r => r.actions.filter(a => a.kind === 'transferSent');
const checks = r => r.actions.filter(a => a.type === 'checkEscrow' && a.purpose === 'settlement');
const event = (s, type, fields = {}) => ({ type, now: s.now, tradeId: s.tradeId, ...fields });
function receive(s, action, now, reducer) {
  const envelope = seal({ kind: action.kind, ch: action.ch, body: action.body }, sim.f.seller.secretKey, { ts: now, nonce: hex() });
  return reducer(s, { type: 'message', now, message: open(envelope, { now, seen: createReplayCache() }) });
}

test('a dropped transfer notice repeats after ten seconds and releases a signer share exactly once', () => {
  assert.equal(TRANSFER_NOTICE_RETRY_SEC, SELLER_FUNDS_RETRY_SEC);
  const original = snapshot('seller', 'transferring'), txHash = hex();
  const sent = stepFinalized(original, event(original, 'transferSent', { ok: true, final: true,
    txHash, sentAt: original.now, finalizedAt: original.now }));
  assert.equal(notices(sent).length, 1);
  let signer = snapshot('signer1', 'holding'); // Drop the first notice entirely.
  assert.equal(signer.txHash, undefined);
  assert.equal(notices(stepFinalized(sent.state, event(sent.state, 'tick', { now: original.now + 9 }))).length, 0);
  const retry = stepFinalized(sent.state, event(sent.state, 'tick', { now: original.now + 10 }));
  assert.deepEqual(notices(retry), notices(sent));
  const verifying = receive(signer, notices(retry)[0], retry.state.now, signerStep);
  signer = verifying.state;
  assert.equal(signer.phase, 'verifyingTransfer');
  assert.equal(verifying.actions.length, 1);
  assert.equal(verifying.actions[0].type, 'verifyTransfer');
  assert.equal(receive(signer, notices(retry)[0], signer.now + 1, signerStep).state, signer);
  const a = verifying.actions[0];
  const verified = signerStep(signer, event(signer, 'transferVerified', { ok: true, final: true, txHash,
    amount: a.minAmount, from: a.from, to: a.to, nonce: a.nonce, asset: a.asset,
    finalizedAt: signer.now, usedBy: signer.tradeId }));
  assert.equal(verified.state.phase, 'persistingTransfer');
  assert.equal(receive(verified.state, notices(retry)[0], signer.now + 1, signerStep).state, verified.state);
  const published = signerStep(verified.state, event(verified.state, 'persisted', {
    scope: 'verifiedTransfer', ok: true, txHash, reservedFor: signer.tradeId }));
  assert.equal(published.state.phase, 'published');
  assert.equal(published.actions.filter(a => a.type === 'publishShare').length, 1);
  assert.equal(receive(published.state, notices(retry)[0], signer.now + 1, signerStep).state, published.state);
  const buyer = receive(snapshot('buyer', 'locked'), notices(retry)[0], retry.state.now, buyerStep);
  assert.equal(buyer.state.txHash, txHash);
  assert.equal(receive(buyer.state, notices(retry)[0], buyer.state.now + 1, buyerStep).state, buyer.state);
  assert.equal(original.txHash, undefined, 'the reducer never mutates its input');
});

test('late notices work strictly inside grace, including a reservation already held by the same trade', () => {
  const seller = snapshot('seller', 'awaitShares'), holding = snapshot('signer1', 'holding');
  const cutoff = seller.terms.sendBy + seller.terms.graceSec;
  const retry = step(seller, event(seller, 'tick', { now: cutoff - 1 }));
  const notice = notices(retry)[0];
  assert.ok(notice);
  holding.usedTx[seller.txHash] = seller.tradeId;
  const accepted = receive(holding, notice, cutoff - 1, signerStep);
  assert.equal(accepted.state.phase, 'verifyingTransfer');
  assert.equal(accepted.actions[0].finalBefore, cutoff);
  for (const now of [cutoff, cutoff + 1]) {
    assert.equal(receive(holding, notice, now, signerStep).state, holding);
    assert.equal(notices(step(retry.state, event(retry.state, 'tick', { now }))).length, 0);
    assert.equal(notices(stepFinalized({ ...seller, transferFinal: true }, event(seller, 'resume', { now }))).length, 0);
  }
  holding.usedTx[seller.txHash] = hex();
  assert.equal(receive(holding, notice, cutoff - 1, signerStep).state, holding);
});

test('notice retries use their own clock, resume immediately without lastMessages, and stop at k shares', () => {
  let s = { ...snapshot('seller', 'awaitShares'), transferFinal: true };
  const gaps = [];
  for (let i = 0; i < 6; i++) {
    const now = s.transferNoticeAt ?? s.now + 10;
    assert.equal(notices(stepFinalized(s, event(s, 'tick', { now: now - 1 }))).length, s.transferNoticeAt ? 0 : 1);
    const retry = stepFinalized(s, event(s, 'tick', { now }));
    assert.equal(notices(retry).length, 1);
    s = retry.state;
    gaps.push(s.transferNoticeAt - s.now);
    assert.equal(notices(stepFinalized(s, event(s, 'tick'))).length, 0);
  }
  assert.deepEqual(gaps, [20, 40, 80, 120, 120, 120], 'repeats back off and cap at two minutes');
  delete s.lastMessages;
  const resumed = stepFinalized(JSON.parse(JSON.stringify(s)), event(s, 'resume', { now: s.now + 1 }));
  assert.equal(notices(resumed).length, 1);
  const due = resumed.state.transferNoticeAt;
  assert.equal(notices(stepFinalized(resumed.state, event(resumed.state, 'tick', { now: due - 1 }))).length, 0);
  assert.equal(notices(stepFinalized(resumed.state, event(resumed.state, 'tick', { now: due }))).length, 1);
  const enough = { ...s, shares: Array.from({ length: s.terms.k }, (_, i) => ({ id: i + 1, share: hex() })) };
  for (const phase of ['awaitShares', 'claiming', 'complete', 'lost']) {
    for (const type of ['tick', 'resume']) {
      assert.equal(notices(stepFinalized({ ...enough, phase }, event(enough, type, { now: s.now + 20 }))).length, 0);
    }
  }
});

test('0.1.31-shaped states resume settlement immediately, regardless of finality and prior polling fields', () => {
  for (const phase of ['awaitShares', 'transferring', 'claiming']) {
    for (const transferFinal of [undefined, true]) {
      for (const settlementPending of [undefined, false, true]) {
        const old = snapshot('seller', phase);
        delete old.transferNoticeAt;
        old.transferFinal = transferFinal;
        old.settlementPending = settlementPending;
        old.nextSettlementCheck = old.terms.refundAfter + 600;
        const journal = JSON.parse(JSON.stringify(old));
        const resumed = stepFinalized(journal, event(journal, 'resume', { now: old.terms.refundAfter }));
        assert.equal(checks(resumed).length, 1);
        assert.equal(resumed.state.settlementPending, true);
        assert.equal(notices(resumed).length, 0);
        for (const [status, expected] of [['refunded', 'lost'], ['claimed', 'complete']]) {
          const settled = stepFinalized(resumed.state, event(resumed.state, 'escrowChecked', {
            hashHex: old.H, purpose: 'settlement', ok: true, status }));
          assert.equal(settled.state.phase, expected);
          assert.equal(settled.state.settlementPending, false);
        }
        assert.deepEqual(journal, JSON.parse(JSON.stringify(old)));
      }
    }
  }
});

test('legacy transfer event replay stays readable and resumes both finality and the missing notice', () => {
  const original = snapshot('seller', 'transferring');
  const replayed = step(original, event(original, 'transferSent', { ok: true, txHash: hex(), sentAt: original.now }));
  assert.equal(replayed.state.phase, 'awaitShares');
  delete replayed.state.transferNoticeAt;
  delete replayed.state.lastMessages;
  const journal = JSON.parse(JSON.stringify(replayed.state));
  const resumed = stepFinalized(journal, event(journal, 'resume', { now: journal.now + 1 }));
  assert.equal(resumed.state.phase, 'transferring');
  assert.equal(notices(resumed).length, 1);
  assert.ok(resumed.actions.some(a => a.type === 'sendTransfer' && a.resume));
});

test('settlement failure retries across the transfer finality transition and rejects mismatched results', () => {
  let s = snapshot('seller', 'transferring');
  s = stepFinalized(s, event(s, 'transferSent', { ok: false, unknown: true, txHash: hex() })).state;
  const pending = stepFinalized(s, event(s, 'tick', { now: s.terms.refundAfter }));
  assert.equal(checks(pending).length, 1);
  assert.ok(pending.actions.some(a => a.type === 'checkSellerTransfer'));
  assert.ok(pending.actions.every(a => a.type !== 'sendTransfer'));
  const failed = stepFinalized(pending.state, event(pending.state, 'error', { purpose: 'settlement' }));
  assert.equal(failed.state.settlementPending, false);
  const final = stepFinalized(failed.state, event(failed.state, 'transferSent', { ok: true, final: true,
    txHash: s.txHash, sentAt: s.now, finalizedAt: s.now }));
  assert.equal(final.state.phase, 'awaitShares');
  assert.equal(checks(stepFinalized(final.state, event(final.state, 'tick', { now: s.terms.refundAfter + 59 }))).length, 0);
  const retry = stepFinalized(final.state, event(final.state, 'tick', { now: s.terms.refundAfter + 60 }));
  assert.equal(checks(retry).length, 1);
  for (const patch of [{ tradeId: hex() }, { hashHex: hex() }, { purpose: 'lock' }, { ok: undefined }]) {
    const rejected = stepFinalized(retry.state, event(retry.state, 'escrowChecked', {
      ok: true, status: 'refunded', hashHex: s.H, purpose: 'settlement', ...patch }));
    assert.equal(rejected.state, retry.state);
  }
  for (const fields of [{ ok: false, status: 'pending' }, { ok: false, status: 'mismatch' }, { ok: true, status: 'active' }]) {
    const uncertain = stepFinalized(retry.state, event(retry.state, 'escrowChecked', { hashHex: s.H, purpose: 'settlement', ...fields }));
    assert.equal(uncertain.state.phase, 'awaitShares');
    assert.equal(uncertain.state.settlementPending, false);
  }
  const settled = stepFinalized(retry.state, event(retry.state, 'escrowChecked', { ok: true, status: 'refunded', hashHex: s.H, purpose: 'settlement' }));
  assert.equal(settled.state.phase, 'lost');
});
