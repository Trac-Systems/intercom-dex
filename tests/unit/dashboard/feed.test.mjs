import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createMarketFeed, dashboardHandler, MARKET_TIMEOUT_MS } from '../../../src/dashboard/server.js';
import { createModel } from '../../../src/dashboard/model.js';
import { traderFixture, httpCall } from './fixtures.mjs';

const pair = 'RESET/USDC', id = n => n.repeat(64);
const cursor = (t = 1000, key = id('b'), p = pair) => Buffer.from(JSON.stringify([p, t, key])).toString('base64url');
const candle = { t: 60, o: '1', h: '2', l: '0.5', c: '1.5', v: '12.000001' };
const candles = (q = {}) => ({ pair, interval: '1m', candles: [{ ...candle }], ...q });
const trades = () => ({ rows: [
  { id: id('c'), t: 1001, side: 'buy', price: '1.5', amount: '2.00000001', usdc: '3.000001' },
  { id: id('b'), t: 1000, side: null, price: '1', amount: '1', usdc: '1' },
], next: cursor() });
const send = (res, value, status = 200, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(JSON.stringify(value)); };

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); return new Promise(r => server.close(r)); });
  return server;
}
async function setup(t, respond, clock) {
  const requests = [], upstream = await listen(t, (req, res) => { requests.push(req.url); respond(req, res); });
  const fx = traderFixture(), model = createModel({ ...fx });
  const marketFeed = createMarketFeed({ url: `http://127.0.0.1:${upstream.address().port}`, ...(clock ? { clock } : {}) });
  const dashboard = await listen(t), port = dashboard.address().port, token = '2'.repeat(64);
  dashboard.on('request', dashboardHandler({ port, token, model, marketFeed }));
  return { requests, call: path => httpCall(port, { path, cookie: `dexdash${port}=${token}` }), fx };
}
const candlePath = '/api/candles?pair=RESET%2FUSDC&interval=1m', tradePath = '/api/trades?pair=RESET%2FUSDC';

test('history proxy forwards normalized queries and converts decimal volumes and amounts exactly', async t => {
  const s = await setup(t, (req, res) => send(res, req.url.startsWith('/v1/market/candles') ? candles() : trades()));
  const c = await s.call(candlePath); assert.equal(c.status, 200);
  assert.deepEqual(c.json().candles[0].v, { units: '12000001', text: '12.000001', unit: 'USDC' });
  assert.equal(s.requests[0], '/v1/market/candles?pair=RESET%2FUSDC&interval=1m&limit=500');
  const before = cursor(1002, id('f'));
  const r = await s.call(tradePath + '&limit=2&before=' + before); assert.equal(r.status, 200, r.body);
  assert.deepEqual(r.json().rows[0].amount, { units: '200000001', text: '2', unit: 'RESET' });
  assert.deepEqual(r.json().rows[0].usdc, { units: '3000001', text: '3.000001', unit: 'USDC' });
  assert.equal(r.json().next, cursor()); assert.equal(r.json().rows[1].side, null);
  assert.equal(s.requests[1], '/v1/market/trades?pair=RESET%2FUSDC&limit=2&before=' + before);
});

test('every query field is validated before fetch, including duplicate keys and pair-bound cursors', async t => {
  const s = await setup(t, (_, res) => send(res, candles()));
  const bad = ['/api/candles', '/api/candles?pair=RESET%2FUSDC', '/api/candles?pair=UNKNOWN%2FUSDC&interval=1m',
    candlePath + '&interval=1h', candlePath + '&extra=1', candlePath + '&pair=TNK%2FUSDC', candlePath + '&limit=501',
    candlePath + '&limit=0', candlePath + '&limit=-1', candlePath + '&limit=1.0', candlePath + '&limit=01', candlePath + '&limit=1e2',
    candlePath + '&limit=', candlePath + '&before=', candlePath + '&before=9007199254740992', candlePath + '&before=1.5',
    candlePath + '&before=01', candlePath + '&before=1&before=2', candlePath + '&before=1%0A', candlePath + '&limit=1%0A', candlePath.replace('interval=1m', 'interval=1M'),
    '/api/trades', tradePath + '&limit=201', tradePath + '&before=garbage', tradePath + '&before=1',
    tradePath + '&before=' + cursor(1000, id('b'), 'TNK/USDC'), tradePath + '&before=' + cursor(-1),
    tradePath + '&before=' + cursor(1.5), tradePath + '&before=' + cursor(1000, 'invalid-id'), tradePath + '&before=' + cursor(1000, id('b') + '\n'),
    tradePath + '&before=' + cursor() + '=', tradePath + '&interval=1m', tradePath + '&limit=2&limit=2'];
  for (const path of bad) { const r = await s.call(path); assert.equal(r.status, 400, path + ': ' + r.body); }
  assert.equal(s.requests.length, 0);
});

test('all sixteen intervals, boundary limits and signed bucket cursors are accepted', async t => {
  const s = await setup(t, (req, res) => {
    const q = new URL(req.url, 'http://127.0.0.1').searchParams;
    send(res, candles({ interval: q.get('interval'), candles: [] }));
  });
  for (const interval of '1m 3m 5m 15m 30m 1h 2h 4h 8h 12h 1d 2d 3d 1w 1mo 1y'.split(' ')) {
    assert.equal((await s.call(candlePath.replace('interval=1m', `interval=${interval}`) + '&limit=1&before=-259200')).status, 200);
  }
  assert.equal(s.requests.length, 16);
});

test('each normalized query is cached for five seconds, concurrent duplicates coalesce and failures retry', async t => {
  let ms = 0, fail = false;
  const s = await setup(t, (_, res) => send(res, fail ? { error: 'upstream detail' } : candles(), fail ? 500 : 200), () => ms);
  const first = await Promise.all([s.call(candlePath), s.call(candlePath), s.call('/api/candles?limit=500&interval=1m&pair=RESET%2FUSDC')]);
  assert.ok(first.every(r => r.status === 200)); assert.equal(s.requests.length, 1);
  ms = 4999; await s.call(candlePath); assert.equal(s.requests.length, 1);
  ms = 5000; await s.call(candlePath); assert.equal(s.requests.length, 2);
  await s.call(candlePath + '&before=120'); assert.equal(s.requests.length, 3);
  fail = true;
  for (let i = 0; i < 2; i++) {
    const r = await s.call(candlePath + '&limit=1'); assert.equal(r.status, 502); assert.equal(r.json().error, 'Market feed unavailable');
  }
  assert.equal(s.requests.length, 5);
  fail = false; assert.equal((await s.call(candlePath + '&limit=1')).status, 200); assert.equal(s.requests.length, 6);
});

test('at most four distinct feed requests are in flight, duplicates share the slot, and capacity is released', async t => {
  const waiting = []; let ready;
  const started = new Promise(r => { ready = r; });
  const s = await setup(t, (_, res) => { waiting.push(res); if (waiting.length === 4) ready(); });
  const requests = [1, 2, 3, 4].map(limit => s.call(candlePath + '&limit=' + limit));
  await started;
  const duplicate = s.call(candlePath + '&limit=1');
  const busy = await s.call(candlePath + '&limit=5'); assert.equal(busy.status, 503);
  assert.equal(s.requests.length, 4);
  waiting.forEach(res => send(res, candles()));
  assert.ok((await Promise.all([...requests, duplicate])).every(r => r.status === 200));
  const next = s.call(candlePath + '&limit=6');
  while (waiting.length < 5) await new Promise(r => setImmediate(r));
  send(waiting.at(-1), candles()); assert.equal((await next).status, 200);
});

test('invalid candle JSON is rejected and never passes upstream strings or fields through', async t => {
  let value, raw = false;
  const s = await setup(t, (_, res) => { if (raw) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(value); } else send(res, value); });
  const invalid = [null, [], {}, candles({ pair: 'TNK/USDC' }), candles({ interval: '1h' }), candles({ candles: {} }),
    candles({ candles: [null] }), candles({ candles: [{ ...candle, t: '60' }] }), candles({ candles: [{ ...candle, o: 1 }] }),
    candles({ candles: [{ ...candle, h: '0.9' }] }), candles({ candles: [{ ...candle, l: '1.1' }] }),
    candles({ candles: [{ ...candle, c: 'Infinity' }] }), candles({ candles: [{ ...candle, v: '-1' }] }),
    candles({ candles: [{ ...candle, o: '1\n' }] }), candles({ candles: [{ ...candle, v: '1\n' }] }),
    candles({ candles: [{ ...candle, v: '0.0000001' }] }), candles({ candles: [candle, candle] }),
    candles({ candles: [{ ...candle, t: 120 }, candle] })];
  for (value of invalid) {
    const r = await s.call(candlePath); assert.equal(r.status, 502, JSON.stringify(value));
    assert.deepEqual(r.json(), { error: 'Invalid market feed response' });
  }
  value = candles(); assert.equal((await s.call(candlePath + '&before=60')).status, 502);
  value = candles({ candles: [candle, { ...candle, t: 120 }] }); assert.equal((await s.call(candlePath + '&limit=1')).status, 502);
  raw = true; value = '<script>upstream text</script>'; assert.equal((await s.call(candlePath)).json().error, 'Invalid market feed response');
  raw = false; value = { ...candles(), injected: '<script>', candles: [{ ...candle, injected: '<script>' }] };
  const good = await s.call(candlePath); assert.equal(good.status, 200); assert.ok(!good.body.includes('injected')); assert.ok(!good.body.includes('<script>'));
});

test('trade JSON validates identifiers, amounts, ordering, before and next cursors', async t => {
  let value;
  const s = await setup(t, (_, res) => send(res, value));
  const row = trades().rows[0];
  const invalid = [{ rows: [], next: cursor() }, { rows: {}, next: null }, { rows: [row] },
    { ...trades(), next: 'garbage' }, { ...trades(), next: cursor(999) },
    ...[{ id: 'bad' }, { id: id('c') + '\n' }, { t: -1 }, { side: 'maker' }, { side: undefined }, { amount: '0' }, { amount: '0.000000001' }, { usdc: 1 }, { price: 'NaN' }]
      .map(patch => ({ rows: [{ ...row, ...patch }], next: null })),
    { rows: [row, row], next: null }, { rows: trades().rows.toReversed(), next: null }];
  for (value of invalid) assert.equal((await s.call(tradePath)).status, 502, JSON.stringify(value));
  value = trades(); assert.equal((await s.call(tradePath + '&before=' + cursor(1000))).status, 502);
  assert.equal((await s.call(tradePath + '&limit=1')).status, 502);
  value = { rows: [], next: null }; assert.deepEqual((await s.call(tradePath)).json(), value);
});

test('HTTP errors, redirects, non-JSON and oversized responses are bounded and sanitized', async t => {
  let mode = 'status';
  const s = await setup(t, (_, res) => {
    if (mode === 'status') return send(res, { error: 'private upstream diagnostics' }, 500);
    if (mode === 'redirect') { res.writeHead(302, { location: 'http://127.0.0.1:1/unreachable' }); return res.end(); }
    if (mode === 'text') return send(res, candles(), 200, 'text/html');
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('x'.repeat(2 * 1024 * 1024 + 1));
  });
  for (mode of ['status', 'redirect', 'text', 'size']) {
    const r = await s.call(candlePath); assert.equal(r.status, 502); assert.deepEqual(r.json(), { error: 'Market feed unavailable' });
  }
  assert.equal(s.requests.length, 4);
});

test('the eight-second deadline also covers a response body that stalls', async t => {
  let stall = true;
  const s = await setup(t, (_, res) => {
    if (!stall) return send(res, candles());
    res.writeHead(200, { 'content-type': 'application/json' }); res.write('{');
  });
  assert.equal(MARKET_TIMEOUT_MS, 8000);
  const start = Date.now(), r = await s.call(candlePath);
  assert.equal(r.status, 504); assert.deepEqual(r.json(), { error: 'Market feed timed out' });
  assert.ok(Date.now() - start >= 7900 && Date.now() - start < 12000);
  stall = false; assert.equal((await s.call(candlePath)).status, 200, 'timed-out requests release their slot and are not cached');
});

test('zero protocol prices remain valid decimal strings in public trades and candles', async t => {
  const s = await setup(t, (req, res) => send(res, req.url.startsWith('/v1/market/candles')
    ? candles({ candles: [{ ...candle, o: '0', h: '0', l: '0', c: '0' }] })
    : { rows: [{ ...trades().rows[0], price: '0' }], next: null }));
  assert.equal((await s.call(candlePath)).json().candles[0].o, '0');
  assert.equal((await s.call(tradePath)).json().rows[0].price, '0');
});

test('state takes each pair\'s 24-hour change from the public market view and stays up without it', async t => {
  let mode = 'ok';
  const s = await setup(t, (req, res) => {
    if (mode === 'down') return send(res, { error: 'x' }, 502);
    send(res, { pairs: [{ pair, change24h: '-0.0412' }, { pair: 'TNK/USDC', change24h: 'NaN' }] });
  });
  const ok = await s.call('/api/state'); assert.equal(ok.status, 200, ok.body);
  assert.equal(s.requests[0], '/v1/market/view');
  assert.equal(ok.json().trader.pairs.find(p => p.pair === pair).change24h, '-0.0412');
  for (const p of ok.json().trader.pairs.filter(p => p.pair !== pair)) assert.equal(p.change24h, null);
  mode = 'down';
  const s2 = await setup(t, (req, res) => send(res, { error: 'x' }, 502));
  const down = await s2.call('/api/state'); assert.equal(down.status, 200, down.body);
  for (const p of down.json().trader.pairs) assert.equal(p.change24h, null);
});
