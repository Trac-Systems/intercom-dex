import { z } from 'zod';
import { signFact, verifyFact } from './certificates.js';
import { stableJSON, sha256Hex } from '../core/canonical.js';
import { deliveryExcusesPenalty } from './proof-clock.js';

const uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hex = z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/);
const transferSchema = z.object({ tradeId: hex, txHash: hex, from: z.string().min(1), to: z.string().min(1),
  asset: z.enum(['RESET', 'TNK']), amount: z.string().regex(/^[1-9][0-9]*$(?![\s\S])/), nonce: hex,
  networkId: uint }).strict();
const observationSchema = transferSchema.extend({ observedBy: uint, clockSlot: uint }).strict();

// This is a quorum-attested observation, not historical Trac time. The wall clock
// is rounded up after verification; a lagging finalized clock cannot backdate it.
export class DeliveryObserver {
  constructor({ store, context, identity, verify, clock, now = () => Math.ceil(Date.now() / 1000) }) {
    Object.assign(this, { store, context, identity, verify, clock, now }); this.queue = Promise.resolve();
  }
  observe(input) {
    const work = this.queue.then(async () => {
      const transfer = transferSchema.parse(input), c = this.context;
      if (transfer.networkId !== c.networkId || !c.epoch.members.some(m => m.dexKey === this.identity.publicKey)) throw new Error('Wrong delivery observer');
      const name = `stake-delivery-observation-${sha256Hex(stableJSON({ ...transfer, epochId: c.epoch.id, venueKey: c.venueKey }))}`;
      const old = this.store.get(name); if (old) return old;
      const proof = await this.verify(transfer);
      if (proof?.ok !== true || proof.final !== true || proof.amount !== transfer.amount) throw new Error('Exact final delivery is required');
      const clock = await this.clock(), localAt = uint.parse(this.now());
      if (!uint.safeParse(clock.at).success || Math.abs(localAt - clock.at) > 60) throw new Error('Delivery observation clocks disagree');
      const body = observationSchema.parse({ ...transfer, observedBy: Math.max(localAt, clock.at), clockSlot: clock.slot });
      const vote = signFact({ v: 1, networkId: c.networkId, venueKey: c.venueKey, epochId: c.epoch.id, kind: 'delivery-observed', body }, this.identity.secretKey);
      const concurrent = this.store.get(name); if (concurrent) return concurrent;
      this.store.put(name, vote); return vote;
    }); this.queue = work.catch(() => {}); return work;
  }
}

// Unresolved is deliberately distinct from late. No caller may turn a missing
// historical timestamp, failed read or post-cutoff observation into an award.
export function deliveryPenaltyEvidence({ expected, proof, observations = [], context, sendBy, overdueDelaySec, clock }) {
  uint.parse(sendBy); uint.parse(overdueDelaySec); const cutoff = uint.parse(sendBy + overdueDelaySec);
  const exact = transferSchema.parse(expected);
  if (proof?.status === 'delivered' && proof.finalizedTimeVerified === true &&
      uint.safeParse(proof.finalizedTime).success && hex.safeParse(proof.evidenceDigest).success &&
      Object.keys(exact).every(k => proof[k] === exact[k])) {
    return deliveryExcusesPenalty({ expected: exact, proof, sendBy, overdueDelaySec, clock }) ?
      { state: 'excused', basis: 'historical_finality' } : { state: 'late', basis: 'historical_finality' };
  }
  if (!Array.isArray(observations) || observations.length > 4) throw new Error('Invalid delivery observations');
  const seen = new Set();
  for (const vote of observations) {
    try {
      if (!context.epoch.members.some(m => m.dexKey === vote.from) || seen.has(vote.from)) continue;
      const b = observationSchema.parse(verifyFact(vote, context, 'delivery-observed', vote.from).body);
      if (Object.keys(exact).every(k => b[k] === exact[k]) && b.observedBy <= cutoff) seen.add(vote.from);
    } catch { /* Invalid evidence contributes no observation. */ }
  }
  if (context?.epoch.n === 4 && context.epoch.k === 3 && context.epoch.maxFaulty === 1 &&
      context.epoch.members.length === 4 && new Set(context.epoch.members.map(m => m.dexKey)).size === 4 && seen.size >= 3)
    return { state: 'excused', basis: 'quorum_finality_upper_bound' };
  return { state: 'unresolved', reason: 'historical_delivery_time_unavailable' };
}
