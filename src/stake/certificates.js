import { z } from 'zod';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes, sha256Hex, stableJSON, utf8 } from '../core/canonical.js';

const hex = z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/);
const factSchema = z.object({ v: z.literal(1), networkId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  venueKey: hex, epochId: hex, kind: z.enum(['admission-inventory', 'delivery-cutoff', 'delivery-result', 'penalty-health', 'penalty-prepare', 'funded', 'funding-refund', 'withdraw-intent', 'resolved', 'freeze-accept', 'freeze', 'decision', 'collected', 'clock', 'delivery-observed', 'inventory', 'book', 'price', 'reward-head', 'completion', 'price-head', 'history-head', 'liability-handoff', 'capacity', 'capacity-handoff', 'capacity-abandon', 'dkg-deal', 'dkg-ready', 'release']),
  body: z.record(z.string(), z.unknown()) }).strict();
const voteSchema = z.object({ fact: factSchema, from: hex, sig: z.string().regex(/^[0-9a-f]{128}$(?![\s\S])/) }).strict();
const bytes = fact => utf8('intercom-dex/stake/v1/fact\n' + stableJSON(factSchema.parse(fact)));

export function factDigest(fact) { return sha256Hex(bytes(fact)); }

// Sign only after the role has independently checked the facts and durably committed its vote.
export function signFact(fact, secret) {
  const s = typeof secret === 'string' ? hexToBytes(secret, 32) : secret;
  return { fact: factSchema.parse(fact), from: bytesToHex(ed25519.getPublicKey(s)), sig: bytesToHex(ed25519.sign(bytes(fact), s)) };
}

export function verifyFact(input, { networkId, venueKey, epoch }, kind, signer) {
  const v = voteSchema.parse(input);
  if (v.from !== signer || v.fact.networkId !== networkId || v.fact.venueKey !== venueKey || v.fact.epochId !== epoch.id ||
      v.fact.kind !== kind || !ed25519.verify(hexToBytes(v.sig, 64), bytes(v.fact), hexToBytes(signer, 32), { zip215: false }))
    throw new Error('Invalid signed stake fact');
  return structuredClone(v.fact);
}

export function verifyCertificate(votes, { networkId, venueKey, epoch }, kind) {
  if (epoch?.n !== 4 || epoch.k !== 3 || epoch.maxFaulty !== 1 || epoch.members?.length !== 4 ||
      new Set(epoch.members.map(m => m.dexKey)).size !== 4) throw new Error('Invalid stake committee');
  if (!Array.isArray(votes) || votes.length < 3 || votes.length > 4) throw new Error('Stake certificate requires three distinct members');
  let digest, fact; const seen = new Set();
  for (const input of votes) {
    const v = voteSchema.parse(input), d = factDigest(v.fact);
    if (v.fact.networkId !== networkId || v.fact.venueKey !== venueKey || v.fact.epochId !== epoch.id || v.fact.kind !== kind ||
        !epoch.members.some(m => m.dexKey === v.from) || seen.has(v.from) || digest && digest !== d ||
        !ed25519.verify(hexToBytes(v.sig, 64), bytes(v.fact), hexToBytes(v.from, 32), { zip215: false })) throw new Error('Invalid stake certificate');
    seen.add(v.from); digest = d; fact = v.fact;
  }
  return structuredClone(fact);
}

// One malformed or conflicting response must not veto three valid original
// members. Never mix digests, identities or epochs to manufacture a threshold.
export function matchingCertificate(inputs, context, kind) {
  if (!Array.isArray(inputs) || inputs.length > 4) throw new Error('Invalid stake vote collection');
  const groups = new Map();
  for (const input of inputs) {
    try {
      if (!context.epoch.members.some(m => m.dexKey === input.from)) continue;
      const fact = verifyFact(input, context, kind, input.from), digest = factDigest(fact);
      const group = groups.get(digest) ?? [];
      if (!group.some(v => v.from === input.from)) group.push(input);
      groups.set(digest, group);
    } catch { /* An invalid response has no vote. */ }
  }
  const group = [...groups.values()].find(votes => votes.length >= 3);
  if (!group) throw new Error('Three matching stake votes are required');
  verifyCertificate(group, context, kind); return structuredClone(group);
}
