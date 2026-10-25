import test from 'node:test';
import assert from 'node:assert/strict';
import { step as buyerStep } from '../../../src/core/trade-buyer.js';
import { stepFinalized as sellerStep } from '../../../src/core/trade-seller.js';
import { refusalReason, peerAbortReason } from '../../../src/core/trade-common.js';
import { seal, open, createReplayCache } from '../../../src/core/envelope.js';
import { simulation } from './simulation.mjs';
import { hex } from './helpers.mjs';

const sim = simulation({ holdSellerFunds: true });
function message(s, reason = 'seller-funds', patch = {}) {
  return { v: 1, kind: 'refused', from: s.terms.committee[0].dexKey, ch: 'intercom-dex:t:' + s.tradeId,
    body: { tradeId: s.tradeId, reason }, ...patch };
}

for (const [role, step] of [['buyer', buyerStep], ['seller', sellerStep]]) {
  test(`${role} stops on a committee refusal with its own plain explanation`, () => {
    const s = sim.state(role);
    for (const reason of ['seller-funds', 'seller-struck']) {
      const r = step(s, { type: 'message', now: s.now, message: message(s, reason) });
      assert.equal(r.state.phase, 'aborted'); assert.equal(r.state.reason, refusalReason(s, reason));
      assert.deepEqual(r.actions.map(a => a.type), ['abort']);
      const peer = sim.state(role === 'buyer' ? 'seller' : 'buyer');
      assert.equal(peerAbortReason(s, refusalReason(peer, reason)), r.state.reason);
    }
  });
  test(`${role} ignores strangers, wrong trades, wrong channels and unknown refusal reasons`, () => {
    const s = sim.state(role);
    for (const patch of [{ from: hex() }, { ch: 'intercom-dex:signers' },
      { body: { tradeId: hex(), reason: 'seller-funds' } }, { body: { tradeId: s.tradeId, reason: 'other' } }]) {
      assert.deepEqual(step(s, { type: 'message', now: s.now, message: message(s, 'seller-funds', patch) }), { state: s, actions: [] });
    }
  });
}

test('late refusals preserve lock, transfer and settlement recovery', () => {
  for (const [role, step, patches] of [
    ['buyer', buyerStep, [{ phase: 'locking', lockAttempted: true }, { phase: 'locked', locked: true }, { phase: 'refunding', locked: true }]],
    ['seller', sellerStep, [{ phase: 'awaitReady', escrowOk: true }, { phase: 'reservingEscrow' }, { phase: 'transferring' }, { phase: 'awaitShares' }, { phase: 'claiming' }]],
  ]) for (const patch of patches) {
    const s = { ...sim.state(role), ...patch };
    assert.deepEqual(step(s, { type: 'message', now: s.now, message: message(s) }), { state: s, actions: [] });
  }
});

test('refusals use the ack envelope signature and reject tampering', () => {
  const node = sim.nodes.get('signer1'), s = node.state;
  const signed = seal({ kind: 'refused', ch: 'intercom-dex:t:' + s.tradeId,
    body: { tradeId: s.tradeId, reason: 'seller-struck' } }, node.identity.secretKey, { ts: s.now, nonce: hex() });
  assert.equal(open(signed, { now: s.now, seen: createReplayCache() }).kind, 'refused');
  assert.throws(() => open({ ...signed, body: { ...signed.body, reason: 'seller-funds' } },
    { now: s.now, seen: createReplayCache() }), /signature/i);
});
