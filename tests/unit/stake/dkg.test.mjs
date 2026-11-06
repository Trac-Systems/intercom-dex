import test from 'node:test';
import assert from 'node:assert/strict';
import { x25519 } from '@noble/curves/ed25519.js';
import { StakeDkg } from '../../../src/stake/dkg.js';
import { StakeLedger, unitId } from '../../../src/stake/ledger.js';
import { signFact, factDigest } from '../../../src/stake/certificates.js';
import { openShare } from '../../../src/locks/dkg.js';
import { verifyShare } from '../../../src/locks/crypto/edvss.js';
import { hexToBytes, fromLe32 } from '../../../src/core/canonical.js';
import { defaultSettings } from '../../../src/stake/settings.js';
import { registryPolicy, memoryStore, secrets, members } from './helpers.mjs';
import { tracAddress } from '../core/helpers.mjs';
const h = n => n.toString(16).padStart(64, '0');
const boxes = [11, 12, 13, 14].map(n => new Uint8Array(32).fill(n));
const publicBox = key => Buffer.from(x25519.getPublicKey(key)).toString('hex');
const ownerBox = new Uint8Array(32).fill(20);
const context = { networkId: 1, venueKey: h(40), epoch: { ...registryPolicy().epoch,
  members: members.map((m, i) => ({ ...m, boxKey: publicBox(boxes[i]) })) } };
function certificate(kind, body) {
  return secrets.slice(0, 3).map(secret => signFact({ v: 1, networkId: 1, venueKey: context.venueKey, epochId: context.epoch.id, kind, body }, secret));
}
function fixture() {
  const clock = { now: 100, localMs: 1000 }, stores = members.map(() => memoryStore());
  const make = i => new StakeDkg({ store: stores[i], context, identity: { publicKey: members[i].dexKey, secretKey: secrets[i] },
    box: { secretKey: boxes[i] }, now: () => clock.now, timeoutNow: () => clock.localMs });
  const workers = stores.map((_, i) => make(i));
  const descriptor = { networkId: 1, venueKey: context.venueKey, epochId: context.epoch.id, batchId: h(1), nonce: h(2),
    owner: { dexKey: h(3), tracAddr: tracAddress(h(4)), boxKey: publicBox(ownerBox) }, purpose: 'seller',
    principalReset: '2500000', tnkReserve: '90000000000000000', createdAt: 0, expiresAt: 2592000 };
  const id = unitId(descriptor), capacity = certificate('capacity', { units: [{ unitId: id, ownerAddress: descriptor.owner.tracAddr, principalReset: descriptor.principalReset }] });
  const deals = workers.map(w => w.start(descriptor, capacity)[0]);
  return { clock, stores, make, workers, descriptor, id, capacity, deals };
}
const complete = f => {
  const ready = [];
  for (const w of f.workers) for (const vote of f.deals) ready.push(...w.receive(vote).filter(v => v.fact.kind === 'dkg-ready'));
  return ready;
};

test('stake DKG reuses lock machinery and three original readiness signatures bind identical keys', () => {
  const f = fixture(), ready = complete(f), result = f.workers[0].readiness(f.id, ready);
  assert.equal(ready.length, 4); assert.equal(result.chain, 'trac');
  assert.equal(f.workers[0].read(f.id).state.phase, 'ready');
  assert.ok(verifyShare(1, fromLe32(hexToBytes(f.workers[0].read(f.id).lock.share, 32)), result.C));
  assert.throws(() => f.workers[0].readiness(f.id, ready.slice(0, 2)), /Three/);
  assert.throws(() => f.workers[0].readiness(f.id, [ready[0], ready[0], ready[1]]), /distinct/);
  const forged = structuredClone(ready); forged[0].fact.body.address = tracAddress(h(99));
  assert.throws(() => f.workers[0].readiness(f.id, forged));
  assert.equal(f.make(0).resume(f.id)[0].fact.kind, 'dkg-ready');
});

test('an offline fourth member recovers its share from original sealed deals and three matching readies', () => {
  const f = fixture();
  for (const w of f.workers.slice(0, 3)) for (const deal of f.deals.slice(0, 3)) w.receive(deal);
  f.clock.now = 221;
  const ready = f.workers.slice(0, 3).flatMap(w => w.resume(f.id));
  assert.equal(ready.length, 3); assert.deepEqual(ready[0].fact.body.Q, [1, 2, 3]);
  f.workers[3].resume(f.id); assert.equal(f.workers[3].read(f.id).state.phase, 'failed');
  const restored = f.make(3), result = restored.recover(f.id, { deals: f.deals.slice(0, 3), ready });
  assert.equal(result[0].fact.body.address, ready[0].fact.body.address);
  assert.ok(verifyShare(4, fromLe32(hexToBytes(restored.read(f.id).lock.share, 32)), ready[0].fact.body.C));
  assert.throws(() => restored.receive({ ...f.deals[0], from: h(999) }), /Unknown/);
});

for (const legacy of [false, true]) test(`${legacy ? 'legacy' : 'new'} stake DKG finishes three original deals after a local timeout with finalized time stalled`, () => {
  const f = fixture();
  for (const w of f.workers.slice(0, 3)) for (const deal of f.deals.slice(0, 3)) w.receive(deal);
  if (legacy) for (const store of f.stores) {
    const record = store.get(`stake-dkg-${f.id}`); delete record.localDeadline;
    store.put(`stake-dkg-${f.id}`, record);
  }
  // Reopen each signer against the same journal; legacy records establish a
  // conservative local deadline on their first recovery attempt.
  for (let i = 0; i < 3; i++) assert.equal(f.make(i).resume(f.id)[0].fact.kind, 'dkg-deal');
  f.clock.localMs += 119;
  for (let i = 0; i < 3; i++) assert.equal(f.make(i).resume(f.id)[0].fact.kind, 'dkg-deal');
  f.clock.localMs++;
  const ready = [0, 1, 2].flatMap(i => f.make(i).resume(f.id));
  assert.equal(ready.length, 3);
  assert.ok(ready.every(v => v.fact.kind === 'dkg-ready'));
  assert.deepEqual(f.make(0).readiness(f.id, ready).Q, [1, 2, 3]);
  assert.equal(f.clock.now, 100, 'local DKG progress does not advance finalized custody time');
  // Neither a local clock rollback nor a restart changes the certified key.
  f.clock.localMs = 900;
  assert.deepEqual(f.make(0).resume(f.id), [ready[0]]);
  const ledger = new StakeLedger({ store: memoryStore(), context, address: f.descriptor.owner.tracAddr });
  const decision = certificate('decision', { decisionId: h(71), outcome: 'seller-expiry', at: f.descriptor.expiresAt,
    pieces: [{ unitId: f.id, generation: 0 }], winnerAddress: f.descriptor.owner.tracAddr,
    winnerBoxKey: f.descriptor.owner.boxKey, evidenceDigest: h(72) });
  f.clock.localMs = f.descriptor.expiresAt + 1;
  assert.throws(() => f.make(0).release(f.id, decision, ledger), /Future stake decision/);
});

test('a local DKG timeout cannot certify only two dealers', () => {
  const f = fixture();
  for (const w of f.workers.slice(0, 2)) for (const deal of f.deals.slice(0, 2)) w.receive(deal);
  f.clock.localMs += 120;
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(f.make(i).resume(f.id), []);
    assert.equal(f.make(i).read(f.id).state.phase, 'failed');
    assert.equal(f.make(i).read(f.id).lock, undefined);
  }
});

test('stake readiness and returned messages wait for durable writes, including an interrupted initial creation', () => {
  const f = fixture(), store = memoryStore(), put = store.put; let calls = 0;
  store.put = (key, value) => { if (++calls === 2) throw Error('disk interrupted'); put(key, value); };
  const make = () => new StakeDkg({ store, context, identity: { publicKey: members[0].dexKey, secretKey: secrets[0] }, box: { secretKey: boxes[0] }, now: () => 100 });
  assert.throws(() => make().start(f.descriptor, f.capacity), /disk/);
  const before = make().read(f.id).state.ownDeal;
  const messages = make().start(f.descriptor, f.capacity);
  assert.deepEqual(messages[0].fact.body, before);
  assert.ok(make().read(f.id).state.deals[1]);
  assert.throws(() => make().start(f.descriptor, f.capacity.slice(0, 2)));
  const altered = { ...f.descriptor, principalReset: '1' };
  assert.throws(() => make().start(altered, f.capacity), /Capacity/);
});

test('a terminal certificate fixes the winner before the original share is sealed and replayed unchanged', () => {
  const f = fixture(), ready = complete(f), address = ready[0].fact.body.address;
  const store = memoryStore(), ledger = new StakeLedger({ store, context, address: f.descriptor.owner.tracAddr });
  ledger.admitFunded(certificate('funded', { unitId: f.id, descriptor: f.descriptor, address, fundingDigest: h(70) }),
    { settings: defaultSettings(), price: { numerator: '20000000', denominator: '1' }, now: 100 });
  const decision = certificate('decision', { decisionId: h(71), outcome: 'seller-expiry', at: f.descriptor.expiresAt,
    pieces: [{ unitId: f.id, generation: 0 }], winnerAddress: f.descriptor.owner.tracAddr, winnerBoxKey: f.descriptor.owner.boxKey, evidenceDigest: h(72) });
  assert.throws(() => f.workers[0].release(f.id, decision.slice(0, 2), ledger));
  assert.throws(() => f.workers[0].release(f.id, decision, ledger), /Future/);
  f.clock.now = f.descriptor.expiresAt;
  const release = f.workers[0].release(f.id, decision, ledger), body = release.fact.body;
  assert.equal(ledger.read().pieces[f.id].state, 'decided-seller');
  const scope = { positionId: f.id, decisionDigest: factDigest(decision[0].fact), winnerAddress: f.descriptor.owner.tracAddr, j: 1 };
  assert.ok(verifyShare(1, fromLe32(openShare(body.sealed, ownerBox, scope, 'release')), body.C));
  assert.equal(body.share, undefined); assert.equal(body.decisionDigest, scope.decisionDigest);
  assert.deepEqual(f.make(0).release(f.id, decision, ledger), release);
  assert.deepEqual(f.make(0).resume(f.id), [release]);
  const changed = certificate('decision', { ...decision[0].fact.body, winnerAddress: tracAddress(h(80)) });
  assert.throws(() => f.make(0).release(f.id, changed, ledger), /immutable/);
  assert.throws(() => f.make(0).receive(f.deals[0]), /retired/);
  assert.throws(() => f.make(0).readiness(f.id, ready), /retired/);
  assert.throws(() => f.make(0).start(f.descriptor, f.capacity));
});
