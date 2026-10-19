import { randomBytes } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesToHex, concatBytes, hexToBytes, stableJSON, utf8 } from './canonical.js';
import { boxPublic, generateBox } from './keys.js';
import { hexKey, sealedBoxSchema } from './schemas.js';

const INFO = utf8('intercom-dex/v1/sealed-share');
function aadFor(recipientKey, { tradeId, signerIndex }) {
  hexKey.parse(tradeId);
  hexKey.parse(recipientKey);
  if (!Number.isSafeInteger(signerIndex) || signerIndex < 1 || signerIndex > 16) throw new RangeError('Invalid signer index');
  return utf8(stableJSON({ tradeId, signerIndex, recipientKey }));
}
function derive(secret, publicKey, ephemeral, recipient) {
  const shared = x25519.getSharedSecret(secret, publicKey);
  return hkdf(sha256, shared, sha256(concatBytes(ephemeral, recipient)), INFO, 32);
}

export function sealTo(plaintext, recipientKey, context, rng = randomBytes) {
  if (!(plaintext instanceof Uint8Array) || plaintext.length !== 32) throw new RangeError('Expected 32-byte share');
  const aad = aadFor(recipientKey, context);
  const recipient = hexToBytes(recipientKey, 32);
  const ephemeral = generateBox(rng);
  const nonce = rng(24);
  if (!(nonce instanceof Uint8Array) || nonce.length !== 24) throw new RangeError('Invalid nonce randomness');
  const key = derive(ephemeral.secretKey, recipient, ephemeral.publicKey, recipient);
  const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
  return { ephemeralKey: bytesToHex(ephemeral.publicKey), nonce: bytesToHex(nonce), ciphertext: bytesToHex(ciphertext) };
}

export function openSealed(sealed, recipientSecret, context) {
  sealedBoxSchema.parse(sealed);
  const secret = typeof recipientSecret === 'string' ? hexToBytes(recipientSecret, 32) : recipientSecret;
  const recipient = boxPublic(secret), ephemeral = hexToBytes(sealed.ephemeralKey, 32);
  const aad = aadFor(bytesToHex(recipient), context);
  const key = derive(secret, ephemeral, ephemeral, recipient);
  return xchacha20poly1305(key, hexToBytes(sealed.nonce, 24), aad).decrypt(hexToBytes(sealed.ciphertext, 48));
}
