import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { createKeyring, openKeyring, keyringPublic } from '../../../src/roles/keyring.js';

const PASSWORD = 'unit-test-password';

test('a keyring keeps every role secret encrypted and opens only with its password', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dex-keyring-')), file = join(dir, 'keyring.json'), sol = Keypair.generate();
  const pub = await createKeyring(file, PASSWORD, { solanaSecret: sol.secretKey });
  const raw = readFileSync(file, 'utf8');
  assert.ok(!raw.includes(Buffer.from(sol.secretKey.subarray(0, 32)).toString('hex')), 'no secret in the clear');
  assert.deepEqual(keyringPublic(file), pub);
  const keys = await openKeyring(file, PASSWORD);
  assert.equal(keys.identity.publicKey, pub.dexKey);
  assert.equal(Keypair.fromSecretKey(keys.solanaSecret).publicKey.toBase58(), sol.publicKey.toBase58());
  assert.equal(keys.storeKey.length, 32);
  await assert.rejects(openKeyring(file, 'wrong-password-123'), /password or file/);
  await assert.rejects(createKeyring(file, PASSWORD), /EEXIST/);
  await assert.rejects(createKeyring(join(dir, 'short.json'), 'short'), /at least 12/);
});

test('a keyring file must be private, regular and untampered', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dex-keyring-')), file = join(dir, 'keyring.json');
  await createKeyring(file, PASSWORD);
  const link = join(dir, 'link.json'); symlinkSync(file, link);
  await assert.rejects(openKeyring(link, PASSWORD));
  chmodSync(file, 0o644);
  await assert.rejects(openKeyring(file, PASSWORD), /0600/);
  chmodSync(file, 0o600);
  const packet = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...packet, public: { ...packet.public, dexKey: 'ab'.repeat(32) } }));
  await assert.rejects(openKeyring(file, PASSWORD), /password or file/);
});
