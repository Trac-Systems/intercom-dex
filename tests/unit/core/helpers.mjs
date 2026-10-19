import { randomBytes } from 'node:crypto';
import { generateBox, generateIdentity, encodeKey } from '../../../src/core/keys.js';
import { bytesToHex, sha256Hex } from '../../../src/core/canonical.js';
import { buildRegistry } from '../../../src/core/registry.js';
import { buildTerms } from '../../../src/core/terms.js';

export const BASES = { TNK: { kind: 'trac-native', id: 'TNK', decimals: 18 }, RESET: { kind: 'trac-contract-token', id: 'RESET', decimals: 8 } };
export const PAIRS = Object.entries(BASES).map(([id, base]) => ({ pair: id + '/USDC', base, minBaseAmount: '1', status: 'open' }));
export const hex = () => bytesToHex(randomBytes(32));
export const SOL = '11111111111111111111111111111111';
export const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOL2 = '4RS6xpspM1V2K7FKSqeSH6VVaZbtzHzhJqacwrz8gJrF';
export const SIG = '2'.repeat(88);
export function tracAddress(key) {
  const data = [], alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  let acc = 0, bits = 0;
  for (const b of Buffer.from(key, 'hex')) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; data.push((acc >>> bits) & 31); }
  }
  if (bits) data.push((acc << (5 - bits)) & 31);
  let check = 1;
  for (const v of [3, 3, 3, 3, 0, 20, 18, 1, 3, ...data, 0, 0, 0, 0, 0, 0]) {
    const top = check >>> 25; check = ((check & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) check ^= [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3][i];
  }
  check ^= 0x2bc830a3;
  const checksum = Array.from({ length: 6 }, (_, i) => (check >>> (5 * (5 - i))) & 31);
  return 'trac1' + [...data, ...checksum].map(x => alphabet[x]).join('');
}

export function fixture({ n = 5, k = 3, pair = 'TNK/USDC' } = {}) {
  const buyer = generateIdentity(), seller = generateIdentity(), service = generateIdentity();
  const signers = Array.from({ length: n }, () => ({ identity: generateIdentity(), box: generateBox() }));
  const registry = buildRegistry({ version: 1, issuedAt: 10, minSoftware: '0.1.0', pairs: PAIRS,
    params: { n, k, sendWindowSec: 900, refundSec: 86400, graceSec: 300 },
    fee: { platformFeeBps: 10, tradeFeeBps: 50, collector: SOL2, signerShareBps: 5000 },
    signers: signers.map((s, i) => ({ dexKey: encodeKey(s.identity.publicKey), boxKey: encodeKey(s.box.publicKey),
      label: 'signer-' + i, limitUsdc: '1000000000', status: 'active', assets: ['TNK', 'RESET'], software: '0.1.0' })), removed: [] });
  const offerId = hex();
  const terms = buildTerms({ offerId, pair, base: BASES[pair.split('/')[0]], baseAmount: '123456', quoteAmount: '5000000', mint: MINT,
    seller: { dexKey: encodeKey(seller.publicKey), tracAddr: tracAddress(encodeKey(seller.publicKey)), solRecipient: SOL2 },
    buyer: { dexKey: encodeKey(buyer.publicKey), tracAddr: tracAddress(encodeKey(buyer.publicKey)), solPayer: SOL },
    registryVersion: 1, committee: registry.signers.map(({ dexKey, boxKey }) => ({ dexKey, boxKey })), k,
    fees: { ...registry.fee, platformFeeBps: 10, platformCollector: SOL }, sendBy: 1000, refundAfter: 86500, graceSec: 300, R: hex() });
  return { buyer, seller, service, signers, registry, terms, offerId };
}

export function rng(seed = 'test') {
  let counter = 0;
  return length => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i += 32) {
      const block = Buffer.from(sha256Hex(seed + ':' + counter++), 'hex');
      out.set(block.subarray(0, Math.min(32, length - i)), i);
    }
    return out;
  };
}

// Shape-valid placeholder. Unit machines stub certificate results; it is never a real proof.
export const proofStub = () => ({ protocol: 'plonk', curve: 'bn128',
  ...Object.fromEntries(['A', 'B', 'C', 'Z', 'T1', 'T2', 'T3', 'Wxi', 'Wxiw'].map(k => [k, ['1', '2', '1']])),
  ...Object.fromEntries(['eval_a', 'eval_b', 'eval_c', 'eval_s1', 'eval_s2', 'eval_zw'].map(k => [k, '0'])) });
