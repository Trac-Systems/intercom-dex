import { ed25519 } from '@noble/curves/ed25519.js';
import { z } from 'zod';
import { bytesToHex, hexToBytes, stableJSON, utf8 } from './canonical.js';
import { bodySchemas, hexKey, parseBody } from './schemas.js';

const PREFIX = 'intercom-dex/v1\n';
const schema = z.object({ v: z.literal(1), kind: z.string(), ch: z.string().min(1).max(160), from: hexKey,
  ts: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 120), nonce: hexKey, body: z.unknown(),
  sig: z.string().length(128).regex(/^[0-9a-f]{128}$/) }).strict();

export class EnvelopeError extends Error {
  constructor(code, message) { super(message); this.name = 'EnvelopeError'; this.code = code; }
}

export function createReplayCache({ maxEntries = 4096 } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError('Invalid cache bound');
  const entries = new Map();
  let lastNow = 0;
  return {
    consume(key, expiresAt, now) {
      if (typeof key !== 'string' || !Number.isSafeInteger(now) || now < lastNow || !Number.isSafeInteger(expiresAt) || expiresAt < now) {
        throw new TypeError('Invalid replay entry');
      }
      lastNow = now;
      for (const [k, until] of entries) if (until < now) entries.delete(k);
      if (entries.has(key)) throw new EnvelopeError('replay', 'Repeated sender nonce');
      // Fail closed: evicting a live entry would allow its envelope to replay.
      if (entries.size >= maxEntries) throw new EnvelopeError('capacity', 'Replay cache is full');
      entries.set(key, expiresAt);
    },
    get size() { return entries.size; },
  };
}

export function seal({ kind, ch, body }, identitySecret, { ts, nonce }) {
  stableJSON(body);
  if (!Object.hasOwn(bodySchemas, kind)) throw new EnvelopeError('unknown-kind', 'Unknown message kind');
  const secret = typeof identitySecret === 'string' ? hexToBytes(identitySecret, 32) : identitySecret;
  const unsigned = { v: 1, kind, ch, from: bytesToHex(ed25519.getPublicKey(secret)), ts, nonce, body: parseBody(kind, body) };
  schema.parse({ ...unsigned, sig: '0'.repeat(128) });
  return { ...unsigned, sig: bytesToHex(ed25519.sign(utf8(PREFIX + stableJSON(unsigned)), secret)) };
}

// maxAgeSec: how old an envelope may be (default 120 s). Trade channels pass the trade's lifetime so members who
// join late can still verify earlier messages. Chat explicitly allows 300 s in either direction.
export function open(envelope, { now, seen, maxAgeSec = 120, maxFutureSec = 120 }) {
  if (!Number.isSafeInteger(now) || now < 0 || typeof seen?.consume !== 'function') throw new TypeError('now and replay cache required');
  if (!Number.isSafeInteger(maxAgeSec) || maxAgeSec < 120) throw new TypeError('Invalid maxAgeSec');
  if (!Number.isSafeInteger(maxFutureSec) || maxFutureSec < 0) throw new TypeError('Invalid maxFutureSec');
  let parsed;
  try { stableJSON(envelope); parsed = schema.parse(envelope); }
  catch { throw new EnvelopeError('schema', 'Invalid envelope schema'); }
  if (!Object.hasOwn(bodySchemas, parsed.kind)) throw new EnvelopeError('unknown-kind', 'Unknown message kind');
  try { parsed.body = parseBody(parsed.kind, parsed.body); }
  catch { throw new EnvelopeError('schema', 'Invalid message body'); }
  if (parsed.ts - now > maxFutureSec || now - parsed.ts > maxAgeSec) throw new EnvelopeError('stale', 'Envelope timestamp outside window');
  const { sig, ...unsigned } = parsed;
  let valid = false;
  try { valid = ed25519.verify(hexToBytes(sig, 64), utf8(PREFIX + stableJSON(unsigned)), hexToBytes(parsed.from, 32), { zip215: false }); }
  catch { /* Invalid curve encoding is a bad signature. */ }
  if (!valid) throw new EnvelopeError('bad-signature', 'Envelope signature failed');
  seen.consume(parsed.from + ':' + parsed.nonce, parsed.ts + maxAgeSec, now);
  return parsed;
}
