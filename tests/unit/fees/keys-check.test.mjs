import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { createKeyring, openKeyring } from '../../../src/roles/keyring.js';
import { openStore } from '../../../src/roles/store.js';
import { checkKeys } from '../../../src/fees/keys-check.js';
import { createFeeReader } from '../../../src/solana/fee-reader.js';
import { deriveConfigPda, deriveTradeConfigPda, deriveVaultAta } from '../../../src/solana/escrow.js';
import { PROGRAM_ID } from '../../../src/solana/constants.js';
import { chainFixture } from './chain.mjs';

const root = resolve('.test-tmp/wallet-fees'); mkdirSync(root, { recursive: true });
const password = 'synthetic-key-check-password';
async function setup(t) {
  const f = chainFixture(t), dir = mkdtempSync(join(root, 'check-'));
  await createKeyring(join(dir, 'keyring.json'), password, { solanaSecret: f.main.secretKey });
  const keys = await openKeyring(join(dir, 'keyring.json'), password);
  await keys.ensureCollector({ id: 'initial', feeBps: 50, useMain: true });
  const c = await keys.ensureCollector({ id: 'second', feeBps: 75 }); f.config(new PublicKey(c.collector), 75);
  f.token(deriveTradeConfigPda(f.main.publicKey).pda, 42n); f.token(deriveConfigPda().pda, 99n);
  const config = { role: 'service', dataDir: dir, serviceKey: keys.identity.publicKey, solana: { endpoints: ['http://127.0.0.1:12345/a', 'http://127.0.0.1:12345/b'], need: 2 } };
  const profile = { mint: f.mint.toBase58(), programId: PROGRAM_ID.toBase58() };
  const store = openStore(dir, keys.storeKey); store.put('service-registry-published', { version: 8, fee: { collector: c.collector } });
  const authorityKeypair = join(dir, 'synthetic-authority.json'); writeFileSync(authorityKeypair, JSON.stringify([...f.platform.secretKey]), { mode: 0o600 });
  const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
  const programdata = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], loader)[0];
  const data = Buffer.alloc(36); data.writeUInt32LE(2); programdata.toBuffer().copy(data, 4);
  const programBytes = Buffer.alloc(45); programBytes.writeUInt32LE(3); programBytes[12] = 1; f.platform.publicKey.toBuffer().copy(programBytes, 13);
  const wire = (bytes, executable) => ({ owner: loader.toBase58(), executable, lamports: 1, data: [bytes.toString('base64'), 'base64'] });
  f.accounts.set(PROGRAM_ID.toBase58(), wire(data, true)); f.accounts.set(programdata.toBase58(), wire(programBytes, false));
  const run = (patch = {}, options = {}) => checkKeys({ ...config, ...patch }, profile, { authorityKeypair, readPassword: async () => password, ...options });
  return { ...f, setConfig: f.config, dir, config, profile, store, authorityKeypair, programdata, run };
}

test('keys check reports every key and finalized quorum balance without changing data or sending transactions', async t => {
  const f = await setup(t), before = statSync(f.dir).mode, files = readdirSync(join(f.dir, 'records'));
  const result = await f.run(); assert.equal(result.ok, true, JSON.stringify(result.lines));
  assert.equal(result.lines.length, 11); assert.ok(result.lines.every(l => l.ok));
  assert.match(result.lines.find(l => l.label.startsWith('collector')).message, /42 base units/);
  assert.match(result.lines.at(-1).message, /99 base units/);
  assert.equal(statSync(f.dir).mode, before); assert.deepEqual(readdirSync(join(f.dir, 'records')), files);
  assert.equal(f.chain.sends.length, 0);
  assert.ok(f.chain.reads.filter(r => r.method === 'getAccountInfo').every(r => r.params[1].commitment === 'finalized'));
  assert.equal((await f.run({}, { authorityKeypair: undefined })).lines.length, 6);
  const reader = createFeeReader({ ...f.config.solana, ...f.profile }); assert.equal(await reader.decimals(), 6);
});

test('key audit surfaces password, pin, rent, collector, registry and authority problems independently', async t => {
  const f = await setup(t);
  let result = await f.run({}, { readPassword: async () => 'incorrect-password' }); assert.equal(result.ok, false); assert.equal(result.lines[0].label, 'keyring');
  result = await f.run({ serviceKey: '00'.repeat(32) }); assert.ok(result.lines.find(l => l.label.startsWith('identity') && !l.ok));
  result = await f.run({ serviceKey: undefined }); assert.match(result.lines[1].message, /Configure serviceKey/);
  f.accounts.get(f.main.publicKey.toBase58()).lamports = 0;
  f.setConfig(f.main.publicKey, 51);
  f.store.put('service-registry-published', { version: 9, fee: { collector: f.buyer.publicKey.toBase58() } });
  const p = deriveConfigPda().pda.toBase58(), old = structuredClone(f.accounts.get(p));
  const data = Buffer.from(old.data[0], 'base64'); f.buyer.publicKey.toBuffer().copy(data, 1); f.seller.publicKey.toBuffer().copy(data, 33);
  f.accounts.get(p).data[0] = data.toString('base64');
  const upgrade = f.accounts.get(f.programdata.toBase58()), bytes = Buffer.from(upgrade.data[0], 'base64'); f.buyer.publicKey.toBuffer().copy(bytes, 13); upgrade.data[0] = bytes.toString('base64');
  result = await f.run();
  for (const label of ['main Solana', 'registry collector', 'platform authority', 'platform collector', 'upgrade authority']) assert.ok(result.lines.find(l => l.label === label && !l.ok), label);
  assert.match(result.lines.find(l => l.label.startsWith('collector') && !l.ok).message, /bps/);
  f.accounts.delete(deriveTradeConfigPda(f.main.publicKey).pda.toBase58());
  result = await f.run(); assert.match(result.lines.find(l => l.label.startsWith('collector') && !l.ok).message, /Finalized.*missing/);
  chmodSync(f.authorityKeypair, 0o644); result = await f.run(); assert.match(result.lines.find(l => l.label === 'authority file').message, /0600/);
  f.store.delete('service-registry-published'); result = await f.run(); assert.match(result.lines.find(l => l.label === 'registry collector').message, /No saved published registry/);
  await assert.rejects(f.run({ role: 'trader' }), /service only/);
});

test('public reader rejects wrong config identities, owners, vaults, programdata and lost RPC quorum', async t => {
  const f = await setup(t), reader = createFeeReader({ ...f.config.solana, ...f.profile });
  const c = deriveTradeConfigPda(f.main.publicKey).pda.toBase58(), saved = structuredClone(f.accounts.get(c));
  f.accounts.get(c).owner = SystemProgram.programId.toBase58(); await assert.rejects(reader.collector(f.main.publicKey.toBase58()), /owner/);
  f.accounts.set(c, structuredClone(saved));
  const data = Buffer.from(saved.data[0], 'base64'); f.buyer.publicKey.toBuffer().copy(data, 33); f.accounts.get(c).data[0] = data.toString('base64');
  await assert.rejects(reader.collector(f.main.publicKey.toBase58()), /different key/);
  f.accounts.set(c, saved);
  const vault = f.accounts.get(deriveVaultAta(deriveConfigPda().pda, f.mint).toBase58()); vault.owner = SystemProgram.programId.toBase58();
  await assert.rejects(reader.platformBalance(), /vault/);
  f.accounts.get(f.mint.toBase58()).owner = SystemProgram.programId.toBase58(); await assert.rejects(reader.decimals(), /mint/);
  const pd = f.accounts.get(f.programdata.toBase58()), pdBytes = Buffer.from(pd.data[0], 'base64'); pdBytes[12] = 0; pd.data[0] = pdBytes.toString('base64');
  await assert.rejects(reader.upgradeAuthority(), /immutable/);
  f.accounts.delete(f.programdata.toBase58()); await assert.rejects(reader.upgradeAuthority(), /programdata/);
  f.accounts.get(PROGRAM_ID.toBase58()).executable = false; await assert.rejects(reader.upgradeAuthority(), /upgradeable/);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('RPC unavailable'); });
  const result = await f.run(); assert.equal(result.ok, false); assert.ok(result.lines.some(l => /quorum/i.test(l.message)));
  for (const label of ['platform authority', 'platform collector', 'upgrade authority', 'platform vault']) assert.equal(result.lines.find(l => l.label === label).ok, false);
});

test('audit of a keyring missing main and collectors reports both without creating a records folder', async t => {
  const f = await setup(t), dir = mkdtempSync(join(root, 'no-main-'));
  const pub = await createKeyring(join(dir, 'keyring.json'), password);
  const result = await f.run({ dataDir: dir, serviceKey: pub.dexKey }, { authorityKeypair: undefined });
  assert.equal(result.ok, false);
  assert.match(result.lines.find(l => l.label === 'main Solana').message, /missing/);
  assert.match(result.lines.find(l => l.label === 'collectors').message, /No collector/);
  assert.deepEqual(readdirSync(dir), ['keyring.json']);
});
