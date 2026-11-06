import { z } from 'zod';
const hex = z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/), uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const units = z.string().regex(/^[1-9][0-9]{0,30}$(?![\s\S])/);
const object = z.record(z.string(), z.unknown());
export const bondSchema = z.object({ protocol: z.literal(1), policyId: hex, policyDigest: hex, epochId: hex,
  targetReset: units, payoutReset: units, payoutUsd: units, expiresNotBefore: uint, historyFromSlot: uint, overdueDelaySec: uint, proofWindowSec: uint,
  pieces: z.array(z.object({ unitId: hex, generation: uint }).strict()).min(1).max(100),
  inventoryCertificate: z.array(object).min(3).max(4), priceCheckpoint: object, priceReference: object }).strict();
export const bondAckSchema = z.object({ reservationId: hex, unitsHash: hex, policyId: hex, epochId: hex, payoutReset: units }).strict();
