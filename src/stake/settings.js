import { z } from 'zod';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256Hex, stableJSON, hexToBytes, utf8 } from '../core/canonical.js';
import { isTracAddress } from '../core/addresses.js';

const uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hex = z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/);
const units = (min, max) => z.string().regex(/^(0|[1-9][0-9]{0,30})$(?![\s\S])/)
  .refine(n => BigInt(n) >= BigInt(min) && BigInt(n) <= BigInt(max), 'Amount outside app bounds');

// Monetary settings are base units: USD 6 decimals, RESET 8, TNK 18.
export const settingsSchema = z.object({
  admissionFreshSec: uint.min(60).max(600).optional(),
  priceLookbackSec: uint.max(2592000).optional(),
  randomnessWaitSec: uint.min(120).max(600).optional(),
  proofClock: z.object({ sampleGapSec: uint.min(15).max(120), sampleFreshSec: uint.min(15).max(180),
    checkpointFreshSec: uint.min(30).max(300) }).strict().optional(),
  penaltyBps: uint.min(50).max(1000), minPenaltyUsd: units('50000', '5000000'),
  overdueDelaySec: uint.min(300).max(21600), proofWindowSec: uint.min(3600).max(259200),
  stake: z.object({ withdrawDelaySec: uint.min(3600).max(604800), suggestBufferBps: uint.min(10000).max(30000),
    maxUsdPerAddress: units('500000', '1000000000000') }).strict(),
  rewards: z.object({ dailyReset: units('0', '100000000000'), activeWeightBps: uint.min(10000).max(50000),
    payoutMinReset: units('1', '10000000000'), payoutIntervalSec: uint.min(3600).max(2592000) }).strict(),
}).strict();

export function defaultSettings() {
  return settingsSchema.parse({ admissionFreshSec: 180, priceLookbackSec: 604800, randomnessWaitSec: 240, penaltyBps: 300, minPenaltyUsd: '500000', overdueDelaySec: 1800, proofWindowSec: 86400,
    proofClock: { sampleGapSec: 60, sampleFreshSec: 90, checkpointFreshSec: 180 },
    stake: { withdrawDelaySec: 86400, suggestBufferBps: 15000, maxUsdPerAddress: '10000000000' },
    rewards: { dailyReset: '500000000', activeWeightBps: 20000, payoutMinReset: '10000000', payoutIntervalSec: 604800 } });
}

// Resolve against the retained policy, never the latest registry or wall clock.
export function proofClockSettings(policy, terms) {
  const retained = [policy.economics.active, policy.economics.pending].find(p => p?.policyId === terms.bond.policyId);
  if (!retained) throw new Error('Original proof clock policy required');
  return structuredClone(retained.settings.proofClock ?? { sampleGapSec: 15, sampleFreshSec: 15, checkpointFreshSec: 30 });
}

export function policyId(settings) {
  return sha256Hex('intercom-dex/stake/v1/policy\n' + stableJSON(settingsSchema.parse(settings)));
}

const receiptSchema = z.object({ from: hex, at: uint, sig: z.string().regex(/^[0-9a-f]{128}$(?![\s\S])/) }).strict();
const publicationScope = z.object({ networkId: uint, venueKey: hex, epochId: hex }).strict();
export function publicationBytes(id, at, scope) {
  hex.parse(id); uint.parse(at);
  return utf8('intercom-dex/stake/v1/publication\n' + stableJSON({ policyId: id, at, ...publicationScope.parse(scope) }));
}
const policySchema = z.object({ policyId: hex, settings: settingsSchema, publishedAt: uint, effectiveAt: uint,
  receipts: z.array(receiptSchema).min(3).max(4) }).strict().superRefine((p, ctx) => {
  const bad = message => ctx.addIssue({ code: 'custom', message });
  if (p.policyId !== policyId(p.settings)) bad('Policy digest mismatch');
  if (p.effectiveAt !== p.publishedAt + 3600) bad('Settings require one hour of notice');
  if (p.publishedAt !== Math.max(...p.receipts.map(r => r.at))) bad('Publication must use the latest receipt');
  if (new Set(p.receipts.map(r => r.from)).size !== p.receipts.length) bad('Duplicate publication receipt');
  for (const r of p.receipts) {
    if (p.publishedAt - r.at > 5) bad('Publication clocks disagree');
  }
});

export const stakeRegistrySchema = z.object({ protocol: z.literal(1), networkId: uint, venueKey: hex, enforceAfter: uint, acceptNew: z.boolean(),
  rewardService: z.object({ dexKey: hex, tracAddr: z.string().refine(a => a === a.toLowerCase() && isTracAddress(a)) }).strict().optional(),
  custody: z.object({ lifetimeSec: uint.min(86400).max(2592000), fundingWindowSec: uint.min(300).max(3600),
    dkgTimeoutSec: uint.min(30).max(120), tnkReserve: units('1', '10000000000000000000') }).strict().optional(),
  epoch: z.object({ id: hex, members: z.array(z.object({ dexKey: hex, boxKey: hex }).strict()).length(4),
    n: z.literal(4), k: z.literal(3), maxFaulty: z.literal(1), startAt: uint, stopNewAt: uint.optional() }).strict(),
  economics: z.object({ active: policySchema, pending: policySchema.optional() }).strict(),
}).strict().superRefine((r, ctx) => {
  const bad = message => ctx.addIssue({ code: 'custom', message });
  for (const field of ['dexKey', 'boxKey']) if (new Set(r.epoch.members.map(m => m[field])).size !== 4) bad('Duplicate epoch member');
  if (r.epoch.stopNewAt != null && r.epoch.stopNewAt <= r.epoch.startAt) bad('Epoch stops before it starts');
  for (const p of [r.economics.active, r.economics.pending].filter(Boolean)) {
    if (p.receipts.some(a => !r.epoch.members.some(m => m.dexKey === a.from))) bad('Publication receipt outside epoch');
    for (const receipt of p.receipts) {
      try {
        const bytes = publicationBytes(p.policyId, receipt.at, { networkId: r.networkId, venueKey: r.venueKey, epochId: r.epoch.id });
        if (!ed25519.verify(hexToBytes(receipt.sig, 64), bytes, hexToBytes(receipt.from, 32), { zip215: false })) bad('Invalid publication receipt');
      } catch { bad('Invalid publication receipt'); }
    }
  }
  if (r.economics.pending && r.economics.pending.publishedAt < r.economics.active.effectiveAt) bad('Overlapping policy schedules');
});

// The registry signature is checked by the existing registry/envelope boundary before this selection.
export function effectiveSettings(policy, now) {
  uint.parse(now);
  const { economics } = stakeRegistrySchema.parse(policy);
  if (economics.active.effectiveAt > now) return null;
  return structuredClone(economics.pending && economics.pending.effectiveAt <= now ? economics.pending : economics.active);
}

// The publishing venue's own rule for moving activation earlier: unbonded trades admitted before the change
// keep their full send window, exactly as with the original schedule.
export function earlierActivationNotice(previous, next, now, sendWindowSec) {
  if (previous && next && next.enforceAfter < previous.enforceAfter && now < previous.enforceAfter && next.enforceAfter < now + sendWindowSec + 120)
    throw new Error(`Earlier stake activation needs ${sendWindowSec + 120} seconds of notice`);
}

export function validatePolicyTransition(previous, next, now) {
  uint.parse(now);
  const n = stakeRegistrySchema.parse(next);
  for (const p of [n.economics.active, n.economics.pending].filter(Boolean)) {
    if (p.publishedAt > now) throw new Error('Future settings publication');
  }
  if (!previous) return n;
  const p = stakeRegistrySchema.parse(previous);
  if (n.networkId !== p.networkId || n.venueKey !== p.venueKey) throw new Error('Stake publication scope cannot change');
  // Activation may move earlier (the venue gives one send window of notice when it publishes); it never moves
  // later once active.
  if (n.enforceAfter > p.enforceAfter && now >= p.enforceAfter) throw new Error('Cannot disable active stake enforcement');
  if (p.epoch.id === n.epoch.id) {
    const { stopNewAt: oldStop, ...oldEpoch } = p.epoch, { stopNewAt: nextStop, ...nextEpoch } = n.epoch;
    if (stableJSON(oldEpoch) !== stableJSON(nextEpoch)) throw new Error('Epoch identity is immutable');
    if (oldStop !== undefined && nextStop !== oldStop || oldStop === undefined && nextStop !== undefined && nextStop < now)
      throw new Error('Announced epoch stop cannot change or be backdated');
  } else {
    if (p.acceptNew || n.acceptNew || p.epoch.stopNewAt === undefined || now < p.epoch.stopNewAt || n.epoch.startAt < p.epoch.stopNewAt)
      throw new Error('Epoch replacement requires quiesced admissions and the announced stop');
    // A draining successor can reattest the same effective settings. New
    // economic values still require their own notice; no schedule is discarded.
    if (p.economics.pending || n.economics.pending || n.economics.active.effectiveAt > now ||
        n.economics.active.policyId !== p.economics.active.policyId || stableJSON(n.economics.active.settings) !== stableJSON(p.economics.active.settings))
      throw new Error('Epoch handoff requires unchanged effective economics and no pending schedule');
    return n;
  }
  const pending = p.economics.pending;
  if (pending) {
    const retained = [n.economics.active, n.economics.pending].find(x => x && stableJSON(x) === stableJSON(pending));
    if (!retained) throw new Error('Announced settings cannot be cancelled or replaced');
    if (now < pending.effectiveAt && stableJSON(n.economics.active) !== stableJSON(p.economics.active)) throw new Error('Pending settings are not effective yet');
  } else if (stableJSON(n.economics.active) !== stableJSON(p.economics.active)) {
    throw new Error('New settings must first be published as pending');
  }
  return n;
}
