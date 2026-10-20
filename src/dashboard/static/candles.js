// Candle arithmetic for the chart, without any DOM: the timeframes, UTC buckets, the gap-filled series and the
// comparison that lets a live refresh rewrite only the newest bars.
export const TIMEFRAMES = Object.freeze([
  ['1m', '1m'], ['3m', '3m'], ['5m', '5m'], ['15m', '15m'], ['30m', '30m'], ['1h', '1h'], ['2h', '2h'], ['4h', '4h'],
  ['8h', '8h'], ['12h', '12h'], ['24h', '1d'], ['2d', '2d'], ['3d', '3d'], ['1W', '1w'], ['1M', '1mo'], ['1Y', '1y'],
].map(([label, interval]) => Object.freeze({ label, interval })));
export const DEFAULT_INTERVAL = '5m';
export const PAGE = 500;
export const DENSE_CAP = 5000;

const SECONDS = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400, '8h': 28800,
  '12h': 43200, '1d': 86400, '2d': 172800, '3d': 259200, '1w': 604800, '1mo': 2592000, '1y': 31536000 };
const FIRST_MONDAY = 345600, WEEK = 604800;
const mod = (v, n) => ((v % n) + n) % n;

export const isInterval = v => Object.hasOwn(SECONDS, v);
export const intervalSeconds = interval => SECONDS[interval];

// The bucket a moment falls in: fixed intervals floor the second, weeks start Monday 00:00 UTC, months and years
// on their first day UTC.
export function bucketStart(sec, interval) {
  const s = Math.floor(sec), d = new Date(s * 1000);
  if (interval === '1w') return s - mod(s - FIRST_MONDAY, WEEK);
  if (interval === '1mo') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  if (interval === '1y') return Date.UTC(d.getUTCFullYear(), 0, 1) / 1000;
  return s - mod(s, SECONDS[interval]);
}
export function nextBucket(t, interval, step = 1) {
  const d = new Date(t * 1000);
  if (interval === '1mo') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + step, 1) / 1000;
  if (interval === '1y') return Date.UTC(d.getUTCFullYear() + step, 0, 1) / 1000;
  return t + step * SECONDS[interval];
}

// One series from two pages, oldest first; a bucket both carry is taken from the newer read.
export function mergeCandles(older, newer) {
  const byT = new Map();
  for (const c of older) byT.set(c.t, c);
  for (const c of newer) byT.set(c.t, c);
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

// Every bucket from the first candle up to the one the clock is in; a bucket without trades is flat at the close
// before it with zero volume. At most `cap` buckets, the newest ones; the first drawn opens at the last known close.
export function denseCandles(candles, interval, nowSec, cap = DENSE_CAP) {
  if (!candles.length) return [];
  const byT = new Map(candles.map(c => [bucketStart(c.t, interval), c]));
  const first = bucketStart(candles[0].t, interval);
  const last = Math.max(bucketStart(candles.at(-1).t, interval), bucketStart(nowSec, interval));
  let start = last;
  for (let n = 1; n < cap && start > first; n++) start = nextBucket(start, interval, -1);
  start = Math.max(start, first);
  let close = candles[0].o;
  for (const c of candles) if (bucketStart(c.t, interval) <= start) close = c.c;
  const out = [];
  for (let t = start; t <= last && out.length < cap; t = nextBucket(t, interval)) {
    const c = byT.get(t);
    if (c) { out.push({ ...c, t }); close = c.c; } else out.push({ t, o: close, h: close, l: close, c: close, v: null });
  }
  return out;
}

// A candle as the chart draws it: numbers for coordinates only (the readout keeps the price strings).
export const toPoint = c => ({ time: c.t, open: Number(c.o), high: Number(c.h), low: Number(c.l), close: Number(c.c),
  volume: c.v ? Number(c.v.units) / 1e6 : 0 });

const samePoint = (a, b) => a.time === b.time && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && a.volume === b.volume;

// What a refresh changed: nothing, a few bars at the end (written one by one, the viewer's zoom stays), or
// anything else (the whole series is written again).
export function tail(previous, next, window = 8) {
  if (!previous.length || !next.length || next.length < previous.length || previous[0].time !== next[0].time) return { kind: 'reset' };
  let changed = previous.length;
  for (let i = 0; i < previous.length; i++) if (!samePoint(previous[i], next[i])) { changed = i; break; }
  if (changed === previous.length && next.length === previous.length) return { kind: 'same' };
  const bars = next.slice(changed);
  return bars.length > window ? { kind: 'reset' } : { kind: 'update', bars, newest: previous.at(-1).time };
}

// Decimal places the price axis shows: the most any of the book's prices carries (2 to 8); with an empty book,
// five significant digits of the reference price.
export function precisionOf(prices, reference = null) {
  let places = 2;
  for (const p of prices) places = Math.max(places, (String(p).split('.')[1] ?? '').replace(/0+$/, '').length);
  if (!prices.length && Number(reference) > 0) places = Math.max(2, 4 - Math.floor(Math.log10(Number(reference))));
  return Math.min(8, places);
}
