import test from 'node:test';
import assert from 'node:assert/strict';
import { generateIdentity, generateBox, identityPublic, boxPublic, encodeKey } from '../../../src/core/keys.js';
import { rng } from './helpers.mjs';

test('identity and box generation support injected entropy and public derivation', () => {
  for (const [generate, publicFrom] of [[generateIdentity, identityPublic], [generateBox, boxPublic]]) {
    const key = generate(rng()), other = generate(rng());
    assert.ok(encodeKey(key.publicKey) === encodeKey(other.publicKey));
    assert.ok(encodeKey(publicFrom(key.secretKey)) === encodeKey(key.publicKey));
    assert.ok(encodeKey(publicFrom(encodeKey(key.secretKey))) === encodeKey(key.publicKey));
    assert.ok(generate().publicKey.length === 32);
    assert.throws(() => generate(() => new Uint8Array(31)));
    assert.throws(() => publicFrom('ff'));
    assert.throws(() => publicFrom(new Uint8Array(33)));
  }
  assert.throws(() => encodeKey(new Uint8Array(1)));
});
