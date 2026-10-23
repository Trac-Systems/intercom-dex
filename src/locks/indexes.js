// Durable records remain available by id; periodic work visits only active records.
export class PositionMap extends Map {
  constructor(isActive) { super(); this.isActive = isActive; this.active = new Map(); }
  set(id, value) { super.set(id, value); if (this.isActive(value)) this.active.set(id, value); else this.active.delete(id); return this; }
  delete(id) { this.active.delete(id); return super.delete(id); }
  clear() { this.active.clear(); super.clear(); }
}

// Sorted public pages are updated on writes, without decrypting or serializing history on reads.
export class BookIndex {
  constructor() { this.rows = new Map(); this.views = new Map(); }
  keys(p) { return ['', p.post.product].flatMap(product => ['', p.post.terms.asset].map(asset => `${product}:${asset}`)); }
  update(p) {
    const old = this.rows.get(p.positionId);
    if (old) for (const key of this.keys(old.position)) {
      const view = this.views.get(key), at = this.find(view.rows, p.positionId);
      view.rows.splice(at, 1);
      if (view.largest === old.size) view.largest = view.rows.reduce((n, row) => Math.max(n, row.size), 1);
    }
    this.rows.delete(p.positionId);
    if (p.state !== 'posted') return;
    const value = { positionId: p.positionId, post: p.post, state: p.state, lock: p.lock, attestations: Object.values(p.posted), lockReady: Object.values(p.dkgs?.['']?.ready ?? {}) };
    const row = { position: p, value, size: JSON.stringify(value).length + 1 };
    this.rows.set(p.positionId, row);
    for (const key of this.keys(p)) {
      const view = this.views.get(key) ?? { rows: [], largest: 1 };
      view.rows.splice(this.find(view.rows, p.positionId), 0, row); view.largest = Math.max(view.largest, row.size); this.views.set(key, view);
    }
  }
  find(rows, id) {
    let lo = 0, hi = rows.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (rows[mid].value.positionId.localeCompare(id) < 0) lo = mid + 1; else hi = mid; }
    return lo;
  }
  page({ page = 0, limit = 100, product = '', asset = '' }) {
    const view = this.views.get(`${product}:${asset}`) ?? { rows: [], largest: 1 };
    const pageSize = Math.max(1, Math.min(limit, Math.floor(180000 / view.largest)));
    return { page, pageSize, total: view.rows.length, positions: view.rows.slice(page * pageSize, (page + 1) * pageSize).map(row => row.value) };
  }
}

export class Deadlines {
  constructor() { this.rows = []; this.byId = new Map(); }
  set(id, at) {
    const old = this.byId.get(id); if (old?.at === at) return;
    if (old) { this.rows.splice(this.rows.indexOf(old), 1); this.byId.delete(id); }
    if (at === undefined) return;
    const row = { id, at }; let lo = 0, hi = this.rows.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.rows[mid].at < at) lo = mid + 1; else hi = mid; }
    this.rows.splice(lo, 0, row); this.byId.set(id, row);
  }
  *due(now) {
    while (this.rows[0]?.at <= now) { const row = this.rows.shift(); this.byId.delete(row.id); yield row.id; }
  }
}
