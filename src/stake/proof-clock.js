import { z } from 'zod';
import { stableJSON, sha256Hex } from '../core/canonical.js';
import { verifyCertificate, factDigest } from './certificates.js';

const uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hex = z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/);
const interval = z.object({ from: uint, to: uint }).strict().refine(i => i.to > i.from);
const intervals = z.array(interval).max(10000).refine(a => a.every((x, i) => !i || x.from >= a[i - 1].to));
const clockSchema = z.object({ tradeId: hex, reservationId: hex, seq: uint, prevHash: hex,
  throughAt: uint, healthyIntervals: intervals, pausedIntervals: intervals,
  healthDigests: z.array(hex).min(1).max(10000), receiptHeads: z.array(hex).length(3) }).strict();

export function createProofClock({ tradeId, reservationId, triggerAt, windowSec }) {
  hex.parse(tradeId); hex.parse(reservationId); uint.parse(triggerAt); uint.parse(windowSec);
  if (windowSec < 1) throw new Error('Invalid proof window');
  const initial = { tradeId, reservationId, triggerAt, windowSec, seq: 0, throughAt: triggerAt,
    healthyIntervals: [], pausedIntervals: [], activeElapsedSec: 0, remainingSec: windowSec,
    deadline: null, deadlineFloor: triggerAt + windowSec };
  uint.parse(initial.deadlineFloor);
  return { ...initial, hash: sha256Hex('intercom-dex/stake/v1/clock\n' + stableJSON(initial)) };
}
const overlap = (a, b) => a.from < b.to && b.from < a.to;
const covered = (intervals, i) => intervals.reduce((n, p) => n + Math.max(0, Math.min(p.to, i.to) - Math.max(p.from, i.from)), 0) === i.to - i.from;

// Each checkpoint covers the complete prefix. Unknown gaps must be explicitly paused, never backfilled healthy.
// The signing role must validate the referenced service samples and reconciled inbox heads before signing.
export function applyProofClock(previous, certificate, context, now) {
  uint.parse(now);
  const fact = verifyCertificate(certificate, context, 'clock'), b = clockSchema.parse(fact.body);
  if (b.tradeId !== previous.tradeId || b.reservationId !== previous.reservationId || b.seq !== previous.seq + 1 ||
      b.prevHash !== previous.hash || b.throughAt < previous.throughAt || b.throughAt > now) throw new Error('Invalid proof clock successor');
  const all = [...b.healthyIntervals, ...b.pausedIntervals].sort((a, b) => a.from - b.from);
  let end = previous.triggerAt;
  for (const i of all) { if (i.from !== end || i.to > b.throughAt) throw new Error('Proof clock has a gap or overlap'); end = i.to; }
  if (end !== b.throughAt) throw new Error('Incomplete proof clock');
  for (const h of b.healthyIntervals) {
    if (previous.pausedIntervals.some(p => overlap(p, h))) throw new Error('A pause cannot become healthy time');
    // Past healthy intervals may be subdivided or corrected to paused, but no formerly unknown prefix can be credited.
    const old = { from: h.from, to: Math.min(h.to, previous.throughAt) };
    if (old.to > old.from && !covered(previous.healthyIntervals, old)) throw new Error('Uncertified historical time');
  }
  const activeElapsedSec = b.healthyIntervals.reduce((n, i) => n + i.to - i.from, 0);
  const pausedSec = b.throughAt - previous.triggerAt - activeElapsedSec;
  const remainingSec = Math.max(0, previous.windowSec - activeElapsedSec);
  const deadlineFloor = previous.triggerAt + previous.windowSec + pausedSec;
  uint.parse(deadlineFloor);
  if (deadlineFloor < previous.deadlineFloor) throw new Error('Proof deadline cannot shorten');
  const paused = !b.healthyIntervals.some(i => i.to === b.throughAt);
  return { ...previous, seq: b.seq, throughAt: b.throughAt, healthyIntervals: b.healthyIntervals, pausedIntervals: b.pausedIntervals,
    activeElapsedSec, pausedSec, remainingSec, deadlineFloor, deadline: paused ? null : deadlineFloor,
    hash: factDigest(fact), certificate };
}

export function qualifyingLock({ includedAt, finalized, exact, historyComplete }, sendBy, lockLeadSec) {
  uint.parse(sendBy); uint.parse(lockLeadSec);
  return finalized === true && exact === true && historyComplete === true && Number.isSafeInteger(includedAt) &&
    includedAt >= 0 && includedAt < sendBy - lockLeadSec;
}

// This consumes independently verified exact transfer facts, never a transport notice or local observation time.
export function deliveryExcusesPenalty({ expected, proof, sendBy, overdueDelaySec, clock }) {
  uint.parse(sendBy); uint.parse(overdueDelaySec);
  if (proof?.status !== 'delivered' || proof.finalizedTimeVerified !== true || !Number.isSafeInteger(proof.finalizedTime) ||
      proof.finalizedTime < 0 || !hex.safeParse(proof.evidenceDigest).success || !hex.safeParse(proof.txHash).success) return false;
  for (const field of ['from', 'to', 'asset', 'amount', 'nonce', 'networkId']) if (proof[field] !== expected[field]) return false;
  return proof.finalizedTime <= sendBy + overdueDelaySec ||
    !!clock?.pausedIntervals.some(i => proof.finalizedTime >= i.from && proof.finalizedTime < i.to);
}

export function canRetryOriginal({ intent, tradeId, nonce, sendBy, overdueDelaySec, now }) {
  uint.parse(sendBy); uint.parse(overdueDelaySec); uint.parse(now);
  return !!intent && intent.tradeId === tradeId && intent.nonce === nonce && hex.safeParse(intent.txHash).success &&
    Number.isSafeInteger(intent.createdAt) && intent.createdAt >= 0 && intent.createdAt < sendBy &&
    now >= intent.createdAt && now <= sendBy + overdueDelaySec;
}
