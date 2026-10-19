import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegistry, signRegistry, verifyRegistry, newestRegistry, removeSigner } from '../../../src/core/registry.js';
import { encodeKey } from '../../../src/core/keys.js';
import { fixture, hex } from './helpers.mjs';

test('registry signatures are pinned to service, newest valid versions selected and signer removed immutably', () => {
  const f = fixture(), serviceKey = encodeKey(f.service.publicKey), signed = signRegistry(f.registry, f.service.secretKey);
  assert.equal(verifyRegistry(signed, serviceKey, { now: 100 }), true);
  assert.equal(verifyRegistry(signed, hex(), { now: 100 }), false);
  assert.equal(verifyRegistry(signed, serviceKey, { now: 9 }), false);
  const next = removeSigner(f.registry, f.registry.signers[0].dexKey, { now: 100, reason: 'invalid release' });
  assert.equal(next.version, 2); assert.equal(next.signers.length, 4); assert.equal(f.registry.signers.length, 5);
  assert.equal(next.removed.length, 1);
  const latest = signRegistry(next, encodeKey(f.service.secretKey));
  const forged = { ...latest, registry: { ...latest.registry, version: 999 } };
  assert.equal(newestRegistry([forged, signed, latest], serviceKey, { now: 100 }).registry.version, 2);
  assert.equal(verifyRegistry(forged, serviceKey, { now: 100 }), false);
  assert.throws(() => newestRegistry([signed], serviceKey, { now: 100, minVersion: 2 }));
  const equivocation = signRegistry({ ...next, issuedAt: 99 }, f.service.secretKey);
  assert.throws(() => newestRegistry([latest, equivocation], serviceKey, { now: 100 }));
});
test('registry rejects bad versions, schema drift, duplicate keys, revived signers and invalid removals', () => {
  const f = fixture();
  for (const invalid of [{ ...f.registry, version: 0 }, { ...f.registry, extra: 1 },
    { ...f.registry, signers: [...f.registry.signers, f.registry.signers[0]] },
    { ...f.registry, params: { ...f.registry.params, k: 6 } },
    { ...f.registry, params: { ...f.registry.params, refundSec: 1200 } },
    { ...f.registry, removed: [{ dexKey: f.registry.signers[0].dexKey, removedAt: 10, reason: 'bad' }] }]) {
    assert.throws(() => buildRegistry(invalid)); assert.throws(() => signRegistry(invalid, f.service.secretKey));
  }
  assert.throws(() => removeSigner(f.registry, hex(), { now: 100, reason: 'unknown' }));
  assert.throws(() => removeSigner(f.registry, f.registry.signers[0].dexKey, { now: 9, reason: 'old' }));
  assert.throws(() => newestRegistry([], encodeKey(f.service.publicKey), { now: 100 }));
  assert.equal(verifyRegistry({}, encodeKey(f.service.publicKey), { now: 100 }), false);
});
