import { createHash } from 'node:crypto';
import { parseBody } from '../core/schemas.js';
import { sha256Hex, stableJSON } from '../core/canonical.js';
import { validOffer, nowSec } from '../roles/common.js';
import { priceUnits } from '../market/assets.js';

const DAY = 86400, BOUND = 10000;
// One record per entry, so an accepted message writes only what it changed.
const SEEN = 'feed-seen-', TRADE = 'feed-trade-', PARTY = 'feed-party-', TERMS = 'feed-terms-', INVENTORY = 'feed-inventory-', META = 'feed-meta';
const load = (store, prefix) => store.list(prefix).map(name => [name.slice(prefix.length), store.get(name)]).filter(([, value]) => value);
const pairName = pair => INVENTORY + Buffer.from(pair).toString('hex');
const newest = (a, b) => b.ts - a.ts || a.tradeId.localeCompare(b.tradeId);
const units = (value, decimals) => {
  const n = BigInt(value), scale = 10n ** BigInt(decimals);
  const fraction = (n % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${n / scale}${fraction ? '.' + fraction : ''}`;
};
const change = (last, first) => {
  const start = priceUnits(first), diff = priceUnits(last) - start;
  if (!start) return null;
  const magnitude = (diff < 0n ? -diff : diff) * 10n ** 12n / start;
  return (diff < 0n && magnitude ? '-' : '') + units(magnitude, 12);
};

// Inputs have already passed envelope authentication and registry admission in MarketFeed.
export class MarketView {
  constructor({ store, now = nowSec, history }) {
    this.store = store; this.now = now; this.history = history;
    this.seen = new Map(load(store, SEEN));
    this.trades = new Map(load(store, TRADE).map(([id, t]) => [id, parseBody('tradeLog', t)]));
    for (const trade of this.trades.values()) history?.addTrade(trade);
    this.parties = new Map(load(store, PARTY));
    this.inventory = new Map(load(store, INVENTORY).map(([, { pair, ...book }]) => [pair, book]));
    this.truncatedUntil = store.get(META)?.truncatedUntil ?? 0;
    this.offers = new Map(); this.books = new Map(); this.tickers = new Map(); this.terms = new Map(load(store, TERMS));
    this.#prune();
  }

  #prune() {
    const now = this.now();
    for (const [id, row] of this.seen) if (row.expiresAt <= now) { this.store.delete(SEEN + id); this.seen.delete(id); }
    for (const [id, row] of this.offers) if (row.offer.expiresAt <= now || row.at <= now - 300) { this.offers.delete(id); this.dirty = true; }
    for (const [id, row] of this.terms) if (row.at <= now - DAY) { this.store.delete(TERMS + id); this.terms.delete(id); }
    const rows = [...this.trades.values()].sort(newest);
    if (rows.length > BOUND && rows[BOUND].ts > now - DAY && rows[BOUND].ts + DAY > this.truncatedUntil) {
      this.truncatedUntil = rows[BOUND].ts + DAY;
      this.store.put(META, { truncatedUntil: this.truncatedUntil });
    }
    rows.forEach((t, i) => {
      if ((i < 100 || t.ts > now - DAY) && i < BOUND) return;
      this.store.delete(TRADE + t.tradeId); this.store.delete(PARTY + t.tradeId);
      this.trades.delete(t.tradeId); this.parties.delete(t.tradeId); this.dirty = true;
    });
  }

  #remember(offer) {
    if (this.seen.has(offer.offerId)) return this.seen.get(offer.offerId);
    if (this.seen.size >= BOUND) return null;
    const row = { postedAt: this.now(), expiresAt: offer.expiresAt, closed: false };
    this.store.put(SEEN + offer.offerId, row);
    this.seen.set(offer.offerId, row);
    return row;
  }

  #remaining(offer) {
    const book = this.inventory.get(offer.pair);
    if (!book || book.registryVersion !== offer.registryVersion) return null;
    const entry = book.remaining.find(r => r.offerId === offer.offerId);
    if (entry) return entry.amount;
    return this.seen.get(offer.offerId).postedAt <= book.ts ? '0' : null;
  }

  offer(body, from) {
    const offer = parseBody('offer', body); this.#prune();
    if (!validOffer(offer, from) || offer.expiresAt <= this.now()) return false;
    const meta = this.#remember(offer);
    if (!meta || meta.closed) return false;
    if (this.#remaining(offer) === '0') { this.offers.delete(offer.offerId); this.dirty = true; return false; }
    this.offers.set(offer.offerId, { offer, at: this.now() });
    this.dirty = true; return true;
  }

  cancel(body, from) {
    const { offerId } = parseBody('cancel', body), row = this.offers.get(offerId);
    if (!row || row.offer.maker.dexKey !== from) return false;
    const seen = { ...this.seen.get(offerId), closed: true };
    this.store.put(SEEN + offerId, seen); this.seen.set(offerId, seen);
    this.offers.delete(offerId); this.dirty = true; return true;
  }

  book(body) {
    const book = parseBody('book', body);
    if (book.ts > this.now() || book.ts <= (this.books.get(book.pair)?.ts ?? -1) ||
        book.remaining && book.ts <= (this.inventory.get(book.pair)?.ts ?? -1)) return false;
    this.#prune(); this.books.set(book.pair, book); this.dirty = true;
    if (book.remaining) {
      const { ts, seq, registryVersion, remaining } = book;
      this.store.put(pairName(book.pair), { pair: book.pair, ts, seq, registryVersion, remaining });
      this.inventory.set(book.pair, { ts, seq, registryVersion, remaining });
      for (const [id, row] of this.offers) if (row.offer.pair === book.pair && this.#remaining(row.offer) === '0') this.offers.delete(id);
    }
    return true;
  }

  ticker(body) {
    const ticker = parseBody('ticker', body);
    if (ticker.ts > this.now() || ticker.ts <= (this.tickers.get(ticker.pair)?.ts ?? -1)) return false;
    this.tickers.set(ticker.pair, ticker); this.dirty = true; return true;
  }

  trade(body) {
    const trade = parseBody('tradeLog', body);
    if (trade.ts > this.now() || this.trades.has(trade.tradeId) || this.history?.ids.has(trade.tradeId)) return false;
    this.history?.addTrade(trade);
    this.store.put(TRADE + trade.tradeId, trade);
    this.trades.set(trade.tradeId, trade);
    this.#associate(trade.tradeId); this.#prune(); this.dirty = true; return true;
  }

  settlement(body) {
    const report = parseBody('settled', body);
    this.#prune();
    if (this.parties.has(report.tradeId) || this.terms.has(report.tradeId) || this.terms.size >= BOUND) return false;
    const row = { terms: report.terms, at: this.now() };
    this.store.put(TERMS + report.tradeId, row);
    this.terms.set(report.tradeId, row);
    this.#associate(report.tradeId); this.dirty = true; return true;
  }

  #associate(id) {
    const trade = this.trades.get(id), terms = this.terms.get(id)?.terms;
    if (!trade || !terms || this.parties.has(id) || sha256Hex(stableJSON(terms)) !== trade.termsHash ||
        trade.pair !== terms.pair || trade.baseAmount !== terms.baseAmount || trade.quoteAmount !== terms.quoteAmount ||
        trade.seller.tracAddr !== terms.seller.tracAddr || trade.seller.solAddr !== terms.seller.solRecipient ||
        trade.buyer.tracAddr !== terms.buyer.tracAddr || trade.buyer.solAddr !== terms.buyer.solPayer) return;
    const association = { keys: [terms.seller, terms.buyer].map(p => [p.dexKey, p.tracAddr]) };
    this.store.put(PARTY + id, association); this.store.delete(TERMS + id);
    this.parties.set(id, association); this.terms.delete(id);
  }

  address(dexKey) {
    this.#prune();
    for (const { offer } of this.offers.values()) if (offer.maker.dexKey === dexKey) return offer.maker.tracAddr;
    for (const association of this.parties.values()) for (const [key, address] of association.keys) if (key === dexKey) return address;
    return dexKey;
  }

  snapshot(registry) {
    if (this.cached && !this.dirty && this.now() < this.validUntil && registry === this.cachedRegistry) return this.cached;
    this.#prune();
    const now = this.now(), definitions = new Map((registry?.pairs ?? []).map(p => [p.pair, p]));
    const all = [...this.trades.values()].sort(newest).filter(t => definitions.has(t.pair));
    const pairs = [...definitions.values()].map(p => {
      const rows = all.filter(t => t.pair === p.pair), day = rows.filter(t => t.ts > now - DAY);
      let last = rows[0]?.price ?? null, volume = day.reduce((n, t) => n + BigInt(t.quoteAmount), 0n), count = day.length;
      const t = this.tickers.get(p.pair);
      const fresh = t && t.registryVersion === registry.version && t.ts > now - 300;
      const agree = fresh && (!rows.length || t.ts >= rows[0].ts && priceUnits(t.last) === priceUnits(last)) &&
        t.trades24h >= count && BigInt(t.volume24h) >= volume && (t.trades24h > count || BigInt(t.volume24h) === volume);
      if (agree) { last = t.trades24h || priceUnits(t.last) > 0n ? t.last : last; volume = BigInt(t.volume24h); count = t.trades24h; }
      const book = this.books.get(p.pair), levels = book?.registryVersion === registry.version && book.ts > now - 300 ? book.levels : [];
      const best = side => levels.filter(l => l.side === side && BigInt(l.baseAmount) > 0n).reduce((v, l) =>
        v === null || (side === 'buy' ? priceUnits(l.price) > priceUnits(v) : priceUnits(l.price) < priceUnits(v)) ? l.price : v, null);
      const completeDay = this.truncatedUntil <= now && (!agree || count === day.length);
      return { pair: p.pair, base: p.base.id, last, change24h: last !== null && day.length && completeDay ? change(last, day.at(-1).price) : null,
        volume24h: rows.length || agree ? units(volume, 6) : null, bestBuy: best('buy'), bestSell: best('sell'), trades24h: rows.length || agree ? count : null };
    });
    const offers = [...this.offers.values()].filter(r => definitions.get(r.offer.pair)?.status === 'open' &&
      r.offer.registryVersion === registry.version)
      .sort((a, b) => this.seen.get(b.offer.offerId).postedAt - this.seen.get(a.offer.offerId).postedAt || a.offer.offerId.localeCompare(b.offer.offerId))
      .slice(0, 200).map(({ offer: o }) => ({ offerId: o.offerId, pair: o.pair, side: o.side, price: o.price,
        amount: units(o.baseAmount, definitions.get(o.pair).base.decimals),
        left: this.#remaining(o) === null ? null : units(this.#remaining(o), definitions.get(o.pair).base.decimals),
        maker: { trac: o.maker.tracAddr, sol: o.maker.solAddr }, postedAt: this.seen.get(o.offerId).postedAt }));
    const trades = all.slice(0, 100).map(t => ({ id: t.tradeId, pair: t.pair, price: t.price,
      amount: units(t.baseAmount, definitions.get(t.pair).base.decimals), usdc: units(t.quoteAmount, 6),
      seller: { trac: t.seller.tracAddr, sol: t.seller.solAddr }, buyer: { trac: t.buyer.tracAddr, sol: t.buyer.solAddr }, settledAt: t.ts }));
    let json = JSON.stringify({ v: 1, ts: now, pairs, offers, trades });
    while (Buffer.byteLength(json) > 60000 && (offers.length || trades.length)) {
      if (offers.length) offers.pop(); else trades.pop();
      json = JSON.stringify({ v: 1, ts: now, pairs, offers, trades });
    }
    const content = JSON.stringify({ pairs, offers, trades });
    if (this.content !== content) {
      this.content = content;
      this.cached = Object.freeze({ json, etag: '"' + createHash('sha256').update(json).digest('hex') + '"' });
    }
    this.cachedRegistry = registry; this.dirty = false;
    this.validUntil = Math.min(this.truncatedUntil > now ? this.truncatedUntil : Infinity, ...[...this.offers.values()].map(r => Math.min(r.offer.expiresAt, r.at + 300)),
      ...[...this.books.values(), ...this.tickers.values()].filter(r => r.ts + 300 > now).map(r => r.ts + 300),
      ...all.filter(t => t.ts + DAY > now).map(t => t.ts + DAY));
    return this.cached;
  }
}
