import { priceUnits } from './assets.js';
import { parseBody } from '../core/schemas.js';

const key = l => `${l.side}:${l.price}`;
const sort = rows => rows.sort((a, b) => {
  if (a.side !== b.side) return a.side === 'sell' ? -1 : 1;
  const d = priceUnits(a.price) - priceUnits(b.price);
  return d === 0n ? 0 : (d > 0n ? 1 : -1) * (a.side === 'sell' ? 1 : -1);
});

export function priceLevels(offers) {
  const levels = new Map();
  for (const o of offers) {
    const price = o.price.includes('.') ? o.price.replace(/0+$/, '').replace(/\.$/, '') : o.price;
    const id = key({ ...o, price }), old = levels.get(id);
    levels.set(id, { side: o.side, price, baseAmount: (BigInt(old?.baseAmount ?? 0) + BigInt(o.baseAmount)).toString(), offers: (old?.offers ?? 0) + 1 });
  }
  const rows = sort([...levels.values()]);
  return ['sell', 'buy'].flatMap(side => rows.filter(l => l.side === side).slice(0, 50));
}

// Every delta is cumulative against the named full snapshot, never the preceding delta.
export class BookFeed {
  constructor() { this.pairs = new Map(); }
  next(pair, registryVersion, offers, now, nextSeq) {
    const levels = priceLevels(offers), current = JSON.stringify(levels), prev = this.pairs.get(pair);
    if (!prev || prev.registryVersion !== registryVersion || now - prev.at >= 60) {
      const seq = nextSeq();
      this.pairs.set(pair, { seq, registryVersion, at: now, levels, current });
      const remaining = offers.slice(0, 200).map(o => ({ offerId: o.offerId, amount: o.baseAmount }));
      return { kind: 'book', body: { pair, registryVersion, seq, ts: now, levels, remaining } };
    }
    if (prev.current === current) return null;
    const base = new Map(prev.levels.map(l => [key(l), l])), live = new Map(levels.map(l => [key(l), l]));
    prev.current = current;
    return { kind: 'bookDelta', body: { pair, seq: prev.seq,
      upserts: levels.filter(l => JSON.stringify(base.get(key(l))) !== JSON.stringify(l)),
      removes: prev.levels.filter(l => !live.has(key(l))).map(({ side, price }) => ({ side, price })) } };
  }
}

export class BookView {
  constructor() { this.books = new Map(); this.bases = new Map(); this.inventory = new Map(); }
  full(body) {
    const b = parseBody('book', body), old = this.bases.get(b.pair);
    if (old && b.seq <= old.seq) return false;
    if (b.remaining) this.inventory.set(b.pair, b);
    this.bases.set(b.pair, b); this.books.set(b.pair, b); return true;
  }
  delta(body, ts) {
    const d = parseBody('bookDelta', body), base = this.bases.get(d.pair), old = this.books.get(d.pair);
    if (!base || d.seq !== base.seq || !Number.isSafeInteger(ts) || ts <= old.ts) return false;
    const levels = new Map(base.levels.map(l => [key(l), l]));
    for (const l of d.removes) levels.delete(key(l));
    for (const l of d.upserts) levels.set(key(l), l);
    const { remaining, ...snapshot } = base;
    const next = parseBody('book', { ...snapshot, ts, levels: sort([...levels.values()]) });
    this.books.set(d.pair, next); return true;
  }
}
