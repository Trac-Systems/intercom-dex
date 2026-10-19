import fs from 'fs';
import path from 'path';
import b4a from 'b4a';
import { tryLock } from 'fs-native-extensions';

const isHash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

export function openUsedTxStore(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('Expected absolute journal folder');
  folder = path.resolve(folder);
  // bare-fs 4.5.0 has neither fsync nor functioning O_SYNC constants. Never
  // acknowledge a durable reservation on that runtime without a flush primitive.
  if (typeof fs.fsyncSync !== 'function') throw new Error('Durable used-tx store requires fs.fsyncSync; installed Bare filesystem is unsupported');
  const firstCreated = fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const filename = path.join(folder, 'used-tx.jsonl');
  const fd = fs.openSync(filename, 'a+', 0o600);
  const claims = new Map();
  let closed = false;
  let failed = false;
  try {
    if (!tryLock(fd)) throw new Error('Used-tx store is already open');
    const raw = fs.readFileSync(fd, 'utf8');
    if (raw && !raw.endsWith('\n')) throw new Error('Incomplete used-tx journal');
    for (const line of raw.split('\n').slice(0, -1)) {
      const row = JSON.parse(line);
      if (!row || Object.keys(row).length !== 3 || row.v !== 1 || !isHash(row.txHash) || !isHash(row.tradeId) || claims.has(row.txHash)) throw new Error('Invalid used-tx journal');
      claims.set(row.txHash, row.tradeId);
    }
    fs.fsyncSync(fd);
    let current = path.resolve(folder);
    const last = firstCreated ? path.dirname(firstCreated) : current;
    for (;;) {
      const directory = fs.openSync(current, 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      if (current === last) break;
      current = path.dirname(current);
    }
  } catch (error) { fs.closeSync(fd); throw error; }

  function check() {
    if (closed) throw new Error('Used-tx store is closed');
    if (failed) throw new Error('Used-tx store failed; reopen and inspect journal');
  }
  return {
    get(txHash) {
      check();
      if (!isHash(txHash)) throw new Error('Invalid txHash');
      return claims.get(txHash) ?? null;
    },
    claim(txHash, tradeId) {
      check();
      if (!isHash(txHash) || !isHash(tradeId)) throw new Error('Invalid transaction or trade ID');
      const previous = claims.get(txHash);
      if (previous) return { ok: previous === tradeId, reason: previous === tradeId ? null : 'tx_already_used' };
      const bytes = b4a.from(JSON.stringify({ v: 1, txHash, tradeId }) + '\n');
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
          if (written === 0) throw new Error('Used-tx journal write made no progress');
          offset += written;
        }
        fs.fsyncSync(fd);
      } catch (error) { failed = true; throw error; }
      claims.set(txHash, tradeId);
      return { ok: true, reason: null };
    },
    close() {
      if (closed) return;
      closed = true;
      fs.closeSync(fd);
    }
  };
}
