import { createHash } from 'node:crypto';

export function headerHash(header) {
  const b = typeof header === 'string' && /^[0-9a-f]{160}$/.test(header) ? Buffer.from(header, 'hex') : header;
  if (!(b instanceof Uint8Array) || b.length !== 80) throw new Error('Expected 80-byte Bitcoin header');
  return createHash('sha256').update(createHash('sha256').update(b).digest()).digest().reverse().toString('hex');
}

export function headerTime(header, expectedHash) {
  if (headerHash(header) !== expectedHash) throw new Error('RESET header hash mismatch');
  return Buffer.from(header, typeof header === 'string' ? 'hex' : undefined).readUInt32LE(68);
}

const height = n => {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid Bitcoin height');
  return n;
};

export class Clock {
  constructor({ bridge, fetchHeader = null }) { Object.assign(this, { bridge, fetchHeader }); this.times = new Map(); }
  async counted() { return height((await this.bridge.call('locks_clock', {})).counted); }
  async hash(N) {
    const r = await this.bridge.call('locks_clock', { height: height(N) });
    if (height(r.counted) < N || !/^[0-9a-f]{64}$/.test(r.hash ?? '')) throw new Error('Height not counted or hash unavailable');
    return r.hash;
  }
  async M(c = undefined) {
    c = c === undefined ? await this.counted() : height(c);
    if (c < 10) throw new Error('Eleven counted headers required');
    const times = await Promise.all(Array.from({ length: 11 }, (_, i) => this.T(c - 10 + i)));
    return times.sort((a, b) => a - b)[5];
  }
  async T(N) {
    const hash = await this.hash(N);
    if (this.times.has(hash)) return this.times.get(hash);
    let header;
    try { header = (await this.bridge.call('locks_header', { height: N, hash })).header; } catch {}
    if (!header && this.fetchHeader) header = await this.fetchHeader(N, hash);
    if (!header) throw new Error('Counted header unavailable');
    const time = headerTime(header, hash); this.times.set(hash, time);
    if (this.times.size > 256) this.times.delete(this.times.keys().next().value);
    return time;
  }
}

export const createClock = options => new Clock(options);
