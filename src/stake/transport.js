import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { z } from 'zod';
import { stableJSON, hexToBytes, bytesToHex, utf8 } from '../core/canonical.js';

export const STAKE_CHANNEL = 'intercom-dex:bonds';
const hex = z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/);
const schema = z.object({ v: z.literal(1), ch: z.literal(STAKE_CHANNEL), kind: z.enum(['stakeRequest', 'stakeReply']),
  from: hex, to: hex, id: hex, at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  method: z.string().regex(/^[a-zA-Z]{1,32}$/), body: z.record(z.string(), z.unknown()),
  sig: z.string().regex(/^[0-9a-f]{128}$(?![\s\S])/) }).strict();
const bytes = m => utf8('intercom-dex/stake/v1/rpc\n' + stableJSON(m));

export function sealStakeMessage(input, secret) {
  const key = typeof secret === 'string' ? hexToBytes(secret, 32) : secret;
  const m = { v: 1, ch: STAKE_CHANNEL, ...input, from: bytesToHex(ed25519.getPublicKey(key)) };
  schema.parse({ ...m, sig: '0'.repeat(128) });
  if (Buffer.byteLength(stableJSON(m)) > 180000) throw new Error('Stake message exceeds transport limit');
  return { ...m, sig: bytesToHex(ed25519.sign(bytes(m), key)) };
}

export function openStakeMessage(raw, now = Math.floor(Date.now() / 1000)) {
  if (!Number.isSafeInteger(now) || now < 0 || Buffer.byteLength(stableJSON(raw)) > 180000) throw new Error('Invalid stake message');
  const m = schema.parse(raw), { sig, ...unsigned } = m;
  if (Math.abs(now - m.at) > 120 || !ed25519.verify(hexToBytes(sig, 64), bytes(unsigned), hexToBytes(m.from, 32), { zip215: false }))
    throw new Error('Invalid or stale stake signature');
  return m;
}

// Each authenticated request has a bounded reply window. Mutating handlers own
// durable operation IDs; a transport retry never authorizes a second operation.
export class StakeTransport {
  constructor({ bridge, identity, handle = async () => { throw new Error('Unsupported stake request'); }, now = () => Math.floor(Date.now() / 1000), timeoutMs = 30000 }) {
    Object.assign(this, { bridge, identity, handle, now, timeoutMs });
    this.pending = new Map(); this.active = new Map(); this.closed = true;
    this.listener = (ch, raw) => { if (ch === STAKE_CHANNEL) void this.receive(raw).catch(() => {}); };
  }
  async start() { this.closed = false; this.bridge.on('message', this.listener); await this.bridge.join(STAKE_CHANNEL); }
  stop() {
    this.closed = true; this.bridge.off('message', this.listener);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Stake transport stopped')); }
    this.pending.clear();
  }
  send(input) { return this.bridge.send(STAKE_CHANNEL, sealStakeMessage({ ...input, at: this.now() }, this.identity.secretKey)); }
  request(to, method, body = {}) {
    if (this.closed || this.pending.size >= 32) return Promise.reject(new Error('Stake transport unavailable'));
    const id = randomBytes(32).toString('hex');
    return new Promise((resolve, reject) => {
      const done = (error, value) => { const p = this.pending.get(id); if (!p) return; clearTimeout(p.timer); this.pending.delete(id); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => done(new Error('Stake response timed out')), this.timeoutMs);
      this.pending.set(id, { to, method, done, timer, reject });
      this.send({ kind: 'stakeRequest', to, id, method, body }).catch(error => done(error));
    });
  }
  async receive(raw) {
    if (this.closed) return;
    const m = openStakeMessage(raw, this.now());
    if (m.to !== this.identity.publicKey) return;
    if (m.kind === 'stakeReply') {
      const p = this.pending.get(m.id);
      if (!p || p.to !== m.from || p.method !== m.method) return;
      p.done(m.body.ok === true ? null : new Error(typeof m.body.error === 'string' ? m.body.error : 'Stake request refused'), m.body.value);
      return;
    }
    const count = this.active.get(m.from) ?? 0;
    if (count >= 4 || [...this.active.values()].reduce((a, b) => a + b, 0) >= 32) return;
    this.active.set(m.from, count + 1);
    try {
      let body;
      try { body = { ok: true, value: await this.handle(m.method, m.body, m.from) }; }
      catch (error) { body = { ok: false, error: String(error.message).slice(0, 256) }; }
      if (!this.closed) await this.send({ kind: 'stakeReply', to: m.from, id: m.id, method: m.method, body });
    } finally {
      const remaining = this.active.get(m.from) - 1;
      if (remaining) this.active.set(m.from, remaining); else this.active.delete(m.from);
    }
  }
}
