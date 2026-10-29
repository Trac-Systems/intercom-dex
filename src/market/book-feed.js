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
    // Keep bid books below the legacy 200-row truncation marker. Otherwise an unlisted bid can fall back to its
    // maker's full amount or a shared price level. Give each side room, then use any spare room on the other side.
    if (offers.some(o => o.side === 'buy') && offers.length >= 200) {
      const asks = offers.filter(o => o.side === 'sell'), bids = offers.filter(o => o.side === 'buy');
      const askCount = Math.min(asks.length, Math.max(99, 199 - bids.length));
      offers = [...asks.slice(0, askCount), ...bids.slice(0, 199 - askCount)];
    }
    const levels = priceLevels(offers), current = JSON.stringify(levels), prev = this.pairs.get(pair);
    const remaining = offers.slice(0, 200).map(o => ({ offerId: o.offerId, amount: o.baseAmount }));
    // Legacy deltas only cap whole price levels. A changed bid allocation needs per-offer sizes immediately, even
    // if another bid at the same price grows by the same amount. Full books already carry these sizes on 0.1.32+.
    const bids = JSON.stringify(offers.filter(o => o.side === 'buy').map(o => [o.offerId, o.baseAmount]));
    if (!prev || prev.registryVersion !== registryVersion || now - prev.at >= 60 || prev.bids !== bids) {
      const seq = nextSeq();
      this.pairs.set(pair, { seq, registryVersion, at: now, levels, current, bids });
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
  // heard: pair -> when this app last received a book or delta for it, on its own clock; listedAt: the same for the
  // last full book with its offer list, and listed: that list's offer ids.
  constructor() { this.books = new Map(); this.bases = new Map(); this.inventory = new Map(); this.heard = new Map(); this.listedAt = new Map(); this.listed = new Map(); }
  full(body, at = null) {
    const b = parseBody('book', body), old = this.bases.get(b.pair);
    if (old && b.seq <= old.seq) return false;
    if (b.remaining) this.inventory.set(b.pair, b);
    this.bases.set(b.pair, b); this.books.set(b.pair, b);
    if (at != null) this.heard.set(b.pair, at);
    if (at != null && b.remaining) { this.listedAt.set(b.pair, at); this.listed.set(b.pair, new Set(b.remaining.map(r => r.offerId))); }
    return true;
  }
  delta(body, ts, at = null) {
    const d = parseBody('bookDelta', body), base = this.bases.get(d.pair), old = this.books.get(d.pair);
    if (!base || d.seq !== base.seq || !Number.isSafeInteger(ts) || ts <= old.ts) return false;
    const levels = new Map(base.levels.map(l => [key(l), l]));
    for (const l of d.removes) levels.delete(key(l));
    for (const l of d.upserts) levels.set(key(l), l);
    const { remaining, ...snapshot } = base;
    const next = parseBody('book', { ...snapshot, ts, levels: sort([...levels.values()]) });
    this.books.set(d.pair, next);
    if (at != null) this.heard.set(d.pair, at);
    return true;
  }
}
