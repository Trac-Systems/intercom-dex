import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { z } from 'zod';
import { hexToBytes, bytesToHex, stableJSON, utf8 } from '../core/canonical.js';
import { createReplayCache } from '../core/envelope.js';
import { registrySchema } from './registry.js';

export const MAIN = 'intercom-locks', SOFTWARE = '0.2.0', HEARTBEAT_MS = 30000;
export const POW_CLASSES = [['heartbeat', 'registry', 'book', 'bookRequest', 'release', 'releaseRequest', 'dkgFail', 'lockReady', 'paid', 'opened'], ['dkgDeal', 'funded', 'take', 'reserve', 'cancel']];
const hex = z.string().regex(/^[0-9a-f]{64}$/), int = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), j = int.min(1).max(16);
export const partySchema = z.object({ lockKey: hex, boxKey: hex, trac: z.string().min(8).max(100), sol: z.string().min(32).max(44) }).strict();
const box = z.object({ ephemeralKey: hex, nonce: z.string().regex(/^[0-9a-f]{48}$/), ciphertext: z.string().regex(/^[0-9a-f]{96}$/) }).strict();
const ref = { positionId: hex }, attempt = { takeId: hex.optional() }, qualified = z.array(j).min(1).max(16), lock = { A: hex, C: z.array(hex).min(1).max(16), chain: z.enum(['trac', 'solana']), address: z.string().max(100) };
const step = z.string().regex(/^(repay|exercise|open:[0-9a-f]{64})$/), winner = z.enum(['maker', 'taker']);
const outcome = z.enum(['repaid', 'defaulted', 'exercised', 'expired', 'cancelled', 'unfunded']);
const object = shape => z.object(shape).strict();
export const bodySchemas = {
  registry: registrySchema,
  heartbeat: object({ registryVersion: int, software: z.string().max(32), status: z.enum(['online', 'offline']), holdCount: int.max(2000) }),
  lockRequest: object({ ...ref, post: z.record(z.string(), z.unknown()) }),
  posted: object({ ...ref, post: z.record(z.string(), z.unknown()), ...lock, Q: qualified, j, registryVersion: int.positive() }),
  dkgDeal: object({ ...ref, ...attempt, i: j, commitments: lock.C, sealed: z.array(box).min(1).max(16) }),
  dkgFail: object({ ...ref, ...attempt, i: j, reason: z.string().max(256) }),
  lockReady: object({ ...ref, ...attempt, Q: qualified, j, ...lock }),
  funded: object({ ...ref, ...attempt, escrow: z.record(z.string(), z.unknown()).optional() }),
  take: object({ ...ref, takeId: hex, taker: partySchema, takeAnchor: int.optional() }),
  reserve: object({ ...ref, takeId: hex, takerKey: hex, expiresAt: int }),
  paid: object({ ...ref, step, signature: z.string().min(32).max(128) }),
  opened: object({ ...ref, takeId: hex, taker: partySchema, takeAnchor: int.optional(), dueBlock: int.optional(), holderLock: object({ ...lock, Q: qualified }).optional(), j }),
  cancel: object(ref),
  release: object({ ...ref, ...attempt, j, winner, outcome, A: hex, C: lock.C, sealed: box }),
  ended: object({ ...ref, winner, outcome }),
  releaseRequest: object({ ...ref, ...attempt, pickup: z.enum(['dkg', 'release', 'receipts']).optional() }),
  dkgBundle: object({ ...ref, ...attempt, post: z.record(z.string(), z.unknown()), take: z.record(z.string(), z.unknown()).optional(), deals: z.array(z.record(z.string(), z.unknown())).max(16), ready: z.array(z.record(z.string(), z.unknown())).max(16) }),
  releaseReceipt: object({ ...ref, ...attempt, j, releaseHash: hex, key: hex }),
  bookRequest: object({ page: int.optional(), limit: int.min(1).max(100).optional(), product: z.enum(['loan', 'call', 'put']).optional(), asset: z.enum(['RESET', 'TNK']).optional() }),
  book: object({ page: int, pageSize: int.min(1).max(100), total: int, positions: z.array(z.record(z.string(), z.unknown())).max(100), requester: hex }),
  summary: object({ ts: int, counted: int, blockAt: int, signers: z.array(object({ n: j, online: z.boolean() })).max(16),
    offers: z.array(z.record(z.string(), z.unknown())).max(30), running: z.array(z.record(z.string(), z.unknown())).max(40), ended: z.array(z.record(z.string(), z.unknown())).max(20) }),
};
const PUBLIC = new Set(['registry', 'heartbeat', 'lockRequest', 'posted', 'book', 'bookRequest', 'releaseRequest', 'summary']);
export function channel(positionId) { hex.parse(positionId); return `${MAIN}:p:${positionId}`; }
function validate(m) {
  if (!bodySchemas[m.kind]) throw new Error('Unknown locks message');
  const body = bodySchemas[m.kind].parse(m.body);
  if (m.ch !== (PUBLIC.has(m.kind) ? MAIN : channel(body.positionId))) throw new Error('Wrong locks channel');
  return body;
}
const envelope = object({ v: z.literal(1), kind: z.string(), ch: z.string().max(160), from: hex, ts: int, nonce: hex, body: z.unknown(), sig: z.string().regex(/^[0-9a-f]{128}$/) });
export function seal({ kind, ch, body }, identitySecret, { ts = Math.floor(Date.now() / 1000), nonce = randomBytes(32).toString('hex') } = {}) {
  const secret = typeof identitySecret === 'string' ? hexToBytes(identitySecret, 32) : identitySecret;
  const m = { v: 1, kind, ch, from: bytesToHex(ed25519.getPublicKey(secret)), ts, nonce, body };
  m.body = validate(m); envelope.parse({ ...m, sig: '0'.repeat(128) });
  return { ...m, sig: bytesToHex(ed25519.sign(utf8('intercom-locks/v1\n' + stableJSON(m)), secret)) };
}
export function open(raw, { now = Math.floor(Date.now() / 1000), seen, maxAgeSec = 120 } = {}) {
  if (stableJSON(raw).length > 200000) throw new Error('Locks envelope too large');
  const m = envelope.parse(raw); validate(m);
  if (m.ts > now + 120 || m.ts < now - maxAgeSec) throw new Error('Stale locks envelope');
  const { sig, ...unsigned } = m;
  if (!ed25519.verify(hexToBytes(sig, 64), utf8('intercom-locks/v1\n' + stableJSON(unsigned)), hexToBytes(m.from, 32), { zip215: false })) throw new Error('Invalid locks signature');
  seen?.consume(m.from + ':' + m.nonce, m.ts + maxAgeSec, now);
  return m;
}
export function receiver(now = () => Math.floor(Date.now() / 1000), { historical = [] } = {}) {
  const global = createReplayCache({ maxEntries: 65536 }), by = new Map();
  return raw => {
    try {
      const t = now();
      for (const [key, row] of by) if (row.until < t) by.delete(key);
      const history = historical.includes(raw?.kind), m = open(raw, { now: t, ...(history ? { maxAgeSec: Number.MAX_SAFE_INTEGER } : {}) }), row = by.get(m.from) ?? { cache: createReplayCache({ maxEntries: 512 }), until: 0 };
      const until = history ? t + 120 : m.ts + 120;
      row.cache.consume(m.nonce, until, t); global.consume(m.from + ':' + m.nonce, until, t);
      row.until = Math.max(row.until, until); by.set(m.from, row); return m;
    } catch { return null; }
  };
}

export async function join(bridge, ch) {
  if (typeof bridge.request === 'function') return bridge.request({ type: 'locks_join', channel: ch });
  return bridge.join(ch);
}
