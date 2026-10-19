import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuyer, step as buyerStep } from '../../../src/core/trade-buyer.js';
import { createSeller, step as sellerStep } from '../../../src/core/trade-seller.js';
import { step as signerStep } from '../../../src/core/trade-signer.js';
import { createTrader } from '../../../src/core/trade-common.js';
import { prepareDeal } from '../../../src/core/dealing.js';
import { parseBody } from '../../../src/core/schemas.js';
import { buildTerms, tradeId, validateTerms } from '../../../src/core/terms.js';
import { polynomialCommitments } from '../../../src/core/vss.js';
import { bytesToHex, le32, sha256Hex, stableJSON } from '../../../src/core/canonical.js';
import { createReplayCache, open, seal } from '../../../src/core/envelope.js';
import { fixture, hex, SIG, proofStub } from './helpers.mjs';
import { simulation } from './simulation.mjs';

const sim = simulation({ capturePhases: true });
const steps = { buyer: buyerStep, seller: sellerStep, signer: signerStep };
function snapshot(name, phase) {
  const s = sim.snapshots.get(name + ':' + phase);
  assert.ok(s, name + ':' + phase);
  return structuredClone(s);
}
function step(s, type, fields = {}) {
  return steps[s.role](s, { type, now: s.now + 1, tradeId: s.tradeId, hashHex: s.H, ...fields });
}
function unchanged(s, type, fields = {}) {
  const r = step(s, type, fields);
  assert.equal(r.state, s);
  assert.deepEqual(r.actions, []);
}
function message(s, identity, kind, body, fields = {}) {
  const now = fields.now ?? s.now + 1;
  const envelope = seal({ kind, body, ch: 'intercom-dex:t:' + (body.tradeId ?? body.offerId) }, identity.secretKey,
    { ts: now, nonce: hex() });
  return step(s, 'message', { now, observedSlot: 100, finalizedAgeMs: 0, tipSlot: 132, tipAgeMs: 0,
    message: open(envelope, { now, seen: createReplayCache() }), ...fields });
}
const types = result => result.actions.map(a => a.type);
const checks = result => result.actions.filter(a => a.type === 'checkEscrow');

test('ready seller reserves first; only its own reservation authorizes one transfer', () => {
  const ready = snapshot('seller', 'awaitReady');
  ready.acks = ready.terms.committee.slice(0, ready.terms.k).map(x => x.dexKey);
  const reserved = step(ready, 'escrowChecked', { ok: true, status: 'active' });
  assert.equal(reserved.state.phase, 'reservingEscrow');
  assert.deepEqual(reserved.actions, [{ type: 'reserveEscrow', tradeId: ready.tradeId, hashHex: ready.H }]);
  assert.equal(reserved.state.transferStartedAt, undefined);
  const sent = step(reserved.state, 'escrowReserved', { ok: true, reservedFor: ready.tradeId });
  assert.equal(sent.state.phase, 'transferring');
  assert.deepEqual(types(sent), ['sendTransfer']);
  assert.equal(sent.state.transferStartedAt, sent.state.now);
  unchanged(sent.state, 'escrowReserved', { ok: true, reservedFor: ready.tradeId });
  for (const fields of [{ tradeId: hex() }, { hashHex: hex() }, { hashHex: undefined }, { ok: undefined }]) {
    unchanged(reserved.state, 'escrowReserved', { ok: true, reservedFor: ready.tradeId, ...fields });
  }
  const otherTrade = { ...reserved.state, tradeId: hex() };
  const conflict = step(otherTrade, 'escrowReserved', { ok: false, reservedFor: ready.tradeId });
  assert.equal(conflict.state.phase, 'aborted');
  assert.equal(conflict.state.reason, 'escrow already used by another trade');
  assert.deepEqual(types(conflict), ['abort']);
});

test('reservations retry after 10 seconds, resume idempotently, and never send at the deadline', () => {
  const s = snapshot('seller', 'reservingEscrow');
  for (const [type, fields] of [['escrowReserved', { ok: false }], ['escrowReserved', { ok: false, reservedFor: s.tradeId }],
    ['escrowReserved', { ok: true, reservedFor: hex() }], ['error', {}], ['error', { definite: true }]]) {
    const failed = step(s, type, fields);
    assert.equal(failed.state.phase, 'reservingEscrow');
    assert.equal(failed.state.reserveRetryAt, failed.state.now + 10);
    assert.deepEqual(types(failed), []);
    assert.deepEqual(types(step(failed.state, 'tick', { now: failed.state.reserveRetryAt - 1 })), []);
    const retry = step(failed.state, 'tick', { now: failed.state.reserveRetryAt });
    assert.deepEqual(types(retry), ['reserveEscrow']);
    assert.equal(retry.state.reserveRetryAt, null);
    assert.deepEqual(types(step(retry.state, 'tick')), []);
    const resumed = step(failed.state, 'resume');
    assert.equal(resumed.actions.filter(a => a.type === 'reserveEscrow').length, 1);
    assert.equal(resumed.state.reserveRetryAt, null);
  }
  for (const type of ['tick', 'resume', 'error', 'escrowReserved']) {
    const late = step(s, type, { now: s.terms.sendBy, ok: true, reservedFor: s.tradeId });
    assert.equal(late.state.phase, 'aborted');
    assert.deepEqual(types(late), ['abort']);
  }
  const cancel = message(s, sim.f.buyer, 'abort', { tradeId: s.tradeId, reason: 'cancel' });
  assert.equal(cancel.state.phase, 'aborted');
});

test('attempted locks ignore peer aborts and retry adapter errors without abandoning the journal', () => {
  const s = snapshot('buyer', 'locking'), original = structuredClone(s);
  assert.equal(s.lockAttempted, true);
  assert.equal(message(s, sim.f.seller, 'abort', { tradeId: s.tradeId, reason: 'cancel' }).state, s);
  for (const definite of [undefined, false, true]) {
    const failed = step(s, 'error', { definite });
    assert.equal(failed.state.phase, 'locking');
    assert.equal(failed.state.lockRetryAt, s.now + 31);
    assert.deepEqual(types(step(failed.state, 'tick', { now: s.now + 30 })), []);
    const retry = step(failed.state, 'tick', { now: s.now + 31 });
    assert.deepEqual(retry.actions, [{ type: 'lockEscrow', tradeId: s.tradeId, terms: s.terms, hashHex: s.H }]);
    assert.equal(retry.state.lockRetryAt, null);
    assert.deepEqual(types(step(retry.state, 'tick')), []);
    const resumed = step(failed.state, 'resume');
    assert.equal(resumed.actions.filter(a => a.type === 'lockEscrow').length, 1);
    assert.equal(resumed.state.lockRetryAt, null);
  }
  unchanged(s, 'error', { tradeId: hex(), definite: true });
  assert.deepEqual(s, original);
  const failed = step(s, 'escrowLocked', { ok: false });
  assert.equal(failed.state.phase, 'aborted');
  assert.equal(failed.state.lockAttempted, false);
  unchanged(failed.state, 'resume');
});

test('unresolved locks enter refund recovery at refundAfter and abort only on proven absence', () => {
  const s = snapshot('buyer', 'locking'), now = s.terms.refundAfter;
  assert.equal(step(s, 'tick', { now: now - 1 }).state.phase, 'locking');
  for (const type of ['tick', 'resume']) {
    const recovering = step(s, type, { now });
    assert.equal(recovering.state.phase, 'refunding');
    assert.equal(recovering.state.locked, true);
    assert.equal(recovering.state.lockUnknown, true);
    assert.deepEqual(types(recovering), ['refund']);
    unchanged(recovering.state, 'escrowLocked', { ok: false });
    const failed = step(recovering.state, 'refunded', { ok: false });
    assert.deepEqual(types(failed), ['checkEscrow']);
    for (const fields of [{ unknown: true }, { status: 'pending' }, { status: 'active', ok: true }]) {
      assert.equal(step(failed.state, 'escrowChecked', { purpose: 'settlement', ok: false, status: 'missing', ...fields }).state.phase, 'refunding');
    }
    const asked = step(failed.state, 'escrowChecked', { purpose: 'settlement', ok: false, status: 'missing' });
    assert.deepEqual(types(asked), ['lockOutcome']);
    assert.equal(step(asked.state, 'lockOutcome', { outcome: 'unknown' }).state.phase, 'refunding');
    const absent = step(asked.state, 'lockOutcome', { outcome: 'none' });
    assert.equal(absent.state.phase, 'aborted');
    assert.equal(absent.state.locked, false);
    assert.equal(absent.state.lockAttempted, false);
    unchanged(absent.state, 'resume');
    const confirmed = { ...failed.state, lockUnknown: false };
    assert.equal(step(confirmed, 'escrowChecked', { purpose: 'settlement', ok: false, status: 'missing' }).state.phase, 'refunding');
  }
});

test('buyer polls after either seller notice, rate limits every trigger and completes from chain evidence', () => {
  const s = snapshot('buyer', 'locked');
  for (const [kind, body] of [['transferSent', { txHash: hex() }], ['claimed', { claimSignature: SIG }]]) {
    const notice = message(s, sim.f.seller, kind, { tradeId: s.tradeId, ...body });
    assert.deepEqual(types(notice), ['checkEscrow']);
    assert.equal(notice.actions[0].purpose, 'settlement');
    assert.equal(notice.state.settlementPending, true);
    assert.equal(notice.state.nextSettlementCheck, notice.state.now + 30);
    assert.equal(checks(step(notice.state, 'tick', { now: notice.state.now + 90 })).length, 0);
    const active = step(notice.state, 'escrowChecked', { purpose: 'settlement', ok: true, status: 'active' });
    assert.equal(active.state.settlementPending, false);
    const other = message(active.state, sim.f.seller, 'claimed', { tradeId: s.tradeId, claimSignature: SIG });
    assert.equal(checks(other).length, 0);
    assert.equal(checks(step(active.state, 'tick', { now: notice.state.nextSettlementCheck - 1 })).length, 0);
    const retry = step(active.state, 'tick', { now: notice.state.nextSettlementCheck });
    assert.equal(checks(retry).length, 1);
    for (const [status, phase] of [['claimed', 'complete'], ['refunded', 'refunded']]) {
      const settled = step(retry.state, 'escrowChecked', { purpose: 'settlement', ok: true, status });
      assert.equal(settled.state.phase, phase);
      unchanged(settled.state, 'tick', { now: s.terms.refundAfter });
    }
  }
});

test('buyer polls at the finality cutoff without any seller notice and recovers failed checks', () => {
  const s = snapshot('buyer', 'locked'), cutoff = s.terms.sendBy + s.terms.graceSec;
  assert.equal(checks(step(s, 'tick', { now: cutoff - 1 })).length, 0);
  const pending = step(s, 'tick', { now: cutoff });
  assert.equal(checks(pending).length, 1);
  for (const [type, fields] of [['escrowChecked', { purpose: 'settlement', ok: false, unknown: true }],
    ['error', {}], ['error', { purpose: 'settlement' }]]) {
    const failed = step(pending.state, type, fields);
    assert.equal(failed.state.phase, 'locked');
    assert.equal(failed.state.settlementPending, false);
    assert.equal(checks(step(failed.state, 'tick', { now: cutoff + 29 })).length, 0);
    assert.equal(checks(step(failed.state, 'tick', { now: cutoff + 30 })).length, 1);
  }
  for (const fields of [{ tradeId: hex() }, { hashHex: hex() }, { purpose: undefined }, { ok: undefined }]) {
    unchanged(pending.state, 'escrowChecked', { purpose: 'settlement', ok: true, status: 'claimed', ...fields });
  }
  const resumed = step(pending.state, 'resume', { now: cutoff + 60 });
  assert.equal(checks(resumed).length, 1);
  assert.equal(resumed.state.nextSettlementCheck, cutoff + 90);
});

test('buyer remembers seller notices during locking and checks once the lock result arrives', () => {
  const s = snapshot('buyer', 'locking');
  for (const [kind, body] of [['transferSent', { txHash: hex() }], ['claimed', { claimSignature: SIG }]]) {
    const notice = message(s, sim.f.seller, kind, { tradeId: s.tradeId, ...body });
    assert.deepEqual(types(notice), []);
    const locked = step(notice.state, 'escrowLocked', { ok: true });
    assert.deepEqual(types(locked), ['persist', 'checkEscrow']);
  }
});

test('buyer settlement checks survive refunding and never suppress the refund deadline', () => {
  const s = snapshot('buyer', 'locked'), now = s.terms.refundAfter;
  const pending = step(s, 'tick', { now: now - 1 });
  const refund = step(pending.state, 'tick', { now });
  assert.deepEqual(types(refund), ['refund']);
  assert.equal(refund.state.settlementPending, true);
  const failedRefund = step(refund.state, 'refunded', { ok: false });
  assert.equal(checks(failedRefund).length, 0);
  const active = step(failedRefund.state, 'escrowChecked', { purpose: 'settlement', ok: true, status: 'active' });
  assert.equal(checks(step(active.state, 'tick', { now: now + 28 })).length, 0);
  const checked = step(active.state, 'tick', { now: now + 29 });
  assert.equal(checks(checked).length, 1);
  for (const status of ['claimed', 'refunded']) {
    assert.equal(step(checked.state, 'escrowChecked', { purpose: 'settlement', ok: true, status }).state.phase,
      status === 'claimed' ? 'complete' : 'refunded');
  }
  const checkError = step(checked.state, 'error', { purpose: 'settlement' });
  assert.equal(checkError.state.settlementPending, false);
  const refundError = step(checked.state, 'error');
  assert.equal(refundError.state.settlementPending, true);
  assert.equal(refundError.state.refundRetryAt, refundError.state.now + 15);
  for (const state of [pending.state, checked.state]) {
    const resumed = step(state, 'resume', { now: now + 60 });
    assert.equal(checks(resumed).length, 1);
    assert.ok(types(resumed).includes('refund'));
    assert.equal(resumed.state.nextSettlementCheck, now + 90);
  }
});

test('sellers poll settlement every 60 seconds after refundAfter in both unpaid recovery phases', () => {
  for (const phase of ['awaitShares', 'claiming']) {
    const s = snapshot('seller', phase), now = s.terms.refundAfter;
    assert.equal(checks(step(s, 'tick', { now: now - 1 })).length, 0);
    const pending = step(s, 'tick', { now });
    assert.equal(checks(pending).length, 1);
    assert.equal(pending.state.nextSettlementCheck, now + 60);
    assert.equal(checks(step(pending.state, 'tick', { now: now + 120 })).length, 0);
    for (const fields of [{ ok: true, status: 'active' }, { ok: false, unknown: true }, { ok: false, status: 'refunded' }]) {
      const active = step(pending.state, 'escrowChecked', { purpose: 'settlement', ...fields });
      assert.equal(active.state.phase, phase);
      assert.equal(checks(step(active.state, 'tick', { now: now + 59 })).length, 0);
      assert.equal(checks(step(active.state, 'tick', { now: now + 60 })).length, 1);
    }
    const failed = step(pending.state, 'error', { purpose: 'settlement' });
    assert.equal(failed.state.settlementPending, false);
    const resumed = step(pending.state, 'resume', { now: now + 120 });
    assert.equal(checks(resumed).length, 1);
    assert.equal(resumed.state.nextSettlementCheck, now + 180);
    for (const fields of [{ hashHex: hex() }, { tradeId: hex() }, { purpose: undefined }, { ok: undefined }]) {
      unchanged(pending.state, 'escrowChecked', { purpose: 'settlement', ok: true, status: 'refunded', ...fields });
    }
    for (const [status, expected] of [['claimed', 'complete'], ['refunded', 'lost']]) {
      const settled = step(pending.state, 'escrowChecked', { purpose: 'settlement', ok: true, status });
      assert.equal(settled.state.phase, expected);
      assert.deepEqual(settled.actions, []);
      unchanged(settled.state, 'tick', { now: now + 120 });
      assert.ok(!types(step(settled.state, 'resume')).includes('claim'));
    }
  }
});

test('active settlement keeps late shares usable; lost ignores all subsequent event types', () => {
  let s = snapshot('seller', 'awaitShares'), now = s.terms.refundAfter;
  const pending = step(s, 'tick', { now }).state;
  s = step(pending, 'escrowChecked', { purpose: 'settlement', ok: true, status: 'active' }).state;
  const publications = sim.log.filter(x => x.action.type === 'publishShare');
  for (const { name, action } of publications.slice(0, s.terms.k)) {
    const r = message(s, sim.nodes.get(name).identity, 'sharePublish', action.body);
    s = r.state;
    if (s.shares.length === s.terms.k) assert.deepEqual(types(r), ['claim']);
  }
  assert.equal(s.phase, 'claiming');
  const lost = step(pending, 'escrowChecked', { purpose: 'settlement', ok: true, status: 'refunded' }).state;
  for (const type of ['tick', 'resume', 'error', 'escrowChecked', 'escrowReserved', 'transferSent', 'claimed', 'refunded', 'persisted', 'transferVerified', 'escrowLocked', 'unexpected']) {
    unchanged(lost, type, { ok: true, purpose: 'settlement', status: 'claimed', claimSignature: SIG, reservedFor: lost.tradeId });
  }
  for (const { name, action } of publications) assert.equal(message(lost, sim.nodes.get(name).identity, 'sharePublish', action.body).state, lost);
  assert.equal(message(lost, sim.f.buyer, 'abort', { tradeId: lost.tradeId, reason: 'cancel' }).state, lost);
});

test('failed signer reservations and adapter errors retry after 10 seconds without expiring', () => {
  const s = snapshot('signer1', 'persistingTransfer'), now = s.terms.refundAfter + 1;
  for (const [type, fields] of [['persisted', { scope: 'verifiedTransfer', ok: false }], ['error', {}], ['error', { definite: true }]]) {
    const failed = step(s, type, { now, ...fields });
    assert.equal(failed.state.phase, 'persistingTransfer');
    assert.equal(failed.state.reserveRetryAt, now + 10);
    assert.deepEqual(types(step(failed.state, 'tick', { now: now + 9 })), []);
    const retry = step(failed.state, 'tick', { now: now + 10 });
    assert.deepEqual(retry.actions, [{ type: 'persist', scope: 'verifiedTransfer', tradeId: s.tradeId,
      record: { txHash: s.txHash, reservedFor: s.tradeId, ifUnused: true } }]);
    assert.equal(retry.state.reserveRetryAt, null);
    assert.deepEqual(types(step(retry.state, 'tick')), []);
    const resumed = step(failed.state, 'resume');
    assert.equal(resumed.actions.filter(a => a.scope === 'verifiedTransfer').length, 1);
    assert.equal(resumed.state.reserveRetryAt, null);
    const published = step(retry.state, 'persisted', { scope: 'verifiedTransfer', ok: true, txHash: s.txHash, reservedFor: s.tradeId });
    assert.equal(published.state.phase, 'published');
    assert.deepEqual(types(published), ['publishShare']);
  }
  for (const fields of [{ tradeId: hex() }, { txHash: hex() }, { scope: 'signerShare' }]) {
    unchanged(s, 'persisted', { now, scope: 'verifiedTransfer', ok: false, ...fields });
  }
});

test('take, accept and reveal require a finalized slot seen less than 15000 ms ago and a chain tip seen less than 6000 ms ago', () => {
  for (const buyerMaker of [false, true]) {
    const transcript = simulation({ buyerMaker, capturePhases: true });
    for (const [name, phase, kind] of [[buyerMaker ? 'buyer' : 'seller', 'awaitTake', 'take'],
      [buyerMaker ? 'seller' : 'buyer', 'awaitAccept', 'accept'], ['buyer', 'awaitReveal', 'reveal'], ['seller', 'awaitReveal', 'reveal']]) {
      const s = structuredClone(transcript.snapshots.get(name + ':' + phase)), other = name === 'buyer' ? 'seller' : 'buyer';
      const body = transcript.log.find(x => x.name === other && x.action.kind === kind).action.body;
      for (const fields of [{ finalizedAgeMs: undefined }, { finalizedAgeMs: 15000 }, { finalizedAgeMs: 16000 },
        { finalizedAgeMs: -1 }, { finalizedAgeMs: NaN }, { finalizedAgeMs: Infinity }, { observedSlot: undefined }, { observedSlot: -1 },
        { tipAgeMs: undefined }, { tipAgeMs: 6000 }, { tipAgeMs: 6900 }, { tipAgeMs: -1 }, { tipAgeMs: NaN }, { tipAgeMs: Infinity },
        { tipSlot: undefined }, { tipSlot: -1 }]) {
        const r = message(s, transcript.f[other], kind, body, { now: 100, ...fields });
        assert.equal(r.state, s, name + ':' + kind);
        assert.deepEqual(r.actions, []);
      }
      const fresh = message(s, transcript.f[other], kind, body, { now: 100, finalizedAgeMs: 14999.99, tipAgeMs: 5999.99 });
      assert.notEqual(fresh.state, s, name + ':' + kind);
      assert.notEqual(fresh.state.phase, 'aborted');
    }
  }
});

test('maker and taker both refuse a peer reveal once the chain tip reaches acceptSlot + 56', () => {
  for (const name of ['buyer', 'seller']) {
    const s = snapshot(name, 'awaitReveal'), other = name === 'buyer' ? 'seller' : 'buyer';
    const body = sim.log.find(x => x.name === other && x.action.kind === 'reveal').action.body;
    assert.equal(message(s, sim.f[other], 'reveal', body, { tipSlot: s.acceptSlot + 55 }).state.phase, 'awaitRandomness');
    for (const slot of [s.acceptSlot + 56, s.acceptSlot + 1000]) {
      const late = message(s, sim.f[other], 'reveal', body, { tipSlot: slot });
      assert.equal(late.state.phase, 'aborted');
      assert.equal(late.state.reason, 'Reveal arrived too late');
    }
    const stale = message(s, sim.f[other], 'reveal', body, { tipSlot: s.acceptSlot + 56, tipAgeMs: 100000 });
    assert.equal(stale.state, s);
    const committed = snapshot(name, name === 'buyer' ? 'locking' : 'transferring');
    assert.equal(message(committed, sim.f[other], 'reveal', body, { tipSlot: s.acceptSlot + 56 }).state, committed);
  }
});

test('canonical terms bind offerId and constructors reject mismatched drafts', () => {
  const f = fixture(), config = { mode: 'taker', offerId: f.offerId, terms: f.terms, registry: f.registry, nonce: hex(), entropy: hex(), now: 100 };
  assert.equal(buildTerms(f.terms).offerId, f.offerId);
  assert.notEqual(tradeId(f.terms), tradeId({ ...f.terms, offerId: hex() }));
  for (const offerId of [undefined, 'ab', 'AB'.repeat(32)]) {
    for (const validate of [buildTerms, validateTerms, tradeId]) assert.throws(() => validate({ ...f.terms, offerId }));
  }
  for (const create of [createBuyer, createSeller]) {
    assert.equal(create(config).draft.offerId, f.offerId);
    assert.throws(() => create({ ...config, offerId: hex() }), /Terms do not match offer/);
  }
  assert.throws(() => createTrader('buyer', { ...config, terms: { ...f.terms, offerId: hex() } }), /Terms do not match offer/);
  const maker = snapshot('seller', 'awaitTake'), take = sim.log.find(x => x.action.kind === 'take').action.body;
  assert.equal(message(maker, sim.f.buyer, 'take', { ...take, offerId: hex() }).state, maker);
});

test('publications include exactly the selected commitments and have a strict schema', () => {
  const s = snapshot('signer1', 'persistingTransfer');
  const r = step(s, 'persisted', { scope: 'verifiedTransfer', ok: true, txHash: s.txHash, reservedFor: s.tradeId });
  const body = r.actions[0].body, expected = s.deal.commitments;
  assert.deepEqual(body.commitments, expected);
  assert.equal(body.commitments.length, s.terms.k);
  assert.deepEqual(parseBody('sharePublish', body), body);
  assert.deepEqual(step(r.state, 'resume').actions[0].body.commitments, expected);
  for (const commitments of [undefined, [], ['xx'], Array(257).fill(expected[0])]) {
    assert.throws(() => parseBody('sharePublish', { ...body, commitments }));
  }
  assert.throws(() => parseBody('sharePublish', { ...body, extra: true }));
  const seller = snapshot('seller', 'awaitShares'), identity = sim.nodes.get('signer1').identity;
  assert.equal(message(seller, identity, 'sharePublish', { ...body, commitments: expected.slice(1) }).state, seller);
  const otherCommitments = polynomialCommitments([1n, 1n, 1n]);
  const accepted = message(seller, identity, 'sharePublish', { ...body, commitments: otherCommitments });
  assert.equal(accepted.state, seller, 'Publications must carry the agreed commitments');
  const forged = message(seller, identity, 'sharePublish', { ...body, share: bytesToHex(le32(3n)), commitments: otherCommitments });
  assert.equal(forged.state, seller, 'A share valid only for the supplied polynomial is rejected');
});

test('a buyer signs no new lock once the seller could no longer send', () => {
  const s = snapshot('buyer', 'locking'), late = s.terms.sendBy;
  const waiting = { ...s, lockRetryAt: late - 10 };
  assert.deepEqual(types(step(waiting, 'tick', { now: late - 1 })), ['lockEscrow']);
  assert.deepEqual(types(step(waiting, 'tick', { now: late })), []);
  assert.ok(!types(step(s, 'resume', { now: late })).includes('lockEscrow'));
});

test('the largest allowed dealing fits the 2 MB sidechannel message limit', async () => {
  const { generateBox, encodeKey } = await import('../../../src/core/keys.js');
  const boxes = Array.from({ length: 16 }, () => encodeKey(generateBox().publicKey));
  const { deal } = prepareDeal({ k: 16, committeeBoxKeys: boxes, tradeId: hex() });
  deal.proof = proofStub();
  const envelope = seal({ kind: 'deal', ch: 'intercom-dex:t:' + deal.tradeId, body: deal }, sim.f.buyer.secretKey, { ts: 100, nonce: hex() });
  assert.ok(JSON.stringify(envelope).length < 2_000_000, `dealing is ${JSON.stringify(envelope).length} bytes`);
});

test('the largest allowed registry fits the 200 KB sidechannel message limit', async () => {
  const { registrySchema } = await import('../../../src/core/schemas.js');
  const { generateIdentity, generateBox, encodeKey } = await import('../../../src/core/keys.js');
  const one = { dexKey: encodeKey(generateIdentity().publicKey), boxKey: encodeKey(generateBox().publicKey) };
  const signers = Array.from({ length: 128 }, (_, i) => ({ dexKey: hex(), boxKey: hex(), label: 'x'.repeat(80), assets: ['TNK', 'RESET'], software: '0.1.0', limitUsdc: '9'.repeat(20), status: 'active', ...(i === 0 ? one : {}) }));
  const removed = Array.from({ length: 256 }, () => ({ dexKey: hex(), removedAt: 4102444800, reason: 'r'.repeat(160) }));
  const registry = registrySchema.parse({ ...sim.f.registry, signers, removed });
  const envelope = seal({ kind: 'registry', ch: 'intercom-dex', body: registry }, sim.f.service.secretKey, { ts: 100, nonce: hex() });
  assert.ok(Buffer.byteLength(JSON.stringify(envelope)) < 200_000, `registry is ${Buffer.byteLength(JSON.stringify(envelope))} bytes`);
  assert.throws(() => registrySchema.parse({ ...registry, signers: [{ ...signers[0], label: '\u4e2d' }] }), 'only plain ASCII text');
  assert.throws(() => registrySchema.parse({ ...registry, removed: [{ ...removed[0], reason: 'a"b' }] }));
});

test('100.01 to 106.91 exceeds the strict monotonic tip age even when wall seconds differ by six', () => {
  const s = snapshot('buyer', 'awaitReveal');
  const body = sim.log.find(x => x.name === 'seller' && x.action.kind === 'reveal').action.body;
  const age = (106.91 - 100.01) * 1000;
  const result = message(s, sim.f.seller, 'reveal', body, { now: 106, finalizedAgeMs: age, tipAgeMs: age, tipSlot: s.acceptSlot + 55 });
  assert.equal(result.state, s); assert.deepEqual(result.actions, []);
  assert.equal(message(s, sim.f.seller, 'reveal', body,
    { now: 106, finalizedAgeMs: 14999.99, tipAgeMs: 5999.99, tipSlot: s.acceptSlot + 55 }).state.phase, 'awaitRandomness');
});
