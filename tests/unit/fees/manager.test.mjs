import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { EventEmitter } from 'node:events';
import { createKeyring, openKeyring, keyringPublic } from '../../../src/roles/keyring.js';
import { openStore } from '../../../src/roles/store.js';
import { Service } from '../../../src/roles/service.js';
import { FeeManager } from '../../../src/fees/manager.js';
import { WalletManager } from '../../../src/wallets/manager.js';
import { percentBps, platformBps, readAuthorityKeypair } from '../../../src/fees/input.js';
import { fixture } from '../core/helpers.mjs';
import { deriveTradeConfigPda, deriveVaultAta } from '../../../src/solana/escrow.js';
import { chainFixture } from './chain.mjs';
import { exportWallets } from '../../../src/wallets/setup.js';

const PASSWORD = 'synthetic-fee-test-password';
class Bridge extends EventEmitter {
  sent = [];
  async setRelays() {}
  async send(ch, envelope) { this.sent.push({ ch, envelope }); }
}

async function setup(t) {
  const chain = chainFixture(t), dir = mkdtempSync(join(tmpdir(), 'fees-')), file = join(dir, 'keyring.json');
  await createKeyring(file, PASSWORD, { solanaSecret: chain.main.secretKey });
  const registryInput = { ...fixture().registry, fee: { platformFeeBps: 10, tradeFeeBps: 50, signerShareBps: 5000, collector: chain.main.publicKey.toBase58() } };
  const open = async () => {
    const keys = await openKeyring(file, PASSWORD), store = openStore(dir, keys.storeKey), bridge = new Bridge();
    const solana = chain.adapter(chain.main, { collectors: () => keys.collectors.map(c => ({ ...c, keypair: Keypair.fromSecretKey(c.secretKey) })) });
    const service = new Service({ firstLaunch: true, identity: keys.identity, store, bridge, solana, trac: {}, registryInput, log: () => {} });
    const config = { role: 'service', dataDir: dir };
    const manager = new FeeManager({ config, keys, store, service, solana });
    return { keys, store, bridge, solana, service, config, manager };
  };
  const first = await open(); await first.manager.initialize();
  return { ...chain, dir, file, open, first };
}

test('exact percent and platform bounds accept zero and maxima, reject floats, exponents and malformed values', () => {
  assert.equal(percentBps('0.01', 1000), 1); assert.equal(percentBps('10', 1000), 1000);
  assert.equal(percentBps('100.00', 10000), 10000); assert.equal(percentBps('0', 1000), 0);
  for (const value of ['10.01', '-1', '+1', '01', '1e0', '1.001', '1.', ' 1', '1\n', 1, undefined, '99999999999']) assert.throws(() => percentBps(value, 1000));
  for (const value of ['0', 0, 500, '500']) assert.equal(platformBps(value), Number(value));
  for (const value of [501, -1, 1.1, '1.0', '01', '5e1', '1\n', null, undefined]) assert.throws(() => platformBps(value));
});

test('collector keyring append is private, durable, idempotent by operation id, and preserves older secrets', async t => {
  const f = await setup(t), keys = f.first.keys;
  const first = await keys.ensureCollector({ id: 'rotation', feeBps: 75 });
  const restarted = await openKeyring(f.file, PASSWORD);
  assert.deepEqual(await restarted.ensureCollector({ id: 'rotation', feeBps: 75 }), first);
  assert.equal(restarted.collectors.length, 2); assert.equal(restarted.collectors[0].collector, f.main.publicKey.toBase58());
  assert.deepEqual(restarted.collectors[0].secretKey, f.main.secretKey);
  const raw = readFileSync(f.file, 'utf8');
  for (const c of restarted.collectors) assert.ok(!raw.includes(Buffer.from(c.secretKey).toString('hex')));
  assert.equal(keyringPublic(f.file).collectors.length, 2);
  await assert.rejects(restarted.ensureCollector({ id: 'rotation', feeBps: 76 }), /different/);
  await assert.rejects(restarted.ensureCollector({ id: 'extra-main', feeBps: 50, useMain: true }), /only/);
  for (const args of [{ id: '../bad', feeBps: 50 }, { id: 'bad', feeBps: 1001 }]) await assert.rejects(restarted.ensureCollector(args));
  const out = join(f.dir, 'backup');
  const files = await exportWallets(f.first.config, { out, readPassword: async () => PASSWORD });
  assert.equal(files.length, 8); assert.ok(files.includes('venue-records.json'));
  for (const c of restarted.collectors) assert.deepEqual(JSON.parse(readFileSync(join(out, `collector-${c.collector}.json`))), [...c.secretKey]);
});

for (const step of ['requested', 'key-saved', 'tx-sent', 'finalized', 'registry-published', 'published']) test(`rotation resumes after crash at ${step} with one new collector, config and registry version`, async t => {
  const f = await setup(t), { manager, store, solana, service } = f.first;
  let crashed = false;
  if (step === 'tx-sent') { f.chain.final = false; f.chain.drop = true; }
  else if (step === 'registry-published') {
    const publish = service.publishFees.bind(service);
    service.publishFees = async fee => { const result = await publish(fee); if (!crashed) { crashed = true; throw Error('crash'); } return result; };
  } else {
    const put = store.put.bind(store);
    store.put = (name, value) => {
      if (!crashed && step === 'key-saved' && name === 'service-fee-change' && value.phase === step) { crashed = true; throw Error('crash after key save, before journal update'); }
      put(name, value);
      if (!crashed && name === 'service-fee-change' && value.phase === step) { crashed = true; throw Error('crash'); }
    };
  }
  await assert.rejects(manager.set({ tradeFee: '0.75', signerShare: '60' }));
  f.chain.final = true; f.chain.drop = false;
  const restarted = await f.open(); await restarted.manager.initialize();
  const result = await restarted.manager.set({ tradeFee: '0.75', signerShare: '60' });
  assert.equal(result.version, 2); assert.equal(result.fee.tradeFeeBps, 75); assert.equal(result.fee.signerShareBps, 6000);
  assert.equal(restarted.keys.collectors.length, 2); assert.notEqual(result.fee.collector, f.main.publicKey.toBase58());
  assert.equal(f.chain.configs, 1); assert.equal(new Set(f.chain.sends.map(s => s.wire)).size, 1);
  assert.equal(restarted.store.get('service-fee-change').phase, 'published');
  const again = await f.open(); assert.equal(again.service.registry.version, 2); assert.deepEqual(again.service.registry.fee, result.fee);
  await solana.assertFeeConfig(result.fee);
});

test('signer-share-only changes publish a registry without generating a key or sending a config transaction', async t => {
  const f = await setup(t), { manager, keys, service } = f.first;
  const before = readFileSync(f.file), collector = service.registry.fee.collector;
  const registry = await manager.set({ signerShare: '100' });
  assert.equal(registry.version, 2); assert.equal(registry.fee.signerShareBps, 10000); assert.equal(registry.fee.collector, collector);
  assert.ok(before.equals(readFileSync(f.file))); assert.equal(keys.collectors.length, 1); assert.equal(f.chain.sends.length, 0);
  for (const args of [{ tradeFee: '10.01' }, { signerShare: '100.01' }, {}]) await assert.rejects(manager.set(args));
  assert.equal(service.registry.version, 2);
  assert.throws(() => new FeeManager({ config: { role: 'trader' } }), /service only/);
});

test('pending rotation rejects a different request and concurrent identical requests allocate once', async t => {
  const f = await setup(t); f.chain.final = false;
  await assert.rejects(f.first.manager.set({ tradeFee: '0.75' }));
  await assert.rejects(f.first.manager.set({ tradeFee: '0.80' }), /pending/);
  f.chain.final = true;
  const results = await Promise.all([f.first.manager.set({ tradeFee: '0.75' }), f.first.manager.set({ tradeFee: '0.75' })]);
  assert.equal(results[0].version, results[1].version); assert.equal(f.first.keys.collectors.length, 2); assert.equal(f.chain.configs, 1);
});

test('service publication refuses invalid finalized configs before saving policy or signing a registry', async t => {
  const f = await setup(t), { service, bridge, store } = f.first;
  await assert.rejects(service.publishFees({ ...service.registry.fee, collector: Keypair.generate().publicKey.toBase58() }), /finalized/);
  await assert.rejects(service.publishFees({ ...service.registry.fee, platformFeeBps: 11 }), /platform/);
  assert.equal(store.get('service-fee-policy'), null); assert.equal(bridge.sent.length, 0); assert.equal(service.registry.version, 1);
  f.config(f.main.publicKey, 51);
  await assert.rejects(service.start(), /matching finalized/); assert.equal(bridge.sent.length, 0); service.stop();
  const keys = { collectors: [], solanaSecret: f.main.secretKey, ensureCollector: () => assert.fail('invalid config must not enroll a collector') };
  const initial = new FeeManager({ config: f.first.config, keys, store, service, solana: f.first.solana });
  await assert.rejects(initial.initialize(), /matching finalized/);
  service.registry.fee.collector = f.buyer.publicKey.toBase58();
  await assert.rejects(initial.initialize(), /service Solana key/);
});

test('authority file is absolute and 0600; platform confirmation gate precedes reads and changes', async t => {
  const f = await setup(t), { manager, service, keys } = f.first, authorityFile = join(f.dir, 'authority.json');
  writeFileSync(authorityFile, JSON.stringify([...f.platform.secretKey]), { mode: 0o600 });
  assert.equal(readAuthorityKeypair(authorityFile).publicKey.toBase58(), f.platform.publicKey.toBase58());
  assert.throws(() => readAuthorityKeypair('relative'), /absolute/);
  await assert.rejects(manager.platform({ bps: 30, authorityKeypair: '/not-read', yes: false }), /Require --yes/);
  assert.equal(f.chain.sends.length, 0);
  chmodSync(authorityFile, 0o644); await assert.rejects(manager.platform({ bps: 30, authorityKeypair: authorityFile, yes: true }), /0600/);
  chmodSync(authorityFile, 0o600);
  writeFileSync(authorityFile, JSON.stringify([...f.buyer.secretKey]));
  await assert.rejects(manager.platform({ bps: 30, authorityKeypair: authorityFile, yes: true }), /authority/);
  assert.equal(f.first.store.get('service-fee-change'), null, 'wrong authority must not leave an unresumable request');
  writeFileSync(authorityFile, JSON.stringify([...f.platform.secretKey]));
  const registry = await manager.platform({ bps: 30, authorityKeypair: authorityFile, yes: true });
  assert.equal(registry.version, 2); assert.equal(registry.fee.platformFeeBps, 30); assert.equal(keys.collectors.length, 1);
  const saved = JSON.stringify(f.first.store.get('service-fee-change'));
  assert.ok(!saved.includes(authorityFile)); assert.ok(!saved.includes(Buffer.from(f.platform.secretKey).toString('hex')));
  await f.first.solana.assertFeeConfig(service.registry.fee);
  writeFileSync(authorityFile, '[1,2,3]'); assert.throws(() => readAuthorityKeypair(authorityFile), /Invalid/);
});

test('multi-collector withdrawal persists all parts before signing, resumes a crash after payment, and reports totals', async t => {
  const f = await setup(t), { manager, keys, solana, service, store, config } = f.first;
  await manager.set({ tradeFee: '0.75' });
  const [old, current] = keys.collectors;
  f.token(deriveTradeConfigPda(old.collector).pda, 5000n); f.token(deriveTradeConfigPda(current.collector).pda, 7500n);
  const target = Keypair.generate().publicKey; config.payout = { solana: target.toBase58() };
  const create = adapter => new WalletManager({ config, configFile: join(f.dir, 'role.json'), store, role: service, solana: adapter,
    trac: {}, addresses: { solana: f.main.publicKey.toBase58(), trac: null } });
  let crash = true;
  const wrapped = { ...solana, walletWithdraw: async input => {
    const plan = store.list('withdraw-').map(n => store.get(n))[0]; assert.equal(plan.parts.length, 3);
    const result = await solana.walletWithdraw(input);
    if (crash) { crash = false; throw Error('crash after finalized payment'); }
    return result;
  } };
  const balances = await create(wrapped).balances(); assert.equal(balances.USDC.collectedFees, '12500'); assert.equal(balances.USDC.collectors.length, 2);
  const first = await create(wrapped).withdraw({ asset: 'USDC', amount: 'all' }); assert.equal(first.status, 'unconfirmed');
  const resumed = create(solana); await resumed.recover();
  const completed = store.get('withdraw-' + first.id); assert.equal(completed.status, 'confirmed');
  assert.equal(completed.parts.length, 3); assert.ok(completed.parts.every(p => p.signature && p.status === 'confirmed'));
  assert.equal(f.balance(deriveVaultAta(target, f.mint)), 3012500n); assert.equal(f.chain.sends.length, 4, 'one rotation and one withdrawal per collector plus wallet');
  await resumed.recover(); assert.equal(f.chain.sends.length, 4);
  assert.equal((await resumed.info({ short: true })).balances.USDC.collectedFees, '0');
});

for (const stage of ['before signing', 'after sending']) test(`platform recovery ${stage} preserves its request and never saves the authority file`, async t => {
  const f = await setup(t), authorityFile = join(f.dir, 'authority.json');
  writeFileSync(authorityFile, JSON.stringify([...f.platform.secretKey]), { mode: 0o600 });
  if (stage === 'before signing') f.first.solana.setPlatformConfig = async () => { throw Error('crash'); };
  else { f.chain.final = false; f.chain.drop = true; }
  await assert.rejects(f.first.manager.platform({ bps: 30, authorityKeypair: authorityFile, yes: true }));
  f.chain.final = true; f.chain.drop = false;
  const restarted = await f.open(); await restarted.manager.initialize();
  if (stage === 'before signing') {
    assert.equal(restarted.service.registry.fee.platformFeeBps, 10); assert.equal(f.chain.sends.length, 0);
    await restarted.manager.platform({ bps: 30, authorityKeypair: authorityFile, yes: true });
  }
  assert.equal(restarted.service.registry.fee.platformFeeBps, 30); assert.equal(restarted.service.registry.version, 2);
  assert.equal(f.chain.sends.length, 1); assert.equal(restarted.keys.collectors.length, 1);
  assert.equal(restarted.store.get('service-fee-change').phase, 'published');
});
