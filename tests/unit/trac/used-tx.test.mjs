import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { openUsedTxStore } from '../../../peer/src/trac/used-tx.js';

const root = process.env.TMPDIR ?? fileURLToPath(new URL('../../../.test-tmp/trac/', import.meta.url));
fs.mkdirSync(root, { recursive: true });
const folder = () => fs.mkdtempSync(path.join(root, 'journal-'));
const tx = '11'.repeat(32), trade = '22'.repeat(32), other = '33'.repeat(32);

test('journal is durable, append-only, idempotent, and blocks cross-trade replay', () => {
  const directory = folder();
  let store = openUsedTxStore(directory);
  assert.equal(store.get(tx), null);
  assert.deepEqual(store.claim(tx, trade), { ok: true, reason: null });
  const first = fs.readFileSync(path.join(directory, 'used-tx.jsonl'), 'utf8');
  assert.deepEqual(store.claim(tx, trade), { ok: true, reason: null });
  assert.deepEqual(store.claim(tx, other), { ok: false, reason: 'tx_already_used' });
  assert.equal(fs.readFileSync(path.join(directory, 'used-tx.jsonl'), 'utf8'), first);
  store.close(); store.close();
  assert.throws(() => store.get(tx), /closed/);
  assert.throws(() => store.claim(tx, trade), /closed/);
  store = openUsedTxStore(directory);
  try {
    assert.equal(store.get(tx), trade);
    assert.equal(store.claim(tx, other).ok, false);
    assert.equal(store.claim(other, trade).ok, true);
    assert.ok(fs.readFileSync(path.join(directory, 'used-tx.jsonl'), 'utf8').startsWith(first));
    assert.equal(fs.statSync(path.join(directory, 'used-tx.jsonl')).mode & 0o777, 0o600);
  } finally { store.close(); }
});

test('second process cannot open an active journal', () => {
  const directory = folder();
  const store = openUsedTxStore(directory);
  try {
    assert.throws(() => openUsedTxStore(directory), /already open/);
    const moduleURL = new URL('../../../peer/src/trac/used-tx.js', import.meta.url).href;
    const script = `import { openUsedTxStore } from ${JSON.stringify(moduleURL)}; try { openUsedTxStore(process.argv[1]); process.exitCode = 2; } catch (e) { if (!e.message.includes('already open')) throw e; }`;
    execFileSync(process.execPath, ['--input-type=module', '-e', script, directory]);
  } finally { store.close(); }
  openUsedTxStore(directory).close();
});

test('a process exit without close preserves a claim and releases the native lock', () => {
  const directory = folder();
  const moduleURL = new URL('../../../peer/src/trac/used-tx.js', import.meta.url).href;
  const script = `import { openUsedTxStore } from ${JSON.stringify(moduleURL)}; openUsedTxStore(process.argv[1]).claim(process.argv[2], process.argv[3]); process.exit(0);`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script, directory, tx, trade]);
  const store = openUsedTxStore(directory);
  try { assert.equal(store.claim(tx, other).ok, false); } finally { store.close(); }
});

test('invalid IDs, incomplete records, duplicates, and corrupt JSON fail closed', () => {
  assert.throws(() => openUsedTxStore('relative'));
  const store = openUsedTxStore(folder());
  try {
    assert.throws(() => store.get('bad'));
    assert.throws(() => store.claim(tx, 'bad'));
    assert.throws(() => store.claim('bad', trade));
    assert.throws(() => store.claim([tx], trade));
    assert.throws(() => store.claim(tx, [trade]));
  } finally { store.close(); }
  const row = JSON.stringify({ v: 1, txHash: tx, tradeId: trade }) + '\n';
  for (const data of ['{', '{}\n', row + row, row.slice(0, -1), 'null\n']) {
    const directory = folder();
    fs.writeFileSync(path.join(directory, 'used-tx.jsonl'), data);
    assert.throws(() => openUsedTxStore(directory));
  }
});

test('creates and syncs nested journal directories', () => {
  const store = openUsedTxStore(path.join(folder(), 'new', 'nested'));
  try { assert.equal(store.claim(tx, trade).ok, true); } finally { store.close(); }
});

test('missing flush primitive and a failed flush never acknowledge a claim', () => {
  const sync = fs.fsyncSync;
  try {
    fs.fsyncSync = undefined;
    assert.throws(() => openUsedTxStore(folder()), /fsyncSync/);
  } finally { fs.fsyncSync = sync; }
  const directory = folder();
  const store = openUsedTxStore(directory);
  try {
    fs.fsyncSync = () => { throw Error('disk error'); };
    assert.throws(() => store.claim(tx, trade), /disk error/);
    assert.throws(() => store.claim(other, trade), /store failed/);
  } finally { fs.fsyncSync = sync; store.close(); }
  const reopened = openUsedTxStore(directory);
  try { assert.equal(reopened.claim(tx, other).ok, false); } finally { reopened.close(); }
});
