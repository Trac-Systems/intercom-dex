import { z } from 'zod';
import { verifyFact, factDigest } from './certificates.js';
import { stableJSON } from '../core/canonical.js';

const uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), hex = z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/);
export const positionSchema = z.object({ bootstrap: hex, coreKey: hex, length: uint.min(1), root: hex }).strict();
export const penaltySampleSchema = z.object({ reservationId: hex, seq: uint, at: uint, slot: uint, healthy: z.boolean(),
  reason: z.enum(['healthy', 'service-unavailable', 'sample-slow']).optional(),
  position: positionSchema.nullable(), receiptHead: hex }).strict();

function samples(votes, context, id) {
  if (!Array.isArray(votes) || votes.length < 3 || votes.length > 4 || new Set(votes.map(v => v.from)).size !== votes.length) throw new Error('Health quorum required');
  return votes.map(v => {
    if (!context.epoch.members.some(m => m.dexKey === v.from)) throw new Error('Wrong health member');
    const body = penaltySampleSchema.parse(verifyFact(v, context, 'penalty-health', v.from).body);
    if (body.reservationId !== id) throw new Error('Wrong health reservation');
    return { ...body, from: v.from, digest: factDigest(v.fact) };
  });
}
const add = (list, from, to) => {
  if (to <= from) return;
  if (list.at(-1)?.to === from) list.at(-1).to = to;
  else list.push({ from, to });
};

// Only consecutive, independently journaled healthy endpoints can credit time.
// A gap, changed quorum or absent endpoint is an outage, never backfilled later.
export function penaltyClockBody(previous, beforeVotes, afterVotes, context, maxGapSec = 15) {
  z.number().int().min(15).max(120).parse(maxGapSec);
  const after = samples(afterVotes, context, previous.reservationId);
  const before = beforeVotes?.length ? samples(beforeVotes, context, previous.reservationId) : [];
  const throughAt = Math.min(...after.map(s => s.at));
  if (throughAt < previous.throughAt || Math.max(...after.map(s => s.at)) - throughAt > 5) throw new Error('Health clocks disagree');
  const healthyIntervals = structuredClone(previous.healthyIntervals), pausedIntervals = structuredClone(previous.pausedIntervals);
  const candidates = after.filter(end => end.healthy && before.some(start => start.from === end.from && start.healthy &&
    end.seq === start.seq + 1 && end.at >= start.at && end.at - start.at <= maxGapSec &&
    start.position?.bootstrap === end.position?.bootstrap && start.position?.coreKey === end.position?.coreKey &&
    end.position.length >= start.position.length));
  const selected = candidates.slice(0, 3);
  const startAt = selected.length === 3 ? Math.max(previous.throughAt, ...selected.map(end => before.find(s => s.from === end.from).at)) : throughAt;
  // Views must agree at each endpoint. A lagging member causes a pause while it
  // catches up; it cannot give a smaller cutoff that falsely classifies delivery.
  const aligned = selected.length === 3 && new Set(selected.map(s => stableJSON(s.position))).size === 1;
  add(pausedIntervals, previous.throughAt, aligned ? startAt : throughAt);
  if (aligned) add(healthyIntervals, startAt, throughAt);
  return { tradeId: previous.tradeId, reservationId: previous.reservationId, seq: previous.seq + 1, prevHash: previous.hash,
    throughAt, healthyIntervals, pausedIntervals, healthDigests: [...before, ...after].map(s => s.digest),
    receiptHeads: after.slice(0, 3).map(s => s.receiptHead) };
}
