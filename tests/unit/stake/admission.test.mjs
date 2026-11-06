import { admissionFixture as fixture } from './admission-helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { registryPolicy, secrets, memoryStore } from './helpers.mjs';
import { fixture as tradeFixture, tracAddress } from '../core/helpers.mjs';
import { signFact } from '../../../src/stake/certificates.js';
import { StakeLedger, unitId } from '../../../src/stake/ledger.js';
import { admissionInventory, prepareBond, validateBond, bondReservation, bondAck, matchingBondAck } from '../../../src/stake/admission.js';
import { StakeAdmission } from '../../../src/stake/admission-runtime.js';
import { ackRejectionReason } from '../../../src/core/trade-buyer.js';
import { stableJSON } from '../../../src/core/canonical.js';

const hex = n => n.toString(16).padStart(64, '0');

test('bonded terms fix allocation and receiving keys; only exact reservation acks count', () => {
  const f = fixture(), terms = { ...f.terms, bond: prepareBond(f.args) };
  assert.equal(terms.bond.payoutReset, '25000');
  assert.deepEqual(validateBond({ ...f.args, terms }), terms.bond);
  const ack = bondAck(terms, hex(50));
  assert.equal(matchingBondAck(terms, hex(50), ack), true);
  assert.equal(matchingBondAck(terms, hex(51), ack), false);
  assert.equal(matchingBondAck(terms, hex(50), { ...ack, payoutReset: '25001' }), false);
  assert.equal(matchingBondAck(f.terms, hex(50)), true);
  const state = { phase: 'awaitAcks', terms, H: hex(50), acks: [] }, message = { from: terms.committee[0].dexKey, body: { H: hex(50), holdUntil: terms.refundAfter } };
  assert.equal(ackRejectionReason(state, message), 'bond_not_reserved');
  assert.equal(ackRejectionReason(state, { ...message, body: { ...message.body, bond: ack } }), null);
  assert.equal(bondReservation(terms, hex(50)).buyerAddress, terms.buyer.tracAddr);
  assert.notEqual(bondAck({ ...terms, buyer: { ...terms.buyer, boxKey: hex(99) } }, hex(50)).reservationId, ack.reservationId);
});

test('admission rejects stale prices, stale or incomplete inventories, buyer stake, near expiry and altered policy', () => {
  const f = fixture();
  assert.throws(() => prepareBond({ ...f.args, now: 4181 }));
  assert.throws(() => prepareBond({ ...f.args, inventoryCertificate: f.args.inventoryCertificate.slice(0, 2) }));
  for (const patch of [{ purpose: 'buyer' }, { blocked: true }, { state: 'withdrawing' }, { expiresAt: 6000 }]) {
    const inventory = { ...f.inventory, pieces: f.inventory.pieces.map(p => ({ ...p, ...patch })) };
    assert.throws(() => prepareBond({ ...f.args, inventoryCertificate: f.cert('admission-inventory', inventory) }));
  }
  const terms = { ...f.terms, bond: prepareBond(f.args) };
  for (const patch of [{ payoutReset: '25001' }, { proofWindowSec: 1 }, { policyDigest: hex(9) }]) assert.throws(() => validateBond({ ...f.args, terms: { ...terms, bond: { ...terms.bond, ...patch } } }));
});

test('signed admission freshness covers a slow handshake without repricing or accepting old evidence', () => {
  const f = fixture(), terms = { ...f.terms, bond: prepareBond({ ...f.args, now: 4059 }) };
  assert.deepEqual(validateBond({ ...f.args, terms, now: 4133 }), terms.bond);
  assert.deepEqual(validateBond({ ...f.args, terms, now: 4180 }), terms.bond);
  assert.throws(() => validateBond({ ...f.args, terms, now: 4181 }), /stake check|bond_stale/);
  const changed = structuredClone(f.policy); changed.economics.active.settings.admissionFreshSec = 600;
  assert.throws(() => validateBond({ ...f.args, policy: changed, terms, now: 4200 }), /Policy digest/);
});

test('admission commits every piece and recovery facts before ack; concurrent take and failed disk write refuse', () => {
  const f = fixture(), registry = () => ({ sellerBond: f.policy });
  const admission = new StakeAdmission({ store: f.store, identity: {}, registry, price: { log: () => f.priceLog } });
  admission.cache.set(f.terms.seller.dexKey, f.args);
  const terms = { ...f.terms, bond: admission.propose(f.terms, 4000, 12) }, state = { terms, H: hex(50), now: 4000 };
  assert.throws(() => admission.reserve(state, { fromSlot: 11, sigs: [] }), /Finalized admission/);
  const ack = admission.reserve(state, { fromSlot: 30, sigs: [] });
  assert.equal(f.ledger.read().pieces[f.id].state, 'reserved');
  assert.equal(f.ledger.read().reservations[ack.reservationId].admission.fromSlot, 12);
  assert.deepEqual(admission.reserve(state, { fromSlot: 30, sigs: [] }), ack);
  assert.throws(() => admission.reserve({ ...state, H: hex(51) }, { fromSlot: 30, sigs: [] }));
  const g = fixture(), a = new StakeAdmission({ store: g.store, identity: {}, registry: () => ({ sellerBond: g.policy }), price: { log: () => g.priceLog } });
  g.store.put = () => { throw new Error('disk full'); };
  assert.throws(() => a.reserve({ terms: { ...g.terms, bond: prepareBond(g.args) }, H: hex(50), now: 4000 }, { fromSlot: 30, sigs: [] }), /disk full/);
  assert.equal(g.ledger.read().pieces[g.id].state, 'free');
});

test('reservation replay after a crash before epoch retention uses the original frozen proof, not a stale new price', () => {
  const f = fixture(), admission = new StakeAdmission({ store: f.store, identity: {}, registry: () => ({ sellerBond: f.policy }), price: { log: () => f.priceLog } });
  admission.cache.set(f.terms.seller.dexKey, f.args);
  const terms = { ...f.terms, bond: admission.propose(f.terms, 4000, 12) }, state = { terms, H: hex(53), now: 4000 };
  const put = f.store.put; let fail = true;
  f.store.put = (name, value) => { if (name.startsWith('stake-retained-epoch-') && fail) throw Error('retention write failed'); return put(name, value); };
  assert.throws(() => admission.reserve(state, { fromSlot: 30, sigs: [] }), /retention write/);
  assert.equal(f.ledger.read().pieces[f.id].state, 'reserved'); fail = false;
  const ack = admission.reserve({ ...state, now: 4100 }, { fromSlot: 40, sigs: [] });
  assert.equal(f.ledger.read().reservations[ack.reservationId].admission.fromSlot, 12);
  assert.equal(Object.keys(f.ledger.read().reservations).length, 1);
});

test('venue stake checks: small batches inside the transport limit, recently checked sellers skipped, prices renewed', async () => {
  const policy = registryPolicy(); let open = 0, most = 0; const asked = [];
  const a = new StakeAdmission({ store: memoryStore(), identity: {}, registry: () => ({ sellerBond: policy }), clock: async () => ({ at: 1000 }),
    price: { import: async () => ({}) },
    request: async (to, method, body) => {
      if (method === 'priceSnapshot') return { checkpoint: 'new-checkpoint', reference: 'new-reference' };
      asked.push(body.owner.dexKey); open++; most = Math.max(most, open);
      await new Promise(resolve => setTimeout(resolve, 2)); open--; throw new Error('Stake response timed out');
    } });
  const owner = n => ({ dexKey: hex(n), tracAddr: `trac-${n}` }), cert = at => [{ fact: { body: { at } } }];
  a.cache.set(hex(1), { inventoryCertificate: cert(990), priceCheckpoint: 'old', priceReference: 'old' });
  a.cache.set(hex(2), { inventoryCertificate: cert(900), priceCheckpoint: 'old', priceReference: 'old' });
  await a.refresh([1, 2, ...Array.from({ length: 20 }, (_, i) => i + 3)].map(owner));
  assert.ok(most <= 12, `at most three sellers (12 requests) at once, saw ${most}`);
  assert.equal(asked.includes(hex(1)), false, 'checked 10 s ago: not asked again');
  assert.equal(asked.filter(k => k === hex(2)).length, 4, 'checked 100 s ago: asked again');
  assert.equal(new Set(asked).size, 21);
  assert.deepEqual([a.cache.get(hex(1)).priceReference, a.cache.get(hex(2)).priceCheckpoint], ['new-reference', 'new-checkpoint']);
  assert.ok(a.cache.has(hex(2)), 'a failed read keeps a check that may still be usable');
});
