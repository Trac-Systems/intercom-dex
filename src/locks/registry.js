import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';
import { sha256Hex, stableJSON, hexToBytes, concatBytes } from '../core/canonical.js';
import { meetsVersion } from '../core/software.js';

const hex = z.string().regex(/^[0-9a-f]{64}$/), int = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const units = z.string().max(78).regex(/^(0|[1-9][0-9]*)$/), software = z.string().regex(/^\d+\.\d+\.\d+$/);
const sol = z.string().refine(s => { try { return new PublicKey(s).toBase58() === s; } catch { return false; } });
const range = z.object({ min: units, max: units }).strict().refine(r => BigInt(r.min) <= BigInt(r.max));
export const registrySchema = z.object({
  version: int.positive(), issuedAt: int, minSoftware: software,
  params: z.object({ n: int.min(1).max(16), k: int.min(1).max(16), dkgTimeoutSec: int.positive().max(3600),
    reserveSec: int.positive().max(86400), payMarginSec: int.positive(), termBlocks: z.object({ min: int.min(6), max: int.min(6) }).strict(),
    offerMaxBlocks: int.positive(), recoveryMarginSec: int.positive(), tnkReserve: units,
    minOperatorSigners: int.max(16).optional(), maxPositions: int.min(1).max(2000).optional(), maxPerMaker: int.min(1).max(50).optional() }).strict(),
  products: z.object({ loan: z.enum(['open', 'paused']), call: z.enum(['open', 'paused']), put: z.enum(['open', 'paused']) }).strict(),
  assets: z.object({ RESET: z.enum(['open', 'paused']), TNK: z.enum(['open', 'paused']) }).strict(),
  limits: z.object({ RESET: range, TNK: range, USDC: range, totalLocked: z.object({ RESET: units, TNK: units, USDC: units }).strict() }).strict(),
  fee: z.object({ loanBps: int.max(1000), optionBps: int.max(1000), optionMin: units, signerShareBps: int.max(10000).optional(), collector: sol, escrowCollector: sol }).strict(),
  signers: z.array(z.object({ lockKey: hex, boxKey: hex, label: z.string().max(128), status: z.enum(['active', 'inactive']), group: z.enum(['operator', 'external']), software }).strict()).max(128),
  removed: z.array(z.object({ lockKey: hex, removedAt: int, reason: z.string().max(256) }).strict()).max(256),
}).strict().superRefine((r, ctx) => {
  const p = r.params, bad = message => ctx.addIssue({ code: 'custom', message });
  if ((p.minOperatorSigners ?? p.k) > p.n) bad('Operator minimum exceeds committee size');
  if (p.k <= p.n / 2 || p.k > p.n) bad('Threshold must satisfy n/2 < k <= n');
  if (p.termBlocks.min > p.termBlocks.max || p.termBlocks.max > p.offerMaxBlocks) bad('Invalid term block range');
  if (p.payMarginSec >= p.reserveSec) bad('Payment margin must be shorter than reservation');
  for (const field of ['lockKey', 'boxKey']) if (new Set(r.signers.map(s => s[field])).size !== r.signers.length) bad('Duplicate signer key');
  if (new Set(r.removed.map(s => s.lockKey)).size !== r.removed.length || r.signers.some(s => r.removed.some(x => x.lockKey === s.lockKey))) bad('Removed signer listed');
  if (stableJSON(r).length > 150000) bad('Registry too large');
});
export const validate = r => registrySchema.parse(r);
export const buildRegistry = validate;

export function activeSigners(registry) {
  return registry.signers.filter(s => s.status === 'active' && meetsVersion(s.software, registry.minSoftware)).sort((a, b) => a.lockKey.localeCompare(b.lockKey));
}

export function selectCommittee(registry, positionId, blockhash) {
  const r = validate(registry), eligible = activeSigners(r), n = r.params.n, minimum = r.params.minOperatorSigners ?? r.params.k;
  hexToBytes(positionId, 32);
  if (eligible.length < n || eligible.filter(s => s.group === 'operator').length < minimum) throw new Error('Not enough eligible signers');
  if (eligible.length === n) return eligible;
  const seed = hexToBytes(blockhash, 32);
  // Retry a whole draw, continuing the same counter, to preserve sampling without replacement.
  let c = 0;
  while (c < 1000000) {
    const pool = [...eligible], result = [];
    while (result.length < n) {
      const counter = Buffer.alloc(4); counter.writeUInt32BE(c++);
      const x = BigInt('0x' + sha256Hex(concatBytes(seed, counter))), size = BigInt(pool.length);
      if (x >= (2n ** 256n / size) * size) continue;
      result.push(pool.splice(Number(x % size), 1)[0]);
    }
    if (result.filter(s => s.group === 'operator').length >= minimum) return result;
  }
  throw new Error('Committee sampling exhausted');
}

export class RegistryView {
  constructor(serviceKey, store = null) {
    this.serviceKey = serviceKey; this.store = store;
    this.current = store?.get('locks-registry-current') ?? null;
    if (this.current) validate(this.current);
    this.digests = store?.get('locks-registry-digests') ?? {};
    this.conflict = store?.get('locks-registry-conflict') ?? null;
    this.snapshots = new Map(this.current ? [[this.current.version, this.current]] : []);
  }
  get usable() { return this.conflict ? null : this.current; }
  // Caller verifies the locks envelope before offering it here.
  offer(message, now = Math.floor(Date.now() / 1000)) {
    if (message.kind !== 'registry' || message.from !== this.serviceKey) return false;
    const r = validate(message.body), digest = sha256Hex(stableJSON(r));
    if (r.issuedAt > now + 60) return false;
    if (this.digests[r.version] && this.digests[r.version] !== digest) {
      this.conflict = { version: r.version, at: now };
      this.store?.put('locks-registry-conflict', this.conflict); return false;
    }
    if (this.current && (r.version <= this.current.version || r.issuedAt < this.current.issuedAt)) return false;
    const digests = { ...this.digests, [r.version]: digest };
    this.store?.put('locks-registry-digests', digests);
    this.store?.put(`locks-registry-v${r.version}`, r);
    this.store?.put('locks-registry-current', r);
    this.digests = digests; this.current = r; this.snapshots.set(r.version, r); return true;
  }
  snapshot(version) { return this.snapshots.get(version) ?? this.store?.get(`locks-registry-v${version}`) ?? null; }
}
