import test from 'node:test';
import assert from 'node:assert/strict';
import { TrafficLog, TRAFFIC_LIMIT, CONNECTION_LIMIT_BYTES } from '../../../src/dashboard/traffic.js';
import { hex } from '../core/helpers.mjs';

// The tap sees envelopes before anyone verifies them, so plain envelope-shaped objects are enough here.
const sender = hex();
const envelope = (kind, ch, body, nonce = hex()) => ({ v: 1, kind, ch, from: sender, ts: 100, nonce, body, sig: 'ab'.repeat(64) });

test('identical signed envelopes fold into one row with a counter; a new nonce is a new row', () => {
  const clock = { t: 1_000_000 }, log = new TrafficLog({ now: () => clock.t });
  const m = envelope('heartbeat', 'intercom-dex:signers', { registryVersion: 1, software: '0.1.0', status: 'online', holdCount: 0 });
  for (let i = 0; i < 7; i++) { log.record('intercom-dex:signers', structuredClone(m), 300); clock.t += 1000; }
  log.record('intercom-dex:signers', { ...m, ts: m.ts }, 300);   // same content, keys in another order
  const page = log.query();
  assert.equal(page.total, 1); assert.equal(page.rows[0].count, 8);
  assert.equal(page.rows[0].lastSeen, clock.t); assert.equal(page.rows[0].firstSeen, 1_000_000);
  assert.equal(page.rows[0].kind, 'heartbeat'); assert.equal(page.rows[0].from, m.from);
  log.record('intercom-dex:signers', envelope('heartbeat', 'intercom-dex:signers', m.body), 300);
  assert.equal(log.query().total, 2);
  log.record('intercom-dex:signers', { ...m, sig: '00'.repeat(64) }, 300);   // any changed field is another envelope
  assert.equal(log.query().total, 3);
});

test('the ring keeps the newest distinct messages; a repeat moves its row to the newest end', () => {
  const log = new TrafficLog({ limit: 3, now: () => 5000 });
  const ms = [0, 1, 2, 3].map(i => envelope('offer', 'intercom-dex:offers', { i }));
  log.record('intercom-dex:offers', ms[0], 10); log.record('intercom-dex:offers', ms[1], 10); log.record('intercom-dex:offers', ms[2], 10);
  log.record('intercom-dex:offers', ms[0], 10);     // repeat: now newest
  log.record('intercom-dex:offers', ms[3], 10);     // evicts ms[1], the oldest
  const rows = log.query().rows;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.count), [1, 2, 1]);
  assert.equal(log.record('intercom-dex:offers', ms[1], 10).count, 1, 'the evicted message counts as new');
  assert.equal(log.query().total, 3);
  assert.equal(new TrafficLog().limit, TRAFFIC_LIMIT);
});

test('filters by channel, kind and trade (from the trade channel or the body), newest first, paged', () => {
  const log = new TrafficLog({ now: () => 0 }), trade = hex(), other = hex();
  log.record(`intercom-dex:t:${trade}`, envelope('ack', `intercom-dex:t:${trade}`, { tradeId: trade }), 200);
  log.record('intercom-dex:signers', envelope('sharePublish', 'intercom-dex:signers', { tradeId: trade }), 400);
  log.record('intercom-dex:signers', envelope('heartbeat', 'intercom-dex:signers', { tradeId: other }), 100);
  for (let i = 0; i < 150; i++) log.record('intercom-dex:offers', envelope('offer', 'intercom-dex:offers', { i }), 50);
  assert.equal(log.query({ trade: trade.slice(0, 8) }).total, 2);
  assert.equal(log.query({ channel: 'intercom-dex:signers' }).total, 2);
  assert.equal(log.query({ kind: 'heartbeat' }).rows[0].trade, other);
  const first = log.query({ kind: 'offer' }), second = log.query({ kind: 'offer', page: 1 });
  assert.equal(first.total, 150); assert.equal(first.rows.length, 100); assert.equal(second.rows.length, 50);
  assert.equal(log.query({ kind: 'offer', page: 'x' }).page, 0);
  assert.deepEqual(first.channels, ['intercom-dex:offers', 'intercom-dex:signers', `intercom-dex:t:${trade}`]);
  assert.deepEqual(first.kinds, ['ack', 'heartbeat', 'offer', 'sharePublish']);
});

test('bytes per second per channel cover the last five seconds, duplicates included', () => {
  const clock = { t: 10_000 }, log = new TrafficLog({ now: () => clock.t }), m = envelope('book', 'intercom-dex', { a: 1 });
  for (let i = 0; i < 5; i++) { log.record('intercom-dex', m, 10_000); clock.t += 1000; }
  clock.t -= 1000;
  assert.deepEqual(log.bytesPerSecond(), { 'intercom-dex': 10_000 });
  clock.t += 3000;
  assert.deepEqual(log.bytesPerSecond(), { 'intercom-dex': 4000 });
  clock.t += 10_000;
  assert.deepEqual(log.bytesPerSecond(), {});
  assert.equal(log.rates.size, 0, 'idle channels are forgotten');
  assert.equal(log.query().limitBytes, CONNECTION_LIMIT_BYTES);
});

test('unverified junk is described safely and never breaks the log', () => {
  const log = new TrafficLog({ now: () => 0 });
  log.record('intercom-dex:offers', 'not an object', 5);
  log.record('intercom-dex:offers', null, 5);
  log.record('intercom-dex:offers', { kind: 'k'.repeat(500), from: 7, body: { tradeId: 'not-hex' } }, 5);
  log.record('c'.repeat(500), { kind: 'x' }, 5);
  const rows = log.query().rows;
  assert.equal(rows.length, 4);
  assert.ok(rows.every(r => r.kind.length <= 32 && r.channel.length <= 100 && r.trade === ''));
  assert.equal(rows.find(r => r.kind.startsWith('k')).from, '');
});
