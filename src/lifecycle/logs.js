import { closeSync, existsSync, fstatSync, openSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const LOG_BYTES = 5 * 1024 * 1024;
export const LOG_COPIES = 3;
export const logPaths = dataDir => ({ peer: join(dataDir, 'peer.log'), trader: join(dataDir, 'trader.log') });

// The supervisor owns the handles, so rotation also moves subsequent child output to the new file.
export function rotatingLog(file, { maxBytes = LOG_BYTES, copies = LOG_COPIES } = {}) {
  let fd = openSync(file, 'a', 0o600), size = fstatSync(fd).size;
  const rotate = () => {
    closeSync(fd);
    if (existsSync(file + '.' + copies)) unlinkSync(file + '.' + copies);
    for (let i = copies - 1; i > 0; i--) if (existsSync(file + '.' + i)) renameSync(file + '.' + i, file + '.' + (i + 1));
    renameSync(file, file + '.1');
    fd = openSync(file, 'a', 0o600); size = 0;
  };
  return {
    write(chunk) {
      const bytes = Buffer.from(chunk);
      for (let offset = 0; offset < bytes.length;) {
        if (size >= maxBytes) rotate();
        const count = Math.min(maxBytes - size, bytes.length - offset);
        const written = writeSync(fd, bytes, offset, count);
        offset += written; size += written;
      }
    },
    close() { if (fd !== null) { closeSync(fd); fd = null; } },
  };
}

export function tailLog(file, maxBytes = 64 * 1024) {
  if (!existsSync(file)) return '';
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size, buffer = Buffer.alloc(Math.min(size, maxBytes));
    readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    const text = buffer.toString('utf8');
    return size > maxBytes ? text.slice(text.indexOf('\n') + 1) : text;
  } finally { closeSync(fd); }
}
