import { closeSync, constants, fsyncSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tryLock } from '../../peer/node_modules/fs-native-extensions/index.js';

export const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};
export const lockPath = dataDir => join(dataDir, 'dex.pid');
export const lockAlive = (record, isAlive = alive) => [record.pid, record.peerPid, record.traderPid].some(isAlive);
const pause = new Int32Array(new SharedArrayBuffer(4));

// Keep one inode: a native lock serializes stale recovery and every read/write across processes.
// Closing the descriptor releases it even after a crash. A stopped instance stores JSON null.
function withPidFile(dataDir, create, work) {
  let fd;
  try { fd = openSync(lockPath(dataDir), constants.O_RDWR | constants.O_NOFOLLOW | (create ? constants.O_CREAT : 0), 0o600); }
  catch (error) { if (!create && error.code === 'ENOENT') return null; throw error; }
  try {
    if (!fstatSync(fd).isFile()) throw new Error('DEX pid file must be a regular file');
    const deadline = Date.now() + 2000;
    while (!tryLock(fd)) {
      if (Date.now() >= deadline) throw new Error('DEX pid file is busy; retry');
      Atomics.wait(pause, 0, 0, 10);
    }
    let record;
    try { const text = readFileSync(fd, 'utf8'); record = text ? JSON.parse(text) : null; }
    catch { throw new Error('Cannot read dex.pid; refusing to replace an uncertain lock'); }
    return work(record, value => {
      const bytes = Buffer.from(JSON.stringify(value));
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
      ftruncateSync(fd, bytes.length); fsyncSync(fd);
    });
  } finally { closeSync(fd); }
}

export const readLock = dataDir => withPidFile(dataDir, false, record => record);

export function acquireLock(dataDir, { isAlive = alive, pid = process.pid } = {}) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  dataDir = realpathSync(dataDir);
  return withPidFile(dataDir, true, (old, write) => {
    if (old && (!old.id || !Number.isSafeInteger(old.pid) || lockAlive(old, isAlive))) throw new Error('DEX already running or starting for this data folder');
    const record = { id: randomUUID(), pid, dataDir, phase: 'starting', startedAt: new Date().toISOString() };
    write(record); return record;
  });
}

export function saveLock(record) {
  return withPidFile(record.dataDir, false, (old, write) => {
    if (old?.id !== record.id) throw new Error('DEX lock ownership changed');
    if (old.stopRequested) record.stopRequested = true;
    write(record);
  });
}

export function requestStop(record, { idleOnly = false, traderPid } = {}) {
  return withPidFile(record.dataDir, false, (old, write) => {
    if (old?.id !== record.id || (traderPid !== undefined && old.traderPid !== traderPid)) throw new Error('DEX instance changed; retry status');
    // An idle stop must not race a replacement trader starting and admitting work.
    if (idleOnly && old.traderPid && !old.stopRequested) return false;
    write({ ...old, stopRequested: true });
    return true;
  });
}

export function launchLocked(record, name, launch) {
  return withPidFile(record.dataDir, false, (old, write) => {
    if (old?.id !== record.id) throw new Error('DEX lock ownership changed');
    if (old.stopRequested) { record.stopRequested = true; return null; }
    const runtime = launch();
    record[name + 'Pid'] = runtime.child.pid ?? null;
    write(record);
    return runtime;
  });
}

export function releaseLock(record) {
  return withPidFile(record.dataDir, false, (old, write) => { if (old?.id === record.id) write(null); });
}
