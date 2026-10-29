import test from 'node:test';
import assert from 'node:assert/strict';
import { BuyerStrikes, SellerStrikes, STRIKE_WINDOW_SEC as WEEK, buyerStrikeCandidate } from '../../../src/roles/signer-strikes.js';
const buyer = { tracAddr: 'proven-buyer', dexKey: 'ab'.repeat(32) };
function memory() { const rows = new Map(); return { get: k => structuredClone(rows.get(k)), put: (k, v) => rows.set(k, structuredClone(v)) }; }

test('buyer strikes independently mirror seller expiry, address identity rotation, restart, clear and cancellation', () => {
  const store = memory(), b = new BuyerStrikes({ enabled: true, store }), s = new SellerStrikes({ enabled: true, store });
  b.record(buyer, 'first', 10); assert.equal(b.refusal(buyer, 10), null);
  b.record({ ...buyer, dexKey: 'cd'.repeat(32) }, 'second', 20);
  assert.equal(b.refusal(buyer, 20).until, 20 + WEEK);
  assert.equal(s.refusal(buyer, 20), null);
  assert.equal(b.record(buyer, 'second', 21), false);
  const again = new BuyerStrikes({ enabled: true, store });
  assert.ok(again.refusal(buyer, 10 + WEEK));
  assert.equal(again.refusal(buyer, 20 + WEEK), null);
  again.forget('first', 30); assert.equal(again.refusal(buyer, 30), null);
  again.record(buyer, 'third', 40);
  assert.deepEqual(again.clear(buyer, 41), { cleared: true, strikes: 2, refusals: 1 });
  assert.deepEqual(again.list(41), { strikes: [], refusals: [] });
});

test('buyer candidates require proven acceptance, seller readiness, observed health and no payment or transfer evidence', () => {
  const r = { role: 'signer', buyerAddressProven: true, buyerAcceptedAt: 1, buyerSellerReady: true,
    state: { phase: 'aborted', terms: { sendBy: 100, graceSec: 30 } } };
  assert.ok(buyerStrikeCandidate(r, 130)); assert.ok(!buyerStrikeCandidate(r, 129));
  assert.ok(!buyerStrikeCandidate(r, 130 + WEEK));
  for (const patch of [{ role: 'buyer' }, { buyerAddressProven: false }, { buyerAcceptedAt: undefined },
    { buyerSellerReady: false }, { buyerStrikeExemption: {} }, { buyerPaymentSeen: true }, { sellerTransferSeen: true }]) {
    assert.ok(!buyerStrikeCandidate({ ...r, ...patch }, 130), JSON.stringify(patch));
  }
});

test('buyer refusal and courtesy aborts explain the paused party without blaming the seller', async () => {
  const { refusalReason, peerAbortReason } = await import('../../../src/core/trade-common.js');
  const own = refusalReason({ role: 'buyer' }, 'buyer-struck'), peer = refusalReason({ role: 'seller' }, 'buyer-struck');
  assert.equal(own, 'Your bids are paused for 7 days: 2 trades were accepted but never paid');
  assert.match(peer, /^The buyer is paused/);
  assert.equal(peerAbortReason({ role: 'buyer' }, peer), own);
  assert.equal(peerAbortReason({ role: 'seller' }, own), peer);
});
