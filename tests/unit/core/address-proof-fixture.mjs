import { ed25519 } from '@noble/curves/ed25519.js';
import { createAddressProof } from '../../../src/core/address-proof.js';
import { encodeKey, generateIdentity } from '../../../src/core/keys.js';
import { tracAddress } from './helpers.mjs';

export const networkId = 7;
export function proofWallet(identity = generateIdentity()) {
  return { address: tracAddress(encodeKey(identity.publicKey)), publicKey: encodeKey(identity.publicKey),
    sign: hash => Buffer.from(ed25519.sign(hash, identity.secretKey)).toString('hex') };
}
export function proveParty(party, { wallet = proofWallet(), expiresAt = 100000, network = networkId } = {}) {
  return { ...party, tracAddr: wallet.address,
    tracProof: createAddressProof(wallet, { networkId: network, dexKey: party.dexKey, expiresAt }) };
}
