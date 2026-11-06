import test from 'node:test';
import assert from 'node:assert/strict';
import { CapacityLedger } from '../../../src/stake/capacity.js';
import { verifyCertificate, signFact } from '../../../src/stake/certificates.js';
import { defaultSettings } from '../../../src/stake/settings.js';
import { registryPolicy, secrets, members, memoryStore } from './helpers.mjs';
import { tracAddress } from '../core/helpers.mjs';
import { ed25519 } from '@noble/curves/ed25519.js';
const cap400 = () => { const s = defaultSettings(); s.stake.maxUsdPerAddress = '400000000'; return s; }; // the first mainnet cap, which these cases measure
const h = n => n.toString(16).padStart(64, '0');
const context = { networkId: 1, venueKey: h(30), epoch: registryPolicy().epoch };
const options = { settings: cap400(), price: { numerator: '20000000', denominator: '1' }, now: 100 };
const identity = i => ({ publicKey: members[i].dexKey, secretKey: secrets[i] });
const make = (i = 0, store = memoryStore(), limits) => new CapacityLedger({ store, context, identity: identity(i), ...(limits ? { limits } : {}) });
const descriptor = (n, owner = 40, amount = '2500000') => ({ networkId: 1, venueKey: context.venueKey, epochId: context.epoch.id,
  batchId: h(1), nonce: h(n), owner: { dexKey: h(owner + 1), tracAddr: tracAddress(h(owner)), boxKey: h(owner + 2) },
  purpose: 'seller', principalReset: amount, tnkReserve: '90000000000000000', createdAt: 0, expiresAt: 1000000 });
const collected = id => secrets.slice(0, 3).map(s => signFact({ v: 1, networkId: 1, venueKey: context.venueKey,
  epochId: context.epoch.id, kind: 'collected', body: { unitId: id, generation: 0, decisionId: h(90), txHash: h(91) } }, s));

test('stopped epoch transfers held capacity once to a changed committee; original collection releases once after restart', () => {
  const stores = [0, 1, 2, 3].map(() => memoryStore()), stopped = { ...context, epoch: { ...context.epoch, stopNewAt: 110 } };
  const old = stores.map((store, i) => new CapacityLedger({ store, context: stopped, identity: identity(i) }));
  const d = [descriptor(10)], grant = old[0].propose(d, options);
  old.forEach(c => c.vote(grant, d, options));
  const replacementSecret = new Uint8Array(32).fill(51), replacement = { publicKey: Buffer.from(ed25519.getPublicKey(replacementSecret)).toString('hex'), secretKey: replacementSecret };
  const next = { ...context, epoch: { ...context.epoch, id: h(120), startAt: 110,
    members: [...context.epoch.members.slice(1), { dexKey: replacement.publicKey, boxKey: h(121) }] } };
  assert.throws(() => old[0].handoffVote(next, 109), /stopped/);
  const cert = old.slice(0, 3).map(c => c.handoffVote(next, 110));
  assert.throws(() => old[0].vote(grant, d, options), /closed/);
  assert.throws(() => old[0].handoffVote({ ...next, epoch: { ...next.epoch, id: h(122) } }, 110), /fixed/);
  const newStore = memoryStore(), b = new CapacityLedger({ store: newStore, context: next, identity: replacement });
  assert.throws(() => b.adoptHandoff(cert.slice(0, 2), stopped), /three/);
  b.adoptHandoff(cert, stopped);
  assert.deepEqual(b.read().tokens, old[0].read().tokens);
  assert.equal(Object.keys(b.read().pieces).length, 1);
  const nextD = [{ ...descriptor(11), epochId: next.epoch.id, createdAt: 110 }], nextOptions = { ...options, now: 111 };
  const nextGrant = b.propose(nextD, nextOptions); assert.equal(nextGrant.units[0].globalToken.id, 2);
  b.vote(nextGrant, nextD, nextOptions);
  const restarted = new CapacityLedger({ store: newStore, context: next, identity: replacement });
  restarted.adoptHandoff(cert, stopped);
  assert.equal(Object.keys(restarted.read().pieces).length, 2, 'replay cannot erase successor work');
  const collection = collected(grant.units[0].unitId);
  const wrongEpoch = secrets.slice(1).map(s => signFact({ ...collection[0].fact, epochId: next.epoch.id }, s));
  assert.throws(() => restarted.retire(wrongEpoch), /Invalid stake certificate/);
  restarted.retire(collection); const once = restarted.read(); restarted.retire(collection);
  assert.deepEqual(restarted.read(), once);
  assert.equal(restarted.read().tokens[1].generation, 1);
  assert.equal(restarted.read().tokens[2].unitId, nextGrant.units[0].unitId);
  const overlapping = new CapacityLedger({ store: stores[1], context: next, identity: identity(1) });
  overlapping.adoptHandoff(cert, stopped);
  old[1].retire(collection);
  assert.equal(overlapping.read().pieces[grant.units[0].unitId].retired, true, 'an original member still serves old collections');
});

test('capacity handoff freezes before signing, retains partial grants and refuses divergent local obligations', () => {
  const store = memoryStore(), stopped = { ...context, epoch: { ...context.epoch, stopNewAt: 110 } };
  const c = new CapacityLedger({ store, context: stopped, identity: identity(0) }), d = [descriptor(20)];
  c.vote(c.propose(d, options), d, options);
  const next = { ...context, epoch: { ...context.epoch, id: h(130), startAt: 110 } }, put = store.put;
  store.put = () => { throw Error('disk failed'); };
  assert.throws(() => c.handoffVote(next, 110), /disk/); assert.equal(c.read().handoff, undefined);
  store.put = put; const vote = c.handoffVote(next, 110);
  assert.equal(Object.keys(vote.fact.body.state.grants).length, 1, 'even a partial capacity grant remains charged');
  const divergent = memoryStore(), other = new CapacityLedger({ store: divergent, context: stopped, identity: identity(1) });
  const otherD = [descriptor(21)]; other.vote(other.propose(otherD, options), otherD, options);
  const cert = secrets.slice(0, 3).map(s => signFact(vote.fact, s));
  const target = new CapacityLedger({ store: divergent, context: next, identity: identity(1) });
  assert.throws(() => target.adoptHandoff(cert, stopped), /obligations differ/);
  assert.equal(Object.keys(other.read().pieces).length, 1);
});

test('certified collection between freeze and adoption carries its exact one-time retirement', () => {
  const store = memoryStore(), stopped = { ...context, epoch: { ...context.epoch, stopNewAt: 110 } };
  const old = new CapacityLedger({ store, context: stopped, identity: identity(0) }), d = [descriptor(25)];
  const grant = old.propose(d, options); old.vote(grant, d, options);
  const next = { ...context, epoch: { ...context.epoch, id: h(131), startAt: 110 } };
  const vote = old.handoffVote(next, 110), certificate = secrets.slice(0, 3).map(s => signFact(vote.fact, s));
  const collection = collected(grant.units[0].unitId); old.retire(collection);
  const target = new CapacityLedger({ store, context: next, identity: identity(0) });
  const adopted = target.adoptHandoff(certificate, stopped);
  assert.equal(adopted.tokens[1].generation, 1);
  assert.deepEqual(adopted.pieces[grant.units[0].unitId].retirementCertificate, collection);
  assert.deepEqual(target.adoptHandoff(certificate, stopped), adopted);
  target.retire(collection); assert.deepEqual(target.read(), adopted);
  const corrupted = memoryStore();
  // A fabricated retirement is not accepted merely because a local piece says retired.
  const frozen = structuredClone(vote.fact.body.state);
  frozen.pieces[grant.units[0].unitId] = structuredClone(adopted.pieces[grant.units[0].unitId]);
  frozen.pieces[grant.units[0].unitId].retirementCertificate = collection.slice(0, 2);
  corrupted.put(old.name, frozen);
  assert.throws(() => new CapacityLedger({ store: corrupted, context: next, identity: identity(0) }).adoptHandoff(certificate, stopped), /three/);
});

test('capacity grants allocate distinct numbered tokens and exact disjoint dollar intervals atomically', () => {
  const c = make(), descriptors = [descriptor(1), descriptor(2)], grant = c.propose(descriptors, options);
  assert.equal(grant.units.length, 2); assert.deepEqual(grant.units.map(u => u.globalToken.id), [1, 2]);
  assert.deepEqual(grant.units.map(u => u.globalRanges), [[{ from: '0', to: '500000', generation: 0 }], [{ from: '500000', to: '1000000', generation: 0 }]]);
  assert.equal(c.read().grants[grant.grantId], undefined, 'a proposal holds no capacity');
  const vote = c.vote(grant, descriptors, options); assert.deepEqual(c.vote(grant, descriptors, options), vote);
  const next = c.propose([descriptor(3, 50)], options);
  assert.equal(next.units[0].globalToken.id, 3); assert.equal(next.units[0].addressToken.id, 1);
  assert.equal(next.units[0].globalRanges[0].from, '1000000'); assert.equal(next.units[0].addressRanges[0].from, '0');
  assert.throws(() => c.vote({ ...grant, grantId: h(0) }, descriptors, options), /differs/);
});

test('three-of-four intersection prevents two conflicting capacity grants with one equivocating member', () => {
  const c = [0, 1, 2, 3].map(i => make(i)), a = [descriptor(1)], b = [descriptor(2, 50)];
  const ga = c[0].propose(a, options), gb = c[3].propose(b, options);
  const va = [0, 1, 2].map(i => c[i].vote(ga, a, options));
  assert.equal(verifyCertificate(va, context, 'capacity').body.grantId, ga.grantId);
  // One signer can equivocate; both other members of the first quorum retain their token vote after restart.
  const vb = [make(0).vote(gb, b, options), c[3].vote(gb, b, options)];
  assert.throws(() => c[1].vote(gb, b, options), /token conflict/);
  assert.throws(() => c[2].vote(gb, b, options), /token conflict/);
  assert.throws(() => verifyCertificate(vb, context, 'capacity'), /three/);
});

test('only certified collection retires tokens; reissued ranges advance generation and old grants stay retired', () => {
  const store = memoryStore(), c = make(0, store), descriptors = [descriptor(1)], grant = c.propose(descriptors, options);
  c.vote(grant, descriptors, options); const id = grant.units[0].unitId;
  assert.throws(() => c.retire(collected(id).slice(0, 2)));
  c.retire(collected(id)); const retired = c.read(); c.retire(collected(id)); assert.deepEqual(c.read(), retired);
  const restarted = make(0, store), next = restarted.propose([descriptor(2)], options);
  assert.deepEqual(next.units[0].globalToken, { id: 1, generation: 1 });
  assert.deepEqual(next.units[0].globalRanges, [{ from: '0', to: '500000', generation: 1 }]);
  assert.throws(() => restarted.vote(grant, descriptors, options), /retired/);
  restarted.vote(next, [descriptor(2)], options);
  assert.equal(restarted.read().tokens[1].unitId, next.units[0].unitId);
});

test('address, venue and batch limits include pending grants and rising marks without releasing old exposure', () => {
  const c = make(), first = [descriptor(1, 40, '1000000000')], grant = c.propose(first, options);
  c.vote(grant, first, options);
  const second = [descriptor(2, 40, '1000000000')], next = c.propose(second, options); c.vote(next, second, options);
  assert.throws(() => c.propose([descriptor(3)], options), /unavailable/);
  assert.throws(() => c.propose([descriptor(4, 40, '1000000001')], options), /unavailable/);
  const lower = { ...options, price: { numerator: '1000000', denominator: '1' } };
  assert.throws(() => c.propose([descriptor(3)], lower), /unavailable/);
  const small = make(0, memoryStore(), { pieces: 1, addressPieces: 1, usd: '500000', depositUsd: '500000' });
  const s = small.propose([descriptor(1)], options); small.vote(s, [descriptor(1)], options);
  assert.throws(() => small.propose([descriptor(2, 50)], options), /unavailable/);
  const rising = make(), d = [descriptor(1, 40, '1000000000')]; rising.vote(rising.propose(d, options), d, options);
  assert.throws(() => rising.propose([descriptor(2)], { ...options, price: { numerator: '41000000', denominator: '1' } }), /unavailable/);
});

test('failed write publishes no vote; old epoch state cannot reset limits under a replacement epoch', () => {
  const store = memoryStore(), c = make(0, store), d = [descriptor(1)], grant = c.propose(d, options), put = store.put;
  store.put = () => { throw Error('disk'); };
  assert.throws(() => c.vote(grant, d, options), /disk/); assert.deepEqual(c.read().pieces, {});
  store.put = put; c.vote(grant, d, options);
  const other = new CapacityLedger({ store, context: { ...context, epoch: { ...context.epoch, id: h(99) } }, identity: identity(0) });
  assert.throws(() => other.read(), /handoff/);
  assert.throws(() => c.propose([descriptor(2), descriptor(3, 50)], options), /one address/);
  const changed = new CapacityLedger({ store, context: { ...context, epoch: { ...context.epoch, startAt: 1 } }, identity: identity(0) });
  assert.throws(() => changed.read(), /handoff/);
  const closing = new CapacityLedger({ store, context: { ...context, epoch: { ...context.epoch, stopNewAt: 100 } }, identity: identity(0) });
  assert.throws(() => closing.propose([descriptor(2)], options), /closed/);
  assert.equal(closing.vote(grant, d, options).fact.body.grantId, grant.grantId, 'original votes remain recoverable');
});

test('reward paging does not raise signed funding capacity', () => {
  const current = make(); assert.equal(current.limits.pieces, 2000);
  assert.throws(() => make(0, memoryStore(), { ...current.limits, pieces: 5000 }));
});

test('a record written under the first limits is raised in place: held ranges, tokens and generations stay', () => {
  const store = memoryStore(), first = make(0, store, { pieces: 2000, addressPieces: 200, usd: '4000000000', depositUsd: '200000000' });
  const d = [descriptor(1, 40, '1000000000')], grant = first.propose(d, options); first.vote(grant, d, options);
  const old = store.get(first.name); delete old.addressPool; old.owners[d[0].owner.tracAddr].free = [{ from: '200000000', to: '400000000', generation: 0 }];
  store.put(first.name, old);
  const raised = make(0, store), state = raised.read(), owner = state.owners[d[0].owner.tracAddr];
  assert.equal(state.limits.usd, '10000000000000'); assert.equal(state.addressPool, '1000000000000');
  assert.deepEqual(state.pieces, old.pieces); assert.deepEqual(state.tokens, old.tokens);
  assert.deepEqual(owner.free, [{ from: '200000000', to: '400000000', generation: 0 }, { from: '400000000', to: '1000000000000', generation: 0 }]);
  assert.deepEqual(state.free.at(-1), { from: '4000000000', to: '10000000000000', generation: 0 });
  const big = { ...options, settings: { ...options.settings, stake: { ...options.settings.stake, maxUsdPerAddress: '10000000000' } } };
  const more = [descriptor(2, 40, '40000000000')], next = raised.propose(more, big); raised.vote(next, more, big);
  assert.equal(raised.read().pieces[next.units[0].unitId].exposureUsd, '8000000000', 'an $8,000 piece fits under a $10,000 cap');
  assert.throws(() => make(0, store, { pieces: 2000, addressPieces: 200, usd: '4000000000', depositUsd: '200000000' }).read(), /handoff/, 'limits never fall in place');
});
