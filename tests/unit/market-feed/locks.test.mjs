import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { generateIdentity, encodeKey } from '../../../src/core/keys.js';
import { MarketFeed } from '../../../src/roles/market-feed.js';
import { startMarketFeedHttp } from '../../../src/market-feed/http.js';
import { MAIN, seal } from '../../../src/locks/transport.js';
import { FakeBridge, memoryStore } from './helpers.mjs';

const id = () => { const k = generateIdentity(); return { publicKey: encodeKey(k.publicKey), secretKey: encodeKey(k.secretKey) }; };
const body = (ts, extra = {}) => ({ ts, counted: 972800, blockAt: ts - 300, signers: [{ n: 1, online: true }], offers: [], running: [], ended: [], ...extra });

test('the feed serves the lock venue\'s newest signed summary and ignores everyone else', async t => {
  const venue = id(), other = id(), clock = { t: 1792760000 }, bridge = new FakeBridge();
  bridge.request = async m => { bridge.joined.push(m.channel); return { type: 'joined' }; };
  const feed = new MarketFeed({ bridge, identity: id(), store: memoryStore(), serviceKey: id().publicKey, locksVenueKey: venue.publicKey, now: () => clock.t });
  const wire = (from, b, kind = 'summary') => seal({ kind, ch: MAIN, body: b }, from.secretKey, { ts: clock.t });
  const dir = mkdtempSync(join(tmpdir(), 'feed-locks-')), viewerKeyFile = join(dir, 'viewer.token');
  writeFileSync(viewerKeyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const server = await startMarketFeedHttp({ feed, port: 0, viewerKeyFile });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = 'http://127.0.0.1:' + server.address().port + '/v1/locks/view';
  assert.equal((await fetch(url)).status, 503);
  assert.equal(await feed.receive(MAIN, wire(other, body(clock.t))), false, 'only the configured venue');
  assert.equal(await feed.receive(MAIN, wire(venue, body(clock.t))), true);
  let res = await fetch(url); const etag = res.headers.get('etag');
  assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'max-age=5');
  assert.deepEqual(await res.json(), { v: 1, ...body(clock.t) });
  assert.equal((await fetch(url, { headers: { 'if-none-match': etag } })).status, 304);
  assert.equal(await feed.receive(MAIN, wire(venue, body(clock.t - 10))), false, 'an older summary never replaces a newer one');
  clock.t += 30;
  assert.equal(await feed.receive(MAIN, wire(venue, body(clock.t, { counted: 972801 }))), true);
  res = await fetch(url); assert.equal((await res.json()).counted, 972801);
  assert.equal(await feed.receive(MAIN, wire(venue, { registryVersion: 2, software: '0.2.0', status: 'online', holdCount: 0 }, 'heartbeat')), false, 'other venue messages are not summaries');
});
