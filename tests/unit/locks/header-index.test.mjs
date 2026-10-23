import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LocksHeaders } from '../../../peer/features/locks-headers.js';
import { Clock, headerHash } from '../../../src/locks/clock.js';

const header = n => { const bytes = Buffer.alloc(80); bytes.writeUInt32LE(n, 68); return bytes.toString('hex'); };
const packet = hx => ({ value: { msg: JSON.stringify({ t: 'header', p: { hx: [hx] } }) }, seq: 7 });
function history(rows) {
  const reads = [];
  return { reads, get: async key => { reads.push(key); return key === 'msgl' ? { value: rows.length } : rows[Number(key.slice(4))]; } };
}

test('concurrent header lookups share one history scan, then index only appended operations', async () => {
  const rows = Array.from({ length: 10000 }, () => ({ value: { msg: '{}' } })), headers = Array.from({ length: 11 }, (_, i) => header(i));
  rows.push(...headers.map(packet)); const view = history(rows), index = new LocksHeaders();
  const found = await Promise.all(headers.map(hx => index.get(view, headerHash(hx))));
  assert.deepEqual(found.map(row => row.header), headers);
  assert.equal(view.reads.filter(key => key.startsWith('msg/')).length, rows.length);
  view.reads.length = 0;
  for (const hx of headers) assert.equal((await index.get(view, headerHash(hx))).header, hx);
  assert.equal(view.reads.length, 0);
  const next = header(12); rows.push(packet(next));
  assert.equal((await index.get(view, headerHash(next))).header, next);
  assert.deepEqual(view.reads, ['msgl', 'msg/10011']);
});

test('header index survives restart and rebuilds corrupt derived cache entries', async t => {
  const area = path.resolve('.test-tmp/locks-headers'); await fs.mkdir(area, { recursive: true });
  const directory = await fs.mkdtemp(path.join(area, 'index-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const hx = header(42), hash = headerHash(hx), rows = [packet(hx)], view = history(rows);
  await new LocksHeaders(directory).get(view, hash); view.reads.length = 0;
  assert.equal((await new LocksHeaders(directory).get(view, hash)).header, hx); assert.equal(view.reads.length, 0);
  await fs.writeFile(path.join(directory, hash.slice(0, 2), hash + '.json'), JSON.stringify({ header: header(43), index: 0, seq: 7 }));
  assert.equal((await new LocksHeaders(directory).get(view, hash)).header, hx);
  assert.ok(view.reads.includes('msg/0'));
});

test('header index bounds memory while retaining a requested historical result', async () => {
  const rows = Array.from({ length: 4100 }, (_, i) => packet(header(i))), index = new LocksHeaders(), view = history(rows);
  assert.equal((await index.get(view, headerHash(header(0)))).header, header(0));
  assert.equal(index.cache.size, 4096);
});

test('cached header times still recheck counted height and the signed hash on every read', async () => {
  let hx = header(42), counted = 10, hashes = 0, bodies = 0;
  const clock = new Clock({ bridge: { call: async type => {
    if (type === 'locks_clock') { hashes++; return { counted, hash: headerHash(hx) }; }
    bodies++; return { header: hx };
  } } });
  assert.equal(await clock.T(10), 42); assert.equal(await clock.T(10), 42);
  assert.equal(hashes, 2); assert.equal(bodies, 1);
  hx = header(43); assert.equal(await clock.T(10), 43); assert.equal(bodies, 2);
  counted = 9; await assert.rejects(clock.T(10), /not counted/);
});

test('a stalled history read keeps the progress made so far', async () => {
  const { LocksHeaders: Index } = await import('../../../peer/features/locks-headers.js');
  const area = path.resolve('.test-tmp/locks-headers-stall'); await fs.rm(area, { recursive: true, force: true });
  const index = new Index(area), total = 9000;
  const view = { get: async (key, opts) => {
    assert.ok(opts?.timeout > 0, 'every history read has a timeout');
    if (key === 'msgl') return { value: total };
    const i = Number(key.slice(4)); if (i === 8500) throw new Error('timeout');
    return { seq: i, value: { msg: '{}' } };
  } };
  await assert.rejects(index.update(view));
  assert.equal(JSON.parse(await fs.readFile(path.join(area, 'cursor.json'), 'utf8')), 8192);
});
