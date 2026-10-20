import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startMarketFeedHttp } from '../../../src/market-feed/http.js';
import { setup } from './helpers.mjs';
import { SOL2 } from '../core/helpers.mjs';

async function http(t) {
  const s = setup(); await s.register();
  const token = randomBytes(32).toString('hex'), dir = mkdtempSync(join(tmpdir(), 'feed-http-')), viewerKeyFile = join(dir, 'viewer.token');
  writeFileSync(viewerKeyFile, token, { mode: 0o600 });
  const server = await startMarketFeedHttp({ feed: s.feed, port: 0, viewerKeyFile });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = 'http://127.0.0.1:' + server.address().port;
  const post = (body, auth = token, path = '/v1/market/chat/viewer') => fetch(url + path, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth === null ? {} : { authorization: 'Bearer ' + auth }) }, body: JSON.stringify(body) });
  return { ...s, server, url, post, token, viewerKeyFile, dir };
}

test('public history routes preserve decimals, page exclusively and use five-second ETags', async t => {
  const s = await http(t), pair = 'RESET/USDC', query = '?pair=RESET%2FUSDC';
  const records = [s.trade({ ts: 199800, price: '1', quoteAmount: '1000001' }),
    s.trade({ ts: 199801, price: '2', quoteAmount: '2000002' }), s.trade({ ts: 199920, price: '3', quoteAmount: '3000003' })];
  for (const record of records) assert.ok(await s.send('tradeLog', record));
  const paths = ['/v1/market/candles' + query + '&interval=1m', '/v1/market/trades' + query];
  for (const path of paths) {
    const res = await fetch(s.url + path), etag = res.headers.get('etag'), body = await res.json();
    assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'max-age=5'); assert.match(etag, /^"[a-f0-9]{64}"$/);
    for (const match of [etag, 'W/' + etag, '"other", ' + etag, '*']) {
      const cached = await fetch(s.url + path, { headers: { 'if-none-match': match } });
      assert.equal(cached.status, 304); assert.equal(await cached.text(), ''); assert.equal(cached.headers.get('etag'), etag);
    }
    assert.deepEqual(body, path.includes('/candles') ? { pair, interval: '1m', candles: [
      { t: 199800, o: '1', h: '2', l: '1', c: '2', v: '3.000003' },
      { t: 199920, o: '3', h: '3', l: '3', c: '3', v: '3.000003' },
    ] } : { rows: [...records].reverse().map(r => ({ id: r.tradeId, t: r.ts, side: null, price: r.price, amount: '1200', usdc: r.price + '.' + String(Number(r.price)).padStart(6, '0') })), next: null });
    s.clock.t++;
    assert.equal((await fetch(s.url + path, { headers: { 'if-none-match': etag } })).status, 304);
  }
  const page = await (await fetch(s.url + paths[1] + '&limit=2')).json();
  assert.equal(page.rows.length, 2); assert.equal(typeof page.next, 'string');
  const older = await (await fetch(s.url + paths[1] + '&limit=2&before=' + page.next)).json();
  assert.deepEqual(older.rows.map(r => r.id), [records[0].tradeId]); assert.equal(older.next, null);
  const candles = await (await fetch(s.url + paths[0] + '&limit=1&before=199920')).json();
  assert.deepEqual(candles.candles.map(c => c.t), [199800]);
  const before = await fetch(s.url + paths[0]), etag = before.headers.get('etag'); await before.arrayBuffer();
  assert.ok(await s.send('tradeLog', s.trade({ ts: 199930, price: '4' })));
  assert.equal((await fetch(s.url + paths[0], { headers: { 'if-none-match': etag } })).status, 200);
  assert.deepEqual(await (await fetch(s.url + '/v1/market/trades?pair=TNK%2FUSDC')).json(), { rows: [], next: null });
});

test('history endpoints reject unknown/duplicate parameters, unknown pairs, invalid limits and cursors', async t => {
  const s = await http(t), pair = 'pair=RESET%2FUSDC';
  for (const route of ['candles', 'trades']) {
    const base = pair + (route === 'candles' ? '&interval=1m' : '');
    for (const query of ['', 'pair=UNKNOWN%2FUSDC', base + '&x=1', base + '&pair=RESET%2FUSDC',
      ...['', '0', '-1', '01', '1.5', '1e2', '2010', '1%0a'].map(limit => base + '&limit=' + limit),
      base + '&limit=1&limit=2', base + '&before=&before=1', base + '&before=']) {
      const res = await fetch(s.url + `/v1/market/${route}?${query}`);
      assert.equal(res.status, 400, `${route} ${query}`); assert.equal(res.headers.get('cache-control'), 'no-store');
    }
    assert.equal((await fetch(s.url + `/v1/market/${route}?${base}`, { method: 'POST' })).status, 404);
  }
  for (const extra of ['interval=2m', 'interval=1m&interval=5m', 'interval=', 'interval=1m&before=01',
    'interval=1m&before=9007199254740992', 'interval=1m&before=1.5', 'interval=1m&before=1%0a', 'interval=1m&limit=501']) {
    assert.equal((await fetch(s.url + '/v1/market/candles?' + pair + '&' + extra)).status, 400, extra);
  }
  for (const extra of ['interval=1m', 'limit=201', 'before=123', 'before=abc']) {
    assert.equal((await fetch(s.url + '/v1/market/trades?' + pair + '&' + extra)).status, 400, extra);
  }
  const pairs = s.f.registry.pairs.map(p => ({ ...p, status: 'paused' }));
  assert.ok(await s.send('registry', { ...s.f.registry, version: 2, pairs }));
  assert.equal((await fetch(s.url + '/v1/market/trades?' + pair)).status, 200);
  s.feed.history.trades = () => { throw new Error('internal failure'); };
  const failure = await fetch(s.url + '/v1/market/trades?' + pair);
  assert.equal(failure.status, 500); assert.deepEqual(await failure.json(), { ok: false, error: 'unavailable' });
});

test('loopback view serves exact cached bytes, strong ETag and 304 until a meaningful change', async t => {
  const s = await http(t); assert.equal(s.server.address().address, '127.0.0.1');
  const first = await fetch(s.url + '/v1/market/view'), etag = first.headers.get('etag'), bytes = await first.text();
  assert.match(etag, /^"[a-f0-9]{64}"$/); assert.equal(first.headers.get('cache-control'), 'max-age=10'); assert.equal(bytes, s.feed.view().json);
  s.clock.t++;
  for (const match of [etag, 'W/' + etag, '"other", ' + etag, '*']) {
    const result = await fetch(s.url + '/v1/market/view', { headers: { 'if-none-match': match } });
    assert.equal(result.status, 304); assert.equal(await result.text(), ''); assert.equal(result.headers.get('etag'), etag);
  }
  const o = s.offer({ expiresAt: s.clock.t + 2 }); await s.send('offer', o, s.f.seller, 'intercom-dex:offers');
  const changed = await fetch(s.url + '/v1/market/view', { headers: { 'if-none-match': etag } });
  assert.equal(changed.status, 200); const active = changed.headers.get('etag'); assert.notEqual(active, etag);
  s.clock.t += 2;
  const expired = await fetch(s.url + '/v1/market/view', { headers: { 'if-none-match': active } });
  assert.equal(expired.status, 200); assert.deepEqual((await expired.json()).offers, []);
});

test('chat gateway shape meets talk.rs cursors, address and viewer-skip expectations', async t => {
  const s = await http(t), offer = s.offer();
  await s.send('offer', offer, s.f.seller, 'intercom-dex:offers');
  await s.send('chat', { text: 'Market update', ts: s.clock.t }, s.f.seller, 'intercom-dex:chat');
  await s.send('chat', { text: 'Unmapped', ts: s.clock.t }, s.f.buyer, 'intercom-dex:chat');
  await s.post({ id: '123-abc', name: 'Guest', text: 'Viewer update' });
  const result = await fetch(s.url + '/v1/market/chat'), data = await result.json();
  assert.deepEqual(Object.keys(data).sort(), ['epoch', 'messages', 'more', 'next', 'now', 'ok', 'oldest']);
  assert.equal(data.ok, true); assert.match(data.epoch, /^[A-Za-z0-9_-]{1,32}$/); assert.equal(data.next, 3);
  assert.deepEqual(data.messages, [
    { seq: 1, kind: 'agent', text: 'Market update', ts: s.clock.t, addr: offer.maker.tracAddr },
    { seq: 2, kind: 'agent', text: 'Unmapped', ts: s.clock.t, addr: s.f.terms.buyer.dexKey },
    { seq: 3, kind: 'viewer', name: 'Guest', text: 'Viewer update', ts: s.clock.t }]);
  const after = await (await fetch(s.url + '/v1/market/chat?after=1')).json();
  assert.deepEqual(after.messages.map(m => m.seq), [2, 3]);
  const empty = await (await fetch(s.url + '/v1/market/chat?after=3')).json(); assert.equal(empty.next, 3); assert.deepEqual(empty.messages, []);
  for (const query of ['after=-1', 'after=1.2', 'after=01', 'after=1&after=2', 'after=9007199254740992', 'after=', 'other=1']) {
    assert.equal((await fetch(s.url + '/v1/market/chat?' + query)).status, 400, query);
  }
});

test('viewer auth, strict input, sanitized display names, replay ids and transport reservation', async t => {
  const s = await http(t), body = { id: '123-0123456789abcdef', name: '  Élise / Jane@ 🌎 abcdefghijklmnopqrstuvwxyz ', text: '  Hello market  ' };
  assert.equal((await s.post(body, null)).status, 401); assert.equal((await s.post(body, 'a'.repeat(64))).status, 401);
  assert.equal(s.bridge.sent.length, 0);
  const [first, duplicate] = await Promise.all([s.post(body), s.post(body)]);
  assert.equal(first.status, 200); assert.equal(duplicate.status, 200);
  assert.equal(s.bridge.sent.length, 1);
  const wire = s.bridge.sent[0].envelope;
  assert.equal(wire.from, s.identity.publicKey); assert.equal(wire.body.text, 'Hello market');
  assert.equal(wire.body.name, 'lise Jane abcdefghijklmn'); assert.ok(wire.body.name.length <= 24);
  const replay = await s.post(body); assert.deepEqual(await replay.json(), { ok: true, duplicate: true });
  assert.equal((await s.post({ ...body, text: 'changed' })).status, 409);
  assert.equal((await s.post({ ...body, id: 'new', text: 'another' })).status, 429);
  for (const bad of [{ ...body, id: '../bad' }, { ...body, id: 'newline\n' }, { ...body, extra: true }, { id: 'a', name: 'A', text: '\nno' }, {}, null]) assert.equal((await s.post(bad)).status, 400);
  s.clock.t++;
  assert.equal((await s.post({ id: 'unicode', name: '🌎', text: 'unicode name' })).status, 200);
  assert.equal(s.bridge.sent.at(-1).envelope.body.name, 'Viewer');
  s.clock.t++;
  s.bridge.send = async () => { throw new Error('failed'); };
  const fail = { id: 'failure', name: 'A', text: 'Ambiguous transport' };
  assert.equal((await s.post(fail)).status, 502);
  const restarted = setup({ store: s.store, key: s.key, f: s.f, clock: s.clock });
  assert.deepEqual(await restarted.feed.postViewer(fail), { ok: true, duplicate: true });
  assert.equal(restarted.bridge.sent.length, 0); assert.notEqual(restarted.feed.epoch, s.feed.epoch);
});

test('strict routes, bounded JSON bodies and private regular token file', async t => {
  const s = await http(t);
  for (const path of ['/status', '/chat', '/v1/market/view?x=1', '/v1/market/view/', '/v1/market/other']) assert.equal((await fetch(s.url + path)).status, 404);
  assert.equal((await fetch(s.url + '/v1/market/view', { method: 'POST' })).status, 404);
  assert.equal((await s.post({ id: 'large', name: 'A', text: 'a'.repeat(5000) })).status, 413);
  const headers = { authorization: 'Bearer ' + s.token, 'content-type': 'application/json' };
  const bad = await fetch(s.url + '/v1/market/chat/viewer', { method: 'POST', headers, body: '{' });
  assert.equal(bad.status, 400); assert.deepEqual(await bad.json(), { ok: false, error: 'format' });
  assert.equal((await fetch(s.url + '/v1/market/chat/viewer', { method: 'POST', headers: { authorization: headers.authorization }, body: '{}' })).status, 415);
  for (const port of [-1, 65536, 1.2, '1']) await assert.rejects(startMarketFeedHttp({ feed: s.feed, port, viewerKeyFile: s.viewerKeyFile }), /port/);
  await assert.rejects(startMarketFeedHttp({ feed: s.feed, port: 0, viewerKeyFile: 'relative' }), /absolute/);
  chmodSync(s.viewerKeyFile, 0o644);
  await assert.rejects(startMarketFeedHttp({ feed: s.feed, port: 0, viewerKeyFile: s.viewerKeyFile }), /0600/);
  chmodSync(s.viewerKeyFile, 0o600);
  const link = join(s.dir, 'link'); symlinkSync(s.viewerKeyFile, link);
  await assert.rejects(startMarketFeedHttp({ feed: s.feed, port: 0, viewerKeyFile: link }));
  writeFileSync(s.viewerKeyFile, 'short');
  await assert.rejects(startMarketFeedHttp({ feed: s.feed, port: 0, viewerKeyFile: s.viewerKeyFile }), /Invalid viewer key/);
});

test('view fits 60000 UTF-8 bytes with 200 maximum-size offers and 100 maximum-size trades', async t => {
  const s = await http(t), max = Number.MAX_SAFE_INTEGER, amount = '9'.repeat(31), price = amount + '.' + '9'.repeat(12);
  s.clock.t = max - 1000;
  const pairs = Array.from({ length: 64 }, (_, i) => ({ ...s.f.registry.pairs[1],
    pair: String(i).padStart(75, 'A') + '/USDC' }));
  assert.ok(await s.send('registry', { ...s.f.registry, version: 2, pairs }));
  const inputs = [];
  for (let i = 0; i < 200; i++) {
    s.clock.t++;
    const offer = s.offer({ pair: pairs[0].pair, registryVersion: 2, baseAmount: amount, price, expiresAt: max,
      software: '0.1.0+' + 'a'.repeat(122), maker: { dexKey: s.f.terms.seller.dexKey, tracAddr: s.f.terms.seller.tracAddr, solAddr: SOL2 } });
    assert.ok(s.feed.market.offer(offer, offer.maker.dexKey)); inputs.unshift(offer.offerId);
  }
  assert.ok(s.feed.market.book({ pair: pairs[0].pair, registryVersion: 2, ts: s.clock.t, seq: 1, levels: [],
    remaining: inputs.map(offerId => ({ offerId, amount })) }));
  const read = async () => {
    const res = await fetch(s.url + '/v1/market/view'), bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(res.status, 200); assert.ok(bytes.length <= 60000, String(bytes.length));
    assert.equal(bytes.toString(), s.feed.view().json);
    const data = JSON.parse(bytes);
    assert.deepEqual(data.pairs.map(p => p.pair), pairs.map(p => p.pair));
    return { data, bytes: bytes.length, etag: res.headers.get('etag') };
  };
  const first = await read();
  assert.ok(first.data.offers.length > 0 && first.data.offers.length < 200);
  assert.deepEqual(first.data.offers.map(o => o.offerId), inputs.slice(0, first.data.offers.length));
  const trades = [];
  for (let i = 0; i < 100; i++) {
    const trade = s.trade({ pair: pairs[0].pair, registryVersion: 2, baseAmount: amount, quoteAmount: amount, price,
      ts: s.clock.t - 99 + i, seller: { tracAddr: s.f.terms.seller.tracAddr, solAddr: SOL2 },
      buyer: { tracAddr: s.f.terms.buyer.tracAddr, solAddr: SOL2 } });
    assert.ok(s.feed.market.trade(trade)); trades.unshift(trade.tradeId);
    if (i === 9) {
      const partial = await read();
      assert.equal(partial.data.trades.length, 10);
      assert.ok(partial.data.offers.length > 0 && partial.data.offers.length < first.data.offers.length);
      assert.deepEqual(partial.data.offers.map(o => o.offerId), inputs.slice(0, partial.data.offers.length));
    }
  }
  const full = await read();
  assert.deepEqual(full.data.offers, []);
  assert.ok(full.data.trades.length > 0 && full.data.trades.length < 100);
  assert.deepEqual(full.data.trades.map(t => t.id), trades.slice(0, full.data.trades.length));
  assert.equal(full.data.pairs[0].trades24h, 100, 'response trimming preserves complete statistics');
  assert.equal(s.feed.market.offers.size, 200); assert.equal(s.feed.market.trades.size, 100);
  const unchanged = await fetch(s.url + '/v1/market/view', { headers: { 'if-none-match': full.etag } });
  assert.equal(unchanged.status, 304);
  t.diagnostic(`view bytes: offers=${first.bytes}, offers+trades=${full.bytes}`);
});

test('chat drops oldest messages to fit 60000 UTF-8 bytes and reports truncation and cursors', async t => {
  const s = await http(t), name = 'V'.repeat(24);
  for (let i = 0; i < 100; i++) {
    s.clock.t++;
    const text = String.fromCodePoint(0x1f300 + i).repeat(280);
    assert.equal((await s.feed.postViewer({ id: String(i), name, text })).ok, true);
  }
  const res = await fetch(s.url + '/v1/market/chat?after=0'), bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(res.status, 200); assert.ok(bytes.length <= 60000);
  const data = JSON.parse(bytes);
  assert.ok(data.messages.length > 0 && data.messages.length < 100);
  assert.equal(data.more, true); assert.equal(data.next, 100); assert.equal(data.oldest, 1);
  assert.deepEqual(data.messages.map(m => m.seq), Array.from({ length: data.messages.length }, (_, i) => 101 - data.messages.length + i));
  assert.equal(data.messages[0].name, name); assert.equal([...data.messages[0].text].length, 280);
  const prior = s.feed.messages.find(m => m.seq === data.messages[0].seq - 1);
  const { from, ...omitted } = prior;
  assert.ok(Buffer.byteLength(JSON.stringify({ ...data, messages: [omitted, ...data.messages] })) > 60000);
  const head = await (await fetch(s.url + '/v1/market/chat')).json();
  assert.equal(head.messages.length, 20); assert.equal(head.more, false); assert.equal(head.next, 100);
  const empty = await (await fetch(s.url + '/v1/market/chat?after=' + data.next)).json();
  assert.deepEqual(empty.messages, []); assert.equal(empty.more, false); assert.equal(empty.next, 100);
  assert.equal(s.feed.messages.length, 100, 'response trimming keeps the retained history');
  t.diagnostic(`chat bytes: ${bytes.length}`);
});
