import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDraft } from '../../../src/roles/common.js';
import { fixture, MINT, SOL, SOL2 } from '../core/helpers.mjs';

function setup() {
  const f = fixture({ pair: 'RESET/USDC' }), registry = structuredClone(f.registry);
  registry.params.n = 4;
  registry.sellerBond = { acceptNew: true, enforceAfter: 0,
    epoch: { members: registry.signers.slice(1).map(({ dexKey, boxKey }) => ({ dexKey, boxKey })) } };
  const args = { registry, offer: { offerId: f.offerId, registryVersion: registry.version, pair: 'RESET/USDC', side: 'sell', price: '2000' },
    baseAmount: '50000', maker: { ...f.terms.seller, solAddr: SOL2 }, taker: { ...f.terms.buyer, solAddr: SOL },
    sendBy: f.terms.sendBy, refundAfter: f.terms.refundAfter, mint: MINT, platformCollector: SOL };
  return { registry, args };
}

test('new bonded draft uses the changed successor committee while original signers remain active', () => {
  const { registry, args } = setup();
  assert.deepEqual(buildDraft(args).committee, registry.sellerBond.epoch.members);
});

test('bonded draft refuses an unavailable successor member instead of substituting an original signer', () => {
  for (const mutate of [s => { s.status = 'inactive'; }, s => { s.limitUsdc = '0'; },
    s => { s.boxKey = 'f'.repeat(64); }, s => { s.assets = ['TNK']; }]) {
    const { registry, args } = setup(); mutate(registry.signers[4]);
    assert.throws(() => buildDraft(args), /Not enough active signers/);
  }
});

test('unbonded drafts retain the existing eligible committee before stake activation', () => {
  const { registry, args } = setup(); registry.sellerBond.enforceAfter = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(buildDraft(args).committee, registry.signers.slice(0, 4).map(({ dexKey, boxKey }) => ({ dexKey, boxKey })));
});
