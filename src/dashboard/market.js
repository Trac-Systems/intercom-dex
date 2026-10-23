import { priceUnits, formatPrice } from '../market/assets.js';
import { availableOffer } from '../market/book.js';
import { amount } from './format.js';
import { meetsVersion } from '../core/software.js';

// Called-off reasons that are about the signers, not the maker: the same offer may work on the next try.
const NOT_THE_MAKER = /signers/i;

// A take called off before anything was locked, for a reason that lies with the maker.
export const calledOffByMaker = s => s.phase === 'aborted' && !s.lockAttempted && !s.locked && !NOT_THE_MAKER.test(String(s.reason ?? ''));

// What this trader's own takes say about other traders' offers. An offer whose take was called off before anything
// was locked (the maker did not answer, declined, or gave up) is skipped from then on, so the next click on its price
// goes to the next offer there; own takes still running count against the offer they took from.
export function ownTakes(trades) {
  const skip = new Set(), running = new Map();
  for (const t of trades) {
    const s = t.state;
    if (s.mode !== 'taker' || !s.offerId) continue;
    if (s.phase === 'aborted') {
      if (calledOffByMaker(s)) skip.add(s.offerId);
      continue;
    }
    if (['complete', 'refunded', 'lost'].includes(s.phase)) continue;
    running.set(s.offerId, (running.get(s.offerId) ?? 0n) + BigInt((s.terms ?? s.draft).baseAmount));
  }
  return { skip, running };
}

// Makers re-announce their offers every 45 s since 0.1.14 (every 120 s before); one not heard for longer than that has
// most likely gone offline. A take at a price level goes to a maker heard recently first, oldest offer first among them.
export const LIVE_SEC = 150, LIVE_SEC_FAST = 70, FAST_ANNOUNCE = '0.1.14';
export function liveSec(software) {
  try { return meetsVersion(software, FAST_ANNOUNCE) ? LIVE_SEC_FAST : LIVE_SEC; } catch { return LIVE_SEC; }
}
const quiet = (row, now) => now - row.lastSeen <= liveSec(row.software) ? 0 : 1;
export const takeOrder = now => (a, b) => quiet(a, now) - quiet(b, now) ||
  a.at - b.at || (a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0);

// Build full depth from signed announcements; the wire book itself has only the best 50 levels per side.
export function buildBook({ pair, offers, mine = [], dexKey, book, inventory = book, now, heardAt = null, taken = { skip: new Set(), running: new Map() } }) {
  const base = pair.base.id, groups = new Map();
  const better = takeOrder(now);
  const add = (o, firstSeen, own, lastSeen = firstSeen) => {
    if (o.pair !== pair.pair || o.expiresAt <= now || BigInt(o.baseAmount) <= 0n) return;
    const price = formatPrice(priceUnits(o.price)), key = `${o.side}:${price}`;
    if (!groups.has(key)) groups.set(key, { price, side: o.side, units: 0n, mine: 0n, count: 0, take: null, seen: firstSeen });
    const g = groups.get(key), units = BigInt(o.baseAmount);
    g.units += units; g.count++; g.seen = Math.max(g.seen, firstSeen);
    if (own) g.mine += units;
    else {
      const candidate = { offerId: o.offerId, units, at: firstSeen, lastSeen, software: o.software };
      if (!g.take || better(candidate, g.take) < 0) g.take = candidate;
    }
  };
  for (const seen of offers) {
    if (seen.offer.pair !== pair.pair || seen.offer.maker.dexKey === dexKey) continue;
    if (taken.skip.has(seen.offer.offerId)) continue;
    const o = availableOffer(seen, book, inventory, now, heardAt), left = o ? BigInt(o.baseAmount) - (taken.running.get(o.offerId) ?? 0n) : 0n;
    if (left > 0n) add({ ...o, baseAmount: left.toString() }, seen.firstSeen ?? seen.lastSeen, false, seen.lastSeen ?? seen.firstSeen);
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
