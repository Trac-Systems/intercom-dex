import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { openStore } from '../../../src/roles/store.js';

function fixture(t) {
  const root = process.env.TMPDIR ?? path.resolve('.test-tmp/sb4a');
  fs.mkdirSync(root, { recursive: true });
  const folder = fs.mkdtempSync(path.join(root, 'store-unit-')), key = new Uint8Array(32).fill(8);
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(folder, { recursive: true, force: true }); });
  return { folder, key, store: openStore(folder, key) };
}

test('encrypted record writes complete short writes before rename and survive a fresh store', t => {
  const { folder, key, store } = fixture(t), write = fs.writeSync;
  let calls = 0;
  t.mock.method(fs, 'writeSync', (fd, bytes, offset, length) => {
    calls++; return write(fd, bytes, offset, Math.min(length, 7));
  });
  syncBuiltinESMExports();
  const value = { sequence: 1, reservations: ['synthetic-trade'], message: 'persist before returning a vote' };
  store.put('stake-test', value);
  assert.ok(calls > 1); assert.deepEqual(openStore(folder, key).get('stake-test'), value);
  assert.equal(fs.existsSync(path.join(folder, 'records', 'stake-test.rec.tmp')), false);
});

test('a stalled or failed write preserves the last complete encrypted record and can be retried', t => {
  const { folder, key, store } = fixture(t), write = fs.writeSync;
  const before = { sequence: 1 }, after = { sequence: 2 };
  store.put('stake-test', before);
  let mode = 'stall';
  t.mock.method(fs, 'writeSync', (...args) => {
    if (mode === 'stall') return 0;
    if (mode === 'error') throw new Error('synthetic disk failure');
    return write(...args);
  });
  syncBuiltinESMExports();
  assert.throws(() => store.put('stake-test', after), /no progress/);
  assert.deepEqual(openStore(folder, key).get('stake-test'), before);
  mode = 'error'; assert.throws(() => store.put('stake-test', after), /disk failure/);
  assert.deepEqual(openStore(folder, key).get('stake-test'), before);
  mode = 'ok'; store.put('stake-test', after);
  assert.deepEqual(openStore(folder, key).get('stake-test'), after);
});
