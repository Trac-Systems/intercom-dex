import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listingPause, stakeAdmissionRequired, buyerCapabilityReason, PAUSE_CODES } from '../../../src/stake/prevention.js';
import { defaultSettings } from '../../../src/stake/settings.js';
const args = { online: true, balances: { RESET: '100000000', TNK: '30000000000000000', feeTnk: '30000000000000000' },
  base: { id: 'RESET' }, baseAmount: '100000000', quoteAmount: '20000000', fees: { platformFeeBps: 10, tradeFeeBps: 50 },
  settings: defaultSettings(), price: { numerator: '20000000', denominator: '1' }, now: 100,
  pieces: [{ state: 'free', unitId: '1'.repeat(64), descriptor: { purpose: 'seller', expiresAt: 200, principalReset: '3000000' } }] };
test('listing needs the full coin amount, TNK fee and free nonwithdrawing seller pieces', () => {
  assert.equal(listingPause(args), null);
  for (const [changes, code] of [[{ online: false }, 'offline'], [{ balances: null }, 'coin_short'],
    [{ balances: { ...args.balances, RESET: '99999999' } }, 'coin_short'],
    [{ balances: { ...args.balances, TNK: '1' } }, 'tnk_short'], [{ price: null }, 'price_unavailable'],
    [{ pieces: [] }, 'stake_short'], [{ pieces: [{ ...args.pieces[0], state: 'withdrawing' }] }, 'stake_short'],
    [{ pieces: [{ ...args.pieces[0], descriptor: { ...args.pieces[0].descriptor, purpose: 'buyer' } }] }, 'stake_short'],
    [{ now: 200 }, 'stake_short']]) assert.equal(listingPause({ ...args, ...changes }).code, code);
  assert.deepEqual(PAUSE_CODES, ['stake_short', 'stake_stale', 'coin_short', 'tnk_short', 'offline', 'price_unavailable']);
  assert.equal(listingPause({ ...args, base: { id: 'TNK' }, baseAmount: args.balances.TNK }).code, 'tnk_short');
});
test('unbonded admission stops before activation and never uses an old registry grace to bypass it', () => {
  const registry = { params: { sendWindowSec: 900 }, sellerBond: { enforceAfter: 2000, acceptNew: true } };
  assert.equal(stakeAdmissionRequired(registry, 979), false); assert.equal(stakeAdmissionRequired(registry, 980), true);
  assert.equal(stakeAdmissionRequired({ ...registry, sellerBond: { ...registry.sellerBond, acceptNew: false } }, 0), true);
  assert.equal(stakeAdmissionRequired({}, 100), false); assert.throws(() => stakeAdmissionRequired(registry, NaN));
  const stopping = { ...registry, sellerBond: { ...registry.sellerBond, enforceAfter: 10000, epoch: { stopNewAt: 1500 } } };
  assert.equal(stakeAdmissionRequired(stopping, 479), false); assert.equal(stakeAdmissionRequired(stopping, 480), true);
});

test('armed policy refuses old buyers with the fixed update reason without changing signer software policy', () => {
  const r = { minSoftware: '0.1.0', params: { sendWindowSec: 300 }, sellerBond: { enforceAfter: 1400, acceptNew: true } };
  assert.equal(buyerCapabilityReason(r, {}, 979), null);
  for (const buyer of [{}, { stakeVersion: 1 }, { boxKey: 'a'.repeat(64) }]) assert.equal(buyerCapabilityReason(r, buyer, 980), 'update the app');
  assert.equal(buyerCapabilityReason(r, { stakeVersion: 1, boxKey: 'a'.repeat(64) }, 980), null);
  assert.equal(r.minSoftware, '0.1.0');
});
