import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dashboardHandler, readStatic } from '../../../src/dashboard/server.js';
import { traderFixture, signerFixture, serviceFixture, startFor, httpCall } from './fixtures.mjs';

const get = (s, path) => httpCall(s.port, { path, cookie: s.cookie });

test('book route returns exact contract levels and refuses missing, unknown, duplicate and extra parameters', async t => {
  const fx = traderFixture(), s = await startFor(t, fx);
  const r = await get(s, '/api/book?pair=TNK%2FUSDC');
  assert.equal(r.status, 200);
  const b = r.json();
  assert.deepEqual(Object.keys(b).sort(), ['asks', 'at', 'base', 'bids', 'pair', 'spread']);
  assert.deepEqual(Object.keys(b.asks[0]).sort(), ['amount', 'count', 'mine', 'price', 'take', 'total']);
  assert.equal(b.asks[1].mine.text, '9'); assert.equal(b.asks[1].take, null);
  assert.equal(b.asks[0].take.offerId, fx.theirs[0].offerId);
  for (const q of ['', 'pair=', 'pair=UNKNOWN%2FUSDC', 'pair=TNK%2FUSDC&pair=TNK%2FUSDC', 'pair=TNK%2FUSDC&limit=10']) {
    assert.equal((await get(s, '/api/book?' + q)).status, 400, q);
  }
  fx.role.offers.get(fx.theirs[0].offerId).lastSeen -= 300;
  assert.equal((await get(s, '/api/book?pair=TNK%2FUSDC')).json().asks[0].price, '0.44');
  const empty = (await get(s, '/api/book?pair=RESET%2FUSDC')).json();
  assert.deepEqual([empty.asks, empty.bids, empty.spread], [[], [], null]);
  const signer = await startFor(t, signerFixture());
  assert.equal((await get(signer, '/api/book?pair=TNK%2FUSDC')).status, 400);
});

test('trader lists page all rows beyond former caps and state contains only counts plus at most 20 attention rows', async t => {
  const fx = traderFixture(), sample = fx.role.host.trades.get('t-off');
  for (let i = 0; i < 450; i++) fx.role.host.trades.set(`extra-${i}`, { ...sample, key: `extra-${i}`, state: { ...sample.state, now: fx.now - i } });
  const s = await startFor(t, fx), state = (await get(s, '/api/state')).json().trader;
  assert.equal(state.counts.history, 452); assert.equal(state.attention.length, 20);
  assert.equal(state.counts.attention, 453);
  for (const name of ['market', 'offers', 'running', 'history']) assert.equal(Object.hasOwn(state, name), false);
  const page = (await get(s, '/api/list?name=trader.history&offset=200&limit=200')).json();
  assert.equal(page.total, 452); assert.equal(page.rows.length, 200);
  assert.equal(page.rows[0].key, 'extra-200'); assert.ok(page.rows.every(r => r.outcome));
  assert.equal((await get(s, '/api/list?name=trader.history')).json().rows.length, 100);
  assert.deepEqual((await get(s, '/api/list?name=trader.history&offset=999')).json(), { total: 452, rows: [] });
  assert.equal((await get(s, '/api/list?name=trader.attention&offset=400&limit=200')).json().rows.length, 53);
  assert.equal((await get(s, '/api/list?name=trader.offers')).json().rows[0].left.text, '9');
  assert.ok((await get(s, '/api/list?name=trader.running')).json().rows.every(r => r.line));
  for (const q of ['', 'name=trader.unknown', 'name=signer.pieces', 'name=trader.history&offset=-1', 'name=trader.history&offset=1000000001',
    'name=trader.history&offset=1.5', 'name=trader.history&offset=', 'name=trader.history&offset=01', 'name=trader.history&limit=0',
    'name=trader.history&limit=201', 'name=trader.history&limit=1e2', 'name=trader.history&limit=1&limit=2', 'name=trader.history&extra=x', 'name=__proto__']) {
    assert.equal((await get(s, '/api/list?' + q)).status, 400, q);
  }
});

test('signer and service lists preserve row shapes, sorting and summaries without embedding their lists', async t => {
  const sf = signerFixture(), s = await startFor(t, sf), state = (await get(s, '/api/state')).json().signer;
  assert.deepEqual(state.counts, { pieces: 3, recent: 3 });
  assert.equal(state.pieces.list, undefined); assert.equal(state.recent, undefined);
  assert.deepEqual(state.pieces, { held: 3, nextAt: sf.now });
  const pieces = (await get(s, '/api/list?name=signer.pieces&offset=1&limit=1')).json();
  assert.equal(pieces.total, 3); assert.equal(pieces.rows[0].until, sf.now + 400);
  assert.equal((await get(s, '/api/list?name=signer.recent')).json().total, 3);
  const vf = serviceFixture(), v = await startFor(t, vf), venue = (await get(v, '/api/state')).json().service;
  assert.equal(venue.signers, undefined); assert.equal(venue.counts.signers, vf.f.registry.signers.length);
  const list = (await get(v, '/api/list?name=service.signers&limit=1')).json();
  assert.equal(list.total, venue.counts.signers); assert.equal(list.rows[0].dexKey, vf.f.registry.signers[0].dexKey);
  assert.equal(list.rows[0].owed.unit, 'USDC');
  assert.equal((await get(v, '/api/list?name=trader.history')).status, 400);
});

test('local and testnet history routes have no feed; every new route requires the dashboard cookie', async t => {
  for (const network of ['local', 'testnet']) {
    const fx = traderFixture(); fx.config.network = network;
    const s = await startFor(t, fx);
    for (const path of ['/api/candles?pair=RESET%2FUSDC&interval=1m', '/api/trades?pair=RESET%2FUSDC']) {
      const r = await get(s, path);
      assert.equal(r.status, 400); assert.deepEqual(r.json(), { error: 'No market feed for this network' });
    }
    for (const path of ['/api/book?pair=TNK%2FUSDC', '/api/list?name=trader.history', '/api/candles?pair=TNK%2FUSDC&interval=1m', '/api/trades?pair=TNK%2FUSDC']) {
      assert.equal((await httpCall(s.port, { path })).status, 401);
    }
  }
});

test('static files are read once recursively with an extension allowlist, no symlinks, no traversal and no directory listing', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dash-static-')), dir = join(root, 'static'); mkdirSync(dir); mkdirSync(join(dir, 'vendor'));
  for (const name of ['index.html', 'app.js', 'style.css', 'vendor/chart.mjs', 'vendor/image.svg', 'vendor/image.png', 'vendor/font.woff2', 'notice.txt']) writeFileSync(join(dir, name), name);
  writeFileSync(join(dir, 'secret.json'), 'not-public'); writeFileSync(join(root, 'outside.txt'), 'not-public');
  symlinkSync(join(root, 'outside.txt'), join(dir, 'linked.txt')); symlinkSync(root, join(dir, 'linked-dir'));
  const files = readStatic(pathToFileURL(dir + '/'));
  writeFileSync(join(dir, 'app.js'), 'changed after loading');
  const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const port = server.address().port, token = '1'.repeat(64), cookie = `dexdash${port}=${token}`;
  server.on('request', dashboardHandler({ port, token, staticFiles: files }));
  const call = path => httpCall(port, { path, cookie });
  assert.equal((await call('/app.js')).body, 'app.js'); assert.equal((await call('/')).body, 'index.html');
  for (const [path, type] of [['/index.html', 'text/html'], ['/app.js', 'text/javascript'], ['/vendor/chart.mjs', 'text/javascript'],
    ['/style.css', 'text/css'], ['/vendor/image.svg', 'image/svg+xml'], ['/vendor/image.png', 'image/png'], ['/vendor/font.woff2', 'font/woff2'], ['/notice.txt', 'text/plain']]) {
    const r = await call(path); assert.equal(r.status, 200, path); assert.ok(r.headers['content-type'].startsWith(type));
    assert.match(r.headers['content-security-policy'], /script-src 'self'; style-src 'self'/);
    assert.ok(!r.headers['content-security-policy'].includes('unsafe-inline'));
  }
  for (const path of ['/vendor/', '/secret.json', '/linked.txt', '/linked-dir/outside.txt', '/outside.txt', '/__proto__', '/constructor', '/%252e%252e/outside.txt']) {
    const r = await call(path); assert.equal(r.status, 404, path); assert.ok(!r.body.includes('not-public'));
  }
  for (const path of ['/../outside.txt', '/vendor/../app.js', '/%2e%2e/outside.txt', '/vendor%2f..%2fapp.js', '/vendor%5c..%5capp.js', '/%00', '/%xx']) {
    assert.equal((await call(path)).status, 400, path);
  }
  assert.equal((await httpCall(port, { path: '/vendor/chart.mjs' })).status, 401);
  assert.equal((await httpCall(port, { path: '/app.js', cookie: `dexdash${port}=${'é'.repeat(64)}` })).status, 401);
});
