import test from 'node:test';
import assert from 'node:assert/strict';
import { sealTo, openSealed } from '../../../src/core/seal.js';
import { generateBox, encodeKey } from '../../../src/core/keys.js';
import { le32, fromLe32 } from '../../../src/core/canonical.js';
import { hex, rng } from './helpers.mjs';

test('sealed shares round trip with deterministic injected entropy', () => {
  const box = generateBox(), context = { tradeId: hex(), signerIndex: 2 };
  const sealed = sealTo(le32(3n), encodeKey(box.publicKey), context, rng());
  assert.deepEqual(sealed, sealTo(le32(3n), encodeKey(box.publicKey), context, rng()));
  assert.ok(fromLe32(openSealed(sealed, box.secretKey, context)) === 3n);
  assert.ok(fromLe32(openSealed(sealed, encodeKey(box.secretKey), context)) === 3n);
});
test('AEAD rejects changed ciphertext, recipient, nonce, signer index and trade; low-order keys fail', () => {
  const box = generateBox(), context = { tradeId: hex(), signerIndex: 2 };
  const sealed = sealTo(le32(3n), encodeKey(box.publicKey), context);
  for (const field of ['nonce', 'ephemeralKey', 'ciphertext']) {
    const changed = { ...sealed, [field]: (sealed[field][0] === '0' ? '1' : '0') + sealed[field].slice(1) };
    assert.throws(() => openSealed(changed, box.secretKey, context));
  }
  assert.throws(() => openSealed(sealed, generateBox().secretKey, context));
  assert.throws(() => openSealed(sealed, box.secretKey, { ...context, tradeId: hex() }));
  assert.throws(() => openSealed(sealed, box.secretKey, { ...context, signerIndex: 3 }));
  assert.throws(() => sealTo(le32(1n), '0'.repeat(64), context));
  assert.throws(() => sealTo(new Uint8Array(31), encodeKey(box.publicKey), context));
  assert.throws(() => sealTo(le32(1n), encodeKey(box.publicKey), { ...context, signerIndex: -1 }));
});
