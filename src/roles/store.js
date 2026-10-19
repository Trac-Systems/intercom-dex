import { openSync, writeSync, fsyncSync, closeSync, renameSync, readFileSync, existsSync, mkdirSync, readdirSync, chmodSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

// Encrypted, durable JSON records (trade states, signer shares, outboxes). One file per record; writes are
// atomic (temp file, fsync, rename, fsync of the folder). The 32-byte key comes from the role's keyring, never
// from a file next to the records.
export function openStore(dir, key, { readOnly = false } = {}) {
  if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error('Store key of 32 bytes required');
  if (!readOnly) { mkdirSync(join(dir, 'records'), { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); }
  const file = name => {
    if (!/^[a-z0-9:_-]{1,160}$/i.test(name)) throw new Error('Invalid record name');
    return join(dir, 'records', name.replaceAll(':', '_') + '.rec');
  };
  const syncDir = path => { const fd = openSync(dirname(path), 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
  return {
    put(name, value) {
      if (readOnly) throw new Error('Read-only record store');
      const path = file(name), nonce = randomBytes(24);
      const body = xchacha20poly1305(key, nonce, Buffer.from(name)).encrypt(Buffer.from(JSON.stringify(value)));
      const tmp = `${path}.tmp`, fd = openSync(tmp, 'w', 0o600);
      try { writeSync(fd, Buffer.concat([nonce, body])); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, path); syncDir(path);
    },
    get(name) {
      const path = file(name);
      if (!existsSync(path)) return null;
      const raw = readFileSync(path);
      return JSON.parse(Buffer.from(xchacha20poly1305(key, raw.subarray(0, 24), Buffer.from(name)).decrypt(raw.subarray(24))).toString());
    },
    delete(name) {
      if (readOnly) throw new Error('Read-only record store');
      const path = file(name);
      if (!existsSync(path)) return false;
      unlinkSync(path); syncDir(path);
      return true;
    },
    list(prefix = '') {
      if (readOnly && !existsSync(join(dir, 'records'))) return [];
      const p = prefix.replaceAll(':', '_');
      return readdirSync(join(dir, 'records')).filter(f => f.endsWith('.rec') && f.startsWith(p)).map(f => f.slice(0, -4));
    },
  };
}
