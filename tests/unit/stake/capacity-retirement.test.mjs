import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { StakeClient } from '../../../src/stake/client.js';
import { StakeCustodySigner } from '../../../src/stake/custody-signer.js';
import { CapacityLedger } from '../../../src/stake/capacity.js';
import { openStore } from '../../../src/roles/store.js';
import { signFact } from '../../../src/stake/certificates.js';
import { defaultSettings } from '../../../src/stake/settings.js';
import { registryPolicy, secrets, members, memoryStore } from './helpers.mjs';
import { tracAddress } from '../core/helpers.mjs';

const h = n => n.toString(16).padStart(64, '0');
function fixture({ successor = false, store = memoryStore() } = {}) {
  const original = registryPolicy(), context = { networkId: original.networkId, venueKey: original.venueKey, epoch: original.epoch };
  const identities = secrets.map((secretKey, i) => ({ publicKey: members[i].dexKey, secretKey }));
  const stores = identities.map(memoryStore);
  const capacity = (i, scope = context) => new CapacityLedger({ store: stores[i], context: scope, identity: identities[i] });
  const descriptor = { networkId: context.networkId, venueKey: context.venueKey, epochId: context.epoch.id,
    batchId: h(1), nonce: h(2), owner: { dexKey: h(40), tracAddr: tracAddress(h(41)), boxKey: h(42) },
    purpose: 'seller', principalReset: '2500000', tnkReserve: '120', createdAt: 0, expiresAt: 1000000 };
  const options = { settings: defaultSettings(), price: { numerator: '20000000', denominator: '1' }, now: 100 };
  const grant = capacity(0).propose([descriptor], options), unitId = grant.units[0].unitId;
  stores.forEach((s, i) => { capacity(i).vote(grant, [descriptor], options); s.put(`stake-retained-epoch-${original.epoch.id}`, original); });
  let policy = original;
  if (successor) {
    const secretKey = new Uint8Array(32).fill(51), extra = { publicKey: Buffer.from(ed25519.getPublicKey(secretKey)).toString('hex'), secretKey };
    identities.push(extra); stores.push(memoryStore());
    policy = { ...original, epoch: { ...original.epoch, id: h(120), startAt: 110,
      members: [...members.slice(1), { dexKey: extra.publicKey, boxKey: h(121) }] } };
    const stopped = { ...context, epoch: { ...context.epoch, stopNewAt: 110 } }, next = { ...context, epoch: policy.epoch };
    const handoff = [0, 1, 2].map(i => capacity(i, stopped).handoffVote(next, 110));
    for (let i = 1; i < stores.length; i++) capacity(i, next).adoptHandoff(handoff, stopped);
  }
  const certificate = secrets.slice(0, 3).map(secret => signFact({ v: 1, networkId: context.networkId, venueKey: context.venueKey,
    epochId: context.epoch.id, kind: 'collected', body: { unitId, generation: 0, decisionId: h(90), txHash: h(91) } }, secret));
  const registry = () => policy && { sellerBond: policy }, calls = [], failures = new Map();
  const signer = i => new StakeCustodySigner({ store: stores[i], identity: identities[i], registry,
    verifyFunding: async () => { throw Error('Retirement must not verify or send funding'); } });
  const args = { store, registry, me: { tracAddr: descriptor.owner.tracAddr }, clock: async () => ({ at: 5000 }),
    request: async (key, method, body) => {
      const i = identities.findIndex(v => v.publicKey === key); calls.push(i);
      assert.equal(method, 'capacityRetire');
      assert.deepEqual(body.certificate, certificate);
      const fail = failures.get(i);
      if (fail === 'offline') throw Error('offline');
      if (fail === 'false') return { retired: false };
      if (fail === 'wrong-sender') return { retired: true, from: h(500) };
      const response = await signer(i).handle(method, body, descriptor.owner.dexKey);
      if (fail === 'lost-reply') throw Error('reply lost after durable retirement');
      return response;
    } };
  return { args, store, calls, failures, certificate, context, unitId, make: () => new StakeClient(args),
    retirements: () => stores.map(s => s.get(capacity(0).name)),
    setPolicy: next => { policy = next; }, name: `stake-capacity-retirement-${unitId}` };
}

for (const successor of [false, true]) test(`${successor ? 'successor' : 'same-epoch'} capacity retirement survives a down member and client restart`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capacity-retirement-')), key = randomBytes(32);
  try {
    const f = fixture({ successor, store: openStore(dir, key) }), missing = successor ? 4 : 3;
    f.failures.set(missing, 'offline');
    await f.make().retireCapacity(f.certificate, f.context);
    assert.equal(f.retirements()[missing].pieces[f.unitId].retired, false);
    assert.equal(f.store.get(f.name).done, false);
    assert.equal(f.store.get(f.name).confirmed.length, successor ? 4 : 3);
    f.args.store = openStore(dir, key);
    await f.make().recover();
    assert.equal(f.args.store.get(f.name).done, false, 'an unavailable member stays pending after restart');
    f.failures.clear(); f.calls.length = 0;
    await f.make().recover();
    assert.deepEqual(f.calls, [missing], 'recovery only retries unconfirmed members');
    assert.ok(f.retirements().every(s => s.pieces[f.unitId].retired));
    assert.ok(f.retirements().every(s => s.tokens[1].generation === 1));
    assert.equal(f.args.store.get(f.name).done, true);
    await f.make().recover(); assert.deepEqual(f.calls, [missing]);
  } finally { key.fill(0); rmSync(dir, { recursive: true, force: true }); }
});

test('a lost retirement reply resends the same certificate without advancing capacity twice', async () => {
  const f = fixture(); f.failures.set(3, 'lost-reply');
  await f.make().retireCapacity(f.certificate, f.context);
  const once = f.retirements(); assert.ok(once.every(s => s.pieces[f.unitId].retired));
  assert.equal(f.store.get(f.name).done, false);
  f.failures.clear(); await f.make().recover();
  assert.deepEqual(f.retirements(), once);
  f.calls.length = 0;
  await f.make().retireCapacity(f.certificate, f.context);
  assert.deepEqual(f.calls, []);
});

test('retirement requires an explicit authenticated confirmation from every member', async () => {
  const f = fixture(); f.failures.set(2, 'false'); f.failures.set(3, 'wrong-sender');
  await f.make().retireCapacity(f.certificate, f.context);
  assert.equal(f.store.get(f.name).confirmed.length, 2);
  f.failures.clear(); f.calls.length = 0;
  await f.make().recover(); assert.deepEqual(f.calls, [2, 3]);
  assert.ok(f.retirements().every(s => s.pieces[f.unitId].retired));
});

test('retirement is journaled before sending and replays safely after a crash before saving replies', async () => {
  const f = fixture(), put = f.store.put;
  f.store.put = () => { throw Error('disk unavailable'); };
  await assert.rejects(f.make().retireCapacity(f.certificate, f.context), /disk unavailable/);
  assert.deepEqual(f.calls, []);
  f.store.put = (name, value) => { if (value.done) throw Error('crash saving confirmations'); put(name, value); };
  await assert.rejects(f.make().retireCapacity(f.certificate, f.context), /crash saving confirmations/);
  assert.equal(f.store.get(f.name).confirmed.length, 0);
  const once = f.retirements(); f.store.put = put;
  await f.make().recover(); assert.deepEqual(f.retirements(), once);
  assert.equal(f.store.get(f.name).done, true);
});

test('retirement keeps the successor quorum requirement and rejects uncertified or conflicting collections', async () => {
  const f = fixture({ successor: true });
  await assert.rejects(f.make().retireCapacity(f.certificate.slice(0, 2), f.context), /three distinct/);
  assert.deepEqual(f.calls, []); assert.equal(f.store.get(f.name), null);
  f.failures.set(3, 'offline'); f.failures.set(4, 'offline');
  await assert.rejects(f.make().retireCapacity(f.certificate, f.context), /quorum unavailable/);
  assert.equal(f.store.get(f.name).done, false);
  f.failures.clear(); await f.make().recover();
  const conflict = secrets.slice(0, 3).map(s => signFact({ ...f.certificate[0].fact,
    body: { ...f.certificate[0].fact.body, txHash: h(92) } }, s));
  await assert.rejects(f.make().retireCapacity(conflict, f.context), /Conflicting capacity retirement/);
  assert.ok(f.retirements().every(s => s.tokens[1].generation === 1));
});
