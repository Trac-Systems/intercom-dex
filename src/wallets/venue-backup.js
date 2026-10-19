import { lstatSync, mkdirSync, readdirSync, openSync, writeSync, fsyncSync, closeSync, chmodSync } from 'node:fs';
import { isAbsolute, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { PublicKey } from '@solana/web3.js';
import { boxPublic } from '../core/keys.js';
import { stableJSON } from '../core/canonical.js';
import { buildRegistry } from '../core/registry.js';
import { importKeyring, readPrivateFile } from '../roles/keyring.js';
import { openStore } from '../roles/store.js';
import { hiddenInput } from './input.js';

function directory(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Absolute directory required');
  try { return lstatSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

// The venue records a restored venue cannot rebuild: every registry version it issued (participants refuse a known
// version number with other content), its fee policy and its book sequence.
const RECORDS = 'venue-records.json';
const recordName = /^(service-registry(-v[1-9][0-9]*|-published)?|service-fee-policy|book-sequence)$/;

export function venueRecords(store) {
  return Object.fromEntries([...store.list('service-registry'), 'service-fee-policy', 'book-sequence'].sort()
    .map(name => [name, store.get(name)]).filter(([, value]) => value !== null));
}

function checkRecords(records) {
  if (!records || typeof records !== 'object' || Array.isArray(records)) throw new Error('Invalid venue records');
  for (const [name, value] of Object.entries(records)) {
    if (!recordName.test(name) || !value || typeof value !== 'object') throw new Error('Invalid venue record');
    if (name.startsWith('service-registry') && buildRegistry(value).version !== Number(name.match(/-v([0-9]+)$/)?.[1] ?? value.version)) throw new Error('Registry record version mismatch');
  }
  return records;
}

function manifest(secrets, records) {
  const sol = secret => new PublicKey(Buffer.from(secret, 'hex').subarray(32)).toBase58();
  const dex = Buffer.from(ed25519.getPublicKey(Buffer.from(secrets.identity, 'hex'))).toString('hex');
  const box = Buffer.from(boxPublic(secrets.box)).toString('hex');
  const main = sol(secrets.solana);
  return { v: 1, role: 'service', keys: [
    { role: 'identity', publicKey: dex, purpose: 'Signs venue registries; pinned serviceKey', file: `identity-${dex}.json` },
    { role: 'box', publicKey: box, purpose: 'Opens sealed messages', file: `box-${box}.json` },
    { role: 'store', fingerprint: createHash('sha256').update(Buffer.from(secrets.store, 'hex')).digest('hex'), purpose: 'Encrypts venue records; symmetric key has no public key', file: 'store-key.json' },
    { role: 'solana', publicKey: main, purpose: 'Main Solana rent and transaction payer', file: `solana-main-${main}.json` },
    ...(secrets.collectors ?? []).map(c => ({ role: 'collector', publicKey: sol(c.secret), purpose: 'Venue trade fee collector',
      id: c.id, feeBps: c.feeBps, file: `collector-${sol(c.secret)}.json` })),
  ], ...(records ? { records: { file: RECORDS, names: Object.keys(records).sort(), sha256: createHash('sha256').update(stableJSON(records)).digest('hex') } } : {}) };
}

function syncDirectory(path) {
  const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function exportVenue(keys, out, records) {
  if (directory(out)) throw new Error('Export directory already exists');
  const collectors = keys.collectors;
  const secrets = { identity: keys.identity.secretKey, box: keys.box.secretKey, store: keys.storeKey.toString('hex'),
    solana: Buffer.from(keys.solanaSecret).toString('hex'), collectors: collectors.map(c => ({ id: c.id, feeBps: c.feeBps, secret: Buffer.from(c.secretKey).toString('hex') })) };
  try {
    const index = manifest(secrets, checkRecords(records)), files = [];
    if (new Set(index.keys.map(k => k.file)).size !== index.keys.length) throw new Error('Duplicate collector keys');
    mkdirSync(out, { mode: 0o700 }); chmodSync(out, 0o700);
    const write = (name, value) => {
      const fd = openSync(join(out, name), 'wx', 0o600);
      try { writeSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
      files.push(name);
    };
    for (const entry of index.keys) {
      let secret = entry.role === 'collector' ? secrets.collectors.find(c => c.id === entry.id).secret : secrets[entry.role];
      if (entry.role === 'identity') secret += entry.publicKey;
      write(entry.file, [...Buffer.from(secret, 'hex')]);
    }
    write(RECORDS, records);
    write('MANIFEST.json', index); syncDirectory(out); syncDirectory(dirname(out));
    return files;
  } finally { for (const c of collectors) c.secretKey.fill(0); }
}

export async function restoreVenue(config, { from, readPassword = hiddenInput } = {}) {
  if (config.role !== 'service') throw new Error('Venue restore is service only');
  const source = directory(from), target = directory(config.dataDir);
  if (!source?.isDirectory() || source.isSymbolicLink() || (source.mode & 0o777) !== 0o700 || source.uid !== process.getuid()) throw new Error('Export directory must be private 0700');
  if (target && (!target.isDirectory() || target.isSymbolicLink() || readdirSync(config.dataDir).length)) throw new Error('Restore requires an empty data folder');
  const index = JSON.parse(readPrivateFile(join(from, 'MANIFEST.json'), 16 * 1024 * 1024));
  if (index?.v !== 1 || index.role !== 'service' || !Array.isArray(index.keys)) throw new Error('Invalid venue manifest');
  const secrets = { collectors: [] }, buffers = [];
  try {
    for (const entry of index.keys) {
      if (!entry || !['identity', 'box', 'store', 'solana', 'collector'].includes(entry.role) ||
          typeof entry.file !== 'string' || !/^[a-zA-Z0-9-]+\.json$/.test(entry.file)) throw new Error('Invalid manifest key');
      const bytes = JSON.parse(readPrivateFile(join(from, entry.file)));
      const length = ['identity', 'solana', 'collector'].includes(entry.role) ? 64 : 32;
      if (!Array.isArray(bytes) || bytes.length !== length || bytes.some(b => !Number.isInteger(b) || b < 0 || b > 255)) throw new Error('Invalid exported key');
      const secret = Buffer.from(bytes); bytes.fill(0); buffers.push(secret);
      if (length === 64 && !Buffer.from(ed25519.getPublicKey(secret.subarray(0, 32))).equals(secret.subarray(32))) throw new Error('Exported public key does not match secret');
      if (entry.role === 'collector') secrets.collectors.push({ id: entry.id, feeBps: entry.feeBps, secret: secret.toString('hex') });
      else {
        if (Object.hasOwn(secrets, entry.role)) throw new Error('Duplicate manifest role');
        secrets[entry.role] = (entry.role === 'identity' ? secret.subarray(0, 32) : secret).toString('hex');
      }
    }
    if (!['identity', 'box', 'store', 'solana'].every(k => secrets[k])) throw new Error('Manifest is missing a required key');
    // Exports made before the records were included hold keys only.
    const records = index.records ? checkRecords(JSON.parse(readPrivateFile(join(from, RECORDS), 64 * 1024 * 1024))) : null;
    if (stableJSON(manifest(secrets, records)) !== stableJSON(index) ||
        stableJSON(readdirSync(from).sort()) !== stableJSON(['MANIFEST.json', ...index.keys.map(k => k.file), ...(records ? [RECORDS] : [])].sort())) throw new Error('Manifest does not match export files');
    const identity = index.keys.find(k => k.role === 'identity').publicKey;
    if (config.serviceKey && config.serviceKey !== identity) throw new Error('Restored identity differs from configured serviceKey');
    const password = await readPassword('New keyring password: ');
    // Recheck after terminal input; exclusive keyring creation also fences simultaneous restores.
    if (directory(config.dataDir) && readdirSync(config.dataDir).length) throw new Error('Restore requires an empty data folder');
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 }); chmodSync(config.dataDir, 0o700);
    const pub = await importKeyring(join(config.dataDir, 'keyring.json'), password, secrets);
    if (records) {
      const storeKey = Buffer.from(secrets.store, 'hex'); buffers.push(storeKey);
      const store = openStore(config.dataDir, storeKey);
      for (const [name, value] of Object.entries(records)) store.put(name, value);
    }
    syncDirectory(dirname(config.dataDir));
    return { dexKey: pub.dexKey, boxKey: pub.boxKey, solana: new PublicKey(Buffer.from(pub.solana, 'hex')).toBase58(), collectors: pub.collectors,
      records: records ? Object.keys(records).sort() : [] };
  } finally { for (const b of buffers) b.fill(0); }
}
