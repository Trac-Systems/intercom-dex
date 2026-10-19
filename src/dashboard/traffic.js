import { createHash } from 'node:crypto';
import { stableJSON } from '../core/canonical.js';

export const TRAFFIC_LIMIT = 2000;
export const CONNECTION_LIMIT_BYTES = 64000;
const RATE_WINDOW_SEC = 5;
const text = (v, max = 64) => (typeof v === 'string' ? v.slice(0, max) : '');
const HEX64 = /^[0-9a-f]{64}$/;

// Received channel messages, in memory only. Identical signed envelopes (same digest of the whole envelope) fold
// into one row with a repeat counter; the oldest distinct row goes once the limit is reached. Nothing is verified
// here: rows only describe what arrived.
export class TrafficLog {
  constructor({ limit = TRAFFIC_LIMIT, now = () => Date.now() } = {}) {
    Object.assign(this, { limit, now });
    this.rows = new Map();     // digest -> row, oldest first
    this.rates = new Map();    // channel -> Map(second -> bytes)
  }

  record(channel, message, bytes) {
    const at = this.now(), ch = text(channel, 100);
    let digest;
    try { digest = createHash('sha256').update(stableJSON(message ?? null)).digest('hex'); } catch { return null; }
    const second = Math.floor(at / 1000), rate = this.rates.get(ch) ?? new Map();
    rate.set(second, (rate.get(second) ?? 0) + bytes);
    for (const s of rate.keys()) if (s <= second - RATE_WINDOW_SEC) rate.delete(s);
    this.rates.set(ch, rate);
    const old = this.rows.get(digest);
    if (old) {
      this.rows.delete(digest);
      old.count++; old.lastSeen = at;
      this.rows.set(digest, old);
      return old;
    }
    const m = message && typeof message === 'object' ? message : {};
    const body = m.body && typeof m.body === 'object' ? m.body : {};
    const ref = ch.startsWith('intercom-dex:t:') ? ch.slice(15) : text(body.tradeId, 64);
    const row = { id: digest.slice(0, 16), channel: ch, kind: text(m.kind, 32) || '?', from: text(m.from, 64), bytes,
      trade: HEX64.test(ref) ? ref : '', firstSeen: at, lastSeen: at, count: 1 };
    this.rows.set(digest, row);
    if (this.rows.size > this.limit) this.rows.delete(this.rows.keys().next().value);
    return row;
  }

  // Bytes per second over the last few seconds, per channel.
  bytesPerSecond() {
    const second = Math.floor(this.now() / 1000), out = {};
    for (const [ch, rate] of this.rates) {
      let sum = 0;
      for (const [s, b] of rate) if (s > second - RATE_WINDOW_SEC && s <= second) sum += b;
      if (sum) out[ch] = Math.round(sum / RATE_WINDOW_SEC);
      else if (![...rate.keys()].some(s => s > second - RATE_WINDOW_SEC)) this.rates.delete(ch);
    }
    return out;
  }

  // Newest first, filtered, one page at a time.
  query({ channel = '', kind = '', trade = '', page = 0, pageSize = 100 } = {}) {
    const match = [...this.rows.values()].reverse().filter(r => (!channel || r.channel === channel) && (!kind || r.kind === kind) && (!trade || r.trade.startsWith(trade)));
    const p = Math.max(0, Math.floor(Number(page) || 0));
    return { total: match.length, page: p, pageSize, rows: match.slice(p * pageSize, (p + 1) * pageSize),
      channels: [...new Set([...this.rows.values()].map(r => r.channel))].sort(),
      kinds: [...new Set([...this.rows.values()].map(r => r.kind))].sort(),
      rates: this.bytesPerSecond(), limitBytes: CONNECTION_LIMIT_BYTES };
  }
}
