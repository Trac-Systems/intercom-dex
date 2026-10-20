// Pure parts of the dashboard page (no DOM): candle buckets and gap filling, the live tail, price precision,
// the virtual list window and the order book rows. Proposed home: tests/unit/dashboard/static.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
const STATIC = new URL('../../../src/dashboard/static', import.meta.url).href;
const { TIMEFRAMES, DEFAULT_INTERVAL, isInterval, bucketStart, nextBucket, mergeCandles, denseCandles, toPoint, tail, precisionOf } = await import(`${STATIC}/candles.js`);
const { windowRange, offsetsFor, OVERSCAN } = await import(`${STATIC}/vlist.js`);
const { bookRows, DEPTH_LEVELS } = await import(`${STATIC}/book.js`);
const { fixed, percent, tone, placesOf } = await import(`${STATIC}/dom.js`);

const usdc = units => ({ units: String(units), text: String(units / 1e6), unit: 'USDC' });
const c = (t, o, h, l, cl, v = 1e6) => ({ t, o, h, l, c: cl, v: usdc(v) });

test('exactly the 16 timeframes, in order, with the 24h/1W/1M/1Y labels and 5m default', () => {
  assert.deepEqual(TIMEFRAMES.map(t => t.label), ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '24h', '2d', '3d', '1W', '1M', '1Y']);
  assert.deepEqual(TIMEFRAMES.map(t => t.interval), ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '2d', '3d', '1w', '1mo', '1y']);
  assert.equal(DEFAULT_INTERVAL, '5m');
  assert.ok(TIMEFRAMES.every(t => isInterval(t.interval)));
  assert.equal(isInterval('1d'), true); assert.equal(isInterval('24h'), false); assert.equal(isInterval('constructor'), false);
});

test('buckets: fixed intervals floor, weeks start Monday UTC, months and years on their first day UTC', () => {
  const t = Date.UTC(2026, 9, 21, 13, 47, 12) / 1000; // Wednesday
  assert.equal(bucketStart(t, '5m'), Date.UTC(2026, 9, 21, 13, 45) / 1000);
  assert.equal(bucketStart(t, '4h'), Date.UTC(2026, 9, 21, 12) / 1000);
  assert.equal(bucketStart(t, '1d'), Date.UTC(2026, 9, 21) / 1000);
  assert.equal(bucketStart(t, '1w'), Date.UTC(2026, 9, 19) / 1000);
  assert.equal(new Date(bucketStart(t, '1w') * 1000).getUTCDay(), 1);
  assert.equal(bucketStart(t, '1mo'), Date.UTC(2026, 9, 1) / 1000);
  assert.equal(bucketStart(t, '1y'), Date.UTC(2026, 0, 1) / 1000);
  assert.equal(nextBucket(Date.UTC(2026, 0, 1) / 1000, '1mo'), Date.UTC(2026, 1, 1) / 1000);
  assert.equal(nextBucket(Date.UTC(2026, 11, 1) / 1000, '1mo'), Date.UTC(2027, 0, 1) / 1000);
  assert.equal(nextBucket(Date.UTC(2026, 2, 1) / 1000, '1mo', -1), Date.UTC(2026, 1, 1) / 1000);
  assert.equal(nextBucket(Date.UTC(2026, 0, 1) / 1000, '1y'), Date.UTC(2027, 0, 1) / 1000);
  assert.equal(nextBucket(600, '5m'), 900);
});

test('gap buckets are flat at the previous close with zero volume, up to the bucket the clock is in', () => {
  const rows = [c(0, '1', '2', '0.5', '1.5'), c(900, '1.6', '1.7', '1.4', '1.45')];
  const dense = denseCandles(rows, '5m', 1500);
  assert.deepEqual(dense.map(x => x.t), [0, 300, 600, 900, 1200, 1500]);
  assert.deepEqual(dense[1], { t: 300, o: '1.5', h: '1.5', l: '1.5', c: '1.5', v: null });
  assert.equal(dense[4].c, '1.45'); assert.equal(dense[5].o, '1.45');
  assert.equal(toPoint(dense[1]).volume, 0);
  assert.deepEqual(toPoint(rows[0]), { time: 0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 });
  assert.deepEqual(denseCandles([], '5m', 1500), []);
});

test('a capped series keeps the newest buckets and opens at the last close before them', () => {
  const rows = [c(0, '1', '1', '1', '1'), c(300, '2', '2', '2', '2'), c(1200, '3', '3', '3', '3')];
  const dense = denseCandles(rows, '5m', 1200, 3);
  assert.deepEqual(dense.map(x => [x.t, x.c]), [[600, '2'], [900, '2'], [1200, '3']]);
});

test('merging pages keeps one candle per bucket, the newer read winning', () => {
  const merged = mergeCandles([c(0, '1', '1', '1', '1'), c(300, '1', '1', '1', '1')], [c(300, '2', '2', '2', '2'), c(600, '3', '3', '3', '3')]);
  assert.deepEqual(merged.map(x => [x.t, x.c]), [[0, '1'], [300, '2'], [600, '3']]);
});

test('the live tail: same, a few changed bars, or a full rewrite', () => {
  const p = (time, close) => ({ time, open: 1, high: 2, low: 0, close, volume: 1 });
  const a = [p(0, 1), p(300, 1), p(600, 1)];
  assert.deepEqual(tail(a, a.map(x => ({ ...x }))), { kind: 'same' });
  const next = [p(0, 1), p(300, 1), p(600, 1.5), p(900, 1.5)];
  assert.deepEqual(tail(a, next), { kind: 'update', bars: next.slice(2), newest: 600 });
  assert.equal(tail(a, [p(300, 1), p(600, 1)]).kind, 'reset');
  assert.equal(tail([], a).kind, 'reset');
  assert.equal(tail(a, [p(0, 9), ...a.slice(1)]).kind, 'update');
  assert.equal(tail(a, [...a, ...Array.from({ length: 9 }, (_, i) => p(900 + i * 300, 1))]).kind, 'reset');
});

test('price precision follows the book, else five significant digits of the reference price', () => {
  assert.equal(precisionOf(['0.25', '0.2512', '0.251']), 4);
  assert.equal(precisionOf(['1.5000', '2']), 2);
  assert.equal(precisionOf(['0.000000001234']), 8);
  assert.equal(precisionOf([], '0.01834'), 6);
  assert.equal(precisionOf([], '123.4'), 2);
  assert.equal(precisionOf([], null), 2);
});

test('the virtual list window: visible rows plus overscan, clamped to the list', () => {
  assert.deepEqual(windowRange({ scrollTop: 0, viewport: 320, rowHeight: 32, count: 5000 }), { from: 0, to: 10 + 1 + OVERSCAN });
  const mid = windowRange({ scrollTop: 32 * 2500, viewport: 320, rowHeight: 32, count: 5000 });
  assert.deepEqual(mid, { from: 2500 - OVERSCAN, to: 2511 + OVERSCAN });
  assert.ok(mid.to - mid.from <= 10 + 1 + 2 * OVERSCAN);
  assert.deepEqual(windowRange({ scrollTop: 32 * 5000, viewport: 320, rowHeight: 32, count: 5000 }), { from: 4999 - OVERSCAN, to: 5000 });
  assert.deepEqual(windowRange({ scrollTop: 0, viewport: 320, rowHeight: 32, count: 0 }), { from: 0, to: 0 });
  assert.deepEqual(windowRange({ scrollTop: 0, viewport: 320, rowHeight: 32, count: 3 }), { from: 0, to: 3 });
});

test('taller expanded rows shift the rows below them', () => {
  const offsets = offsetsFor(5, 30, new Map([[1, 100]]));
  assert.deepEqual([...offsets], [0, 30, 130, 160, 190, 220]);
  assert.deepEqual(windowRange({ scrollTop: 135, viewport: 30, rowHeight: 30, count: 5, offsets, overscan: 0 }), { from: 2, to: 4 });
  assert.deepEqual(windowRange({ scrollTop: 40, viewport: 10, rowHeight: 30, count: 5, offsets, overscan: 0 }), { from: 1, to: 2 });
});

test('book rows: sells reversed (best ask last, next to the spread), buys best first, depth bars capped', () => {
  const lvl = (price, units, total) => ({ price, amount: { units: String(units) }, total: { units: String(total) }, count: 1, mine: null, take: null });
  const book = { asks: [lvl('0.26', 10, 10), lvl('0.27', 30, 40)], bids: [lvl('0.25', 20, 20), lvl('0.24', 60, 80)] };
  const rows = bookRows(book, 4);
  assert.deepEqual(rows.asks.map(r => r.price), ['0.27', '0.26']);
  assert.deepEqual(rows.bids.map(r => r.price), ['0.25', '0.24']);
  assert.ok(rows.asks.every(r => r.side === 'sell' && r.places === 4) && rows.bids.every(r => r.side === 'buy'));
  assert.equal(rows.bids[1].depth, 1); assert.equal(rows.bids[0].depth, 0.25); assert.equal(rows.asks[1].depth, 10 / 80);
  const deep = { asks: Array.from({ length: DEPTH_LEVELS + 10 }, (_, i) => lvl(String(1 + i), 1, i + 1)), bids: [] };
  const deepRows = bookRows(deep);
  assert.equal(deepRows.asks[0].depth, 1);
  assert.equal(deepRows.asks.at(-1).depth, 1 / DEPTH_LEVELS);
  assert.deepEqual(bookRows({ asks: [], bids: [] }), { asks: [], bids: [] });
});

test('prices and changes as text', () => {
  assert.equal(fixed('0.25', 4), '0.2500');
  assert.equal(fixed('0.249999999999', 4), '0.2499');
  assert.equal(fixed('12', 2), '12.00');
  assert.equal(fixed('12.5', 0), '12');
  assert.equal(fixed(null, 2), '—');
  assert.equal(placesOf('0.123'), 3); assert.equal(placesOf('7'), 0);
  assert.equal(percent('-0.0412'), '-4.12%'); assert.equal(percent('0.1'), '+10.00%'); assert.equal(percent('0'), '0.00%'); assert.equal(percent(null), '—');
  assert.equal(tone('0.01'), 'up'); assert.equal(tone('-0.01'), 'down'); assert.equal(tone('0'), ''); assert.equal(tone(null), '');
});
