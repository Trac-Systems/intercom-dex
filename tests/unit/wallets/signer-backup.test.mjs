import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { createKeyring, openKeyring, keyringPublic } from '../../../src/roles/keyring.js';
import { openStore } from '../../../src/roles/store.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exportSignerBackup, verifySignerBackup, restoreSignerBackup, signerBackupCommand, TWO_COPIES_RULE } from '../../../src/wallets/signer-backup.js';

const root = resolve(process.env.TMPDIR ?? '.test-tmp', 'signer-backup'); mkdirSync(root, { recursive: true });
const keyPassword = 'throwaway-signer-password', newKeyPassword = 'throwaway-restored-password', passphrase = 'throwaway backup passphrase';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const id = c => c.repeat(64);

// A signer data folder: one stake piece with its final share, one still in DKG, one returned, and registry snapshots.
async function signer() {
  const dir = mkdtempSync(join(root, 'signer-')), config = { role: 'signer', dataDir: join(dir, 'data') };
  mkdirSync(config.dataDir, { mode: 0o700 });
  await createKeyring(join(config.dataDir, 'keyring.json'), keyPassword);
  const keys = await openKeyring(join(config.dataDir, 'keyring.json'), keyPassword), store = openStore(config.dataDir, keys.storeKey);
  const records = {
    [`stake-dkg-${id('a')}`]: { unitId: id('a'), state: { phase: 'ready' }, lock: { share: '11'.repeat(32) }, deals: {} },
    [`stake-dkg-${id('b')}`]: { unitId: id('b'), state: { phase: 'dealing' }, deals: {} },
    [`stake-dkg-${id('c')}`]: { unitId: id('c'), lock: { share: '22'.repeat(32) }, release: { at: 1 } },
    [`stake-funded-vote-${id('a')}`]: { vote: 'funded' }, 'registry-v1': { version: 1 }, 'registry-current': { version: 1 },
  };
  for (const [name, value] of Object.entries(records)) store.put(name, value);
  return { dir, config, keys, store, records, out: join(dir, 'backups') };
}
const exportOf = (s, extra = {}) => exportSignerBackup(s.config, { out: s.out, passphrase, keyPassword, ...extra });
const restoreTo = (s, file, dataDir, extra = {}) => restoreSignerBackup({ role: 'signer', dataDir }, { from: file, passphrase, keyPassword: newKeyPassword, ...extra });

test('round trip: export, verify and restore bring back the same signer, its keys and every record', async () => {
  const s = await signer(), r = await exportOf(s);
  assert.equal(basename(r.file), `signer-${s.keys.identity.publicKey.slice(0, 16)}-${r.position}.dexbackup`);
  assert.deepEqual([r.records, r.stakePieces, r.stakeShares, r.stakeInProgress, r.stakeRetired, r.superseded], [6, 3, 1, 1, 1, []]);
  assert.equal(statSync(r.file).mode & 0o777, 0o600); assert.equal(statSync(s.out).mode & 0o777, 0o700);
  const text = readFileSync(r.file, 'utf8');
  for (const secret of [s.keys.identity.secretKey, s.keys.box.secretKey, s.keys.storeKey.toString('hex'), '11'.repeat(32), 'registry-v1', passphrase])
    assert.ok(!text.includes(secret), 'nothing readable in the bundle');
  const v = await verifySignerBackup(r.file, passphrase);
  assert.deepEqual(v, { ok: true, file: r.file, signer: s.keys.identity.publicKey, position: r.position, records: 6, stakePieces: 3, stakeShares: 1, stakeRetired: 1, stakeInProgress: 1 });
  const dataDir = join(s.dir, 'restored'), restored = await restoreTo(s, r.file, dataDir);
  assert.equal(restored.dexKey, s.keys.identity.publicKey); assert.equal(restored.rule, TWO_COPIES_RULE);
  assert.match(TWO_COPIES_RULE, /^Never run two copies of one signer/);
  const keys = await openKeyring(join(dataDir, 'keyring.json'), newKeyPassword), store = openStore(dataDir, keys.storeKey, { readOnly: true });
  assert.deepEqual([keys.identity.secretKey, keys.box.secretKey, keys.storeKey.toString('hex')], [s.keys.identity.secretKey, s.keys.box.secretKey, s.keys.storeKey.toString('hex')]);
  assert.deepEqual(Object.fromEntries(store.list().map(n => [n, store.get(n)])), s.records);
  assert.equal(statSync(dataDir).mode & 0o777, 0o700);
});

test('a wrong passphrase, a short one, a tampered bundle and a changed header are all refused', async () => {
  const s = await signer(), { file } = await exportOf(s);
  await assert.rejects(verifySignerBackup(file, 'another long passphrase'), /^Error: Wrong passphrase, or the bundle was changed or damaged$/);
  await assert.rejects(verifySignerBackup(file, 'short'), /at least 12 characters/);
  await assert.rejects(exportOf(s, { passphrase: 'short' }), /at least 12 characters/);
  const packet = JSON.parse(readFileSync(file, 'utf8')), bytes = Buffer.from(packet.ciphertext, 'base64');
  bytes[100] ^= 1;
  const tampered = join(s.dir, 'tampered.dexbackup'); writeFileSync(tampered, JSON.stringify({ ...packet, ciphertext: bytes.toString('base64') }), { mode: 0o600 });
  await assert.rejects(verifySignerBackup(tampered, passphrase), /changed or damaged/);
  const later = join(s.dir, 'later.dexbackup'); writeFileSync(later, JSON.stringify({ ...packet, position: packet.position + 1 }), { mode: 0o600 });
  await assert.rejects(verifySignerBackup(later, passphrase), /changed or damaged/, 'the journal position in the clear is authenticated');
  const junk = join(s.dir, 'junk.dexbackup'); writeFileSync(junk, 'not json', { mode: 0o600 });
  await assert.rejects(verifySignerBackup(junk, passphrase), /Not a signer backup file/);
  await assert.rejects(restoreTo(s, tampered, join(s.dir, 'never')), /changed or damaged/);
  assert.deepEqual(readdirSync(s.dir).filter(f => f === 'never'), [], 'a refused restore writes nothing');
});

test('stale bundles: a newer export supersedes the older one; restore refuses a bundle older than the journal the operator names', async () => {
  const s = await signer(), first = await exportOf(s);
  assert.equal((await exportOf(s)).unchanged, true, 'nothing written since: the same bundle');
  await sleep(20); s.store.put(`stake-dkg-${id('d')}`, { unitId: id('d'), lock: { share: '33'.repeat(32) } });
  const second = await exportOf(s);
  assert.ok(second.position > first.position); assert.deepEqual(second.superseded, [basename(first.file)]); assert.equal(second.stakeShares, 2);
  assert.deepEqual(readdirSync(s.out).sort(), [basename(first.file), basename(second.file)].sort(), 'older bundles stay until the owner removes them');
  await assert.rejects(restoreTo(s, first.file, join(s.dir, 'r1'), { journal: second.position }), /is older than journal .* Restore the newest bundle/);
  const ok = await restoreTo(s, second.file, join(s.dir, 'r2'), { journal: second.position });
  assert.equal(ok.position, second.position);
  // An export from an older copy of this signer never sits next to a newer bundle as if it were current.
  const copy = { ...s, config: { role: 'signer', dataDir: join(s.dir, 'r3') } };
  await restoreTo(s, first.file, copy.config.dataDir);
  assert.equal((await exportSignerBackup(copy.config, { out: join(s.dir, 'elsewhere'), passphrase, keyPassword: newKeyPassword })).position, first.position,
    'a restored signer keeps the journal position of its bundle');
  await assert.rejects(exportSignerBackup(copy.config, { out: s.out, passphrase, keyPassword: newKeyPassword }), /newer backup of this signer is already there/);
});

test('restore goes into an empty folder only and never over the same signer; export is for signers only', async () => {
  const s = await signer(), { file } = await exportOf(s);
  await assert.rejects(restoreTo(s, file, s.config.dataDir), new RegExp(`already holds signer ${s.keys.identity.publicKey}\\. Never run two copies`));
  const other = join(s.dir, 'other'); mkdirSync(other); writeFileSync(join(other, 'notes.txt'), 'x');
  await assert.rejects(restoreTo(s, file, other), /^Error: Restore requires an empty data folder$/);
  const empty = join(s.dir, 'empty'); mkdirSync(empty);
  assert.equal((await restoreTo(s, file, empty)).dexKey, keyringPublic(join(empty, 'keyring.json')).dexKey);
  await assert.rejects(restoreSignerBackup({ role: 'trader', dataDir: join(s.dir, 'x') }, { from: file, passphrase, keyPassword }), /signer roles only/);
  await assert.rejects(exportSignerBackup({ ...s.config, role: 'service' }, { out: s.out, passphrase, keyPassword }), /signer roles only/);
  await assert.rejects(exportOf(s, { out: 'relative/dir' }), /--out must be an absolute directory/);
  const shared = join(s.dir, 'shared'); mkdirSync(shared, { mode: 0o755 });
  await assert.rejects(exportOf(s, { out: shared }), /private 0700 folder/);
  assert.deepEqual(readdirSync(shared), []);
  await assert.rejects(exportOf(s, { keyPassword: 'wrong signer password' }), /Keyring password or file is invalid/);
});

test('the command line: passphrase from a private file or asked twice, never printed; restore prints the two-copies rule', async () => {
  const s = await signer(), repo = fileURLToPath(new URL('../../../', import.meta.url));
  const file = join(s.dir, 'passphrase'); writeFileSync(file, passphrase + '\n', { mode: 0o600 });
  const configFile = join(s.dir, 'signer.json'); writeFileSync(configFile, JSON.stringify(s.config));
  const dex = (...args) => spawnSync(process.execPath, ['bin/dex.mjs', ...args, '--config', configFile, '--passphrase-file', file],
    { cwd: repo, encoding: 'utf8', env: { ...process.env, DEX_KEY_PASSWORD: keyPassword } });
  const made = dex('signer-backup', 'export', '--out', s.out);
  assert.equal(made.status, 0, made.stderr);
  const bundle = JSON.parse(made.stdout).file;
  const checked = dex('signer-backup', 'verify', '--from', bundle);
  assert.equal(checked.status, 0, checked.stderr); assert.equal(JSON.parse(checked.stdout).stakeShares, 1);
  writeFileSync(configFile, JSON.stringify({ role: 'signer', dataDir: join(s.dir, 'cli-restored') }));
  const back = dex('signer-backup', 'restore', '--from', bundle, '--journal', String(JSON.parse(made.stdout).position));
  assert.equal(back.status, 0, back.stderr); assert.match(back.stderr, /Never run two copies of one signer/);
  for (const r of [made, checked, back]) assert.ok(!(r.stdout + r.stderr).includes(passphrase) && !(r.stdout + r.stderr).includes(keyPassword), 'secrets never printed');
  assert.notEqual(dex('signer-backup', 'verify', '--from', bundle, '--journal', '1').status, 0, '--journal is for restore only');
  // Prompts: export asks twice and refuses a mismatch; a passphrase file must be private.
  const answers = ['first passphrase here', 'second passphrase here'];
  await assert.rejects(signerBackupCommand(s.config, 'export', { out: s.out }, { ask: async () => answers.shift(), env: { DEX_KEY_PASSWORD: keyPassword } }), /The passphrases differ/);
  const open = join(s.dir, 'open-passphrase'); writeFileSync(open, passphrase, { mode: 0o644 });
  await assert.rejects(signerBackupCommand(s.config, 'verify', { from: bundle, passphraseFile: open }), /private 0600/);
  await assert.rejects(signerBackupCommand(s.config, 'restore', { from: bundle, passphraseFile: file, journal: 'yesterday' }), /--journal must be a journal position/);
  await assert.rejects(signerBackupCommand(s.config, 'delete', {}), /Expected signer-backup export, verify or restore/);
});
