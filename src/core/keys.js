import { randomBytes } from 'node:crypto';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from './canonical.js';

function keyBytes(key) {
  const bytes = typeof key === 'string' ? hexToBytes(key, 32) : key;
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new RangeError('Expected 32-byte key');
  return bytes;
}

export function identityPublic(secret) { return ed25519.getPublicKey(keyBytes(secret)); }
export function boxPublic(secret) { return x25519.getPublicKey(keyBytes(secret)); }
export function encodeKey(key) { return bytesToHex(keyBytes(key)); }

export function generateIdentity(rng = randomBytes) {
  const secretKey = Uint8Array.from(keyBytes(rng(32)));
  return { secretKey, publicKey: identityPublic(secretKey) };
}

export function generateBox(rng = randomBytes) {
  const secretKey = Uint8Array.from(keyBytes(rng(32)));
  return { secretKey, publicKey: boxPublic(secretKey) };
}
