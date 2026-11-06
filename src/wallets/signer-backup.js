import { lstatSync, readdirSync, readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, mkdirSync, chmodSync, existsSync, constants, fstatSync, utimesSync } from 'node:fs';
import { isAbsolute, join, basename } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { identityPublic } from '../core/keys.js';
import { bytesToHex, stableJSON } from '../core/canonical.js';
import { openKeyring, importKeyring, keyringPublic, readPrivateFile } from '../roles/keyring.js';
import { openStore } from '../roles/store.js';
import { hiddenInput } from './input.js';

// Encrypted backups of one signer's key pieces: its keyring secrets and every record of its encrypted store (stake
// and lock DKG state, final shares, votes, decisions, reservations, registry snapshots). One file per export, named
// by signer and journal position (the newest record write, in milliseconds); a newer bundle supersedes an older one.
// The passphrase never sits next to the bundles: three of four signers' pieces control every stake.
const KDF = { N: 2 ** 17, r: 8, p: 1, dkLen: 32 }, MAXMEM = 256 * 1024 * 1024, MAX_BYTES = 512 * 1024 * 1024;
const FILE = /^signer-([0-9a-f]{16})-([0-9]{1,16})\.dexbackup$/;
export const TWO_COPIES_RULE = 'Never run two copies of one signer. Start this restored signer only once the old one is stopped for good; '
  + 'two copies of one identity can sign two different outcomes for the same stake.';

const sha256 = text => createHash('sha256').update(text).digest('hex');
const checkPassphrase = p => { if (typeof p !== 'string' || p.length < 12) throw new Error('Backup passphrase of at least 12 characters required'); };
const lookup = path => { try { return lstatSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; } };
const syncDir = path => { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };

// The journal: every record of the signer's store with the time of its last write, and the newest of those times.
// Restore puts the times back, so a restored signer continues from the bundle's position.
function journal(dataDir) {
  const dir = join(dataDir, 'records');
  const names = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.rec')).sort() : [];
  const times = Object.fromEntries(names.map(f => [f.slice(0, -4), Math.floor(lstatSync(join(dir, f)).mtimeMs)]));
  return { times, position: Math.max(0, ...Object.values(times)) };
}

// What the records hold, so verify can tell a complete bundle from a partial one without the signer's keyring.
function inventory(records) {
  const dkg = Object.entries(records).filter(([name]) => name.startsWith('stake-dkg-'));
  for (const [name, r] of dkg) if (r?.unitId !== name.slice('stake-dkg-'.length)) throw new Error(`Stake record ${name} does not match its piece`);
  return { records: Object.keys(records).length, stakePieces: dkg.length, stakeShares: dkg.filter(([, r]) => r.lock && !r.release).length,
    stakeRetired: dkg.filter(([, r]) => r.release).length, stakeInProgress: dkg.filter(([, r]) => !r.lock && !r.release).length };
}

function seal(header, body, key) {
  const nonce = randomBytes(24), full = { ...header, nonce: nonce.toString('hex') };
  const ciphertext = xchacha20poly1305(key, nonce, Buffer.from(stableJSON(full))).encrypt(Buffer.from(JSON.stringify(body)));
  return JSON.stringify({ ...full, ciphertext: Buffer.from(ciphertext).toString('base64') }) + '\n';
}

// Writes `<out>/signer-<id>-<position>.dexbackup` from the signer's data folder (stopped or running). A running signer
// may write while the records are read; the read is repeated until the journal stood still for one whole pass.
export async function exportSignerBackup(config, { out, passphrase, keyPassword }) {
  if (config.role !== 'signer') throw new Error('Signer backups are for signer roles only');
  checkPassphrase(passphrase);
  if (typeof out !== 'string' || !isAbsolute(out)) throw new Error('--out must be an absolute directory');
  const keys = await openKeyring(join(config.dataDir, 'keyring.json'), keyPassword);
  try {
    const signer = keys.identity.publicKey, store = openStore(config.dataDir, keys.storeKey, { readOnly: true });
    let snapshot;
    for (let pass = 0; pass < 5 && !snapshot; pass++) {
      const before = journal(config.dataDir);
      const records = Object.fromEntries(Object.keys(before.times).map(name => [name, store.get(name)]));
      if (stableJSON(journal(config.dataDir)) === stableJSON(before)) snapshot = { records, ...before };
    }
    if (!snapshot) throw new Error('The signer kept writing during the export. Try again, or stop the signer first.');
    const name = `signer-${signer.slice(0, 16)}-${snapshot.position}.dexbackup`, file = join(out, name), counts = inventory(snapshot.records);
    const dir = lookup(out);
    if (dir && (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o777) !== 0o700 || dir.uid !== process.getuid())) throw new Error('The backup folder must be a private 0700 folder of this user');
    const others = (dir ? readdirSync(out) : []).map(f => [f, f.match(FILE)]).filter(([, m]) => m && m[1] === signer.slice(0, 16));
    const newer = others.filter(([, m]) => Number(m[2]) > snapshot.position).map(([f]) => f);
    if (newer.length) throw new Error(`A newer backup of this signer is already there: ${newer.join(', ')}`);
    if (others.some(([f]) => f === name)) return { file, signer, position: snapshot.position, unchanged: true, ...counts };
    const body = { v: 1, signer, position: snapshot.position, secrets: { identity: keys.identity.secretKey, box: keys.box.secretKey,
      store: keys.storeKey.toString('hex'), solana: keys.solanaSecret ? Buffer.from(keys.solanaSecret).toString('hex') : null },
    records: snapshot.records, times: snapshot.times, recordsSha256: sha256(stableJSON(snapshot.records)) };
    const salt = randomBytes(16), key = await scryptAsync(passphrase, salt, { ...KDF, maxmem: MAXMEM });
    let text;
    try { text = seal({ v: 1, kind: 'dex-signer-backup', signer, position: snapshot.position, records: Object.keys(snapshot.records).length, kdf: KDF, salt: salt.toString('hex') }, body, key); }
    finally { key.fill(0); }
    mkdirSync(out, { recursive: true, mode: 0o700 });
    const tmp = join(out, `.${name}.${randomBytes(6).toString('hex')}.tmp`), fd = openSync(tmp, 'wx', 0o600);
    try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file); syncDir(out);
    return { file, signer, position: snapshot.position, superseded: others.map(([f]) => f).sort(), ...counts };
  } finally { keys.storeKey.fill(0); keys.solanaSecret?.fill(0); }
}

// Decrypts a bundle in memory and checks it: authenticated header and body, the keyring secrets against the signer
// id, every record against the recorded digest, and each stake record against its piece. Nothing is written.
export async function openSignerBackup(file, passphrase) {
  checkPassphrase(passphrase);
  if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('Backup file must be an absolute path');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let packet;
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_BYTES) throw new Error('Not a signer backup file');
    packet = JSON.parse(readFileSync(fd, 'utf8'));
  } catch (error) { throw new Error(error instanceof SyntaxError ? 'Not a signer backup file' : error.message); } finally { closeSync(fd); }
  const { ciphertext, ...header } = packet ?? {};
  if (header.v !== 1 || header.kind !== 'dex-signer-backup' || stableJSON(header.kdf) !== stableJSON(KDF) || !/^[0-9a-f]{32}$/.test(header.salt ?? '') ||
      !/^[0-9a-f]{48}$/.test(header.nonce ?? '') || typeof ciphertext !== 'string') throw new Error('Not a signer backup file');
  const key = await scryptAsync(passphrase, Buffer.from(header.salt, 'hex'), { ...KDF, maxmem: MAXMEM });
  let body;
  try { body = JSON.parse(Buffer.from(xchacha20poly1305(key, Buffer.from(header.nonce, 'hex'), Buffer.from(stableJSON(header))).decrypt(Buffer.from(ciphertext, 'base64'))).toString()); }
  catch { throw new Error('Wrong passphrase, or the bundle was changed or damaged'); }
  finally { key.fill(0); }
  const s = body.secrets;
  if (body.v !== 1 || body.signer !== header.signer || body.position !== header.position || !s || bytesToHex(identityPublic(s.identity)) !== body.signer)
    throw new Error('Bundle keys do not match its signer');
  if (sha256(stableJSON(body.records)) !== body.recordsSha256 || Object.keys(body.records).length !== header.records ||
      stableJSON(Object.keys(body.times ?? {}).sort()) !== stableJSON(Object.keys(body.records).sort())) throw new Error('Bundle records are incomplete');
  return { header, body, summary: { signer: body.signer, position: body.position, ...inventory(body.records) } };
}

export async function verifySignerBackup(file, passphrase) {
  return { ok: true, file, ...(await openSignerBackup(file, passphrase)).summary };
}

// Restores into an empty data folder only. `journal` is the newest position the operator knows of (from a later
// bundle or the signer's last export); an older bundle is refused because its pieces may lack later decisions.
export async function restoreSignerBackup(config, { from, passphrase, keyPassword, journal: newest = null }) {
  if (config.role !== 'signer') throw new Error('Signer backups are for signer roles only');
  if (typeof config.dataDir !== 'string' || !isAbsolute(config.dataDir)) throw new Error('Absolute dataDir required');
  const { body, summary } = await openSignerBackup(from, passphrase);
  if (newest !== null && (!Number.isSafeInteger(newest) || summary.position < newest))
    throw new Error(`This bundle (journal ${summary.position}) is older than journal ${newest}. Restore the newest bundle of this signer.`);
  const target = lookup(config.dataDir);
  if (target && (!target.isDirectory() || target.isSymbolicLink())) throw new Error('Restore requires an empty data folder');
  if (target && readdirSync(config.dataDir).length) {
    const keyring = join(config.dataDir, 'keyring.json');
    if (existsSync(keyring) && keyringPublic(keyring)?.dexKey === summary.signer) throw new Error(`This folder already holds signer ${summary.signer}. ${TWO_COPIES_RULE}`);
    throw new Error('Restore requires an empty data folder');
  }
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 }); chmodSync(config.dataDir, 0o700);
  // Exclusive keyring creation also fences two restores into one folder.
  const pub = await importKeyring(join(config.dataDir, 'keyring.json'), keyPassword, body.secrets);
  const storeKey = Buffer.from(body.secrets.store, 'hex');
  try {
    const store = openStore(config.dataDir, storeKey);
    for (const [name, value] of Object.entries(body.records)) {
      store.put(name, value);
      // Seconds with half a millisecond more, so the time reads back as the same whole millisecond.
      utimesSync(join(config.dataDir, 'records', name.replaceAll(':', '_') + '.rec'), Date.now() / 1000, (body.times[name] + 0.5) / 1000);
    }
  } finally { storeKey.fill(0); }
  return { dexKey: pub.dexKey, boxKey: pub.boxKey, restoredFrom: basename(from), ...summary, rule: TWO_COPIES_RULE };
}

// `dex signer-backup export|verify|restore`: the passphrase from a private 0600 file or a hidden prompt (asked twice
// for a new bundle), the keyring password from the role's password variable or a hidden prompt. Neither is echoed.
export async function signerBackupCommand(config, action, { out, from, passphraseFile, journal } = {}, { ask = hiddenInput, env = process.env } = {}) {
  const passphrase = async again => {
    if (passphraseFile !== undefined) {
      if (!isAbsolute(passphraseFile)) throw new Error('--passphrase-file must be an absolute path');
      return readPrivateFile(passphraseFile, 4096).replace(/\r?\n$/, '');
    }
    const first = await ask('Backup passphrase: ');
    if (again && first !== await ask('Backup passphrase again: ')) throw new Error('The passphrases differ');
    return first;
  };
  const keyPassword = prompt => env[config.keyPasswordEnv ?? 'DEX_KEY_PASSWORD'] ?? ask(prompt);
  if (action === 'export') return exportSignerBackup(config, { out, passphrase: await passphrase(true), keyPassword: await keyPassword('Keyring password: ') });
  if (action === 'verify') return verifySignerBackup(from, await passphrase(false));
  if (action === 'restore') {
    if (journal !== undefined && !/^[0-9]{1,16}$/.test(journal)) throw new Error('--journal must be a journal position from a bundle name');
    const p = await passphrase(false);
    return restoreSignerBackup(config, { from, passphrase: p, keyPassword: await keyPassword('New keyring password: '), journal: journal === undefined ? null : Number(journal) });
  }
  throw new Error('Expected signer-backup export, verify or restore');
}
