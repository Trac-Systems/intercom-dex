import test from 'node:test';
import assert from 'node:assert/strict';
import { StakeEpochHandoff } from '../../../src/stake/epoch-handoff.js';
import { CapacityLedger } from '../../../src/stake/capacity.js';
import { StakePriceService, stakeContext } from '../../../src/stake/price-service.js';
import { registryPolicy, memoryStore, members, secrets } from './helpers.mjs';
import { signFact } from '../../../src/stake/certificates.js';
import { tracAddress } from '../core/helpers.mjs';

test('draining handoff resumes a lost publication without duplicate capacity transfer or clearing histories', async () => {
  const store = memoryStore(), stores = members.map(memoryStore);
  let now = 5000, policy = registryPolicy(), fail = true, votes = 0;
  store.put('reward-liabilities', { unpaid: '123' }); store.put('original-price-history', { height: 9 });
  const next = registryPolicy({ networkId: policy.networkId, venueKey: policy.venueKey, epochId: 'b'.repeat(64) });
  next.acceptNew = false; next.epoch.startAt = 5030;
  const request = async (to, method, body) => {
    const i = members.findIndex(m => m.dexKey === to), identity = { publicKey: to, secretKey: secrets[i] };
    const previous = store.get(`stake-venue-epoch-${body.previousEpochId}`);
    if (method === 'capacityHandoffVote') {
      votes++; return new CapacityLedger({ store: stores[i], context: stakeContext({ sellerBond: previous }), identity }).handoffVote(stakeContext({ sellerBond: next }), now);
    }
    new CapacityLedger({ store: stores[i], context: stakeContext({ sellerBond: next }), identity }).adoptHandoff(body.certificate, stakeContext({ sellerBond: previous }));
    return { adopted: true, epochId: next.epoch.id };
  };
  const args = { store, registry: () => ({ sellerBond: policy }), clock: async () => ({ at: now }), request,
    publish: async p => { policy = p; if (p.epoch.id === next.epoch.id && fail) { fail = false; throw Error('publication reply lost'); } } };
  const first = new StakeEpochHandoff(args);
  assert.equal((await first.quiesce()).stopNewAt, 5030);
  await assert.rejects(first.handoff(next), /announced stop/);
  now = 5030; await assert.rejects(first.handoff(next), /reply lost/);
  assert.equal(votes, 4); assert.equal(policy.epoch.id, next.epoch.id);
  const restarted = new StakeEpochHandoff(args);
  assert.equal((await restarted.handoff(next)).state, 'draining');
  await restarted.handoff(next); assert.equal(votes, 4);
  assert.deepEqual(store.get('reward-liabilities'), { unpaid: '123' });
  assert.deepEqual(store.get('original-price-history'), { height: 9 });
  assert.equal(store.get('stake-epoch-handoff').done, true);
  assert.throws(() => new StakePriceService({ store, registry: args.registry }).log(), /history reconciliation/);
});

test('collection after freeze reaches every successor before publication and survives a failed retirement round', async () => {
  const store = memoryStore(), stores = members.map(memoryStore), policy = registryPolicy();
  policy.acceptNew = false; policy.epoch.stopNewAt = 5000;
  const next = registryPolicy({ networkId: policy.networkId, venueKey: policy.venueKey, epochId: 'c'.repeat(64) });
  next.acceptNew = false; next.epoch.startAt = 5000;
  const oldContext = stakeContext({ sellerBond: policy }), nextContext = stakeContext({ sellerBond: next });
  const ledger = (i, context) => new CapacityLedger({ store: stores[i], context, identity: { publicKey: members[i].dexKey, secretKey: secrets[i] } });
  const descriptor = { networkId: policy.networkId, venueKey: policy.venueKey, epochId: policy.epoch.id,
    batchId: '1'.repeat(64), nonce: '2'.repeat(64), owner: { dexKey: '3'.repeat(64), tracAddr: tracAddress('4'.repeat(64)), boxKey: '5'.repeat(64) },
    purpose: 'seller', principalReset: '25000', tnkReserve: '90000000000000000', createdAt: 4000, expiresAt: 10000 };
  const options = { settings: policy.economics.active.settings, price: { numerator: '20000000', denominator: '1' }, now: 4999 };
  const grant = ledger(0, oldContext).propose([descriptor], options);
  stores.forEach((_, i) => ledger(i, oldContext).vote(grant, [descriptor], options));
  const collection = secrets.slice(0, 3).map(secret => signFact({ v: 1, networkId: policy.networkId, venueKey: policy.venueKey,
    epochId: policy.epoch.id, kind: 'collected', body: { unitId: grant.units[0].unitId, generation: 0, decisionId: '6'.repeat(64), txHash: '7'.repeat(64) } }, secret));
  let votes = 0, fail = true, published = 0;
  const request = async (to, method, body) => {
    const i = members.findIndex(m => m.dexKey === to);
    if (method === 'capacityHandoffVote') {
      const vote = ledger(i, oldContext).handoffVote(nextContext, 5000);
      if (++votes === 4) ledger(1, oldContext).retire(collection);
      return vote;
    }
    if (method === 'capacityRetire') {
      if (fail && i > 1) throw Error('local transport unavailable');
      ledger(i, nextContext).retire(body.certificate); return { retired: true };
    }
    const state = ledger(i, nextContext).adoptHandoff(body.certificate, oldContext);
    return { adopted: true, epochId: next.epoch.id, retirements: Object.values(state.pieces).filter(p => p.retired).map(p => p.retirementCertificate) };
  };
  const args = { store, registry: () => ({ sellerBond: policy }), clock: async () => ({ at: 5000 }), request,
    publish: async () => { published++; } };
  await assert.rejects(new StakeEpochHandoff(args).handoff(next), /archive incomplete/);
  assert.equal(votes, 4); assert.equal(published, 0);
  assert.ok(stores.every(s => s.get(ledger(0, oldContext).name).epochId === policy.epoch.id), 'archive recovery keeps the original epoch available');
  const funded = secrets.slice(0, 3).map(secret => signFact({ v: 1, networkId: policy.networkId, venueKey: policy.venueKey,
    epochId: policy.epoch.id, kind: 'funded', body: { unitId: grant.units[0].unitId, descriptor,
      address: tracAddress('8'.repeat(64)), fundingDigest: '9'.repeat(64) } }, secret));
  store.put(`stake-venue-funded-${grant.units[0].unitId}`, secrets.slice(0, 3).map(secret => signFact({ ...funded[0].fact,
    body: { ...funded[0].fact.body, unitId: 'a'.repeat(64) } }, secret)));
  await assert.rejects(new StakeEpochHandoff(args).handoff(next), /archive differs/);
  assert.equal(published, 0);
  store.put(`stake-venue-funded-${grant.units[0].unitId}`, funded);
  await assert.rejects(new StakeEpochHandoff(args).handoff(next), /retirement quorum/);
  assert.equal(published, 0); assert.equal(Object.keys(store.get('stake-epoch-handoff').retirements).length, 1);
  fail = false; await new StakeEpochHandoff(args).handoff(next);
  assert.equal(votes, 4); assert.equal(published, 1);
  stores.forEach((_, i) => { assert.equal(ledger(i, nextContext).read().tokens[1].generation, 1); });
});
