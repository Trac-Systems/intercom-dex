import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Keypair } from '@solana/web3.js';
import { createKeyring, openKeyring } from '../../../src/roles/keyring.js';
import { openStore } from '../../../src/roles/store.js';
import { withPlatformLock } from '../../../src/fees/platform-withdraw.js';

const root = resolve('.test-tmp/wallet-fees'); mkdirSync(root, { recursive: true });
const password = 'synthetic-owner-cli-password';
const lockModule = new URL('../../../src/fees/platform-withdraw.js', import.meta.url).href;

function terminal(dir, sources = {}) {
  const file = join(dir, 'terminal.mjs');
  writeFileSync(file, `import '${new URL('../../../src/wallets/setup.js', import.meta.url).href}';
import {registerHooks} from 'node:module';
const sources=${JSON.stringify(sources)};
registerHooks({load(url,context,next){const key=Object.keys(sources).find(k=>url.endsWith(k));return key?{format:'module',source:sources[key],shortCircuit:true}:next(url,context)}});
Object.defineProperty(process.stdin,'isTTY',{value:true});Object.defineProperty(process.stderr,'isTTY',{value:true});process.stdin.setRawMode=()=>{};
const write=process.stderr.write.bind(process.stderr);process.stderr.write=(text,...args)=>{if(text.endsWith(': '))process.nextTick(()=>process.stdin.emit('data',Buffer.from(${JSON.stringify(password)}+'\\r')));return write(text,...args)};
globalThis.fetch=()=>{throw Error('CLI test must not use network')};`, { mode: 0o600 });
  return file;
}

test('CLI venue export/restore uses terminal passwords and prints only filenames/public keys', async () => {
  const dir = mkdtempSync(join(root, 'cli-backup-')), dataDir = join(dir, 'data'), file = join(dir, 'service.json'); mkdirSync(dataDir);
  const pub = await createKeyring(join(dataDir, 'keyring.json'), password, { withSolana: true });
  const config = { role: 'service', network: 'mainnet', dataDir, serviceKey: pub.dexKey }; writeFileSync(file, JSON.stringify(config));
  const loader = terminal(dir), out = join(dir, 'export');
  const run = (args, tty = true) => spawnSync(process.execPath, [...(tty ? ['--import', loader] : []), 'bin/dex.mjs', ...args, '--config', file], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, DEX_KEY_PASSWORD: password } });
  assert.match(run(['export', '--out', out], false).stderr, /terminal/); assert.ok(!existsSync(out));
  const exported = run(['export', '--out', out]); assert.equal(exported.status, 0, exported.stderr);
  const manifest = JSON.parse(readFileSync(join(out, 'MANIFEST.json')));
  assert.deepEqual(exported.stdout.trim().split('\n'), [...manifest.keys.map(k => k.file), manifest.records.file, 'MANIFEST.json']);
  assert.notEqual(run(['export', '--out', out]).status, 0);
  config.dataDir = join(dir, 'restored'); writeFileSync(file, JSON.stringify(config));
  assert.match(run(['restore', '--from', out], false).stderr, /terminal/);
  const restored = run(['restore', '--from', out]); assert.equal(restored.status, 0, restored.stderr);
  assert.equal(JSON.parse(restored.stdout).dexKey, pub.dexKey); assert.ok(!restored.stdout.includes('secret'));
  assert.notEqual(run(['restore', '--from', out]).status, 0);
  assert.ok(![exported, restored].some(r => (r.stdout + r.stderr).includes(password)));
});

test('CLI key audit exit status and platform withdrawal dispatch, private authority file and empty message', async () => {
  const dir = mkdtempSync(join(root, 'cli-keys-')), file = join(dir, 'service.json'), authority = Keypair.generate(), authorityFile = join(dir, 'throwaway-authority.json');
  const pub = await createKeyring(join(dir, 'keyring.json'), password, { withSolana: true }), keys = await openKeyring(join(dir, 'keyring.json'), password);
  const c = await keys.ensureCollector({ id: 'initial', feeBps: 50, useMain: true });
  const store = openStore(dir, keys.storeKey); store.put('service-registry-published', { version: 1, fee: { collector: c.collector } });
  const config = { role: 'service', network: 'mainnet', dataDir: dir, serviceKey: pub.dexKey, solana: { endpoints: ['http://127.0.0.1:12345'], sendEndpoint: 'http://127.0.0.1:12345', need: 1 } };
  writeFileSync(file, JSON.stringify(config)); writeFileSync(authorityFile, JSON.stringify([...authority.secretKey]), { mode: 0o600 });
  const sources = {
    '/src/solana/fee-reader.js': `export function createFeeReader(){return {main:async()=>({balance:'10000000',rent:'1000000'}),collector:async()=>({feeBps:50,balance:'10'}),platform:async()=>({authority:'${authority.publicKey}',collector:'${authority.publicKey}'}),upgradeAuthority:async()=>'${authority.publicKey}',platformBalance:async()=>process.env.TEST_EMPTY?'0':'10000',decimals:async()=>6}}`,
    '/src/solana/adapter.js': `export function createSolanaAdapter({keypair}){return {withdrawPlatformFees:async input=>{if(input.amount!=='10000')throw Error('bad amount');input.afterSign();if(!keypair.secretKey.every(b=>b===0))throw Error('not wiped');return {ok:true,signature:'synthetic-signature',slot:100,vaultAfter:'0'}}}}`,
  };
  const loader = terminal(dir, sources);
  const run = (args, env = {}) => spawnSync(process.execPath, ['--import', loader, 'bin/dex.mjs', ...args, '--config', file], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env } });
  const check = run(['keys', 'check', '--authority-keypair', authorityFile]); assert.equal(check.status, 0, check.stderr); assert.match(check.stdout, /OK upgrade authority/);
  writeFileSync(file, JSON.stringify({ ...config, serviceKey: '00'.repeat(32) }));
  const bad = run(['keys', 'check']); assert.equal(bad.status, 1); assert.match(bad.stdout, /PROBLEM identity/);
  writeFileSync(file, JSON.stringify(config));
  const args = ['fee', 'withdraw-platform', '--authority-keypair', authorityFile, '--to', authority.publicKey.toBase58()];
  const withdrawn = run(args); assert.equal(withdrawn.status, 0, withdrawn.stderr); assert.equal(withdrawn.stdout, 'synthetic-signature\n');
  assert.equal(run(args, { TEST_EMPTY: '1' }).stdout, 'Platform fee vault is empty\n');
  chmodSync(authorityFile, 0o644); assert.match(run(args).stderr, /0600/);
  assert.notEqual(run(['fee', 'withdraw-platform', '--to', authority.publicKey.toBase58()]).status, 0);
  assert.notEqual(run(['keys', 'check', '--out', dir]).status, 0);
  writeFileSync(file, JSON.stringify({ ...config, role: 'trader' })); assert.match(run(args).stderr, /service only/);
});

test('native platform command lock excludes another process and releases on failure and process death', async () => {
  const dir = mkdtempSync(join(root, 'lock-'));
  const script = `import {withPlatformLock} from ${JSON.stringify(lockModule)}; await withPlatformLock(${JSON.stringify(dir)},async()=>{console.log('acquired');process.exit(0)});`;
  const child = () => spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000 });
  await withPlatformLock(dir, async () => { const result = child(); assert.notEqual(result.status, 0); assert.match(result.stderr, /active/); });
  await assert.rejects(withPlatformLock(dir, async () => { throw Error('crash'); }), /crash/);
  assert.equal(child().status, 0); assert.equal(child().status, 0, 'OS releases lock at process exit');
  await assert.rejects(withPlatformLock('relative', async () => {}), /Absolute/);
  chmodSync(join(dir, 'platform-withdraw.lock'), 0o644); await assert.rejects(withPlatformLock(dir, async () => {}), /private/);
});
