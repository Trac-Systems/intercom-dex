import { generateIdentity, generateBox, encodeKey } from '../../../src/core/keys.js';
import { Keypair } from '@solana/web3.js';
export const identity = () => { const k = generateIdentity(); return { secretKey: k.secretKey, publicKey: encodeKey(k.publicKey) }; };
export const box = () => { const k = generateBox(); return { secretKey: k.secretKey, publicKey: encodeKey(k.publicKey) }; };
export const sol = () => Keypair.generate().publicKey.toBase58();
export function registry(signers = Array.from({ length: 5 }, () => ({ identity: identity(), box: box() }))) {
  return { version: 1, issuedAt: 1000, minSoftware: '0.2.0',
    params: { n: 5, k: 3, dkgTimeoutSec: 120, reserveSec: 600, payMarginSec: 120, termBlocks: { min: 6, max: 12960 }, offerMaxBlocks: 12960, recoveryMarginSec: 604800, tnkReserve: '1000000000000000000' },
    assets: { RESET: 'open', TNK: 'open' }, products: { loan: 'open', call: 'open', put: 'open' }, limits: { TNK: { min: '1', max: '1000000000000000000000000' }, RESET: { min: '1', max: '1000000000000' }, USDC: { min: '1', max: '1000000000000' }, totalLocked: { TNK: '999999999999999999999999999', RESET: '9999999999999999', USDC: '9999999999999999' } },
    fee: { loanBps: 50, optionBps: 1000, optionMin: '50000', signerShareBps: 4000, collector: sol(), escrowCollector: sol() }, signers: signers.map((s, i) => ({ lockKey: s.identity.publicKey, boxKey: s.box.publicKey, status: 'active', group: 'operator', label: `s${i}`, software: '0.2.0' })), removed: [] };
}
export function memoryStore() {
  const m = new Map(); return { put: (k, v) => m.set(k, structuredClone(v)), get: k => structuredClone(m.get(k) ?? null), list: p => [...m.keys()].filter(k => k.startsWith(p)), delete: k => m.delete(k) };
}
