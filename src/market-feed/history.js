import { openSync, closeSync, readSync, writeSync, fsyncSync, fstatSync, ftruncateSync, mkdirSync, readdirSync, lstatSync, constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { tryLock } from '../../peer/node_modules/fs-native-extensions/index.js';
import { amount, hexKey, pairSchema, price, parseBody } from '../core/schemas.js';
import { priceUnits } from '../market/assets.js';

const DURATIONS = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600,
  '2h': 7200, '4h': 14400, '8h': 28800, '12h': 43200, '1d': 86400, '2d': 172800, '3d': 259200, '1w': 604800 };
export const INTERVALS = Object.freeze([...Object.keys(DURATIONS), '1mo', '1y']);
const positive = amount.refine(v => BigInt(v) > 0n);
const rowSchema = z.object({ id: hexKey, pair: pairSchema, price, baseAmount: positive, quoteAmount: positive,
  ts: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), side: z.enum(['buy', 'sell']).optional() }).strict();
const SEGMENT_BYTES = 64 * 1024 * 1024;
const compare = (a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const lower = (rows, before, cmp) => {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (cmp(rows[mid], before) < 0) lo = mid + 1; else hi = mid; }
  return lo;
};

// Bounded leaf arrays also keep late trades and an unordered venue import cheap.
class OrderedRows {
  constructor(cmp) { this.cmp = cmp; this.blocks = []; }
  insert(row) {
    let b = lower(this.blocks, row, (block, value) => this.cmp(block.at(-1), value));
    if (b === this.blocks.length) b = Math.max(0, b - 1);
    const block = this.blocks[b] ?? (this.blocks[b] = []);
    block.splice(lower(block, row, this.cmp), 0, row);
    if (block.length > 1024) this.blocks.splice(b + 1, 0, block.splice(512));
  }
  before(value, limit) {
    let b = value === null ? this.blocks.length : lower(this.blocks, value, (block, v) => this.cmp(block.at(-1), v));
    let i = b === this.blocks.length ? 0 : lower(this.blocks[b], value, this.cmp);
    const rows = [];
    while (rows.length < limit) {
      if (i === 0) { if (--b < 0) break; i = this.blocks[b].length; }
      rows.push(this.blocks[b][--i]);
    }
    return rows;
  }
}

export function bucketStart(ts, interval) {
  if (!Number.isSafeInteger(ts) || ts < 0 || !INTERVALS.includes(interval)) throw new Error('Invalid candle bucket');
  if (interval === '1mo' || interval === '1y') {
    // Gregorian dates repeat every 400 years; keep Date within its supported range even for protocol uint times.
    const cycle = 146097 * 86400, cycles = Math.floor((ts - 946684800) / cycle);
    const date = new Date((ts - cycles * cycle) * 1000);
    return Date.UTC(date.getUTCFullYear(), interval === '1mo' ? date.getUTCMonth() : 0, 1) / 1000 + cycles * cycle;
  }
  const duration = DURATIONS[interval], offset = interval === '1w' ? 345600 : 0;
  return Math.floor((ts - offset) / duration) * duration + offset;
}

export function decimalUnits(value, decimals) {
  const n = BigInt(value), scale = 10n ** BigInt(decimals);
  const fraction = decimals ? (n % scale).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return `${n / scale}${fraction ? '.' + fraction : ''}`;
}

const cursor = (pair, row) => Buffer.from(JSON.stringify([pair, row.ts, row.id])).toString('base64url');
export function parseTradeCursor(value, pair) {
  if (typeof value !== 'string' || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('before');
  try {
    const data = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(data) || data.length !== 3 || data[0] !== pair || !Number.isSafeInteger(data[1]) || data[1] < 0 ||
        !hexKey.safeParse(data[2]).success || cursor(pair, { ts: data[1], id: data[2] }) !== value) throw new Error();
    return { ts: data[1], id: data[2] };
  } catch { throw new Error('before'); }
}

const syncDir = dir => { const fd = openSync(dir, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
function writeAll(fd, value) {
  const bytes = Buffer.from(value);
  let offset = 0;
  while (offset < bytes.length) {
    const n = writeSync(fd, bytes, offset, bytes.length - offset);
    if (!n) throw new Error('History write made no progress');
    offset += n;
  }
}

// Only public compact rows are stored here. The encrypted role store retains its existing bounded view.
export class TradeHistory {
  constructor({ dataDir, log = () => {}, segmentBytes = SEGMENT_BYTES } = {}) {
    this.ids = new Set(); this.pairs = new Map(); this.files = new Map(); this.log = log; this.segmentBytes = segmentBytes;
    if (!Number.isSafeInteger(segmentBytes) || segmentBytes < 1) throw new Error('Invalid history segment size');
    if (dataDir === undefined) return;
    if (!isAbsolute(dataDir)) throw new Error('History dataDir must be absolute');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    try {
      this.lock = openSync(join(dataDir, 'market-history.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      if (!fstatSync(this.lock).isFile() || !tryLock(this.lock)) throw new Error('Market feed history is locked; stop the feed before importing');
      this.dir = join(dataDir, 'market-history');
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      if (!lstatSync(this.dir).isDirectory()) throw new Error('History directory must not be a symlink');
      syncDir(dataDir);
      for (const name of readdirSync(this.dir).sort()) {
        const match = /^([a-f0-9]+)-([0-9]{8})\.jsonl$/.exec(name);
        if (!match) throw new Error('Unexpected file in market history');
        const pair = Buffer.from(match[1], 'hex').toString('utf8');
        if (!pairSchema.safeParse(pair).success || Buffer.from(pair).toString('hex') !== match[1]) throw new Error('Invalid history segment pair');
        const path = join(this.dir, name), size = this.#load(path, pair);
        this.files.set(pair, { path, size, segment: Number(match[2]) });
      }
    } catch (error) { this.close(); throw error; }
  }

  #load(path, pair) {
    const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error('History segment must be a regular file');
      const chunk = Buffer.alloc(65536); let pending = Buffer.alloc(0), position = 0, start = 0;
      const line = (bytes, end, terminated) => {
        let row;
        try {
          row = rowSchema.parse(JSON.parse(bytes.toString('utf8')));
          if (row.pair !== pair) throw new Error('History pair mismatch');
        } catch {
          if (end !== stat.size) throw new Error(`Damaged history segment ${path} at byte ${start}`);
          ftruncateSync(fd, start); fsyncSync(fd);
          this.log(`market history: discarded damaged last line in ${path} at byte ${start}`);
          return start;
        }
        if (!this.ids.has(row.id)) this.#index(row);
        if (!terminated) {
          writeSync(fd, Buffer.from('\n'), 0, 1, end); fsyncSync(fd);
          this.log(`market history: completed last line in ${path}`);
          return end + 1;
        }
        return end;
      };
      let size = stat.size;
      while (position < stat.size) {
        const n = readSync(fd, chunk, 0, chunk.length, position);
        if (!n) throw new Error('History segment shortened during load');
        position += n; pending = Buffer.concat([pending, chunk.subarray(0, n)]);
        let end;
        while ((end = pending.indexOf(10)) !== -1) {
          size = line(pending.subarray(0, end), start + end + 1, true);
          start += end + 1; pending = pending.subarray(end + 1);
        }
        if (pending.length > 4096 && position < stat.size) throw new Error('History line too long');
      }
      if (pending.length) size = line(pending, stat.size, false);
      return size;
    } finally { closeSync(fd); }
  }

  #index(row) {
    this.ids.add(row.id);
    let pair = this.pairs.get(row.pair);
    if (!pair) {
      pair = { trades: new OrderedRows(compare), candles: new Map(INTERVALS.map(interval => [interval,
        { byTime: new Map(), ordered: new OrderedRows((a, b) => a.t - b.t) }])) };
      this.pairs.set(row.pair, pair);
    }
    pair.trades.insert(row);
    const units = priceUnits(row.price), volume = BigInt(row.quoteAmount);
    for (const interval of INTERVALS) {
      const t = bucketStart(row.ts, interval), index = pair.candles.get(interval);
      let bucket = index.byTime.get(t);
      if (!bucket) {
        bucket = { t, first: row, last: row, h: row.price, l: row.price, high: units, low: units, volume: 0n };
        index.byTime.set(t, bucket); index.ordered.insert(bucket);
      }
      if (compare(row, bucket.first) < 0) bucket.first = row;
      if (compare(row, bucket.last) > 0) bucket.last = row;
      if (units > bucket.high) { bucket.high = units; bucket.h = row.price; }
      if (units < bucket.low) { bucket.low = units; bucket.l = row.price; }
      bucket.volume += volume;
    }
  }

  addTrade(body) {
    const { tradeId: id, pair, price, baseAmount, quoteAmount, ts } = parseBody('tradeLog', body);
    return this.append({ id, pair, price, baseAmount, quoteAmount, ts });
  }

  append(input) {
    if (this.closed || this.failed) throw new Error('History is closed or needs reopening after a write failure');
    const row = rowSchema.parse(input);
    if (this.ids.has(row.id)) return false;
    if (this.dir) {
      const bytes = JSON.stringify(row) + '\n';
      try {
        let file = this.files.get(row.pair);
        if (!file || file.size >= this.segmentBytes) {
          if (file?.fd !== undefined) { closeSync(file.fd); delete file.fd; }
          const segment = (file?.segment ?? 0) + 1;
          if (segment > 99999999) throw new Error('History segment limit');
          const path = join(this.dir, `${Buffer.from(row.pair).toString('hex')}-${String(segment).padStart(8, '0')}.jsonl`);
          const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
          file = { path, fd, size: 0, segment }; this.files.set(row.pair, file); syncDir(this.dir);
        }
        file.fd ??= openSync(file.path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
        writeAll(file.fd, bytes); fsyncSync(file.fd); file.size += Buffer.byteLength(bytes);
      } catch (error) {
        this.failed = true; this.log('market history: write failed; fix storage and restart the feed'); throw error;
      }
    }
    this.#index(row);
    return true;
  }

  candles({ pair, interval, limit = 500, before = null }) {
    if (!INTERVALS.includes(interval) || !Number.isInteger(limit) || limit < 1 || limit > 500 ||
        before !== null && !Number.isSafeInteger(before)) throw new Error('Invalid candle query');
    const rows = this.pairs.get(pair)?.candles.get(interval).ordered.before(before === null ? null : { t: before }, limit) ?? [];
    return { pair, interval, candles: rows.reverse().map(b => ({ t: b.t, o: b.first.price, h: b.h, l: b.l,
      c: b.last.price, v: decimalUnits(b.volume, 6) })) };
  }

  trades({ pair, decimals, limit = 100, before = null }) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(decimals) || decimals < 0 || decimals > 30) throw new Error('Invalid trade query');
    const boundary = before === null ? null : parseTradeCursor(before, pair);
    const rows = this.pairs.get(pair)?.trades.before(boundary, limit + 1) ?? [], more = rows.length > limit;
    if (more) rows.pop();
    return { rows: rows.map(r => ({ id: r.id, t: r.ts, side: r.side ?? null, price: r.price,
      amount: decimalUnits(r.baseAmount, decimals), usdc: decimalUnits(r.quoteAmount, 6) })),
    next: more ? cursor(pair, rows.at(-1)) : null };
  }

  close() {
    this.closed = true;
    for (const file of this.files.values()) if (file.fd !== undefined) { closeSync(file.fd); delete file.fd; }
    if (this.lock !== undefined) { closeSync(this.lock); this.lock = undefined; }
  }
}
