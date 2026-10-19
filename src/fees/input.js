import { isAbsolute } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { readPrivateFile } from '../roles/keyring.js';

export const PLATFORM_WARNING = 'Changing the global platform fee makes agreed trades that have not locked fail: platform fee changed, take again. Nothing moves for those trades. Require --yes.';

export function percentBps(value, max) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(value) || value.length > 10) throw new Error('Percent must have at most two decimal places');
  const [whole, fraction = ''] = value.split('.');
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(bps) || bps > max) throw new Error(`Fee exceeds ${max / 100}%`);
  return bps;
}

export function platformBps(value) {
  if (typeof value === 'string' && /^(0|[1-9][0-9]{0,2})$/.test(value)) value = Number(value);
  if (!Number.isInteger(value) || value < 0 || value > 500) throw new Error('Platform bps must be an integer from 0 to 500');
  return value;
}

export function readAuthorityKeypair(file) {
  if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('Authority keypair file must be absolute');
  const bytes = JSON.parse(readPrivateFile(file));
  if (!Array.isArray(bytes) || bytes.length !== 64 || bytes.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error('Invalid Solana authority keypair');
  const secret = Uint8Array.from(bytes);
  try {
    if (!Buffer.from(ed25519.getPublicKey(secret.subarray(0, 32))).equals(Buffer.from(secret.subarray(32)))) throw new Error('Invalid Solana authority keypair');
    // A web3 Keypair's secretKey getter returns a copy. Keep a wipeable signer buffer instead.
    return { publicKey: new PublicKey(secret.subarray(32)), secretKey: secret };
  } catch (error) { secret.fill(0); throw error; }
  finally { bytes.fill(0); }
}
