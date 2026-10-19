import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createWallet, openWallet } from '../../../src/trac/wallet.js';

const area = process.env.TMPDIR ?? fileURLToPath(new URL('../../../.test-tmp/trac/', import.meta.url));
await fs.mkdir(area, { recursive: true, mode: 0o700 });
const root = await fs.mkdtemp(path.join(area, 'wallet-'));

test('wallet is encrypted, 0600, signs hashes and reopens with the same public identity', async () => {
  const file = path.join(root, 'fresh.json');
  const password = randomBytes(24).toString('hex');
  const wallet = await createWallet(file, password);
  let opened;
  try {
    assert.deepEqual(Object.keys(wallet).sort(), ['address', 'close', 'publicKey', 'sign']);
    assert.match(wallet.address, /^trac1/);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    const packet = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(packet.N, 2 ** 17);
    assert.equal(packet.cipher, 'xchacha20poly1305');
    assert.equal(packet.ciphertext.length, 96);
    const digest = randomBytes(32);
    const signature = wallet.sign(digest);
    assert.ok(ed25519.verify(Buffer.from(signature, 'hex'), digest, Buffer.from(wallet.publicKey, 'hex')));
    for (const bad of [null, '00'.repeat(32), Buffer.alloc(31), Buffer.alloc(33)]) assert.throws(() => wallet.sign(bad), /32-byte/);
    opened = await openWallet(file, password);
    assert.equal(opened.publicKey, wallet.publicKey);
    assert.equal(opened.address, wallet.address);
    assert.equal(opened.sign(digest), signature);
    const before = createHash('sha256').update(await fs.readFile(file)).digest('hex');
    await assert.rejects(createWallet(file, password), /exists/);
    assert.equal(createHash('sha256').update(await fs.readFile(file)).digest('hex'), before);
    await assert.rejects(openWallet(file, randomBytes(24).toString('hex')), /authentication/);
    packet.publicKey = '00'.repeat(32);
    await fs.writeFile(file, JSON.stringify(packet));
    await assert.rejects(openWallet(file, password), /authentication/);
  } finally { wallet.close(); opened?.close(); }
  wallet.close();
  assert.throws(() => wallet.sign(randomBytes(32)), /closed/);
});

test('wallet rejects invalid inputs, unsafe files and malformed envelopes', async () => {
  const password = randomBytes(24).toString('hex');
  for (const [file, pass] of [['relative', password], [path.join(root, 'empty.json'), ''], [path.join(root, 'wrong-type.json'), null]]) {
    await assert.rejects(createWallet(file, pass));
    await assert.rejects(openWallet(file, pass));
  }
  await assert.rejects(openWallet(path.join(root, 'missing.json'), password), /ENOENT/);
  const file = path.join(root, 'malformed.json');
  await fs.writeFile(file, '{}', { mode: 0o600 });
  await assert.rejects(openWallet(file, password), /Invalid wallet/);
  await fs.writeFile(file, 'not json');
  await assert.rejects(openWallet(file, password), /Invalid wallet/);
  await fs.chmod(file, 0o644);
  await assert.rejects(openWallet(file, password), /0600/);
  const link = path.join(root, 'linked.json');
  await fs.symlink(file, link);
  await assert.rejects(openWallet(link, password));
  await assert.rejects(createWallet(link, password), /exists/);
});
