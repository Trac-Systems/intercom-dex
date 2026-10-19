import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ed25519 } from '@noble/curves/ed25519.js';
import PeerWallet from '../../../peer/node_modules/trac-wallet/index.js';
import { buildTnkTransfer } from '../../../src/trac/transfers.js';
import { openIntentStore } from '../../../src/trac/intents.js';

const root = process.env.TMPDIR ?? fileURLToPath(new URL('../../../.test-tmp/trac/', import.meta.url));
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const folder = () => fs.mkdtempSync(path.join(root, 'intent-unit-'));
const moduleURL = new URL('../../../src/trac/intents.js', import.meta.url).href;

async function fixture() {
  const secret = ed25519.utils.randomSecretKey();
  const from = PeerWallet.encodeBech32m('trac', ed25519.getPublicKey(secret));
  const tradeId = '11'.repeat(32), to = PeerWallet.encodeBech32m('trac', Buffer.alloc(32, 2));
  try {
    const payload = await buildTnkTransfer({ networkId: 918, txv: '33'.repeat(32), from, to, amount: '42', tradeId,
      sign: bytes => Buffer.from(ed25519.sign(bytes, secret)).toString('hex') });
    return { tradeId, asset: 'TNK', from, to, amount: '42', sendBy: 200, createdAt: 100, sentAt: 100, txHash: payload.tro.tx, payload, submission: null };
  } finally { secret.fill(0); }
}

test('intent store persists exact immutable signed data and forbids replacements', async () => {
  const intent = await fixture(), directory = path.join(folder(), 'new', 'nested');
  let store = openIntentStore(directory);
  assert.equal(store.get(intent.tradeId), null);
  store.save(intent);
  const original = structuredClone(intent);
  intent.payload.tro.txv = '00'.repeat(32);
  store.get(intent.tradeId).payload.tro.txv = 'ff'.repeat(32);
  assert.deepEqual(store.get(intent.tradeId), original);
  assert.throws(() => store.save(intent), /already exists/);
  store.close(); store.close();
  assert.throws(() => store.get(intent.tradeId), /closed/);
  assert.throws(() => store.save(original), /closed/);
  store = openIntentStore(directory);
  try {
    assert.deepEqual(store.get(intent.tradeId), original);
    assert.equal(fs.statSync(path.join(directory, 'intents.jsonl')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  } finally { store.close(); }
});

test('intent lock excludes another process and abrupt exit preserves the intent', async () => {
  const directory = folder(), intent = await fixture();
  const store = openIntentStore(directory);
  try {
    assert.throws(() => openIntentStore(directory), /already open/);
    execFileSync(process.execPath, ['--input-type=module', '-e', `import { openIntentStore } from ${JSON.stringify(moduleURL)}; try { openIntentStore(process.argv[1]); process.exitCode = 2; } catch (e) { if (!e.message.includes('already open')) throw e; }`, directory]);
  } finally { store.close(); }
  execFileSync(process.execPath, ['--input-type=module', '-e', `import { openIntentStore } from ${JSON.stringify(moduleURL)}; openIntentStore(process.argv[1]).save(JSON.parse(process.argv[2])); process.exit(0);`, directory, JSON.stringify(intent)]);
  const reopened = openIntentStore(directory);
  try { assert.deepEqual(reopened.get(intent.tradeId), intent); } finally { reopened.close(); }
});

test('intent journal rejects invalid records, truncation, duplicates, corruption and symlinks', async () => {
  assert.throws(() => openIntentStore('relative'));
  const directory = folder(), intent = await fixture();
  const store = openIntentStore(directory);
  try {
    assert.throws(() => store.get('bad'));
    for (const patch of [{ tradeId: 'bad' }, { asset: 'OTHER' }, { txHash: 'bad' }, { sentAt: 200 }, { createdAt: 101 }, { amount: '0' }, { payload: {} }, { submission: {} }]) assert.throws(() => store.save({ ...intent, ...patch }));
    store.save(intent);
  } finally { store.close(); }
  const row = fs.readFileSync(path.join(directory, 'intents.jsonl'), 'utf8');
  for (const raw of ['{', '{}\n', 'null\n', row.slice(0, -1), row + row, row.replace('"amount":"42"', '"amount":"43"')]) {
    const broken = folder();
    fs.writeFileSync(path.join(broken, 'intents.jsonl'), raw);
    assert.throws(() => openIntentStore(broken));
  }
  const link = folder();
  fs.symlinkSync(path.join(directory, 'intents.jsonl'), path.join(link, 'intents.jsonl'));
  assert.throws(() => openIntentStore(link));
});

test('intent journal handles partial writes and fails closed on write or flush failure', async () => {
  const intent = await fixture(), write = fs.writeSync, sync = fs.fsyncSync;
  const partial = openIntentStore(folder());
  try {
    fs.writeSync = (fd, buffer, offset, length) => write(fd, buffer, offset, Math.min(7, length));
    partial.save(intent);
    assert.deepEqual(partial.get(intent.tradeId), intent);
  } finally { fs.writeSync = write; partial.close(); }
  for (const fault of ['write', 'flush']) {
    const store = openIntentStore(folder());
    try {
      store.save(intent);
      if (fault === 'write') fs.writeSync = () => 0;
      else fs.fsyncSync = () => { throw Error('disk full'); };
      const another = { ...intent, tradeId: '44'.repeat(32) };
      assert.throws(() => store.save(another));
      assert.throws(() => store.save(another), /store failed/);
      assert.throws(() => store.get(another.tradeId), /store failed/);
      assert.deepEqual(store.get(intent.tradeId), intent, 'a prior submission remains recoverable');
    } finally { fs.writeSync = write; fs.fsyncSync = sync; store.close(); }
  }
});
