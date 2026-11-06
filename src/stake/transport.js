import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { z } from 'zod';
import { stableJSON, hexToBytes, bytesToHex, utf8 } from '../core/canonical.js';
import { STAKE_MESSAGE_BYTES, STAKE_PAGE_BYTES, STAKE_BUFFER_BYTES, STAKE_TRANSFERS, STAKE_TRANSFER_MS,
  packStakeBody, validStakeManifest, unpackStakeBody } from './paging.js';

export const STAKE_CHANNEL = 'intercom-dex:bonds';
const hex = z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/);
const schema = z.object({ v: z.literal(1), ch: z.literal(STAKE_CHANNEL), kind: z.enum(['stakeRequest', 'stakeReply', 'stakeManifest', 'stakePage']),
  from: hex, to: hex, id: hex, at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  method: z.string().regex(/^[a-zA-Z]{1,32}$/), body: z.record(z.string(), z.unknown()),
  sig: z.string().regex(/^[0-9a-f]{128}$(?![\s\S])/) }).strict();
const bytes = m => utf8('intercom-dex/stake/v1/rpc\n' + stableJSON(m));

export function sealStakeMessage(input, secret) {
  const key = typeof secret === 'string' ? hexToBytes(secret, 32) : secret;
  const m = { v: 1, ch: STAKE_CHANNEL, ...input, from: bytesToHex(ed25519.getPublicKey(key)) };
  schema.parse({ ...m, sig: '0'.repeat(128) });
  if (Buffer.byteLength(stableJSON({ ...m, sig: '0'.repeat(128) })) > STAKE_MESSAGE_BYTES) throw new Error('Stake message exceeds transport limit');
  return { ...m, sig: bytesToHex(ed25519.sign(bytes(m), key)) };
}

export function openStakeMessage(raw, now = Math.floor(Date.now() / 1000)) {
  if (!Number.isSafeInteger(now) || now < 0 || Buffer.byteLength(stableJSON(raw)) > STAKE_MESSAGE_BYTES) throw new Error('Invalid stake message');
  const m = schema.parse(raw), { sig, ...unsigned } = m;
  if (Math.abs(now - m.at) > 120 || !ed25519.verify(hexToBytes(sig, 64), bytes(unsigned), hexToBytes(m.from, 32), { zip215: false }))
    throw new Error('Invalid or stale stake signature');
  return m;
}

// Each authenticated request has a bounded reply window. Mutating handlers own
// durable operation IDs; a transport retry never authorizes a second operation.
export class StakeTransport {
  constructor({ bridge, identity, handle = async () => { throw new Error('Unsupported stake request'); }, now = () => Math.floor(Date.now() / 1000), timeoutMs = 30000, allowPagingPeer = () => false, pageRate = () => 0, transferMs = STAKE_TRANSFER_MS }) {
    Object.assign(this, { bridge, identity, handle, now, timeoutMs, allowPagingPeer, pageRate, transferMs });
    this.transfers = new Map(); this.finished = new Map(); this.bufferBytes = 0; this.outbound = new Map(); this.pacing = new Map();
    this.pending = new Map(); this.active = new Map(); this.closed = true;
    this.listener = (ch, raw) => { if (ch === STAKE_CHANNEL) void this.receive(raw).catch(() => {}); };
  }
  async start() { this.closed = false; this.bridge.on('message', this.listener); await this.bridge.join(STAKE_CHANNEL); }
  stop() {
    this.closed = true; this.bridge.off('message', this.listener);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Stake transport stopped')); }
    this.pending.clear();
    for (const id of this.transfers.keys()) this.dropTransfer(id);
    this.finished.clear(); this.outbound.clear();
    for (const [timer, reject] of this.pacing) { clearTimeout(timer); reject(new Error('Stake transport stopped')); }
    this.pacing.clear();
  }
  async send(input) {
    const envelope = { ...input, at: this.now(), from: this.identity.publicKey, v: 1, ch: STAKE_CHANNEL, sig: '0'.repeat(128) };
    if (Buffer.byteLength(stableJSON(envelope)) <= STAKE_MESSAGE_BYTES)
      return this.bridge.send(STAKE_CHANNEL, sealStakeMessage({ ...input, at: envelope.at }, this.identity.secretKey));
    if (!this.allowPagingPeer(input.to)) throw new Error('Stake paging peer is not configured');
    const { data, ...manifest } = packStakeBody(input.body);
    const body = { ...manifest, kind: input.kind, transfer: randomBytes(32).toString('hex') };
    const end = Date.now() + this.transferMs;
    const send = async (kind, body) => {
      if (this.closed || Date.now() >= end || input.kind === 'stakeRequest' && !this.pending.has(input.id)) throw new Error('Stake page send expired');
      const m = sealStakeMessage({ ...input, kind, body, at: envelope.at }, this.identity.secretKey);
      await this.pace(input.to, Buffer.byteLength(stableJSON(m)) + 1024);
      if (this.closed || Date.now() >= end || input.kind === 'stakeRequest' && !this.pending.has(input.id)) throw new Error('Stake page send expired');
      return this.bridge.send(STAKE_CHANNEL, m);
    };
    await send('stakeManifest', body);
    for (let index = 0; index < manifest.pages; index++)
      await send('stakePage', { transfer: body.transfer, index, data: data.subarray(index * STAKE_PAGE_BYTES, (index + 1) * STAKE_PAGE_BYTES).toString('base64') });
  }
  async pace(to, bytes) {
    const rate = this.pageRate(to);
    if (!rate) return;
    // Reserve time across concurrent transfers to the same rate-limited payout peer.
    const now = Date.now(), end = Math.max(now, this.outbound.get(to) ?? now) + bytes * 1000 / rate;
    this.outbound.set(to, end);
    // Charge before sending, including the first page, so a full public burst
    // has time to replenish the receiver's tokens.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pacing.delete(timer); if (this.outbound.get(to) === end) this.outbound.delete(to); resolve();
      }, end - now);
      this.pacing.set(timer, reject);
    });
  }
  dropTransfer(key) {
    const transfer = this.transfers.get(key);
    if (!transfer) return;
    clearTimeout(transfer.timer); this.bufferBytes -= transfer.reserved; this.transfers.delete(key);
  }
  page(m) {
    if (!this.allowPagingPeer(m.from)) return null;
    const key = `${m.from}:${m.body.transfer}`;
    for (const [id, until] of this.finished) if (until <= Date.now()) this.finished.delete(id);
    if (this.finished.has(key)) return null;
    if (m.kind === 'stakeManifest') {
      const b = m.body;
      if (!validStakeManifest(b) || this.transfers.has(key)) return null;
      if (b.kind === 'stakeReply') {
        const p = this.pending.get(m.id);
        if (!p || p.to !== m.from || p.method !== m.method) return null;
      }
      const reserved = b.bytes + b.rawBytes;
      if (this.transfers.size >= STAKE_TRANSFERS || this.bufferBytes + reserved > STAKE_BUFFER_BYTES ||
          [...this.transfers.values()].filter(t => t.m.from === m.from).length >= 4 || this.finished.size + this.transfers.size >= 256) return null;
      const timer = setTimeout(() => this.dropTransfer(key), this.transferMs); timer.unref?.();
      this.transfers.set(key, { m, reserved, timer, pages: new Array(b.pages), count: 0 }); this.bufferBytes += reserved;
      return null;
    }
    const t = this.transfers.get(key);
    if (!t || m.id !== t.m.id || m.to !== t.m.to || m.method !== t.m.method || m.at !== t.m.at) return null;
    const { index, data } = m.body, b = t.m.body;
    if (Object.keys(m.body).sort().join(',') !== 'data,index,transfer' || !Number.isSafeInteger(index) || index < 0 || index >= b.pages ||
        t.pages[index] || typeof data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) return null;
    const decoded = Buffer.from(data, 'base64'), length = Math.min(STAKE_PAGE_BYTES, b.bytes - index * STAKE_PAGE_BYTES);
    if (decoded.length !== length || decoded.toString('base64') !== data) return null;
    t.pages[index] = decoded; t.count++;
    if (t.count !== b.pages) return null;
    this.dropTransfer(key); this.finished.set(key, Date.now() + 240000);
    return { ...t.m, kind: b.kind, body: unpackStakeBody(b, t.pages) };
  }
  request(to, method, body = {}, timeoutMs = this.timeoutMs) {
    if (this.closed || this.pending.size >= 32) return Promise.reject(new Error('Stake transport unavailable'));
    const id = randomBytes(32).toString('hex');
    return new Promise((resolve, reject) => {
      const done = (error, value) => { const p = this.pending.get(id); if (!p) return; clearTimeout(p.timer); this.pending.delete(id);
        for (const [key, t] of this.transfers) if (t.m.id === id && t.m.body.kind === 'stakeReply') this.dropTransfer(key);
        error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => done(new Error('Stake response timed out')), timeoutMs);
      this.pending.set(id, { to, method, done, timer, reject });
      this.send({ kind: 'stakeRequest', to, id, method, body }).catch(error => done(error));
    });
  }
  async receive(raw) {
    if (this.closed) return;
    let m = openStakeMessage(raw, this.now());
    if (m.to !== this.identity.publicKey) return;
    if (m.kind === 'stakeManifest' || m.kind === 'stakePage') { m = this.page(m); if (!m) return; }
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
