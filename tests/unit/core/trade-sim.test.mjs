import test from 'node:test';
import assert from 'node:assert/strict';
import { simulation } from './simulation.mjs';
import { hex } from './helpers.mjs';

test('full n=5 k=3 trade completes through signed envelopes and in-memory adapters', () => {
  const sim = simulation();
  assert.equal(sim.state('seller').phase, 'complete'); assert.equal(sim.state('buyer').phase, 'complete');
  assert.equal(sim.count('sendTransfer'), 1); assert.equal(sim.count('claim'), 1); assert.equal(sim.count('publishShare'), 5);
  assert.equal(sim.count('abort'), 0);
  for (let i = 1; i <= 5; i++) {
    const entries = sim.log.filter(x => x.name === 'signer' + i).map(x => x.action);
    const persist = entries.findIndex(a => a.type === 'persist' && a.scope === 'signerShare');
    const ack = entries.findIndex(a => a.type === 'send' && a.kind === 'ack');
    const verify = entries.findIndex(a => a.type === 'verifyTransfer');
    const reserve = entries.findIndex(a => a.type === 'persist' && a.scope === 'verifiedTransfer');
    const publish = entries.findIndex(a => a.type === 'publishShare');
    assert.ok(persist < ack && ack < verify && verify < reserve && reserve < publish);
  }
});
test('maker can be buyer or seller, and either TNK or RESET can be the base', () => {
  for (const buyerMaker of [false, true]) for (const pair of ['TNK/USDC', 'RESET/USDC']) {
    const sim = simulation({ buyerMaker, pair });
    assert.equal(sim.state('seller').phase, 'complete'); assert.equal(sim.state('buyer').phase, 'complete');
    assert.equal(sim.count('abort'), 0);
  }
});
test('one or two offline signers still leave k of n to complete', () => {
  for (const offline of [[5], [4, 5]]) {
    const sim = simulation({ offline });
    assert.equal(sim.state('seller').phase, 'complete'); assert.equal(sim.count('publishShare'), 5 - offline.length);
  }
});
test('too few acks or missing/negative escrow checks prevent every seller transfer', () => {
  for (const options of [{ ackCount: 2 }, { escrowCheck: false }, { escrowOk: false }, { persistShare: false }]) {
    const sim = simulation(options); assert.equal(sim.count('sendTransfer'), 0);
    sim.dispatch('seller', { type: 'tick', now: sim.state('seller').terms.sendBy }); sim.drain();
    assert.equal(sim.count('sendTransfer'), 0); assert.equal(sim.state('seller').phase, 'aborted');
  }
});
test('wrong amount, nonce, recipient, asset, nonfinal or late transfers never release shares', () => {
  for (const transferPatch of [{ amount: '123455' }, { amount: '123457' }, { nonce: hex() }, { to: 'wrong' },
    { asset: 'OTHER' }, { final: false }, { ok: false }, { now: 1300, finalizedAt: 1300 }, { finalizedAt: 101 }]) {
    const sim = simulation({ transferPatch });
    assert.equal(sim.count('publishShare'), 0); assert.equal(sim.count('claim'), 0);
  }
});
test('used transfer cannot release for a second trade; durable reservation also gates publication', () => {
  const usedTx = new Map(), txHash = hex();
  const first = simulation({ usedTx, txHash }); assert.equal(first.state('seller').phase, 'complete');
  const second = simulation({ usedTx, txHash }); assert.equal(second.count('publishShare'), 0);
  const snapshot = simulation({ txHash, usedSnapshot: Object.fromEntries(usedTx) }); assert.equal(snapshot.count('verifyTransfer'), 0);
  const notDurable = simulation({ persistTransfer: false }); assert.equal(notDurable.count('publishShare'), 0);
});
test('seller never sends: buyer refunds at refundAfter, never before it', () => {
  const sim = simulation({ neverSend: true }), deadline = sim.state('buyer').terms.refundAfter;
  assert.equal(sim.count('claim'), 0);
  sim.dispatch('buyer', { type: 'tick', now: deadline - 1 }); sim.drain(); assert.equal(sim.count('refund'), 0);
  sim.dispatch('buyer', { type: 'tick', now: deadline }); sim.drain();
  assert.equal(sim.count('refund'), 1); assert.equal(sim.state('buyer').phase, 'refunded');
});
test('an adapter error after locking leaves the buyer locked and preserves its refund path', () => {
  const sim = simulation({ neverSend: true });
  sim.dispatch('buyer', { type: 'error', reason: 'transport failed' }); sim.drain();
  assert.equal(sim.state('buyer').phase, 'locked');
  sim.dispatch('buyer', { type: 'tick', now: sim.state('buyer').terms.refundAfter }); sim.drain();
  assert.equal(sim.state('buyer').phase, 'refunded');
});
test('a signed but unconfirmed claim notification cannot disable buyer refund recovery', () => {
  const sim = simulation({ neverSend: true }), s = sim.state('buyer');
  sim.deliver('seller', 'claimed', { tradeId: s.tradeId, claimSignature: '2'.repeat(88) }, 'intercom-dex:t:' + s.tradeId);
  sim.drain();
  assert.notEqual(sim.state('buyer').phase, 'complete');
  sim.dispatch('buyer', { type: 'tick', now: s.terms.refundAfter }); sim.drain();
  assert.equal(sim.state('buyer').phase, 'refunded');
});
test('seller retries an escrow still being created and waits for a positive check', () => {
  const sim = simulation({ pendingChecks: 1 });
  assert.equal(sim.count('sendTransfer'), 0); assert.equal(sim.state('seller').phase, 'awaitReady');
  sim.dispatch('seller', { type: 'tick', now: 101 }); sim.drain();
  assert.equal(sim.state('seller').phase, 'complete'); assert.equal(sim.state('buyer').phase, 'complete');
});
test('corrupted sealed shares prevent affected signers from acking; a lost quorum prevents sending', () => {
  const one = simulation({ corruptShares: [1] });
  assert.equal(one.state('signer1').phase, 'aborted'); assert.equal(one.state('seller').phase, 'complete');
  const quorum = simulation({ corruptShares: [1, 2, 3] });
  assert.equal(quorum.count('sendTransfer'), 0); assert.equal(quorum.count('publishShare'), 0);
});
test('a failed certificate stops the seller and all signers before payment', () => {
  const sim = simulation({ checkProofOk: false });
  assert.equal(sim.count('sendTransfer'), 0); assert.equal(sim.count('publishShare'), 0);
  assert.equal(sim.state('seller').phase, 'aborted');
  assert.equal(sim.state('seller').reason, 'Invalid lock certificate');
  assert.equal(sim.log.filter(x => x.action.kind === 'ack').length, 0);
});

test('a failed claim is retried until it succeeds; the seller never gives up after sending', () => {
  const sim = simulation({ claimFailures: 2 });
  assert.equal(sim.state('seller').phase, 'claiming');
  for (const now of [120, 140]) { sim.dispatch('seller', { type: 'tick', now }); sim.drain(); }
  assert.equal(sim.state('seller').phase, 'complete');
  assert.equal(sim.count('claim'), 3); assert.equal(sim.count('abort'), 0);
});

test('a buyer cancel after the seller sent changes nothing: signers still publish and the seller claims', () => {
  const sim = simulation({ holdVerify: true });
  const s = sim.state('seller');
  assert.equal(s.phase, 'awaitShares');
  sim.deliver('buyer', 'abort', { tradeId: s.tradeId, reason: 'changed my mind' }, 'intercom-dex:t:' + s.tradeId);
  sim.drain();
  for (let i = 1; i <= 5; i++) assert.notEqual(sim.state('signer' + i).phase, 'aborted');
  sim.releaseVerifications();
  assert.equal(sim.state('seller').phase, 'complete');
  assert.equal(sim.count('publishShare'), 5);
});
