import { z } from 'zod';
import { isTracAddress } from '../core/addresses.js';
import { sha256Hex, stableJSON } from '../core/canonical.js';
import { settingsSchema } from './settings.js';
import { allocatePieces, usdForReset } from './amounts.js';
import { verifyCertificate, factDigest } from './certificates.js';

const hex = z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/);
const uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const units = z.string().regex(/^[1-9][0-9]{0,30}$(?![\s\S])/);
const descriptorSchema = z.object({ networkId: uint, venueKey: hex, epochId: hex, batchId: hex, nonce: hex,
  owner: z.object({ dexKey: hex, tracAddr: z.string().refine(a => a === a.toLowerCase() && isTracAddress(a)), boxKey: hex }).strict(),
  purpose: z.enum(['seller', 'buyer']), principalReset: units, tnkReserve: units,
  createdAt: uint, expiresAt: uint, replacementOf: hex.optional(), lineageIds: z.array(hex).min(1).max(100).optional()
}).strict().refine(d => d.expiresAt > d.createdAt, 'Invalid stake expiry');
const references = z.array(z.object({ unitId: hex, generation: uint }).strict()).min(1).max(100)
  .refine(a => a.every((p, i) => !i || p.unitId > a[i - 1].unitId), 'Piece references must be sorted and unique');
const reservationSchema = z.object({ tradeId: hex, H: hex, sellerDexKey: hex, buyerAddress: z.string().refine(isTracAddress),
  buyerBoxKey: hex, policyId: hex, targetReset: units, payoutReset: units, pieces: references, expiresNotBefore: uint }).strict();
export const terminalDecisionSchema = z.object({ decisionId: hex, outcome: z.enum(['buyer-no-show', 'seller-withdraw', 'seller-expiry', 'seller-unfunded']),
  pieces: references, reservationId: hex.optional(), at: uint, winnerAddress: z.string().refine(isTracAddress), winnerBoxKey: hex,
  evidenceDigest: hex, replacement: z.object({ operationId: hex, withdrawReset: units, tnkLimit: units,
    descriptors: z.array(descriptorSchema).min(1).max(100) }).strict().optional() }).strict();

export function unitId(descriptor) { return sha256Hex('intercom-dex/stake/v1/unit\n' + stableJSON(descriptorSchema.parse(descriptor))); }
export function reservationId(input) { return sha256Hex('intercom-dex/stake/v1/reservation\n' + stableJSON(reservationSchema.parse(input))); }

// One address record owns all mutations. put() must be synchronous, atomic and fsynced (roles/store.js).
// Chain checks and allocation preparation happen before entry; no await separates a conflict check and commit.
export class StakeLedger {
  constructor({ store, context, address }) {
    if (!store?.get || !store?.put || !isTracAddress(address)) throw new Error('Stake ledger requires a durable store and account address');
    this.store = store; this.context = structuredClone(context); this.address = address.toLowerCase();
    this.name = 'stake-ledger-' + sha256Hex(stableJSON({ networkId: context.networkId, venueKey: context.venueKey, address: this.address }));
  }
  read() { return this.store.get(this.name) ?? { v: 1, sequence: 0, pieces: {}, reservations: {}, withdrawals: {}, decisions: {} }; }
  save(record) { record.sequence++; this.store.put(this.name, record); }
  fact(certificate, kind) { return verifyCertificate(certificate, this.context, kind); }

  admitFunded(certificate, { settings, price, now }) {
    uint.parse(now); const policy = settingsSchema.parse(settings), fact = this.fact(certificate, 'funded');
    const b = z.object({ descriptor: descriptorSchema, unitId: hex, address: z.string().refine(isTracAddress), fundingDigest: hex }).strict().parse(fact.body);
    const d = b.descriptor;
    if (unitId(d) !== b.unitId || d.owner.tracAddr !== this.address || d.networkId !== fact.networkId || d.venueKey !== fact.venueKey ||
        d.epochId !== fact.epochId || d.expiresAt <= now || d.createdAt > now) throw new Error('Invalid funded stake binding');
    const record = this.read(), prior = record.pieces[b.unitId];
    if (prior) {
      if (prior.fundingHash !== factDigest(fact)) throw new Error('Conflicting stake funding');
      return structuredClone(prior);
    }
    const active = Object.values(record.pieces).filter(p => p.state !== 'retired');
    if (active.length >= 200 || Object.values(record.pieces).some(p => p.address === b.address)) throw new Error('bond_setup_unavailable');
    const exposureUsd = usdForReset(d.principalReset, price, true);
    const held = active.reduce((n, p) => n + BigInt(p.exposureUsd), 0n);
    const marked = active.reduce((n, p) => n + BigInt(usdForReset(p.descriptor.principalReset, price, true)), 0n);
    if (held + BigInt(exposureUsd) > BigInt(policy.stake.maxUsdPerAddress) || marked + BigInt(exposureUsd) > BigInt(policy.stake.maxUsdPerAddress)) throw new Error('bond_setup_unavailable');
    record.pieces[b.unitId] = { unitId: b.unitId, descriptor: d, address: b.address, exposureUsd, generation: 0, state: 'free',
      fundingHash: factDigest(fact), fundingCertificate: certificate };
    this.save(record); return structuredClone(record.pieces[b.unitId]);
  }

  admitRefund(certificate) {
    const fact = this.fact(certificate, 'funding-refund');
    const b = z.object({ descriptor: descriptorSchema, unitId: hex, address: z.string().refine(isTracAddress),
      returnReset: z.string().regex(/^(0|[1-9][0-9]{0,30})$/), exposureUsd: units }).strict().parse(fact.body);
    const d = b.descriptor, record = this.read(), prior = record.pieces[b.unitId];
    if (unitId(d) !== b.unitId || d.owner.tracAddr !== this.address || d.epochId !== fact.epochId ||
        d.networkId !== fact.networkId || d.venueKey !== fact.venueKey) throw new Error('Invalid funding refund scope');
    if (prior) {
      if (prior.refundHash !== factDigest(fact)) throw new Error('Funding refund conflicts with admitted stake');
      return prior;
    }
    record.pieces[b.unitId] = { unitId: b.unitId, descriptor: d, address: b.address, exposureUsd: b.exposureUsd,
      generation: 0, state: 'funding-return', returnReset: b.returnReset, refundHash: factDigest(fact), refundCertificate: certificate };
    this.save(record); return record.pieces[b.unitId];
  }

  reserve(input, admission = null) {
    const r = reservationSchema.parse(input), id = reservationId(r), record = this.read();
    if (record.reservations[id]) {
      if (record.reservations[id].state !== 'reserved') throw new Error('bond_not_reserved');
      return structuredClone(record.reservations[id]);
    }
    if (Object.values(record.reservations).some(x => x.body.tradeId === r.tradeId)) throw new Error('Conflicting reservation for trade');
    if (Object.values(record.reservations).filter(r => r.state === 'reserved').length >= 8) throw new Error('bond_setup_unavailable');
    const eligible = Object.values(record.pieces).filter(p => p.state === 'free' && !p.withdrawal && !p.returnIntent && !p.decisionVote && p.descriptor.purpose === 'seller' &&
      p.descriptor.owner.dexKey === r.sellerDexKey && p.descriptor.epochId === this.context.epoch.id && p.descriptor.expiresAt > r.expiresNotBefore)
      .map(p => ({ unitId: p.unitId, principalReset: p.descriptor.principalReset, expiresAt: p.descriptor.expiresAt, generation: p.generation }));
    const allocation = allocatePieces(eligible, r.targetReset);
    const chosen = allocation?.pieces.map(({ unitId, generation }) => ({ unitId, generation })).sort((a, b) => a.unitId.localeCompare(b.unitId));
    if (!allocation || allocation.payoutReset !== r.payoutReset || stableJSON(chosen) !== stableJSON(r.pieces)) throw new Error('bond_not_reserved');
    for (const ref of r.pieces) {
      const p = record.pieces[ref.unitId]; p.state = 'reserved'; p.reservationId = id;
    }
    record.reservations[id] = { reservationId: id, body: r, state: 'reserved', ...(admission ? { admission: structuredClone(admission) } : {}) };
    this.save(record); return structuredClone(record.reservations[id]);
  }

  resolve(certificate) {
    const fact = this.fact(certificate, 'resolved');
    const b = z.object({ reservationId: hex, outcome: z.enum(['delivered', 'unfunded']), evidenceDigest: hex, pieces: references }).strict().parse(fact.body);
    const record = this.read(), r = record.reservations[b.reservationId];
    if (!r || stableJSON(r.body.pieces) !== stableJSON(b.pieces)) throw new Error('Unknown reservation closure');
    if (r.state !== 'reserved') {
      if (r.closureHash === factDigest(fact)) return r;
      throw new Error('Conflicting reservation closure');
    }
    for (const ref of b.pieces) {
      const p = record.pieces[ref.unitId];
      if (p.state !== 'reserved' || p.reservationId !== b.reservationId || p.generation !== ref.generation) throw new Error('Stake generation conflict');
      p.generation++; p.state = 'free'; delete p.reservationId; delete p.decisionVote;
    }
    r.state = b.outcome; r.closureHash = factDigest(fact); r.closureCertificate = certificate;
    this.save(record); return structuredClone(r);
  }

  deliveryIntent(id, { txHash, evidenceDigest, share = false }) {
    hex.parse(txHash); hex.parse(evidenceDigest);
    const record = this.read(), r = record.reservations[id];
    if (!r || r.state !== 'reserved' || r.body.pieces.some(ref => record.pieces[ref.unitId].decisionVote)) throw new Error('Penalty vote blocks settlement');
    if (r.delivery && r.delivery.txHash !== txHash) throw new Error('Conflicting delivery');
    r.delivery ??= { txHash, evidenceDigest };
    if (share) r.shareIntent = { txHash, evidenceDigest };
    this.save(record); return structuredClone(r.delivery);
  }

  closureIntent(id, body) {
    const record = this.read(), r = record.reservations[id], digest = sha256Hex(stableJSON(body));
    if (!r || r.state !== 'reserved' || r.body.pieces.some(ref => record.pieces[ref.unitId].decisionVote) ||
        r.closureVote && r.closureVote !== digest) throw new Error('Conflicting closure vote');
    r.closureVote = digest; this.save(record);
  }

  prepareFreeze(input) {
    const b = z.object({ operationId: hex, pieces: references, acceptedAt: uint }).strict().parse(input), record = this.read();
    const prior = record.freezeVotes?.[b.operationId];
    if (prior) {
      if (stableJSON(prior.pieces) !== stableJSON(b.pieces)) throw new Error('Withdrawal operation reused');
      return structuredClone(prior);
    }
    for (const ref of b.pieces) {
      const p = record.pieces[ref.unitId];
      if (!p || p.state !== 'free' || p.generation !== ref.generation || p.withdrawal || p.decisionVote ||
          p.returnIntent && p.returnIntent !== b.operationId) throw new Error('bond_reserved');
    }
    for (const ref of b.pieces) { const p = record.pieces[ref.unitId]; p.state = 'withdrawing'; p.withdrawal = b.operationId; }
    (record.freezeVotes ??= {})[b.operationId] = b;
    this.save(record); return structuredClone(b);
  }

  requestWithdrawal({ operationId, unitIds }) {
    hex.parse(operationId); z.array(hex).min(1).max(100).parse(unitIds);
    if (new Set(unitIds).size !== unitIds.length) throw new Error('Duplicate withdrawal intent');
    const record = this.read();
    for (const id of unitIds) {
      const p = record.pieces[id];
      if (!p || p.descriptor.epochId !== this.context.epoch.id || p.returnIntent && p.returnIntent !== operationId ||
          p.withdrawal && p.withdrawal !== operationId) throw new Error('Conflicting withdrawal intent');
    }
    for (const id of unitIds) record.pieces[id].returnIntent = operationId;
    this.save(record); return { operationId, unitIds };
  }

  freeze(certificate, settings) {
    const delay = settingsSchema.parse(settings).stake.withdrawDelaySec, fact = this.fact(certificate, 'freeze');
    const b = z.object({ operationId: hex, pieces: references, acceptedAt: uint, withdrawDelaySec: uint }).strict().parse(fact.body);
    if (b.withdrawDelaySec !== delay) throw new Error('Withdrawal delay differs from signed policy');
    const record = this.read(), prior = record.withdrawals[b.operationId];
    if (prior) { if (prior.hash !== factDigest(fact)) throw new Error('Withdrawal operation reused'); return prior; }
    for (const ref of b.pieces) {
      const p = record.pieces[ref.unitId];
      if (!p || p.generation !== ref.generation || p.decisionVote ||
          !(p.state === 'free' && !p.withdrawal || p.state === 'withdrawing' && p.withdrawal === b.operationId &&
            record.freezeVotes?.[b.operationId]?.acceptedAt <= b.acceptedAt)) throw new Error('bond_reserved');
    }
    const availableAt = b.acceptedAt + delay; uint.parse(availableAt);
    for (const ref of b.pieces) { const p = record.pieces[ref.unitId]; p.state = 'withdrawing'; p.withdrawal = b.operationId; p.availableAt = availableAt; }
    record.withdrawals[b.operationId] = { ...b, availableAt, hash: factDigest(fact), certificate };
    this.save(record); return structuredClone(record.withdrawals[b.operationId]);
  }

  validateDecision(input, record = this.read()) {
    const b = terminalDecisionSchema.parse(input);
    if (b.replacement) {
      if (b.outcome !== 'seller-withdraw') throw new Error('Only a matured withdrawal can replace surplus');
      const sources = b.pieces.map(ref => record.pieces[ref.unitId]);
      if (sources.some(p => !p)) throw new Error('Replacement sources unavailable');
      const total = sources.reduce((n, p) => n + BigInt(p.descriptor.principalReset), 0n);
      const expiry = Math.min(...sources.map(p => p.descriptor.expiresAt));
      const lineages = [...new Set(sources.flatMap(p => p.descriptor.lineageIds ?? [p.descriptor.batchId]))].sort();
      const replacements = b.replacement.descriptors;
      if (new Set(replacements.map(unitId)).size !== replacements.length ||
          replacements.reduce((n, d) => n + BigInt(d.principalReset), BigInt(b.replacement.withdrawReset)) !== total ||
          replacements.some(d => d.replacementOf !== b.replacement.operationId || d.epochId !== this.context.epoch.id ||
            d.networkId !== this.context.networkId || d.venueKey !== this.context.venueKey || d.createdAt !== b.at ||
            d.expiresAt > expiry || d.owner.tracAddr !== this.address || d.owner.boxKey !== b.winnerBoxKey ||
            sources.some(p => p.descriptor.owner.dexKey !== d.owner.dexKey || p.descriptor.purpose !== d.purpose) ||
            stableJSON(d.lineageIds) !== stableJSON(lineages))) throw new Error('Invalid exact withdrawal replacement plan');
    }
    for (const ref of b.pieces) {
      const p = record.pieces[ref.unitId];
      if (!p || p.generation !== ref.generation || p.decisionId) throw new Error('Terminal stake generation');
      if (b.outcome === 'buyer-no-show') {
        const r = record.reservations[b.reservationId];
        if (!r || r.state !== 'reserved' || r.delivery || r.shareIntent || r.closureVote || p.state !== 'reserved' || p.descriptor.purpose !== 'seller' || p.reservationId !== b.reservationId ||
            stableJSON(r.body.pieces) !== stableJSON(b.pieces) || b.winnerAddress !== r.body.buyerAddress || b.winnerBoxKey !== r.body.buyerBoxKey) throw new Error('Invalid penalty reservation');
      } else {
        if (b.reservationId || b.winnerAddress !== p.descriptor.owner.tracAddr || b.winnerBoxKey !== p.descriptor.owner.boxKey) throw new Error('Invalid return winner');
        if (b.outcome === 'seller-unfunded' ? p.state !== 'funding-return' || !p.refundCertificate :
          b.outcome === 'seller-withdraw' ? p.state !== 'withdrawing' || !Number.isSafeInteger(p.availableAt) || b.at < p.availableAt :
          !['free', 'withdrawing'].includes(p.state) || b.at < p.descriptor.expiresAt) throw new Error('bond_cooldown');
      }
    }
    return b;
  }

  prepareDecision(input) {
    const record = this.read(), b = this.validateDecision(input, record), digest = sha256Hex(stableJSON(b));
    for (const ref of b.pieces) if (record.pieces[ref.unitId].decisionVote && record.pieces[ref.unitId].decisionVote !== digest)
      throw new Error('Conflicting terminal vote');
    for (const ref of b.pieces) record.pieces[ref.unitId].decisionVote = digest;
    (record.decisionVotes ??= {})[digest] = b;
    this.save(record); return structuredClone(b);
  }

  decide(certificate) {
    const fact = this.fact(certificate, 'decision'), record = this.read(), b = terminalDecisionSchema.parse(fact.body);
    if (record.decisions[b.decisionId]) {
      if (record.decisions[b.decisionId].hash !== factDigest(fact)) throw new Error('Decision id reused');
      return record.decisions[b.decisionId];
    }
    this.validateDecision(b, record);
    for (const ref of b.pieces) { const p = record.pieces[ref.unitId]; p.state = b.outcome === 'buyer-no-show' ? 'decided-buyer' : 'decided-seller'; p.decisionId = b.decisionId; }
    if (b.reservationId) record.reservations[b.reservationId].state = 'decided';
    record.decisions[b.decisionId] = { ...b, hash: factDigest(fact), certificate };
    this.save(record); return structuredClone(record.decisions[b.decisionId]);
  }

  collected(certificate) {
    const fact = this.fact(certificate, 'collected');
    const b = z.object({ unitId: hex, generation: uint, decisionId: hex, txHash: hex.nullable(), asset: z.literal('TNK').optional() }).strict().parse(fact.body);
    const record = this.read(), p = record.pieces[b.unitId];
    if (!p || p.generation !== b.generation || p.decisionId !== b.decisionId || !record.decisions[b.decisionId]) throw new Error('Unknown stake collection');
    if ((b.asset || b.txHash === null) && (!p.refundCertificate || p.returnReset !== '0')) throw new Error('Principal collection requires RESET finality');
    if (p.collectionHash) { if (p.collectionHash !== factDigest(fact)) throw new Error('Conflicting collection'); return p; }
    p.state = 'retired'; p.collectionHash = factDigest(fact); p.collectionCertificate = certificate;
    this.save(record); return structuredClone(p);
  }
}
