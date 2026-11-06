import test from 'node:test';
import assert from 'node:assert/strict';
import { admissionFixture } from './admission-helpers.mjs';
import { prepareBond, bondAck } from '../../../src/stake/admission.js';
import { tradeBondStatus, BOND_STATES } from '../../../src/stake/trade-status.js';
import { StakeAdmission } from '../../../src/stake/admission-runtime.js';
import { previewBond } from '../../../src/stake/bond-preview.js';
import { Trader } from '../../../src/roles/trader.js';

const hex = n => n.toString(16).padStart(64, '0');
function fixture() {
  const f = admissionFixture(), terms = { ...f.terms, bond: prepareBond(f.args) };
  const trade = { role: 'buyer', state: { terms, H: hex(90), acks: [], registry: { sellerBond: f.policy } } };
  return { ...f, terms, trade, id: bondAck(terms, trade.state.H).reservationId };
}
test('bond state waits for distinct accepted original acks and certified closure, including aborted trades', () => {
  const f = fixture(), project = result => tradeBondStatus(f.trade, result);
  assert.equal(tradeBondStatus({ state: {} }), null);
  assert.equal(project().state, 'reserving');
  f.trade.state.acks = [f.terms.committee[0].dexKey, f.terms.committee[0].dexKey, hex(99)];
  assert.equal(project().state, 'reserving');
  f.trade.state.acks = f.terms.committee.slice(0, 3).map(m => m.dexKey);
  assert.equal(project().state, 'reserved');
  f.trade.state.phase = 'aborted'; assert.equal(project().state, 'reserved');
  const resolved = f.cert('resolved', { reservationId: f.id, pieces: f.terms.bond.pieces, outcome: 'unfunded', evidenceDigest: hex(50) });
  assert.equal(project({ resolved: resolved.slice(0, 2) }).state, 'reserved');
  assert.equal(project({ resolved }).state, 'released');
  assert.equal(project({ resolved }).outcome, 'unfunded');
  assert.equal(project({ resolved: f.cert('resolved', { ...resolved[0].fact.body, reservationId: hex(99) }) }).state, 'reserved');
});
test('penalty status exposes only verified collection hashes; one of two payments remains collecting', () => {
  const f = fixture();
  f.terms.bond.pieces.push({ unitId: hex(991), generation: 3 });
  f.terms.bond.pieces.sort((a, b) => a.unitId.localeCompare(b.unitId));
  const id = bondAck(f.terms, f.trade.state.H).reservationId;
  const decision = f.cert('decision', { reservationId: id, decisionId: hex(33), pieces: f.terms.bond.pieces, outcome: 'buyer-no-show',
    winnerAddress: f.terms.buyer.tracAddr, winnerBoxKey: f.terms.buyer.boxKey });
  const result = { decision, collections: {} }, project = () => tradeBondStatus(f.trade, result);
  assert.equal(project().state, 'decided-being-collected');
  for (const [i, ref] of f.terms.bond.pieces.entries()) {
    result.collections[ref.unitId] = f.cert('collected', { ...ref, decisionId: hex(33), txHash: hex(60 + i) });
    assert.equal(project().state, i ? 'paid' : 'decided-being-collected');
  }
  assert.deepEqual(project().transactions, [hex(60), hex(61)]);
  assert.equal(project().tx, undefined);
  result.collections[f.terms.bond.pieces[1].unitId] = [];
  assert.equal(project().state, 'decided-being-collected');
  const role = { bondProjection: () => project() };
  assert.equal(Trader.prototype.deliveryProjection.call(role, f.trade).state.penaltyPaid, false);
  assert.equal(f.trade.state.penaltyPaid, undefined);
  assert.equal(BOND_STATES.length, 5);
});
test('one fully collected penalty exposes its payment transaction and rejects another decision or epoch', () => {
  const f = fixture(), ref = f.terms.bond.pieces[0], decisionId = hex(33), txHash = hex(60);
  const result = { decision: f.cert('decision', { reservationId: f.id, decisionId, pieces: f.terms.bond.pieces, outcome: 'buyer-no-show',
    winnerAddress: f.terms.buyer.tracAddr, winnerBoxKey: f.terms.buyer.boxKey }), collections: {} };
  result.collections[ref.unitId] = f.cert('collected', { ...ref, decisionId: hex(34), txHash });
  assert.equal(tradeBondStatus(f.trade, result).state, 'decided-being-collected');
  result.collections[ref.unitId] = f.cert('collected', { ...ref, decisionId, txHash });
  const status = tradeBondStatus(f.trade, result);
  assert.equal(status.state, 'paid'); assert.equal(status.tx, txHash); assert.equal(status.formatted.payoutReset, '0.00025');
  assert.equal(tradeBondStatus(f.trade, result, { ...f.policy, epoch: { ...f.policy.epoch, id: hex(99) } }).state, 'reserving');
});
test('preview shares the exact admission allocator and distinguishes stale stake from price or setup failures', () => {
  const f = admissionFixture(), registry = { sellerBond: f.policy, pairs: [{ pair: 'RESET/USDC', base: f.terms.base, status: 'open' }],
    fee: f.terms.fees, params: { sendWindowSec: 1000, refundSec: 6000 } };
  const admission = new StakeAdmission({ registry: () => registry, price: { log: () => f.priceLog } });
  // Only what refresh() caches; the preview's own terms must reach the allocator.
  admission.cache.set(f.terms.seller.dexKey, { inventoryCertificate: f.args.inventoryCertificate, priceCheckpoint: f.args.priceCheckpoint, priceReference: f.args.priceReference });
  // Like Trader.me: no receiving key; the stake runtime holds it.
  const { boxKey, ...me } = f.terms.seller, role = { registry: { usable: registry }, me, stakeRuntime: { admission, boxKey } };
  const request = { pair: 'RESET/USDC', side: 'sell', amount: '50000', price: '2000' };
  const preview = previewBond(role, request, 4000);
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.bond, admission.propose({ ...f.terms, baseAmount: '50000', quoteAmount: '1000000', bond: undefined }, 4000));
  assert.equal(previewBond(role, request, 4180).ok, true);
  assert.equal(previewBond(role, request, 4181).code, 'bond_stale');
  assert.equal(admission.coverage({ maker: f.terms.seller, pair: request.pair, baseAmount: request.amount, price: request.price }, 4181).code, 'stake_stale');
  assert.equal(previewBond(role, { ...request, price: undefined }, 4000).code, 'bond_price_unavailable');
  assert.equal(previewBond(role, { ...request, side: 'buy' }, 4000).code, 'bond_setup_unavailable');
  assert.throws(() => previewBond(role, { ...request, amount: '1.5' }, 4000));
  assert.throws(() => previewBond(role, { ...request, secret: 'no' }, 4000));
  assert.equal(f.ledger.read().pieces[f.id].state, 'free', 'preview does not reserve');
});
