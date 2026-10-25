import { z } from 'zod';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, stableJSON, utf8 } from './canonical.js';
import { tracPublicKey } from './addresses.js';
import { meetsVersion } from './software.js';

// Emit the new participant field only after the venue activates it. Old strict-schema peers can keep trading
// throughout the upgrade; the current registry minimum also gates trades naming an older registry snapshot.
export const ADDRESS_PROOF_SOFTWARE = '0.1.34';
export const addressProofRequired = registry => !!registry && meetsVersion(registry.minSoftware, ADDRESS_PROOF_SOFTWARE);
const uint = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const addressProofSchema = z.object({ expiresAt: uint, signature: z.string().regex(/^[0-9a-f]{128}$(?![\s\S])/) }).strict();

export function addressProofHash({ networkId, dexKey, tracAddr, expiresAt }) {
  uint.parse(networkId); uint.parse(expiresAt);
  if (typeof dexKey !== 'string' || dexKey.length !== 64 || !/^[0-9a-f]{64}$/.test(dexKey)) throw new Error('Invalid DEX key');
  tracPublicKey(tracAddr);
  if (tracAddr !== tracAddr.toLowerCase()) throw new Error('Expected canonical Trac address');
  // A wallet signs 32-byte hashes. This domain cannot be confused with a Trac transaction or DEX envelope.
  return sha256(utf8('intercom-dex/v1/trac-address-proof\n' + stableJSON({ networkId, dexKey, tracAddr, expiresAt })));
}

export function createAddressProof(wallet, { networkId, dexKey, expiresAt }) {
  const tracAddr = wallet?.address;
  const signature = wallet.sign(addressProofHash({ networkId, dexKey, tracAddr, expiresAt }));
  const proof = addressProofSchema.parse({ expiresAt, signature });
  if (!validAddressProof({ dexKey, tracAddr, tracProof: proof }, { networkId, now: 0 })) throw new Error('Trac wallet proof failed');
  return proof;
}

export function validAddressProof(party, { networkId, now, validUntil = now, required = true } = {}) {
  try {
    if (party?.tracProof === undefined) return !required;
    const { expiresAt, signature } = addressProofSchema.parse(party.tracProof);
    uint.parse(now); uint.parse(validUntil);
    if (expiresAt <= now || expiresAt < validUntil) return false;
    return ed25519.verify(hexToBytes(signature, 64), addressProofHash({ networkId, dexKey: party.dexKey,
      tracAddr: party.tracAddr, expiresAt }), tracPublicKey(party.tracAddr), { zip215: false });
  } catch { return false; }
}

export function validTermsAddressProofs(terms, policy) {
  return [terms.seller, terms.buyer].every(p => validAddressProof(p, { ...policy, validUntil: terms.sendBy }));
}
