import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signFact, verifyCertificate, factDigest, matchingCertificate } from '../../../src/stake/certificates.js';
import { StakeLedger, unitId, reservationId } from '../../../src/stake/ledger.js';
import { defaultSettings } from '../../../src/stake/settings.js';
import { registryPolicy, secrets, memoryStore } from './helpers.mjs';
import { tracAddress } from '../core/helpers.mjs';
const cap400 = () => { const s = defaultSettings(); s.stake.maxUsdPerAddress = '400000000'; return s; }; // the first mainnet cap, which these cases measure
const hex = n => n.toString(16).padStart(64, '0');
const address = tracAddress(hex(41)), buyer = tracAddress(hex(42));
const settings = cap400(), price = { numerator: '20000000', denominator: '1' };
const context = { networkId: 1, venueKey: hex(8), epoch: registryPolicy().epoch };
const cert = (kind, body) => secrets.slice(0, 3).map(s => signFact({ v: 1, networkId: 1, venueKey: context.venueKey, epochId: context.epoch.id, kind, body }, s));
function fixture({ purpose = 'seller', amount = '2500000', store = memoryStore() } = {}) {
  const ledger = new StakeLedger({ store, context, address });
  const descriptor = { networkId: 1, venueKey: context.venueKey, epochId: context.epoch.id, batchId: hex(1), nonce: hex(2),
    owner: { dexKey: hex(3), tracAddr: address, boxKey: hex(4) }, purpose, principalReset: amount, tnkReserve: '90000000000000000', createdAt: 0, expiresAt: 2592000 };
  const id = unitId(descriptor), funding = cert('funded', { descriptor, unitId: id, address: tracAddress(hex(90)), fundingDigest: hex(10) });
  ledger.admitFunded(funding, { settings, price, now: 100 });
  const reservation = { tradeId: hex(11), H: hex(12), sellerDexKey: hex(3), buyerAddress: buyer, buyerBoxKey: hex(13),
    policyId: hex(14), targetReset: amount, payoutReset: amount, pieces: [{ unitId: id, generation: 0 }], expiresNotBefore: 200000 };
  return { ledger, store, descriptor, id, funding, reservation };
}

test('certificates require three distinct pinned identities on identical network-bound facts', () => {
  const votes = cert('inventory', { sequence: 1 });
  assert.deepEqual(verifyCertificate(votes, context, 'inventory'), votes[0].fact);
  assert.equal(factDigest(votes[0].fact).length, 64);
  for (const bad of [votes.slice(0, 2), [votes[0], votes[0], votes[1]], [...votes.slice(0, 2), cert('inventory', { sequence: 2 })[2]],
    [{ ...votes[0], sig: '0'.repeat(128) }, ...votes.slice(1)]]) assert.throws(() => verifyCertificate(bad, context, 'inventory'));
  assert.throws(() => verifyCertificate(votes, { ...context, networkId: 2 }, 'inventory'));
  assert.throws(() => verifyCertificate(votes, context, 'book'));
  assert.throws(() => signFact({ ...votes[0].fact, kind: 'bad' }, secrets[0]));
});
test('funding is idempotent; address caps include both admission exposure and current mark', () => {
  const f = fixture(); assert.equal(f.ledger.admitFunded(f.funding, { settings, price, now: 100 }).state, 'free');
  assert.equal(f.ledger.read().sequence, 1);
  const descriptor = { ...f.descriptor, nonce: hex(15), principalReset: '2000000000' }, id = unitId(descriptor);
  const funding = cert('funded', { descriptor, unitId: id, address: tracAddress(hex(91)), fundingDigest: hex(16) });
  assert.throws(() => f.ledger.admitFunded(funding, { settings, price, now: 100 }), /setup/);
  assert.equal(Object.keys(f.ledger.read().pieces).length, 1);
  assert.throws(() => f.ledger.admitFunded(f.funding, { settings, price, now: 3000000 }), /binding/);
  assert.throws(() => unitId({ ...descriptor, extra: true }));
});
test('reservation is atomic, replayable after restart and excludes simultaneous takes', () => {
  const f = fixture(), r = f.ledger.reserve(f.reservation);
  assert.equal(r.reservationId, reservationId(f.reservation));
  const restarted = new StakeLedger({ store: f.store, context, address });
  assert.deepEqual(restarted.reserve(f.reservation), r);
  assert.throws(() => restarted.reserve({ ...f.reservation, tradeId: hex(99) }), /not_reserved/);
  assert.equal(restarted.read().sequence, 2);
  const f2 = fixture(); const before = f2.ledger.read();
  assert.throws(() => f2.ledger.reserve({ ...f2.reservation, pieces: [...f2.reservation.pieces, { unitId: 'f'.repeat(64), generation: 0 }] }));
  assert.deepEqual(f2.ledger.read(), before);
});
test('a failed durable write emits no successful reservation and changes no state', () => {
  const store = memoryStore(), f = fixture({ store }), before = f.ledger.read();
  store.put = () => { throw new Error('disk full'); };
  assert.throws(() => f.ledger.reserve(f.reservation), /disk full/); assert.deepEqual(f.ledger.read(), before);
});
test('buyer-only stake can earn rewards but cannot be reserved or penalized', () => {
  const f = fixture({ purpose: 'buyer' }); assert.throws(() => f.ledger.reserve(f.reservation), /not_reserved/);
  assert.throws(() => f.ledger.decide(cert('decision', { decisionId: hex(30), outcome: 'buyer-no-show', pieces: f.reservation.pieces,
    reservationId: hex(31), at: 200, winnerAddress: buyer, winnerBoxKey: hex(13), evidenceDigest: hex(32) })), /reservation/);
});
test('delivered closure advances public generation without releasing a key', () => {
  const f = fixture(), r = f.ledger.reserve(f.reservation);
  const closure = cert('resolved', { reservationId: r.reservationId, outcome: 'delivered', evidenceDigest: hex(20), pieces: f.reservation.pieces });
  f.ledger.resolve(closure); f.ledger.resolve(closure);
  assert.equal(f.ledger.read().pieces[f.id].generation, 1); assert.equal(f.ledger.read().pieces[f.id].state, 'free');
  assert.throws(() => f.ledger.reserve({ ...f.reservation, tradeId: hex(21) }), /not_reserved/);
  f.ledger.reserve({ ...f.reservation, tradeId: hex(21), pieces: [{ unitId: f.id, generation: 1 }] });
  assert.throws(() => f.ledger.resolve(cert('resolved', { ...closure[0].fact.body, outcome: 'unfunded' })), /Conflicting/);
});
test('withdrawal freeze excludes reservations and enforces full signed wait before release', () => {
  const f = fixture(), body = { operationId: hex(22), pieces: f.reservation.pieces, acceptedAt: 100, withdrawDelaySec: 86400 };
  const freeze = cert('freeze', body); assert.equal(f.ledger.freeze(freeze, settings).availableAt, 86500);
  assert.deepEqual(f.ledger.freeze(freeze, settings).pieces, body.pieces);
  assert.throws(() => f.ledger.reserve(f.reservation), /not_reserved/);
  const decision = { decisionId: hex(23), outcome: 'seller-withdraw', pieces: body.pieces, at: 86499,
    winnerAddress: address, winnerBoxKey: f.descriptor.owner.boxKey, evidenceDigest: hex(24) };
  assert.throws(() => f.ledger.decide(cert('decision', decision)), /cooldown/);
  f.ledger.decide(cert('decision', { ...decision, at: 86500 }));
  assert.equal(f.ledger.read().pieces[f.id].state, 'decided-seller');
  const f2 = fixture(); f2.ledger.reserve(f2.reservation); assert.throws(() => f2.ledger.freeze(freeze, settings), /reserved/);
});
test('award fixes the buyer and retirement permanently forbids reuse or a second winner', () => {
  const f = fixture(), r = f.ledger.reserve(f.reservation);
  const body = { decisionId: hex(30), outcome: 'buyer-no-show', pieces: f.reservation.pieces, reservationId: r.reservationId,
    at: 200000, winnerAddress: buyer, winnerBoxKey: hex(13), evidenceDigest: hex(32) };
  assert.throws(() => f.ledger.decide(cert('decision', { ...body, winnerAddress: address })), /reservation/);
  const decision = cert('decision', body); f.ledger.decide(decision); f.ledger.decide(decision);
  const collected = cert('collected', { unitId: f.id, generation: 0, decisionId: body.decisionId, txHash: hex(33) });
  f.ledger.collected(collected); f.ledger.collected(collected);
  assert.equal(f.ledger.read().pieces[f.id].state, 'retired');
  f.ledger.admitFunded(f.funding, { settings, price, now: 100 });
  assert.equal(f.ledger.read().pieces[f.id].state, 'retired');
  assert.throws(() => f.ledger.decide(cert('decision', { ...body, decisionId: hex(35) })), /Terminal/);
});

test('pre-certificate withdrawal barrier survives restart and never permits an undefined maturity', () => {
  const f = fixture(), input = { operationId: hex(81), pieces: f.reservation.pieces, acceptedAt: 200 };
  f.ledger.prepareFreeze(input);
  const restarted = new StakeLedger({ store: f.store, context, address });
  assert.deepEqual(restarted.prepareFreeze({ ...input, acceptedAt: 300 }), input);
  assert.throws(() => restarted.reserve(f.reservation), /not_reserved/);
  const decision = { decisionId: hex(82), outcome: 'seller-withdraw', pieces: input.pieces, at: 100000,
    winnerAddress: address, winnerBoxKey: f.descriptor.owner.boxKey, evidenceDigest: hex(83) };
  assert.throws(() => restarted.prepareDecision(decision), /cooldown/);
  restarted.freeze(cert('freeze', { ...input, acceptedAt: 202, withdrawDelaySec: 86400 }), settings);
  restarted.prepareDecision(decision);
  const again = new StakeLedger({ store: f.store, context, address });
  assert.deepEqual(again.prepareDecision(decision), decision);
  assert.throws(() => again.prepareDecision({ ...decision, decisionId: hex(84) }), /Conflicting terminal vote/);
});

test('failed vote persistence leaves no withdrawal or terminal barrier', () => {
  const f = fixture(), before = f.ledger.read(), put = f.store.put;
  f.store.put = () => { throw new Error('disk full'); };
  assert.throws(() => f.ledger.prepareFreeze({ operationId: hex(85), pieces: f.reservation.pieces, acceptedAt: 200 }), /disk full/);
  assert.deepEqual(f.ledger.read(), before);
  f.store.put = put;
  f.ledger.freeze(cert('freeze', { operationId: hex(85), pieces: f.reservation.pieces, acceptedAt: 200, withdrawDelaySec: 86400 }), settings);
  const frozen = f.ledger.read(); f.store.put = () => { throw new Error('disk full'); };
  assert.throws(() => f.ledger.prepareDecision({ decisionId: hex(86), outcome: 'seller-withdraw', pieces: f.reservation.pieces, at: 86600,
    winnerAddress: address, winnerBoxKey: f.descriptor.owner.boxKey, evidenceDigest: hex(87) }), /disk full/);
  assert.deepEqual(f.ledger.read(), frozen);
});


test('one invalid response cannot veto three matching original member votes', () => {
  const votes = cert('inventory', { sequence: 1 });
  const fourth = signFact(votes[0].fact, secrets[3]);
  assert.equal(matchingCertificate([...votes, { ...fourth, sig: '0'.repeat(128) }], context, 'inventory').length, 3);
  assert.equal(matchingCertificate([...votes, fourth], context, 'inventory').length, 4);
  assert.throws(() => matchingCertificate([votes[0], votes[0], votes[1]], context, 'inventory'), /Three matching/);
  assert.throws(() => matchingCertificate([votes[0], votes[1], signFact({ ...fourth.fact, body: { sequence: 2 } }, secrets[3])], context, 'inventory'), /Three matching/);
});

test('settlement share and terminal penalty intents exclude each other across restart and disk failure', () => {
  const f = fixture(), r = f.ledger.reserve(f.reservation);
  const decision = { decisionId: hex(90), outcome: 'buyer-no-show', pieces: f.reservation.pieces, reservationId: r.reservationId,
    at: 500, winnerAddress: buyer, winnerBoxKey: hex(13), evidenceDigest: hex(91) };
  f.ledger.deliveryIntent(r.reservationId, { txHash: hex(92), evidenceDigest: hex(93), share: true });
  assert.throws(() => new StakeLedger({ store: f.store, context, address }).prepareDecision(decision), /reservation/);
  const g = fixture(), gr = g.ledger.reserve(g.reservation); g.ledger.prepareDecision(decision);
  assert.throws(() => g.ledger.deliveryIntent(gr.reservationId, { txHash: hex(92), evidenceDigest: hex(93), share: true }), /blocks settlement/);
  assert.throws(() => g.ledger.closureIntent(gr.reservationId, { outcome: 'delivered' }), /closure/);
  const h = fixture(), hr = h.ledger.reserve(h.reservation), before = h.ledger.read();
  h.store.put = () => { throw new Error('disk full'); };
  assert.throws(() => h.ledger.deliveryIntent(hr.reservationId, { txHash: hex(92), evidenceDigest: hex(93), share: true }), /disk full/);
  assert.deepEqual(h.ledger.read(), before);
});
