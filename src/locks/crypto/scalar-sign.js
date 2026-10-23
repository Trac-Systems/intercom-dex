import { ed25519 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, le32, concatBytes, utf8 } from '../../core/canonical.js';
import { publicOf, SCALAR_ORDER as L } from './edvss.js';

const reduce = bytes => {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n % L;
};

export function scalarSigner(a) {
  const publicKey = publicOf(a), A = hexToBytes(publicKey, 32);
  const prefix = sha512(concatBytes(utf8('intercom-locks/v1/nonce'), le32(a))).slice(0, 32);
  return { publicKey, sign(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('Message must be bytes');
    const r = reduce(sha512(concatBytes(prefix, bytes)));
    const R = ed25519.Point.BASE.multiplyUnsafe(r).toBytes();
    const S = (r + reduce(sha512(concatBytes(R, A, bytes))) * a) % L;
    return bytesToHex(concatBytes(R, le32(S)));
  } };
}
