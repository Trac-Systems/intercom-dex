import { bondSchema, bondAckSchema } from './wire.js';
import { z } from 'zod';
import { stableJSON, sha256Hex } from '../core/canonical.js';
import { effectiveSettings } from './settings.js';
import { allocatePieces, penaltyTarget, usdForReset } from './amounts.js';
import { verifyCertificate } from './certificates.js';
import { reservationId } from './ledger.js';
import { stakeError } from './errors.js';

const hex = z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/), uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const units = z.string().regex(/^[1-9][0-9]{0,30}$(?![\s\S])/);
const inventorySchema = z.object({ address: z.string(), dexKey: hex, at: uint,
  pieces: z.array(z.object({ unitId: hex, generation: uint, principalReset: units, expiresAt: uint,
    purpose: z.enum(['seller', 'buyer']), state: z.string(), blocked: z.boolean() }).strict()).max(200) }).strict();

export function admissionInventory(record, owner, at, epochId) {
  return inventorySchema.parse({ address: owner.tracAddr, dexKey: owner.dexKey, at,
    pieces: Object.values(record.pieces).filter(p => p.state !== 'retired' && p.descriptor.owner.dexKey === owner.dexKey && p.descriptor.epochId === epochId)
      .map(p => ({ unitId: p.unitId, generation: p.generation, principalReset: p.descriptor.principalReset, expiresAt: p.descriptor.expiresAt,
        purpose: p.descriptor.purpose, state: p.state, blocked: !!(p.withdrawal || p.returnIntent || p.decisionVote) })).sort((a, b) => a.unitId.localeCompare(b.unitId)) });
}

export function prepareBond({ terms, policy, context, inventoryCertificate, priceCheckpoint, priceReference, priceLog, now, historyFromSlot = terms.bond?.historyFromSlot ?? 0 }) {
  if (!policy.acceptNew || now < policy.epoch.startAt || policy.epoch.stopNewAt != null && now >= policy.epoch.stopNewAt)
    throw new Error('bond_setup_unavailable');
  const current = effectiveSettings(policy, now);
  if (!current || !terms.buyer.boxKey || !terms.seller.boxKey) throw new Error('bond_setup_unavailable');
  // The signed policy covers negotiation and first acknowledgements. Historical
  // policies without this setting retain their original sixty-second limit.
  const freshSec = current.settings.admissionFreshSec ?? 60;
  const inventory = inventorySchema.parse(verifyCertificate(inventoryCertificate, context, 'admission-inventory').body);
  if (inventory.at > now || now - inventory.at > freshSec) throw stakeError('bond_stale', { retrySec: 60 });
  if (inventory.address !== terms.seller.tracAddr || inventory.dexKey !== terms.seller.dexKey ||
      new Set(inventory.pieces.map(p => p.unitId)).size !== inventory.pieces.length) throw new Error('bond_not_reserved');
  const s = current.settings, q = priceLog.verifyReference(priceReference, priceCheckpoint, now, freshSec, s.priceLookbackSec ?? 0);
  const targetReset = penaltyTarget(terms, q, s).targetReset;
  const expiresNotBefore = Math.max(terms.refundAfter, terms.sendBy + s.overdueDelaySec + s.proofWindowSec) + 600;
  const chosen = allocatePieces(inventory.pieces.filter(p => p.state === 'free' && !p.blocked && p.purpose === 'seller' && p.expiresAt > expiresNotBefore), targetReset);
  if (!chosen || BigInt(usdForReset(chosen.payoutReset, q, true)) > 200000000n) throw new Error('bond_not_reserved');
  return bondSchema.parse({ protocol: 1, policyId: current.policyId, policyDigest: sha256Hex(stableJSON(policy)), epochId: context.epoch.id,
    targetReset, payoutReset: chosen.payoutReset, payoutUsd: usdForReset(chosen.payoutReset, q, true), expiresNotBefore, historyFromSlot, overdueDelaySec: s.overdueDelaySec, proofWindowSec: s.proofWindowSec,
    pieces: chosen.pieces.map(({ unitId, generation }) => ({ unitId, generation })).sort((a, b) => a.unitId.localeCompare(b.unitId)),
    inventoryCertificate, priceCheckpoint, priceReference });
}

export function validateBond({ terms, policy, context, priceLog, now }) {
  const b = bondSchema.parse(terms.bond);
  const expected = prepareBond({ terms, policy, context, ...b, priceLog, now });
  if (stableJSON(b) !== stableJSON(expected) || terms.k !== 3 || terms.committee.length !== 4 ||
      stableJSON([...terms.committee].sort((a, b) => a.dexKey.localeCompare(b.dexKey))) !==
      stableJSON([...context.epoch.members].sort((a, b) => a.dexKey.localeCompare(b.dexKey)))) throw new Error('bond_not_reserved');
  return b;
}

export function bondReservation(terms, H) {
  const b = bondSchema.parse(terms.bond);
  return { tradeId: sha256Hex(stableJSON(terms)), H, sellerDexKey: terms.seller.dexKey,
    buyerAddress: terms.buyer.tracAddr, buyerBoxKey: terms.buyer.boxKey, policyId: b.policyId,
    targetReset: b.targetReset, payoutReset: b.payoutReset, pieces: b.pieces, expiresNotBefore: b.expiresNotBefore };
}
export function bondAck(terms, H) {
  const r = bondReservation(terms, H), b = terms.bond;
  return bondAckSchema.parse({ reservationId: reservationId(r), unitsHash: sha256Hex(stableJSON(r.pieces)),
    policyId: b.policyId, epochId: b.epochId, payoutReset: b.payoutReset });
}
export function matchingBondAck(terms, H, ack) {
  return terms.bond ? stableJSON(bondAck(terms, H)) === stableJSON(ack ?? null) : ack === undefined;
}
