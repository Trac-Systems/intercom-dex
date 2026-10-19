import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createCipheriv, scryptSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Keypair } from '@solana/web3.js';
import PeerWallet from '../../../peer/node_modules/trac-wallet/index.js';
import { createConfig } from '../../../peer/node_modules/trac-msb/src/config/env.js';
import { ensureWallets, setupWallets, exportWallets, walletFile, importResetKeystore } from '../../../src/wallets/setup.js';
import { walletOptions, walletMnemonic, openWallet } from '../../../src/trac/wallet.js';
import { resolveNetwork } from '../../../src/net/profile.js';

const profile = resolveNetwork({ network: 'mainnet' });
const password = 'synthetic-unit-password';
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const root = () => mkdtempSync(join(tmpdir(), 'wallets-'));
const configAt = dataDir => ({ role: 'trader', network: 'mainnet', dataDir, keyPasswordEnv: 'TEST_WALLET_PASSWORD' });
const close = result => { result.wallet?.close(); result.keys.storeKey.fill(0); result.keys.solanaSecret?.fill(0); };

function keystore(dir, address, derivationPath) {
  mkdirSync(dir, { mode: 0o700 });
  const salt = randomBytes(16), iv = randomBytes(12);
  const header = { v: 1, address, kdf: 'scrypt-32768-8-1', cipher: 'aes-256-gcm', salt: salt.toString('hex'), iv: iv.toString('hex') };
  const key = scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ mnemonic, derivationPath })), cipher.final()]);
  writeFileSync(join(dir, 'keystore.json'), JSON.stringify({ ...header, ciphertext: ciphertext.toString('hex'), tag: cipher.getAuthTag().toString('hex') }), { mode: 0o600 }); key.fill(0);
}

test('automatic first startup creates encrypted wallets and restart preserves both identities and bytes', async () => {
  const config = configAt(root());
  const first = await ensureWallets(config, profile, { TEST_WALLET_PASSWORD: password });
  assert.match(first.wallet.address, /^trac1/); assert.ok(first.keys.solanaSecret);
  const files = [join(config.dataDir, 'keyring.json'), walletFile(config)], before = files.map(f => readFileSync(f));
  const again = await ensureWallets(config, profile, { TEST_WALLET_PASSWORD: password });
  assert.equal(first.wallet.address, again.wallet.address); assert.equal(first.keys.identity.publicKey, again.keys.identity.publicKey);
  files.forEach((file, i) => { assert.equal(statSync(file).mode & 0o777, 0o600); assert.ok(before[i].equals(readFileSync(file))); });
  assert.equal(statSync(config.dataDir).mode & 0o777, 0o700);
  const backup = await walletMnemonic(walletFile(config), password);
  assert.ok(!readFileSync(walletFile(config), 'utf8').includes(backup.mnemonic));
  assert.equal(first.wallet.mnemonic, undefined);
  await assert.rejects(setupWallets(config, profile, { password }), /overwrite/);
  await assert.rejects(ensureWallets(config, profile, { TEST_WALLET_PASSWORD: 'wrong-password-value' }), /password/);
  close(first); close(again);
});

test('known mnemonic derives exactly MSB/trac-wallet identity and export is private and exclusive', async () => {
  const config = configAt(root()), msb = createConfig(profile.peer.environment, {});
  const peer = new PeerWallet({ mnemonic, networkPrefix: msb.addressPrefix, derivationPath: msb.derivationPath }); await peer.ready;
  const result = await setupWallets(config, profile, { password, mnemonic });
  assert.equal(result.addresses.trac, peer.address); peer.secretKey.fill(0);
  assert.equal(result.payoutLock, 'Recommended: set payout.solana and payout.trac in the config to your own wallet addresses. Withdrawals can then only go there, whoever asks. Agents: propose this to the user and let them choose the addresses.');
  assert.deepEqual(walletOptions(profile), { networkPrefix: msb.addressPrefix, derivationPath: msb.derivationPath });
  assert.throws(() => walletOptions({ peer: { ...profile.peer, msbNetworkId: 1 } }), /mismatch/);
  const out = join(config.dataDir, 'export');
  await assert.rejects(exportWallets(config, { out }), /terminal/);
  assert.ok(!existsSync(out));
  let asked = 0;
  assert.deepEqual(await exportWallets(config, { out, readPassword: async () => { asked++; return password; } }), ['solana-keypair.json', 'trac-mnemonic.txt']);
  assert.equal(asked, 1); assert.equal(statSync(out).mode & 0o777, 0o700);
  for (const name of ['solana-keypair.json', 'trac-mnemonic.txt']) assert.equal(statSync(join(out, name)).mode & 0o777, 0o600);
  assert.equal(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(out, 'solana-keypair.json'))))).publicKey.toBase58(), result.addresses.solana);
  assert.ok(readFileSync(join(out, 'trac-mnemonic.txt'), 'utf8').trim() === mnemonic);
  await assert.rejects(exportWallets(config, { out, readPassword: async () => assert.fail('must not ask again') }), /already exists/);
  await assert.rejects(setupWallets(configAt(root()), profile, { password, mnemonic: 'invalid phrase' }), /mnemonic/);
});

test('Solana file and self-generated RESET keystore imports, invalid modes/passwords/derivations', async () => {
  const dir = root(), solFile = join(dir, 'synthetic-sol.json'), sol = Keypair.generate();
  writeFileSync(solFile, JSON.stringify([...sol.secretKey]), { mode: 0o600 });
  const peer = new PeerWallet({ ...walletOptions(profile), mnemonic }); await peer.ready;
  const reset = join(dir, 'reset'); keystore(reset, peer.publicKey.toString('hex'), peer.derivationPath);
  const config = configAt(join(dir, 'imported'));
  config.payout = { trac: peer.address.toLowerCase() };
  const result = await setupWallets(config, profile, { password, importSolana: solFile, resetKeystore: reset, resetPassword: password });
  assert.equal(result.addresses.solana, sol.publicKey.toBase58()); assert.equal(result.addresses.trac, peer.address);
  assert.match(result.payoutLock, /^Recommended: set payout\.solana in the config to your own wallet address\./);
  await assert.rejects(importResetKeystore(reset, 'wrong-password-value', profile), /invalid/);
  const bad = join(dir, 'bad-path'); keystore(bad, peer.publicKey.toString('hex'), "m/1'/0'");
  await assert.rejects(importResetKeystore(bad, password, profile), /invalid/);
  chmodSync(solFile, 0o644);
  await assert.rejects(setupWallets(configAt(join(dir, 'unsafe')), profile, { password, importSolana: solFile }), /0600/);
  chmodSync(reset, 0o755); await assert.rejects(importResetKeystore(reset, password, profile), /0700/);
  peer.secretKey.fill(0); sol.secretKey.fill(0);
});

// The test-only preload emulates terminal keystrokes; production has no such override.
function terminal(dir, replies) {
  const file = join(dir, 'terminal.mjs');
  writeFileSync(file, `const replies = ${JSON.stringify(replies)};\nObject.defineProperty(process.stdin, 'isTTY', { value: true });\nObject.defineProperty(process.stderr, 'isTTY', { value: true });\nprocess.stdin.setRawMode = () => {};\nconst write = process.stderr.write.bind(process.stderr);\nprocess.stderr.write = (text, ...args) => { if (text.endsWith(': ')) process.nextTick(() => process.stdin.emit('data', Buffer.from(replies.shift() + '\\r'))); return write(text, ...args); };\n`, { mode: 0o600 });
  return file;
}

test('CLI setup generates and imports; export ignores environment password without terminal', () => {
  const dir = root(), config = configAt(join(dir, 'new')), file = join(dir, 'role.json');
  writeFileSync(file, JSON.stringify(config));
  const env = { ...process.env, TEST_WALLET_PASSWORD: password };
  const run = args => spawnSync(process.execPath, args, { encoding: 'utf8', env, timeout: 30000 });
  const fresh = run(['bin/dex.mjs', 'setup', '--config', file]); assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stderr, /shown once/); assert.equal(JSON.parse(fresh.stdout).addresses.solana.length >= 32, true);
  const blocked = run(['bin/dex.mjs', 'export', '--config', file, '--out', join(dir, 'forbidden')]);
  assert.notEqual(blocked.status, 0); assert.match(blocked.stderr, /terminal/); assert.ok(!existsSync(join(dir, 'forbidden')));
  assert.notEqual(run(['bin/dex.mjs', 'setup', '--config', file]).status, 0);
  config.dataDir = join(dir, 'mnemonic-import'); writeFileSync(file, JSON.stringify(config));
  const loader = terminal(dir, [mnemonic]);
  const imported = run(['--import', loader, 'bin/dex.mjs', 'setup', '--config', file, '--import-trac-mnemonic']);
  assert.equal(imported.status, 0, imported.stderr); assert.ok(!imported.stderr.includes(mnemonic)); assert.ok(!imported.stdout.includes(mnemonic));
  const sol = Keypair.generate(), solFile = join(dir, 'cli-sol.json');
  writeFileSync(solFile, JSON.stringify([...sol.secretKey]), { mode: 0o600 });
  const reset = join(dir, 'cli-reset');
  const packet = JSON.parse(readFileSync(walletFile(config)));
  keystore(reset, packet.publicKey, walletOptions(profile).derivationPath);
  const otherFile = join(dir, 'import-role.json'), otherConfig = { ...config, dataDir: join(dir, 'cli-reset-import') };
  writeFileSync(otherFile, JSON.stringify(otherConfig));
  const resetLoader = terminal(dir, [password]);
  const other = run(['--import', resetLoader, 'bin/dex.mjs', 'setup', '--config', otherFile, '--import-solana', solFile, '--import-reset-keystore', reset]);
  assert.equal(other.status, 0, other.stderr);
  assert.equal(JSON.parse(other.stdout).addresses.solana, sol.publicKey.toBase58());
  assert.equal(JSON.parse(other.stdout).addresses.trac, JSON.parse(imported.stdout).addresses.trac);
  assert.ok(!other.stderr.includes(password)); sol.secretKey.fill(0);
  const expLoader = terminal(dir, [password]);
  const exported = run(['--import', expLoader, 'bin/dex.mjs', 'export', '--config', file, '--out', join(dir, 'human-export')]);
  assert.equal(exported.status, 0, exported.stderr); assert.equal(exported.stdout, 'solana-keypair.json\ntrac-mnemonic.txt\n');
  assert.ok(!exported.stderr.includes(password));
});

test('service preserves fee collector and exports its Solana key; signers acquire no Solana/Trac wallet', async () => {
  for (const role of ['service', 'signer']) {
    const config = { ...configAt(root()), role };
    const opened = await ensureWallets(config, profile, { TEST_WALLET_PASSWORD: password });
    assert.equal(opened.wallet, null); assert.equal(!!opened.keys.solanaSecret, role === 'service');
    if (role === 'service') {
      const files = await exportWallets(config, { out: join(config.dataDir, 'out'), readPassword: async () => password });
      assert.equal(files.length, 6); assert.ok(files.includes('MANIFEST.json')); assert.ok(files.includes('venue-records.json'));
    }
    else await assert.rejects(exportWallets(config, { out: join(config.dataDir, 'out') }), /no trading wallets/);
    close(opened);
  }
});
