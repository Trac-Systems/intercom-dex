import { priceUnits, formatPrice } from '../market/assets.js';
import { availableOffer } from '../market/book.js';
import { amount } from './format.js';

// Build full depth from signed announcements; the wire book itself has only the best 50 levels per side.
export function buildBook({ pair, offers, mine = [], dexKey, book, inventory = book, now }) {
  const base = pair.base.id, groups = new Map();
  const add = (o, firstSeen, own) => {
    if (o.pair !== pair.pair || o.expiresAt <= now || BigInt(o.baseAmount) <= 0n) return;
    const price = formatPrice(priceUnits(o.price)), key = `${o.side}:${price}`;
    if (!groups.has(key)) groups.set(key, { price, side: o.side, units: 0n, mine: 0n, count: 0, take: null, seen: firstSeen });
    const g = groups.get(key), units = BigInt(o.baseAmount);
    g.units += units; g.count++; g.seen = Math.max(g.seen, firstSeen);
    if (own) g.mine += units;
    else if (!g.take || firstSeen < g.take.at || (firstSeen === g.take.at && o.offerId < g.take.offerId)) {
      g.take = { offerId: o.offerId, units, at: firstSeen };
    }
  };
  for (const seen of offers) {
    if (seen.offer.pair !== pair.pair || seen.offer.maker.dexKey === dexKey) continue;
    const o = availableOffer(seen, book, inventory, now);
    if (o) add(o, seen.firstSeen ?? seen.lastSeen, false);
  }
  for (const o of mine) add({ ...o, baseAmount: o.available }, now, true);
  const levels = side => {
    let total = 0n;
    return [...groups.values()].filter(g => g.side === side).sort((a, b) => {
      const d = priceUnits(a.price) - priceUnits(b.price);
      return (d < 0n ? -1 : d > 0n ? 1 : 0) * (side === 'sell' ? 1 : -1);
    }).map(g => {
      const level = book?.levels.find(l => l.side === side && priceUnits(l.price) === priceUnits(g.price));
      if (level && book.ts >= g.seen && BigInt(level.baseAmount) < g.units) g.units = BigInt(level.baseAmount);
      const own = g.mine < g.units ? g.mine : g.units;
      const take = g.take && g.units > own ? { offerId: g.take.offerId,
        amount: amount(g.take.units < g.units - own ? g.take.units : g.units - own, base) } : null;
      total += g.units;
      return { price: g.price, amount: amount(g.units, base), total: amount(total, base), count: g.count,
        mine: own > 0n ? amount(own, base) : null, take };
    });
  };
  const asks = levels('sell'), bids = levels('buy');
  let spread = null;
  if (asks.length && bids.length) {
    const ask = priceUnits(asks[0].price), bid = priceUnits(bids[0].price), diff = ask - bid;
    const decimal = units => (units < 0n ? '-' : '') + formatPrice(units < 0n ? -units : units);
    spread = { price: decimal(diff), pct: bid > 0n ? decimal(diff * 100n * 10n ** 12n / bid) : null };
  }
  return { pair: pair.pair, base, at: now, asks, bids, spread };
}
