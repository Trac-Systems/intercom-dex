import test from 'node:test';
import assert from 'node:assert/strict';
import { DeliveryObserver, deliveryPenaltyEvidence } from '../../../src/stake/delivery-evidence.js';
import { registryPolicy, secrets, memoryStore } from './helpers.mjs';
import { signFact } from '../../../src/stake/certificates.js';
const h = n => n.toString(16).padStart(64, '0');
const context = { networkId: 1, venueKey: h(1), epoch: registryPolicy().epoch };
const expected = { tradeId: h(2), txHash: h(3), from: 'seller', to: 'buyer', asset: 'RESET', amount: '100', nonce: h(4), networkId: 1 };
const check = extra => deliveryPenaltyEvidence({ expected, context, sendBy: 1000, overdueDelaySec: 1800, ...extra });
const votes = (at, changes = {}) => secrets.slice(0, 3).map((secret, i) => signFact({ v: 1, networkId: 1, venueKey: h(1), epochId: context.epoch.id,
  kind: 'delivery-observed', body: { ...expected, observedBy: at + i, clockSlot: 100, ...changes } }, secret));

test('unknown timing is not a late delivery; three original timely observations only prove an upper bound', () => {
  assert.equal(check({ proof: { ...expected, status: 'delivered', finalizedAt: 3000 } }).state, 'unresolved');
  assert.equal(check({ observations: votes(2798) }).state, 'excused');
  assert.equal(check({ observations: votes(2800) }).state, 'unresolved');
  assert.equal(check({ observations: votes(3000), clock: { pausedIntervals: [{ from: 2900, to: 4000 }] } }).state, 'unresolved');
  assert.equal(check({ observations: [votes(2700)[0], votes(2700)[0], votes(2700)[1]] }).state, 'unresolved');
  for (const changes of [{ amount: '101' }, { nonce: h(99) }, { txHash: h(98) }, { networkId: 2 }])
    assert.equal(check({ observations: votes(2700, changes) }).state, 'unresolved');
  const bad = votes(2700); bad[0].sig = '00'.repeat(64);
  assert.equal(check({ observations: bad }).state, 'unresolved');
  assert.throws(() => check({ observations: Array(5).fill(null) }), /Invalid/);
});
test('historical exact finality distinguishes grace, late and certified pause', () => {
  const proof = { ...expected, status: 'delivered', finalizedTimeVerified: true, finalizedTime: 2800, evidenceDigest: h(6) };
  assert.equal(check({ proof }).state, 'excused');
  assert.equal(check({ proof: { ...proof, finalizedTime: 2801 } }).state, 'late');
  assert.equal(check({ proof: { ...proof, finalizedTime: 3000 }, clock: { pausedIntervals: [{ from: 3000, to: 4000 }] } }).state, 'excused');
  assert.equal(check({ proof: { ...proof, amount: '101' } }).state, 'unresolved');
});
test('observer verifies final exact delivery before the finalized clock and persists before returning', async () => {
  const store = memoryStore(), events = []; let final = false, at = 2700;
  const options = { store, context, identity: { publicKey: context.epoch.members[0].dexKey, secretKey: secrets[0] },
    verify: async () => { events.push('verify'); return { ok: true, final, amount: '100' }; },
    clock: async () => { events.push('clock'); return { at, slot: 42 }; }, now: () => at + 1 };
  await assert.rejects(new DeliveryObserver(options).observe(expected), /Exact final/);
  assert.deepEqual(events, ['verify']); final = true;
  const first = await new DeliveryObserver(options).observe(expected);
  assert.equal(first.fact.body.observedBy, 2701, 'a lagging finalized clock never backdates the observation');
  assert.deepEqual(events, ['verify', 'verify', 'clock']); at = 5000;
  assert.deepEqual(await new DeliveryObserver(options).observe(expected), first);
  assert.equal(events.length, 3, 'restart preserves the original evidence without redating');
  await assert.rejects(new DeliveryObserver({ ...options, store: { get: () => null, put() { throw new Error('disk'); } } }).observe(expected), /disk/);
  await assert.rejects(new DeliveryObserver(options).observe({ ...expected, networkId: 2 }), /Wrong/);
});
