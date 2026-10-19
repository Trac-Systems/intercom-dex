import { openSync, readFileSync, writeSync, fsyncSync, closeSync, fstatSync, renameSync, constants } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { identityPublic, boxPublic } from '../core/keys.js';
import { bytesToHex, stableJSON } from '../core/canonical.js';
import { PublicKey } from '@solana/web3.js';

// One password-encrypted file per role holding its secrets: the dex identity (signs every message), the box key
// (opens sealed shares), the store key (encrypts trade records) and, for traders and the service, the Solana key.
// Public keys sit in the clear (authenticated) so tooling can read them without the password. Nothing secret is
// ever written unencrypted; the password comes from the operator (environment / OS keychain), not the data folder.
const PARAMS = { N: 2 ** 17, r: 8, p: 1, dkLen: 32 }, KDF = { ...PARAMS, maxmem: 256 * 1024 * 1024 };
const isHex = (v, bytes) => typeof v === 'string' && v.length === bytes * 2 && /^[0-9a-f]+$/.test(v);

function check(file, password) {
  if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('Keyring file must be absolute');
  if (typeof password !== 'string' || password.length < 12) throw new Error('Keyring password of at least 12 characters required');
}

// Reads a private file: regular, not a symlink, mode 0600, owned by this user.
export function readPrivateFile(file, maxBytes = 65536) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o777) !== 0o600 || st.uid !== process.getuid() || st.size > maxBytes) throw new Error(`${file} must be a private 0600 regular file of this user`);
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

const publicOf = secrets => ({
  dexKey: bytesToHex(identityPublic(secrets.identity)), boxKey: bytesToHex(boxPublic(secrets.box)),
  solana: secrets.solana ? bytesToHex(ed25519.getPublicKey(Buffer.from(secrets.solana, 'hex').subarray(0, 32))) : null,
  ...(secrets.collectors ? { collectors: secrets.collectors.map(({ id, feeBps, secret }) => ({ id, feeBps,
    collector: new PublicKey(ed25519.getPublicKey(Buffer.from(secret, 'hex').subarray(0, 32))).toBase58() })) } : {}),
});

export async function createKeyring(file, password, { solanaSecret = null, withSolana = false } = {}) {
  check(file, password);
  const secrets = { identity: randomBytes(32).toString('hex'), box: randomBytes(32).toString('hex'), store: randomBytes(32).toString('hex'),
    solana: solanaSecret ? Buffer.from(solanaSecret).toString('hex') : withSolana ? solanaKeypairSecret() : null };
  if (secrets.solana && !isHex(secrets.solana, 64)) throw new Error('Solana secret must be 64 bytes');
  if (secrets.solana && bytesToHex(ed25519.getPublicKey(Buffer.from(secrets.solana, 'hex').subarray(0, 32))) !== secrets.solana.slice(64)) throw new Error('Solana secret does not match its public key');
  return importKeyring(file, password, secrets);
}

// Used by verified disaster-recovery imports; never overwrites an existing keyring.
export async function importKeyring(file, password, secrets) {
  check(file, password);
  if (!secrets || !['identity', 'box', 'store'].every(k => isHex(secrets[k], 32)) ||
      secrets.solana !== null && !isHex(secrets.solana, 64)) throw new Error('Invalid keyring secrets');
  const collectors = secrets.collectors ?? [];
  if (!Array.isArray(collectors) || new Set(collectors.map(c => c.id)).size !== collectors.length ||
      collectors.some(c => typeof c.id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(c.id) || !Number.isInteger(c.feeBps) || c.feeBps < 0 || c.feeBps > 1000 || !isHex(c.secret, 64))) throw new Error('Invalid collector secrets');
  for (const secret of [secrets.solana, ...collectors.map(c => c.secret)].filter(Boolean)) {
    if (bytesToHex(ed25519.getPublicKey(Buffer.from(secret, 'hex').subarray(0, 32))) !== secret.slice(64)) throw new Error('Solana secret does not match its public key');
  }
  const salt = randomBytes(16), nonce = randomBytes(24), pub = publicOf(secrets);
  const header = { v: 1, kdf: PARAMS, salt: salt.toString('hex'), nonce: nonce.toString('hex'), public: pub };
  const key = await scryptAsync(password, salt, KDF);
  try {
    const ciphertext = xchacha20poly1305(key, nonce, Buffer.from(stableJSON(header))).encrypt(Buffer.from(JSON.stringify(secrets)));
    const fd = openSync(file, 'wx', 0o600);
    try { writeSync(fd, JSON.stringify({ ...header, ciphertext: Buffer.from(ciphertext).toString('hex') }) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    const dir = openSync(dirname(file), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { key.fill(0); }
  return pub;
}

function solanaKeypairSecret() {
  const seed = randomBytes(32);
  return Buffer.concat([seed, Buffer.from(ed25519.getPublicKey(seed))]).toString('hex');
}

export function keyringPublic(file) {
  const packet = JSON.parse(readPrivateFile(file, 16 * 1024 * 1024));
  return packet.public;
}

async function decryptKeyring(file, password) {
  check(file, password);
  let packet;
  try { packet = JSON.parse(readPrivateFile(file, 16 * 1024 * 1024)); } catch (e) { throw new Error(`Invalid keyring: ${e.message}`); }
  if (packet?.v !== 1 || !isHex(packet.salt, 16) || !isHex(packet.nonce, 24) || typeof packet.ciphertext !== 'string' ||
      stableJSON(packet.kdf ?? null) !== stableJSON(PARAMS)) throw new Error('Invalid keyring');
  const { ciphertext, ...header } = packet;
  const key = await scryptAsync(password, Buffer.from(packet.salt, 'hex'), KDF);
  let secrets;
  try { secrets = JSON.parse(Buffer.from(xchacha20poly1305(key, Buffer.from(packet.nonce, 'hex'), Buffer.from(stableJSON(header))).decrypt(Buffer.from(ciphertext, 'hex'))).toString()); }
  catch { throw new Error('Keyring password or file is invalid'); }
  finally { key.fill(0); }
  if (stableJSON(publicOf(secrets)) !== stableJSON(packet.public)) throw new Error('Keyring public keys do not match its secrets');
  return { secrets, pub: packet.public };
}

export async function openKeyring(file, password) {
  let { secrets, pub } = await decryptKeyring(file, password);
  let queue = Promise.resolve();
  return {
    identity: { secretKey: secrets.identity, publicKey: pub.dexKey },
    box: { secretKey: secrets.box, publicKey: pub.boxKey },
    storeKey: Buffer.from(secrets.store, 'hex'),
    solanaSecret: secrets.solana ? Uint8Array.from(Buffer.from(secrets.solana, 'hex')) : null,
    get collectors() {
      const publicKeys = publicOf(secrets).collectors;
      return (secrets.collectors ?? []).map((c, i) => ({ ...publicKeys[i], secretKey: Uint8Array.from(Buffer.from(c.secret, 'hex')) }));
    },
    // The operation id is written with the key. Retrying after any file-write crash reuses that exact key.
    ensureCollector({ id, feeBps, useMain = false }) {
      const next = queue.then(async () => {
        if (typeof id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(id) || !Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000 || typeof useMain !== 'boolean') throw new Error('Invalid collector request');
        ({ secrets, pub } = await decryptKeyring(file, password));
        const prior = secrets.collectors?.find(c => c.id === id);
        if (prior) {
          if (prior.feeBps !== feeBps) throw new Error('Collector operation has different bps');
          return publicOf(secrets).collectors.find(c => c.id === id);
        }
        if (!secrets.solana || useMain && secrets.collectors?.length) throw new Error('Main collector can only be registered once');
        const updated = { ...secrets, collectors: [...(secrets.collectors ?? []), { id, feeBps, secret: useMain ? secrets.solana : solanaKeypairSecret() }] };
        const salt = randomBytes(16), nonce = randomBytes(24), key = await scryptAsync(password, salt, KDF);
        const header = { v: 1, kdf: PARAMS, salt: salt.toString('hex'), nonce: nonce.toString('hex'), public: publicOf(updated) };
        try {
          const ciphertext = xchacha20poly1305(key, nonce, Buffer.from(stableJSON(header))).encrypt(Buffer.from(JSON.stringify(updated)));
          const tmp = file + '.' + randomBytes(8).toString('hex') + '.tmp', fd = openSync(tmp, 'wx', 0o600);
          try { writeSync(fd, JSON.stringify({ ...header, ciphertext: Buffer.from(ciphertext).toString('hex') }) + '\n'); fsyncSync(fd); }
          finally { closeSync(fd); }
          renameSync(tmp, file);
          const dir = openSync(dirname(file), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
          secrets = updated; pub = header.public;
          return pub.collectors.at(-1);
        } finally { key.fill(0); }
      });
      queue = next.catch(() => {});
      return next;
    },
  };
}
