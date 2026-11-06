import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '../../../src/core/canonical.js';
import { defaultSettings, policyId, publicationBytes } from '../../../src/stake/settings.js';

export const secrets = [1, 2, 3, 4].map(n => new Uint8Array(32).fill(n));
export const members = secrets.map((s, i) => ({ dexKey: bytesToHex(ed25519.getPublicKey(s)), boxKey: String(i + 1).repeat(64) }));
const defaultScope = { networkId: 1, venueKey: '8'.repeat(64), epochId: 'a'.repeat(64) };
export function policy(settings = defaultSettings(), at = 100, scope = defaultScope) {
  const id = policyId(settings);
  return { policyId: id, settings, publishedAt: at, effectiveAt: at + 3600,
    receipts: secrets.slice(0, 3).map((s, i) => ({ from: members[i].dexKey, at,
      sig: bytesToHex(ed25519.sign(publicationBytes(id, at, scope), s)) })) };
}
export function registryPolicy(scope = defaultScope) {
  return { protocol: 1, networkId: scope.networkId, venueKey: scope.venueKey, enforceAfter: 100000, acceptNew: true,
    epoch: { id: scope.epochId, members, n: 4, k: 3, maxFaulty: 1, startAt: 0 }, economics: { active: policy(defaultSettings(), 100, scope) } };
}
export function memoryStore() {
  const data = new Map();
  return { get: key => structuredClone(data.get(key) ?? null), put: (key, value) => data.set(key, structuredClone(value)),
    list: prefix => [...data.keys()].filter(k => k.startsWith(prefix)) };
}
