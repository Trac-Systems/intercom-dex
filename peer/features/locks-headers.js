import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import b4a from 'b4a';

const READ_TIMEOUT_MS = 30000;
const digest = hx => createHash('sha256').update(createHash('sha256').update(b4a.from(hx, 'hex')).digest()).digest().reverse().toString('hex');
const valid = row => row && typeof row.header === 'string' && /^[0-9a-f]{160}$/.test(row.header) && Number.isSafeInteger(row.index) && Number.isSafeInteger(row.seq);

// Derived data only: every lookup still checks the hash in the signed RESET view.
// The bounded memory cache is backed by an incremental on-disk index for old positions.
export class LocksHeaders {
  constructor(directory = null) {
    this.directory = directory; this.cache = new Map(); this.cursor = 0; this.queue = Promise.resolve();
    this.ready = directory ? fs.promises.readFile(path.join(directory, 'cursor.json'), 'utf8').then(raw => {
      const n = JSON.parse(raw); if (Number.isSafeInteger(n) && n >= 0) this.cursor = n;
    }).catch(() => {}) : Promise.resolve();
  }
  remember(hash, row) {
    this.cache.delete(hash); this.cache.set(hash, row);
    if (this.cache.size > 4096) this.cache.delete(this.cache.keys().next().value);
  }
  file(hash) { return path.join(this.directory, hash.slice(0, 2), hash + '.json'); }
  async cached(hash) {
    if (this.cache.has(hash)) return this.cache.get(hash);
    if (!this.directory) return null;
    try {
      const row = JSON.parse(await fs.promises.readFile(this.file(hash), 'utf8'));
      if (valid(row) && digest(row.header) === hash) { this.remember(hash, row); return row; }
    } catch {}
    return null;
  }
  async put(hash, row) {
    if (this.directory) {
      const file = this.file(hash); await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, JSON.stringify(row));
    }
    this.remember(hash, row);
  }
  async scan(view, total, start, wanted, progress = false) {
    let found;
    for (let i = start; i < total; i++) {
      if (i > start && i % 256 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      // Progress survives a stalled read: the next sync resumes here instead of rescanning the history.
      if (progress && i > start && i % 4096 === 0) await this.saveCursor(i);
      // A block that no peer serves must not stall the index forever; the next update retries it.
      const entry = await view.get(`msg/${i}`, { timeout: READ_TIMEOUT_MS }); let packet;
      try { packet = JSON.parse(entry?.value.msg); } catch { continue; }
      if (packet?.t !== 'header' || !Array.isArray(packet.p?.hx)) continue;
      for (const hx of packet.p.hx) if (typeof hx === 'string' && /^[0-9a-f]{160}$/.test(hx)) {
        const hash = digest(hx), row = { header: hx, index: i, seq: entry.seq };
        await this.put(hash, row); if (hash === wanted) found = row;
      }
    }
    return found;
  }
  async sync(view, wanted) {
    await this.ready;
    const total = (await view.get('msgl', { timeout: READ_TIMEOUT_MS }))?.value ?? 0;
    if (!Number.isSafeInteger(total) || total < 0) throw new Error('Invalid header history');
    const start = this.cursor > total ? 0 : this.cursor;
    let found = await this.scan(view, total, start, wanted, true);
    // A missing/corrupt cache file is recoverable; the chain remains the authority.
    if (wanted && !found && !await this.cached(wanted) && start) found = await this.scan(view, start, 0, wanted);
    if (start !== total) await this.saveCursor(total);
    return found;
  }
  async saveCursor(n) {
    this.cursor = n;
    if (!this.directory) return;
    await fs.promises.mkdir(this.directory, { recursive: true });
    await fs.promises.writeFile(path.join(this.directory, 'cursor.json.tmp'), JSON.stringify(n));
    await fs.promises.rename(path.join(this.directory, 'cursor.json.tmp'), path.join(this.directory, 'cursor.json'));
  }
  enqueue(fn) { const work = this.queue.then(fn); this.queue = work.catch(() => {}); return work; }
  update(view) { return this.enqueue(() => this.sync(view)); }
  async get(view, hash) {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid header hash');
    await this.ready;
    const hit = await this.cached(hash); if (hit) return hit;
    return this.enqueue(async () => {
      const hit = await this.cached(hash); if (hit) return hit;
      const found = await this.sync(view, hash), row = found ?? await this.cached(hash);
      if (!row) throw new Error('Applied header unavailable');
      return row;
    });
  }
}
