import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegistry } from '../../../src/core/registry.js';
import { buildTerms } from '../../../src/core/terms.js';
import { createBuyer, step as buyerStep } from '../../../src/core/trade-buyer.js';
import { step as sellerStep } from '../../../src/core/trade-seller.js';
import { buildDraft, checkTermsAgainstRegistry } from '../../../src/roles/common.js';
import { accountBalances } from '../../../src/wallets/accounting.js';
import { fixture, hex } from '../core/helpers.mjs';
import { simulation } from '../core/simulation.mjs';

test('registry, terms, drafts and offer reservations all carry the variable platform fee', () => {
  const f = fixture(), registry = buildRegistry({ ...f.registry, fee: { ...f.registry.fee, platformFeeBps: 500, tradeFeeBps: 1000 } });
  const terms = buildTerms({ ...f.terms, fees: { ...f.terms.fees, ...registry.fee } });
  for (const bad of [-1, 501, 1.5, '10']) {
    assert.throws(() => buildRegistry({ ...registry, fee: { ...registry.fee, platformFeeBps: bad } }));
    assert.throws(() => buildTerms({ ...terms, fees: { ...terms.fees, platformFeeBps: bad } }));
  }
  assert.doesNotThrow(() => buildTerms({ ...terms, fees: { ...terms.fees, platformFeeBps: 0 } }));
  const maker = { dexKey: terms.buyer.dexKey, solAddr: terms.buyer.solPayer, tracAddr: terms.buyer.tracAddr },
    taker = { dexKey: terms.seller.dexKey, solAddr: terms.seller.solRecipient, tracAddr: terms.seller.tracAddr };
  const offer = { offerId: f.offerId, registryVersion: registry.version, pair: 'TNK/USDC', side: 'buy', baseAmount: '1000000000000000000', price: '1', expiresAt: 1000 };
  const draft = buildDraft({ offer, baseAmount: offer.baseAmount, maker, taker, registry, sendBy: 1000, refundAfter: 2000, mint: terms.mint, platformCollector: terms.fees.platformCollector });
  assert.equal(draft.fees.platformFeeBps, 500);
  const balances = accountBalances({ balances: { USDC: '10000000' }, offers: [offer], registry: () => registry, now: 100 });
  assert.equal(balances.USDC.breakdown.offers, '1150000');
  assert.throws(() => createBuyer({ mode: 'maker', offerId: f.offerId, registry, terms: { ...draft, fees: { ...draft.fees, platformFeeBps: 10 } }, nonce: hex(), entropy: hex(), now: 100 }), /registry/);
  assert.throws(() => checkTermsAgainstRegistry({ ...terms, fees: { ...terms.fees, platformFeeBps: 10 } }, registry), /registry/);
});

test('a definite platform lock failure reaches both traders with a plain reason and no transfer action', () => {
  const sim = simulation({ capturePhases: true });
  const buyer = structuredClone(sim.snapshots.get('buyer:locking')), seller = structuredClone(sim.snapshots.get('seller:awaitReady'));
  const result = buyerStep(buyer, { type: 'escrowLocked', tradeId: buyer.tradeId, hashHex: buyer.H, now: buyer.now, ok: false, reason: 'platform fee changed, take again' });
  assert.equal(result.state.phase, 'aborted'); assert.equal(result.state.reason, 'platform fee changed, take again'); assert.equal(result.state.locked, false);
  const other = sellerStep(seller, { type: 'message', now: seller.now, message: { v: 1, kind: 'abort', from: buyer.self,
    ch: 'intercom-dex:t:' + buyer.tradeId, body: { tradeId: buyer.tradeId, reason: result.state.reason } } });
  assert.equal(other.state.phase, 'aborted'); assert.match(other.state.reason, /platform fee changed, take again/);
  assert.ok([...result.actions, ...other.actions].every(a => a.type === 'abort'));
});
