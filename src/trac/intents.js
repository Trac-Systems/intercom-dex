import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { tryLock } from '../../peer/node_modules/fs-native-extensions/index.js';

const isHash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const digest = intent => createHash('sha256').update(JSON.stringify(intent)).digest('hex');
const fields = ['tradeId', 'asset', 'from', 'to', 'amount', 'sendBy', 'txHash', 'createdAt', 'sentAt', 'payload', 'submission'];

function validate(intent) {
  if (!exact(intent, fields) || !isHash(intent.tradeId) || !isHash(intent.txHash) || !['TNK', 'RESET'].includes(intent.asset) ||
      typeof intent.from !== 'string' || typeof intent.to !== 'string' || typeof intent.amount !== 'string' || !/^[1-9][0-9]{0,77}$/.test(intent.amount) ||
      !['createdAt', 'sentAt', 'sendBy'].every(key => Number.isSafeInteger(intent[key]) && intent[key] >= 0) ||
      intent.sentAt < intent.createdAt || intent.sentAt >= intent.sendBy) throw new Error('Invalid transfer intent');
  const operation = intent.asset === 'TNK' ? intent.payload?.tro : intent.payload?.txo;
  if (intent.payload?.type !== (intent.asset === 'TNK' ? 13 : 12) || intent.payload.address !== intent.from || operation?.tx !== intent.txHash ||
      !isHash(operation.txv) || (intent.asset === 'TNK' ? intent.submission !== null : intent.submission?.tx !== intent.txHash)) throw new Error('Invalid signed intent');
}

export function openIntentStore(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('Expected absolute intent folder');
  folder = path.resolve(folder);
  const firstCreated = fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const fd = fs.openSync(path.join(folder, 'intents.jsonl'), fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  const intents = new Map();
  let closed = false, failed = false;
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('Expected a regular intent journal');
    if (!tryLock(fd)) throw new Error('Intent store is already open');
    const raw = fs.readFileSync(fd, 'utf8');
    if (raw && !raw.endsWith('\n')) throw new Error('Incomplete intent journal');
    for (const line of raw.split('\n').slice(0, -1)) {
      const row = JSON.parse(line);
      if (!exact(row, ['v', 'intent', 'sha256']) || row.v !== 1 || row.sha256 !== digest(row.intent)) throw new Error('Invalid intent journal');
      validate(row.intent);
      if (intents.has(row.intent.tradeId)) throw new Error('Duplicate transfer intent');
      intents.set(row.intent.tradeId, row.intent);
    }
    fs.fsyncSync(fd);
    const last = firstCreated ? path.dirname(firstCreated) : folder;
    for (let current = folder;; current = path.dirname(current)) {
      const directory = fs.openSync(current, 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      if (current === last) break;
    }
  } catch (error) { fs.closeSync(fd); throw error; }

  function check() {
    if (closed) throw new Error('Intent store is closed');
    if (failed) throw new Error('Intent store failed; reopen and inspect journal');
  }
  return {
    get(tradeId) {
      if (closed) throw new Error('Intent store is closed');
      if (!isHash(tradeId)) throw new Error('Invalid trade ID');
      // A failed append for another trade must not hide an earlier submission.
      if (!intents.has(tradeId)) check();
      return structuredClone(intents.get(tradeId) ?? null);
    },
    save(intent) {
      check();
      validate(intent);
      if (intents.has(intent.tradeId)) throw new Error('Transfer intent already exists');
      const copy = structuredClone(intent);
      const bytes = Buffer.from(JSON.stringify({ v: 1, intent: copy, sha256: digest(copy) }) + '\n');
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
          if (!written) throw new Error('Intent write made no progress');
          offset += written;
        }
        fs.fsyncSync(fd);
      } catch (error) { failed = true; throw error; }
      intents.set(copy.tradeId, copy);
    },
    close() { if (!closed) { closed = true; fs.closeSync(fd); } }
  };
}
