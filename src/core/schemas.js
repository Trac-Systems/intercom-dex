import { z } from 'zod';
import { lockProofSchema } from './lock-certificate.js';
import { isTracAddress, isSolanaAddress } from './addresses.js';
import { softwareSchema } from './software.js';
import { addressProofSchema } from './address-proof.js';

export const hexKey = z.string().length(64).regex(/^[0-9a-f]{64}$/);
export const amount = z.string().regex(/^(0|[1-9][0-9]{0,30})$(?![\s\S])/);
export const price = z.string().regex(/^(0|[1-9][0-9]{0,30})(\.[0-9]{1,12})?$(?![\s\S])/);
export const tracAddress = z.string().refine(isTracAddress, 'Invalid Trac checksum');
export const solanaAddress = z.string().refine(isSolanaAddress, 'Invalid Solana public key');
const uint = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const chatText = z.string().regex(/^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]*$(?![\s\S])/, 'Chat must be a single line without control characters');
const trimmedChatText = chatText.trim().min(1).refine(text => [...text].length <= 280, 'Chat must be at most 280 characters');
// Names that would pass a message off as the venue or the software are reserved, also inside other words or split up.
const RESERVED_CHAT_NAMES = ['venue', 'system', 'admin', 'exchange', 'intercom', 'official', 'moderator', 'support'];
export const chatNameReserved = name => RESERVED_CHAT_NAMES.some(word => name.toLowerCase().replace(/[ ._-]/g, '').includes(word));
export const chatInputSchema = z.object({ text: trimmedChatText,
  name: z.string().min(1).max(24).regex(/^[A-Za-z0-9 ._-]+$(?![\s\S])/).refine(name => !chatNameReserved(name), 'This chat name is reserved').optional() }).strict();
export const chatSinceSchema = uint;
const positive = amount.refine(v => BigInt(v) > 0n, 'Amount must be positive');
export const assetIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$(?![\s\S])/);
export const pairSchema = z.string().min(6).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*\/USDC$(?![\s\S])/);
const pair = pairSchema;
export const baseSchema = z.object({ kind: assetIdSchema, id: assetIdSchema, decimals: uint.max(30) }).strict();
export const pairEntrySchema = z.object({ pair, base: baseSchema, minBaseAmount: positive, status: z.enum(['open', 'paused']) }).strict();
const solSignature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$(?![\s\S])/);
// Registry texts are printable ASCII without quotes or backslashes, so their serialized size is exactly their length.
const plainText = max => z.string().min(1).max(max).regex(/^[ !#-\[\]-~]+$/);
const reason = plainText(160);
const tracParticipant = { dexKey: hexKey, tracAddr: tracAddress, tracProof: addressProofSchema.optional() };
const participant = z.object({ ...tracParticipant, solAddr: solanaAddress }).strict();
const member = z.object({ dexKey: hexKey, boxKey: hexKey }).strict();
const signer = member.extend({ label: plainText(80), limitUsdc: amount, status: z.enum(['active', 'inactive']),
  assets: z.array(assetIdSchema).min(1).max(64).refine(a => new Set(a).size === a.length), software: softwareSchema, relayKey: hexKey.optional() }).strict();
export const feesSchema = z.object({
  platformFeeBps: uint.max(500), tradeFeeBps: uint.max(1000), signerShareBps: uint.max(10000),
  collector: solanaAddress, platformCollector: solanaAddress,
}).strict().refine(f => f.tradeFeeBps + f.platformFeeBps <= 1500, 'Total fees exceed limit');
export const termsSchema = z.object({
  offerId: hexKey, pair, base: baseSchema, baseAmount: positive, quoteAmount: positive, mint: solanaAddress,
  seller: z.object({ ...tracParticipant, solRecipient: solanaAddress }).strict(),
  buyer: z.object({ ...tracParticipant, solPayer: solanaAddress }).strict(),
  registryVersion: uint.min(1), committee: z.array(member).min(1).max(16), k: uint.min(1).max(16),
  fees: feesSchema, sendBy: uint, refundAfter: uint, graceSec: uint,
  R: hexKey,
}).strict().superRefine((t, ctx) => {
  const bad = message => ctx.addIssue({ code: 'custom', message });
  if (t.k > t.committee.length) bad('k exceeds n');
  if (t.refundAfter - t.sendBy - t.graceSec < 600) bad('Claim buffer must be at least 600 seconds');
  if (t.seller.dexKey === t.buyer.dexKey) bad('Identical traders');
  if (new Set(t.committee.map(s => s.dexKey)).size !== t.committee.length ||
      new Set(t.committee.map(s => s.boxKey)).size !== t.committee.length) bad('Duplicate committee member');
  if (t.committee.some(s => [t.seller.dexKey, t.buyer.dexKey].includes(s.dexKey))) bad('Trader in committee');
});
export const registrySchema = z.object({
  version: uint.min(1), issuedAt: uint, minSoftware: softwareSchema,
  serviceRelayKey: hexKey.optional(),
  pairs: z.array(pairEntrySchema).min(1).max(64),
  params: z.object({ n: uint.min(1).max(16), k: uint.min(1).max(16),
    sendWindowSec: uint.min(300), refundSec: uint.min(1), graceSec: uint }).strict(),
  fee: z.object({ platformFeeBps: uint.max(500), tradeFeeBps: uint.max(1000), collector: solanaAddress, signerShareBps: uint.max(10000) })
    .strict().refine(f => f.platformFeeBps + f.tradeFeeBps <= 1500, 'Total fees exceed limit'),
  signers: z.array(signer).max(128),
  removed: z.array(z.object({ dexKey: hexKey, removedAt: uint, reason }).strict()).max(256),
}).strict().superRefine((r, ctx) => {
  const bad = message => ctx.addIssue({ code: 'custom', message });
  if (new Set(r.pairs.map(p => p.pair)).size !== r.pairs.length) bad('Duplicate pair');
  const assets = new Map();
  for (const p of r.pairs) {
    const definition = `${p.base.kind}:${p.base.decimals}`;
    if (assets.has(p.base.id) && assets.get(p.base.id) !== definition) bad('Conflicting asset definition');
    assets.set(p.base.id, definition);
  }
  // Fits one transport message (200 KB) with room for the envelope.
  if (JSON.stringify(r).length > 150000) bad('Registry exceeds the channel size budget');
  if (r.params.k > r.params.n) bad('k exceeds n');
  if (r.params.refundSec - r.params.sendWindowSec - r.params.graceSec < 600) bad('Claim buffer must be at least 600 seconds');
  if (new Set(r.signers.map(s => s.dexKey)).size !== r.signers.length ||
      new Set(r.signers.map(s => s.boxKey)).size !== r.signers.length) bad('Duplicate signer');
  if (new Set(r.removed.map(s => s.dexKey)).size !== r.removed.length) bad('Duplicate removal');
  if (r.signers.some(s => r.removed.some(x => x.dexKey === s.dexKey))) bad('Removed signer still present');
});
export const sealedBoxSchema = z.object({ ephemeralKey: hexKey, nonce: z.string().length(48).regex(/^[0-9a-f]{48}$/),
  ciphertext: z.string().length(96).regex(/^[0-9a-f]{96}$/) }).strict();
export const dealSchema = z.object({ tradeId: hexKey, k: uint.min(1).max(16),
  committeeBoxKeys: z.array(hexKey).min(1).max(16), H: hexKey,
  commitments: z.array(hexKey).min(1).max(16), sealedShares: z.array(sealedBoxSchema).min(1).max(16),
  proof: lockProofSchema,
}).strict().superRefine((d, ctx) => {
  const bad = message => ctx.addIssue({ code: 'custom', message });
  if (d.k > d.committeeBoxKeys.length || d.commitments.length !== d.k ||
      d.sealedShares.length !== d.committeeBoxKeys.length) bad('Invalid dealing dimensions');
  if (new Set(d.committeeBoxKeys).size !== d.committeeBoxKeys.length) bad('Duplicate box key');
});
const offer = z.object({ offerId: hexKey, pair, side: z.enum(['buy', 'sell']), baseAmount: positive,
  price, maker: participant, peerKey: hexKey, expiresAt: uint, registryVersion: uint.min(1), software: softwareSchema }).strict();
const bookRemaining = z.array(z.object({ offerId: hexKey, amount }).strict()).max(200)
  .refine(rows => new Set(rows.map(o => o.offerId)).size === rows.length);
const publicParty = z.object({ tracAddr: tracAddress, solAddr: solanaAddress }).strict();
const levelKey = z.object({ side: z.enum(['buy', 'sell']), price }).strict();
const level = levelKey.extend({ baseAmount: z.string().regex(/^(0|[1-9][0-9]{0,46})$(?![\s\S])/), offers: uint.min(1) }).strict();
const levels = z.array(level).max(100).refine(a => ['buy', 'sell'].every(side => a.filter(l => l.side === side).length <= 50) &&
  new Set(a.map(l => `${l.side}:${l.price}`)).size === a.length, 'Invalid book levels');
export const bodySchemas = Object.freeze({
  chat: chatInputSchema.extend({ text: chatText.min(1).refine(text => text === text.trim() && [...text].length <= 280), ts: uint }).strict(),
  offer,
  cancel: z.object({ offerId: hexKey }).strict(),
  take: z.object({ offerId: hexKey, pair, registryVersion: uint.min(1), software: softwareSchema, baseAmount: positive, taker: participant, commitment: hexKey, sendBy: uint, refundAfter: uint }).strict(),
  settled: z.object({ offerId: hexKey, tradeId: hexKey, terms: termsSchema, hashHex: hexKey, claimSignature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/).optional(), txHash: hexKey }).strict(),
  accept: z.object({ offerId: hexKey, takeCommitment: hexKey, commitment: hexKey, slot: uint.max(Number.MAX_SAFE_INTEGER - 32) }).strict(),
  decline: z.object({ offerId: hexKey, takeNonce: hexKey, reason: z.enum(['busy', 'insufficient', 'signers', 'expired', 'invalid', 'version', 'reset-gateway']) }).strict(),
  commit: z.object({ offerId: hexKey, commitment: hexKey }).strict(),
  reveal: z.object({ offerId: hexKey, takeCommitment: hexKey, nonce: hexKey }).strict(),
  present: z.object({ ref: hexKey }).strict(),
  summon: z.object({ tradeId: hexKey, terms: termsSchema, sigs: z.array(z.record(z.string(), z.unknown())).length(2) }).strict(),
  terms: z.object({ tradeId: hexKey, terms: termsSchema }).strict(),
  termsSig: z.object({ tradeId: hexKey }).strict(),
  working: z.object({ tradeId: hexKey, step: z.literal('certificate') }).strict(),
  deal: dealSchema,
  ack: z.object({ tradeId: hexKey, H: hexKey, holdUntil: uint }).strict(),
  refused: z.object({ tradeId: hexKey, reason: z.enum(['seller-funds', 'seller-struck', 'buyer-struck']) }).strict(),
  transferSent: z.object({ tradeId: hexKey, txHash: hexKey }).strict(),
  sharePublish: z.object({ tradeId: hexKey, H: hexKey, signerIndex: uint.min(1).max(16), share: hexKey,
    commitments: z.array(hexKey).min(1).max(16) }).strict(),
  shareRequest: z.object({ tradeId: hexKey }).strict(),
  claimed: z.object({ tradeId: hexKey, claimSignature: solSignature }).strict(),
  refunded: z.object({ tradeId: hexKey, refundSignature: solSignature }).strict(),
  abort: z.object({ tradeId: hexKey, commitment: hexKey.optional(), reason }).strict(),
  registry: registrySchema,
  book: z.object({ pair, registryVersion: uint.min(1), ts: uint, seq: uint.min(1), levels, remaining: bookRemaining.optional() }).strict(),
  bookDelta: z.object({ pair, seq: uint.min(1), upserts: levels, removes: z.array(levelKey).max(100) }).strict(),
  ticker: z.object({ pair, registryVersion: uint.min(1), ts: uint, last: price, volume24h: amount, high24h: price, low24h: price, trades24h: uint }).strict(),
  tradeLog: z.object({ tradeId: hexKey, pair, price, seller: publicParty, buyer: publicParty, registryVersion: uint.min(1), baseAmount: positive, quoteAmount: positive, ts: uint,
    termsHash: hexKey, escrowAddress: solanaAddress, claimSignature: solSignature, tracTxHash: hexKey }).strict(),
  heartbeat: z.object({ registryVersion: uint.min(1), software: softwareSchema, status: z.enum(['online', 'offline']), holdCount: uint }).strict(),
  status: z.object({ status: z.enum(['online', 'degraded', 'offline']), software: softwareSchema, ts: uint, message: z.string().max(512),
    latest: z.object({ version: softwareSchema, commit: z.string().regex(/^[0-9a-f]{40}$(?![\s\S])/), sha256: hexKey }).strict().optional() }).strict(),
});

export function parseBody(kind, body) {
  if (!Object.hasOwn(bodySchemas, kind)) throw new TypeError('Unknown message kind');
  return bodySchemas[kind].parse(body);
}
