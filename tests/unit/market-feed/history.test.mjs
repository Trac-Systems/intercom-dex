import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, readdirSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, symlinkSync, unlinkSync, rmdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { TradeHistory, INTERVALS, bucketStart, parseTradeCursor } from '../../../src/market-feed/history.js';
import { MarketView } from '../../../src/market-feed/view.js';
import { setup, memoryStore } from './helpers.mjs';

const pair = 'RESET/USDC', at = text => Date.parse(text + 'Z') / 1000;
const row = (n, extra = {}) => ({ id: n.toString(16).padStart(64, '0'), pair, price: '0.42', baseAmount: '100000000', quoteAmount: '420000', ts: 200000 + n, ...extra });
const temp = () => mkdtempSync(join(tmpdir(), 'feed-history-'));
const segment = (dir, pair = 'RESET/USDC', n = 1) => join(dir, 'market-history', `${Buffer.from(pair).toString('hex')}-${String(n).padStart(8, '0')}.jsonl`);

test('all 16 buckets use UTC, Monday weeks, calendar months/years and epoch-aligned multi-days', () => {
  assert.equal(INTERVALS.length, 16);
  const cases = [
    ['1m', '2024-03-31T00:59:59', '2024-03-31T00:59:00'], ['1m', '2024-03-31T01:00:00', '2024-03-31T01:00:00'],
    ['3m', '2024-01-01T00:05:59', '2024-01-01T00:03:00'], ['5m', '2024-01-01T00:09:59', '2024-01-01T00:05:00'],
    ['15m', '2024-01-01T00:29:59', '2024-01-01T00:15:00'], ['30m', '2024-01-01T00:59:59', '2024-01-01T00:30:00'],
    ['1h', '2024-03-31T01:59:59', '2024-03-31T01:00:00'], ['1h', '2024-03-31T02:00:00', '2024-03-31T02:00:00'],
    ['2h', '2024-10-27T01:59:59', '2024-10-27T00:00:00'], ['4h', '2024-01-01T07:59:59', '2024-01-01T04:00:00'],
    ['8h', '2024-01-01T15:59:59', '2024-01-01T08:00:00'], ['12h', '2024-01-01T23:59:59', '2024-01-01T12:00:00'],
    ['1d', '2024-01-01T23:59:59', '2024-01-01T00:00:00'], ['2d', '1970-01-04T23:59:59', '1970-01-03T00:00:00'],
    ['3d', '1970-01-06T23:59:59', '1970-01-04T00:00:00'],
    ['1w', '2024-12-29T23:59:59', '2024-12-23T00:00:00'], ['1w', '2024-12-30T00:00:00', '2024-12-30T00:00:00'],
    ['1mo', '2024-02-29T23:59:59', '2024-02-01T00:00:00'], ['1mo', '2024-03-01T00:00:00', '2024-03-01T00:00:00'],
    ['1y', '2024-12-31T23:59:59', '2024-01-01T00:00:00'], ['1y', '2025-01-01T00:00:00', '2025-01-01T00:00:00'],
  ];
  for (const [interval, time, expected] of cases) assert.equal(bucketStart(at(time), interval), at(expected), `${interval} ${time}`);
  assert.equal(bucketStart(0, '1w'), -259200);
  for (const interval of INTERVALS) {
    const t = bucketStart(Number.MAX_SAFE_INTEGER, interval);
    assert.ok(Number.isSafeInteger(t) && t <= Number.MAX_SAFE_INTEGER);
  }
  for (const [ts, interval] of [[-1, '1m'], [1.5, '1h'], [Infinity, '1m'], [0, '2mo']]) assert.throws(() => bucketStart(ts, interval));
});

test('out-of-order OHLC uses timestamp/id order, exact prices and quote volume, with no gap buckets', () => {
  const history = new TradeHistory(), start = at('2024-12-31T23:59:00');
  const prices = ['9007199254740993.000000000001', '9007199254740993.000000000003', '9007199254740993.000000000002'];
  history.append(row(3, { ts: start + 40, price: prices[2], quoteAmount: '9999999999999999999999999999999' }));
  history.append(row(2, { ts: start + 10, price: prices[1], quoteAmount: '1' }));
  history.append(row(1, { ts: start + 10, price: prices[0], quoteAmount: '2' }));
  assert.equal(history.append(row(1, { ts: start + 10, price: '1' })), false);
  history.append(row(4, { ts: start + 180, price: '7', quoteAmount: '1000000' }));
  assert.deepEqual(history.candles({ pair, interval: '1m' }), { pair, interval: '1m', candles: [
    { t: start, o: prices[0], h: prices[1], l: prices[0], c: prices[2], v: '10000000000000000000000000.000002' },
    { t: start + 180, o: '7', h: '7', l: '7', c: '7', v: '1' },
  ] });
  assert.deepEqual(history.candles({ pair, interval: '1m', before: start + 180, limit: 1 }).candles.map(c => c.t), [start]);
  assert.deepEqual(history.candles({ pair, interval: '1m', before: start }).candles, []);
  for (const interval of INTERVALS) {
    const sum = history.candles({ pair, interval }).candles.reduce((n, c) => {
      const [whole, fraction = ''] = c.v.split('.'); return n + BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
    }, 0n);
    assert.equal(sum, 10000000000000000000000001000002n);
  }
  assert.deepEqual(history.candles({ pair: 'TNK/USDC', interval: '1y' }).candles, []);
});

test('trade pages are stable with tied timestamps, exclusive cursors, late inserts and independent pairs', () => {
  const history = new TradeHistory();
  for (const n of [4, 2, 1, 3, 5]) history.append(row(n, { ts: 100, side: n === 5 ? 'buy' : 'sell' }));
  history.append(row(9, { pair: 'TNK/USDC', baseAmount: '1000000000000000001' }));
  const first = history.trades({ pair, decimals: 8, limit: 2 });
  assert.deepEqual(first.rows.map(r => r.id), [row(5).id, row(4).id]);
  assert.deepEqual(first.rows[0], { id: row(5).id, t: 100, side: 'buy', price: '0.42', amount: '1', usdc: '0.42' });
  assert.deepEqual(parseTradeCursor(first.next, pair), { ts: 100, id: row(4).id });
  history.append(row(6, { ts: 101 }));
  const second = history.trades({ pair, decimals: 8, limit: 2, before: first.next });
  assert.deepEqual(second.rows.map(r => r.id), [row(3).id, row(2).id]);
  const third = history.trades({ pair, decimals: 8, limit: 2, before: second.next });
  assert.deepEqual(third.rows.map(r => r.id), [row(1).id]); assert.equal(third.next, null);
  assert.equal(history.trades({ pair: 'TNK/USDC', decimals: 18 }).rows[0].amount, '1.000000000000000001');
  for (const before of ['', 'abc', first.next + '=', first.next + '\n', Buffer.from('["RESET/USDC",-1,"x"]').toString('base64url')]) {
    assert.throws(() => history.trades({ pair, decimals: 8, before }), /before/);
  }
  assert.throws(() => history.trades({ pair: 'TNK/USDC', decimals: 18, before: first.next }), /before/);
});

test('chunk indexes cross leaves correctly after descending and interleaved insertion', () => {
  const history = new TradeHistory();
  for (let n = 4000; n > 0; n -= 2) history.append(row(n, { ts: n * 60 }));
  for (let n = 1; n < 4000; n += 2) history.append(row(n, { ts: n * 60 }));
  let before = null, count = 4000;
  do {
    const page = history.trades({ pair, decimals: 8, before, limit: 137 });
    for (const r of page.rows) assert.equal(r.id, row(count--).id);
    before = page.next;
  } while (before);
  assert.equal(count, 0);
  const candles = history.candles({ pair, interval: '1m', before: 2500 * 60, limit: 500 }).candles;
  assert.deepEqual(candles.map(c => c.t), Array.from({ length: 500 }, (_, i) => (2000 + i) * 60));
});

test('segments persist, rotate, deduplicate across restart and reject a second writer or symlink', () => {
  const dataDir = temp(), history = new TradeHistory({ dataDir, segmentBytes: 1 });
  assert.ok(history.append(row(1))); assert.ok(history.append(row(2))); assert.equal(history.append(row(1)), false);
  assert.throws(() => new TradeHistory({ dataDir }), /locked/);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {TradeHistory} from ${JSON.stringify(new URL('../../../src/market-feed/history.js', import.meta.url).href)}; new TradeHistory({dataDir:process.argv[1]});`, dataDir], { encoding: 'utf8' });
  assert.notEqual(child.status, 0); assert.match(child.stderr, /locked/);
  assert.equal(readdirSync(join(dataDir, 'market-history')).length, 2);
  history.close(); history.close(); assert.throws(() => history.append(row(3)), /closed/);
  const restart = new TradeHistory({ dataDir });
  assert.equal(restart.ids.size, 2); assert.equal(restart.append(row(1)), false); assert.ok(restart.append(row(3)));
  restart.close();
  const badDir = temp(); symlinkSync(join(dataDir, 'market-history.lock'), join(badDir, 'market-history.lock'));
  assert.throws(() => new TradeHistory({ dataDir: badDir }));
});

test('damaged or unterminated last line is reported and repaired before a subsequent durable append', () => {
  for (const [tail, count] of [['{"id":', 1], ['{bad}\n', 1], [JSON.stringify(row(2)), 2]]) {
    const dataDir = temp(), history = new TradeHistory({ dataDir }); history.append(row(1)); history.close();
    appendFileSync(segment(dataDir), tail); const messages = [];
    const restart = new TradeHistory({ dataDir, log: message => messages.push(message) });
    assert.equal(messages.length, 1); assert.match(messages[0], /last line/);
    assert.equal(restart.ids.size, count);
    restart.append(row(3)); restart.close();
    const again = new TradeHistory({ dataDir, log: () => assert.fail('tail repaired already') });
    assert.ok(again.ids.has(row(1).id)); assert.ok(again.ids.has(row(3).id)); again.close();
    assert.ok(readFileSync(segment(dataDir), 'utf8').endsWith('\n'));
  }
  const dataDir = temp(), history = new TradeHistory({ dataDir }); history.append(row(1)); history.close();
  appendFileSync(segment(dataDir), '{bad}\n' + JSON.stringify(row(2)) + '\n');
  assert.throws(() => new TradeHistory({ dataDir }), /Damaged history segment/);
  writeFileSync(segment(dataDir), JSON.stringify(row(1)) + '\n');
  new TradeHistory({ dataDir }).close();
});

test('partial writes complete, while write/flush failures never acknowledge or index an unflushed trade', () => {
  const originalWrite = fs.writeSync, originalSync = fs.fsyncSync;
  for (const mode of ['partial', 'write-failure', 'flush-failure', 'no-progress']) {
    const dataDir = temp(), messages = [], history = new TradeHistory({ dataDir, log: message => messages.push(message) });
    history.append(row(1)); let writes = 0;
    try {
      fs.writeSync = (fd, buffer, offset, length) => {
        writes++;
        if (mode === 'no-progress') return 0;
        if (mode === 'write-failure' && writes > 1) throw new Error('Injected write failure');
        return originalWrite(fd, buffer, offset, Math.min(length, 7));
      };
      fs.fsyncSync = fd => { if (mode === 'flush-failure') throw new Error('Injected flush failure'); return originalSync(fd); };
      syncBuiltinESMExports();
      if (mode === 'partial') assert.equal(history.append(row(2)), true);
      else {
        assert.throws(() => history.append(row(2)), /failure|no progress/);
        assert.equal(history.ids.size, 1); assert.equal(history.candles({ pair, interval: '1y' }).candles[0].v, '0.42');
        assert.throws(() => history.append(row(3)), /reopening/); assert.match(messages[0], /write failed/);
      }
    } finally {
      fs.writeSync = originalWrite; fs.fsyncSync = originalSync; syncBuiltinESMExports(); history.close();
    }
    const restarted = new TradeHistory({ dataDir });
    assert.ok(restarted.ids.has(row(1).id));
    assert.equal(restarted.ids.has(row(2).id), ['partial', 'flush-failure'].includes(mode));
    restarted.append(row(2)); restarted.append(row(3)); assert.equal(restarted.ids.size, 3); restarted.close();
  }
});

test('invalid input fails before writing, and duplicate rows on disk do not inflate candles', () => {
  const dataDir = temp(), history = new TradeHistory({ dataDir });
  for (const bad of [null, {}, row(1, { extra: true }), row(1, { ts: -1 }), row(1, { price: 'NaN' }),
    row(1, { baseAmount: '0' }), row(1, { quoteAmount: '1.1' }), row(1, { pair: '../USDC' }), row(1, { side: 'maker' })]) assert.throws(() => history.append(bad));
  assert.equal(readdirSync(join(dataDir, 'market-history')).length, 0);
  history.append(row(1)); history.close(); appendFileSync(segment(dataDir), JSON.stringify(row(1)) + '\n');
  const loaded = new TradeHistory({ dataDir });
  assert.equal(loaded.ids.size, 1); assert.equal(loaded.candles({ pair, interval: '1y' }).candles[0].v, '0.42'); loaded.close();
  const memory = new TradeHistory();
  for (const limit of [0, -1, 501, 1.5, '2']) assert.throws(() => memory.candles({ pair, interval: '1m', limit }));
  for (const limit of [0, -1, 201, 1.5, '2']) assert.throws(() => memory.trades({ pair, decimals: 8, limit }));
  assert.throws(() => memory.candles({ pair, interval: '2mo' }));
  assert.throws(() => memory.candles({ pair, interval: '1m', before: NaN }));
  assert.throws(() => memory.trades({ pair, decimals: -1 }));
});

test('archive keeps accepted venue trades after view pruning and migrates retained rows before startup pruning', async () => {
  const s = setup(); await s.register();
  const first = s.trade({ ts: 0 }); assert.ok(await s.send('tradeLog', first));
  for (let n = 0; n < 101; n++) assert.ok(await s.send('tradeLog', s.trade({ ts: n + 1 })));
  assert.equal(s.feed.market.trades.size, 100); assert.equal(s.feed.history.ids.size, 102);
  assert.equal(await s.send('tradeLog', first), false);
  assert.equal(await s.send('tradeLog', s.trade(), s.f.buyer), false);
  assert.equal(await s.send('tradeLog', s.trade({ ts: s.clock.t + 1 })), false);
  assert.equal(await s.send('tradeLog', s.trade({ registryVersion: 99 })), false);
  assert.equal(s.feed.history.ids.size, 102);
  assert.equal(s.feed.readTrades({ pair, limit: 200 }).rows.at(-1).id, first.tradeId);
  const rows = Array.from({ length: 105 }, (_, ts) => s.trade({ ts }));
  const store = memoryStore(Object.fromEntries(rows.map(t => ['feed-trade-' + t.tradeId, t]))), history = new TradeHistory();
  new MarketView({ store, now: () => s.clock.t, history });
  assert.equal(store.list('feed-trade-').length, 100); assert.equal(history.ids.size, 105);
});

test('one million durable trades: initial and paged queries stay below 20 ms without request-time aggregation', t => {
  const dataDir = temp(); mkdirSync(join(dataDir, 'market-history'));
  const fd = openSync(segment(dataDir), 'w', 0o600), count = 1000000;
  try {
    for (let start = 0; start < count; start += 1000) {
      const lines = Array.from({ length: 1000 }, (_, i) => JSON.stringify(row(start + i, { ts: 1700000000 + start + i })) + '\n').join('');
      writeSync(fd, lines);
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  const loadStart = performance.now(), history = new TradeHistory({ dataDir });
  t.after(() => {
    history.close(); unlinkSync(segment(dataDir)); unlinkSync(join(dataDir, 'market-history.lock'));
    rmdirSync(join(dataDir, 'market-history')); rmdirSync(dataDir);
  });
  assert.equal(history.ids.size, count);
  const loadMs = performance.now() - loadStart; let max = 0;
  for (const interval of INTERVALS) {
    for (const before of [null, 1700500000, 1700250000]) {
      const start = performance.now(), result = history.candles({ pair, interval, before });
      JSON.stringify(result); const elapsed = performance.now() - start; max = Math.max(max, elapsed);
      assert.ok(elapsed < 20, `${interval} took ${elapsed.toFixed(2)} ms`);
      assert.ok(result.candles.length > 0 && result.candles.length <= 500);
    }
  }
  let before = null;
  for (let i = 0; i < 10; i++) {
    const start = performance.now(), result = history.trades({ pair, decimals: 8, before, limit: 200 });
    JSON.stringify(result); const elapsed = performance.now() - start; max = Math.max(max, elapsed);
    assert.ok(elapsed < 20, `trades took ${elapsed.toFixed(2)} ms`); before = result.next;
  }
  t.diagnostic(`1,000,000 trades: load ${loadMs.toFixed(0)} ms; slowest query incl. JSON ${max.toFixed(2)} ms`);
});
