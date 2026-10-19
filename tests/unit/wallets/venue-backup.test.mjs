import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, chmodSync, cpSync, symlinkSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { createKeyring, openKeyring, importKeyring } from '../../../src/roles/keyring.js';
import { exportWallets } from '../../../src/wallets/setup.js';
import { restoreVenue, exportVenue } from '../../../src/wallets/venue-backup.js';
import { openStore } from '../../../src/roles/store.js';
import { Service } from '../../../src/roles/service.js';
import { RegistryView, publicReceiver } from '../../../src/roles/common.js';
import { fixture } from '../core/helpers.mjs';

const root = resolve('.test-tmp/wallet-fees'); mkdirSync(root, { recursive: true });
const password = 'throwaway-backup-password', newPassword = 'throwaway-restored-password';
async function backup() {
  const dir = mkdtempSync(join(root, 'backup-')), config = { role: 'service', dataDir: join(dir, 'old') };
  mkdirSync(config.dataDir, { mode: 0o700 });
  await createKeyring(join(config.dataDir, 'keyring.json'), password, { withSolana: true });
  const keys = await openKeyring(join(config.dataDir, 'keyring.json'), password);
  await keys.ensureCollector({ id: 'initial', feeBps: 50, useMain: true });
  await keys.ensureCollector({ id: 'rotate', feeBps: 75 });
  config.serviceKey = keys.identity.publicKey;
  const out = join(dir, 'export'), files = await exportWallets(config, { out, readPassword: async () => password });
  return { dir, config, keys, out, files };
}

test('complete venue export restores every key, records and registry identity pinned by an existing trader', async () => {
  const f = await backup(), target = { ...f.config, dataDir: join(f.dir, 'restored') };
  assert.equal(statSync(f.out).mode & 0o777, 0o700);
  for (const file of f.files) assert.equal(statSync(join(f.out, file)).mode & 0o777, 0o600);
  const manifest = JSON.parse(readFileSync(join(f.out, 'MANIFEST.json')));
  assert.deepEqual(manifest.keys.filter(k => k.role === 'collector').map(k => k.feeBps), [50, 75]);
  const restored = await restoreVenue(target, { from: f.out, readPassword: async () => newPassword });
  assert.equal(restored.dexKey, f.config.serviceKey);
  assert.equal(statSync(target.dataDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(target.dataDir, 'keyring.json')).mode & 0o777, 0o600);
  const keys = await openKeyring(join(target.dataDir, 'keyring.json'), newPassword);
  assert.deepEqual(keys.identity, f.keys.identity); assert.deepEqual(keys.box, f.keys.box);
  assert.deepEqual(keys.storeKey, f.keys.storeKey); assert.deepEqual(keys.solanaSecret, f.keys.solanaSecret);
  assert.deepEqual(keys.collectors, f.keys.collectors);
  assert.deepEqual(await keys.ensureCollector({ id: 'rotate', feeBps: 75 }), restored.collectors[1]);
  const oldStore = openStore(f.config.dataDir, f.keys.storeKey); oldStore.put('credits', { amount: '123' });
  cpSync(join(f.config.dataDir, 'records'), join(target.dataDir, 'records'), { recursive: true });
  const store = openStore(target.dataDir, keys.storeKey);
  assert.deepEqual(store.get('credits'), { amount: '123' });
  const bridge = new EventEmitter(), sent = [];
  bridge.setRelays = async () => {}; bridge.join = async () => {}; bridge.send = async (ch, message) => sent.push(message);
  const service = new Service({ firstLaunch: true, bridge, identity: keys.identity, store, solana: { assertFeeConfig: async () => {} }, trac: {}, registryInput: fixture().registry, log: () => {} });
  await service.publishFees({ ...service.registry.fee, collector: keys.collectors[1].collector, tradeFeeBps: 75 });
  const message = sent.find(m => m.kind === 'registry'), verified = publicReceiver()(message);
  assert.ok(verified); assert.equal(new RegistryView(f.config.serviceKey).offer(verified), true);
  assert.equal(store.get('service-registry-published').fee.collector, keys.collectors[1].collector);
  const readOnly = openStore(target.dataDir, keys.storeKey, { readOnly: true });
  assert.throws(() => readOnly.put('x', {}), /Read-only/); assert.throws(() => readOnly.delete('credits'), /Read-only/);
});

// One venue configuration per test: a changed configured registry is a new version.
function venue(keys, store, registryInput, options = {}) {
  const bridge = new EventEmitter(), sent = [];
  bridge.setRelays = async () => {}; bridge.join = async () => {}; bridge.send = async (ch, message) => sent.push(message);
  const service = new Service({ bridge, identity: keys.identity, store, solana: { assertFeeConfig: async () => {} }, trac: {}, registryInput, log: () => {}, ...options });
  return { service, sent };
}

test('the export carries registry history, fee policy and book sequence; the restored venue continues its version count', async () => {
  const dir = mkdtempSync(join(root, 'records-')), config = { role: 'service', dataDir: join(dir, 'old') };
  mkdirSync(config.dataDir, { mode: 0o700 });
  await createKeyring(join(config.dataDir, 'keyring.json'), password, { withSolana: true });
  const keys = await openKeyring(join(config.dataDir, 'keyring.json'), password), old = openStore(config.dataDir, keys.storeKey);
  const rotate = await keys.ensureCollector({ id: 'rotate', feeBps: 75 }), input = fixture().registry;
  const first = venue(keys, old, input, { firstLaunch: true }).service;
  await first.publishFees({ ...first.registry.fee, collector: rotate.collector, tradeFeeBps: 75 });
  old.put('book-sequence', { seq: 41 }); old.put('settle-' + 'ab'.repeat(32), { kept: 'not exported' });
  const out = join(dir, 'export'), files = await exportWallets({ ...config, serviceKey: keys.identity.publicKey }, { out, readPassword: async () => password });
  assert.ok(files.includes('venue-records.json'));
  const manifest = JSON.parse(readFileSync(join(out, 'MANIFEST.json')));
  assert.deepEqual(manifest.records.names, ['book-sequence', 'service-fee-policy', 'service-registry', 'service-registry-published', 'service-registry-v1', 'service-registry-v2']);
  // Only the export survived: the keys and these records come back, nothing else.
  const target = { ...config, dataDir: join(dir, 'restored') };
  const restored = await restoreVenue(target, { from: out, readPassword: async () => newPassword });
  assert.deepEqual(restored.records, manifest.records.names);
  const store = openStore(target.dataDir, (await openKeyring(join(target.dataDir, 'keyring.json'), newPassword)).storeKey);
  for (const name of manifest.records.names) assert.deepEqual(store.get(name), old.get(name), name);
  assert.equal(store.get('settle-' + 'ab'.repeat(32)), null);
  // The restored venue needs no first-launch flag, keeps version 2 and its fee policy, and numbers the next change 3.
  const again = venue(keys, store, input).service;
  assert.equal(again.registry.version, 2); assert.equal(again.registry.fee.collector, rotate.collector);
  assert.deepEqual(again.registry, old.get('service-registry'));
  assert.equal((await again.publishFees({ ...again.registry.fee, signerShareBps: 6000 })).version, 3);
  // A tampered record file no longer matches the manifest.
  const tampered = JSON.parse(readFileSync(join(out, 'venue-records.json'))); tampered['book-sequence'].seq = 1;
  writeFileSync(join(out, 'venue-records.json'), JSON.stringify(tampered));
  await assert.rejects(restoreVenue({ ...config, dataDir: join(dir, 'tampered') }, { from: out, readPassword: async () => newPassword }), /Manifest does not match/);
});

test('without a stored registry the venue refuses to start unless it is a first launch; versions never go below the highest stored', async () => {
  const dir = mkdtempSync(join(root, 'first-')), dataDir = join(dir, 'data'); mkdirSync(dataDir, { mode: 0o700 });
  await createKeyring(join(dataDir, 'keyring.json'), password, { withSolana: true });
  const keys = await openKeyring(join(dataDir, 'keyring.json'), password), store = openStore(dataDir, keys.storeKey), input = fixture().registry;
  assert.throws(() => venue(keys, store, input), /no venue registry.*--first-launch only on the very first start/s);
  assert.deepEqual(store.list('service-registry'), []);
  const { service } = venue(keys, store, input, { firstLaunch: true });
  assert.equal(service.registry.version, 1);
  assert.equal(venue(keys, store, input, { firstLaunch: true }).service.registry.version, 1, 'the flag changes nothing once a registry is stored');
  // A higher version seen earlier (here a stored copy of version 5) keeps the counter above it.
  store.put('service-registry-v5', { ...service.registry, version: 5 });
  const next = await venue(keys, store, input).service.publishFees({ ...service.registry.fee, signerShareBps: 6000 });
  assert.equal(next.version, 6);
});

test('venue backup refuses overwrite, wrong passwords, unsafe modes, symlinks and nonempty restore folders', async () => {
  const f = await backup();
  assert.throws(() => exportVenue(f.keys, f.out), /already exists/);
  await assert.rejects(exportWallets(f.config, { out: join(f.dir, 'bad-password'), readPassword: async () => 'incorrect-password' }), /password/);
  await assert.rejects(restoreVenue(f.config, { from: f.out }), /empty/);
  await assert.rejects(restoreVenue({ ...f.config, role: 'trader' }, { from: f.out }), /service only/);
  const target = { ...f.config, dataDir: join(f.dir, 'empty') }; mkdirSync(target.dataDir);
  const opts = { from: f.out, readPassword: async () => newPassword };
  await assert.rejects(restoreVenue({ ...target, serviceKey: '00'.repeat(32) }, opts), /serviceKey/);
  chmodSync(f.out, 0o755); await assert.rejects(restoreVenue(target, opts), /0700/); chmodSync(f.out, 0o700);
  const key = join(f.out, f.files[0]); chmodSync(key, 0o644); await assert.rejects(restoreVenue(target, opts), /0600/); chmodSync(key, 0o600);
  const linked = join(f.dir, 'linked'); symlinkSync(f.out, linked);
  await assert.rejects(restoreVenue(target, { ...opts, from: linked }), /0700/);
  await assert.rejects(restoreVenue(target, { ...opts, from: 'relative' }), /Absolute/);
  await assert.rejects(restoreVenue(target, { ...opts, readPassword: async () => 'short' }), /password/);
  assert.deepEqual(readdirSync(target.dataDir), []);
});

test('manifest verification rejects altered public keys, fee metadata, missing roles, traversal and malformed secrets', async () => {
  const f = await backup();
  const source = JSON.parse(readFileSync(join(f.out, 'MANIFEST.json')));
  for (const mutate of [
    m => { m.keys[0].publicKey = '00'.repeat(32); },
    m => { m.keys[4].feeBps = 1001; },
    m => { m.keys.pop(); },
    m => { m.keys[0].file = '../outside.json'; },
    m => { m.keys[1] = m.keys[0]; },
    m => { m.keys = m.keys.filter(k => k.role !== 'store'); },
  ]) {
    const m = structuredClone(source); mutate(m); writeFileSync(join(f.out, 'MANIFEST.json'), JSON.stringify(m));
    await assert.rejects(restoreVenue({ ...f.config, dataDir: join(f.dir, 'never-created') }, { from: f.out, readPassword: async () => newPassword }));
  }
  writeFileSync(join(f.out, 'MANIFEST.json'), JSON.stringify(source));
  writeFileSync(join(f.out, f.files[0]), JSON.stringify(Array(64).fill(0)));
  await assert.rejects(restoreVenue({ ...f.config, dataDir: join(f.dir, 'invalid') }, { from: f.out, readPassword: async () => newPassword }), /public key/);
  await assert.rejects(importKeyring(join(f.dir, 'bad.json'), newPassword, {}), /Invalid/);
});
