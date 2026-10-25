import { priceUnits } from './assets.js';
import { meetsVersion } from '../core/software.js';

export const OFFER_FRESH_SEC = 300;
export const STALE_OFFER_MESSAGE = 'This offer is no longer announced by its maker.';
// A venue book newer than an offer is needed before the offer shows, unless the venue has been silent this long.
export const VENUE_SILENT_SEC = 90;

export const freshOffer = (seen, now) => !!seen && Number.isSafeInteger(seen.lastSeen) &&
  now - seen.lastSeen < OFFER_FRESH_SEC && seen.offer.expiresAt > now;

// Makers re-announce their offers every 45 s since 0.1.14 (every 120 s before). An offer not heard for longer than
// LIVE_SEC_FAST (LIVE_SEC for older makers) is not shown or taken: its maker went offline, or a running trade holds all
// of it. It stays stored until OFFER_FRESH_SEC with its first-seen time, so an offer heard again shows again at once.
export const LIVE_SEC = 150, LIVE_SEC_FAST = 70, FAST_ANNOUNCE = '0.1.14';
const liveWindows = new Map();
export function liveSec(software) {
  let sec = liveWindows.get(software);
  if (sec === undefined) {
    try { sec = meetsVersion(software, FAST_ANNOUNCE) ? LIVE_SEC_FAST : LIVE_SEC; } catch { sec = LIVE_SEC; }
    if (liveWindows.size >= 1000) liveWindows.clear();
    liveWindows.set(software, sec);
  }
  return sec;
}
export const liveOffer = (offer, lastSeen, now) => now - lastSeen <= liveSec(offer.software);

// Full snapshots identify up to 200 offers. Deltas only identify levels; retain the last full inventory and
// cap an individual offer by its level. Absence beyond either wire depth limit does not prove removal.
// `heardAt` is when this app last received the venue's book for the pair (its own clock). Another maker's offer waits
// for a venue book heard after the offer: the venue leaves out offers whose maker cannot fund a trade, and those
// would otherwise show between two books each time the maker announces them again.
export function availableOffer(seen, book, inventory, now, heardAt = null) {
  if (!freshOffer(seen, now) || !liveOffer(seen.offer, seen.lastSeen, now)) return null;
  const o = seen.offer, firstSeen = seen.firstSeen ?? seen.lastSeen;
  if (heardAt != null && heardAt < firstSeen && now - heardAt < VENUE_SILENT_SEC) return null;
  let left = BigInt(o.baseAmount);
  // The venue's current book includes live offers made under earlier registry terms.
  if (inventory?.pair === o.pair && inventory.remaining) {
    const row = inventory.remaining.find(r => r.offerId === o.offerId);
    if (row) left = left < BigInt(row.amount) ? left : BigInt(row.amount);
    else if (inventory.ts >= firstSeen && inventory.remaining.length < 200) return null;
  }
  if (book?.pair === o.pair && book.ts >= firstSeen) {
    const levels = book.levels.filter(l => l.side === o.side), price = priceUnits(o.price);
    const level = levels.find(l => priceUnits(l.price) === price);
    if (level) left = left < BigInt(level.baseAmount) ? left : BigInt(level.baseAmount);
    else if (levels.length < 50 || levels.some(l => o.side === 'sell' ? price <= priceUnits(l.price) : price >= priceUnits(l.price))) return null;
  }
  return left > 0n ? { ...o, baseAmount: left.toString() } : null;
}

// Offers seen on intercom-dex:offers (already verified envelopes). Remaining size shrinks with logged trades.
export class OfferBook {
  constructor() { this.offers = new Map(); this.cancelled = new Map(); }

  add(offer, now) {
    for (const [id, expiry] of this.cancelled) if (expiry <= now) this.cancelled.delete(id);
    if (offer.expiresAt <= now || this.cancelled.has(offer.offerId)) return false;
    const old = this.offers.get(offer.offerId);
    if (old) { old.lastSeen = now; return false; }
    this.offers.set(offer.offerId, { ...offer, remaining: BigInt(offer.baseAmount), firstSeen: now, lastSeen: now });
    return true;
  }

  cancel(offerId, makerKey) {
    const o = this.offers.get(offerId);
    if (!o || o.maker.dexKey !== makerKey) return false;
    this.cancelled.set(offerId, o.expiresAt);
    return this.offers.delete(offerId);
  }

  fill(offerId, baseAmount) {
    const o = this.offers.get(offerId); if (!o) return;
    o.remaining -= BigInt(baseAmount);
    if (o.remaining <= 0n) this.offers.delete(offerId);
  }

  // Saved by the venue so a restart keeps the offers it already verified; restore keeps those still inside the window.
  saved() {
    return { offers: [...this.offers.values()].map(o => ({ ...o, remaining: o.remaining.toString() })), cancelled: [...this.cancelled] };
  }

  restore(saved, now) {
    for (const [id, expiry] of saved?.cancelled ?? []) if (expiry > now) this.cancelled.set(id, expiry);
    for (const o of saved?.offers ?? []) {
      if (o.expiresAt <= now || now - o.lastSeen >= 300 || this.cancelled.has(o.offerId) || BigInt(o.remaining) <= 0n) continue;
      this.offers.set(o.offerId, { ...o, remaining: BigInt(o.remaining) });
    }
  }

  get(offerId, now) {
    const o = this.offers.get(offerId);
    return o && o.expiresAt > now && now - o.lastSeen < OFFER_FRESH_SEC ? o : null;
  }

  // Sells ascending, buys descending; ties by expiry then id. Expired offers are dropped.
  snapshot(pair, now) {
    for (const [id, o] of this.offers) if (o.expiresAt <= now || now - o.lastSeen >= OFFER_FRESH_SEC) this.offers.delete(id);
    // Retain the oldest 20 live offers per maker, across all pairs. Offers whose maker went quiet are left out.
    const counts = new Map();
    const rows = [...this.offers.values()].filter(o => liveOffer(o, o.lastSeen, now)).sort((a, b) => a.firstSeen - b.firstSeen || a.offerId.localeCompare(b.offerId)).filter(o => {
      const n = (counts.get(o.maker.dexKey) ?? 0) + 1; counts.set(o.maker.dexKey, n);
      return n <= 20 && o.pair === pair;
    });
    const cmp = (a, b, dir) => {
      const d = priceUnits(a.price) - priceUnits(b.price);
      return d !== 0n ? (d > 0n ? dir : -dir) : a.expiresAt - b.expiresAt || (a.offerId < b.offerId ? -1 : 1);
    };
    const shown = o => ({ offerId: o.offerId, pair: o.pair, registryVersion: o.registryVersion, software: o.software, side: o.side, baseAmount: o.remaining.toString(), price: o.price, maker: o.maker, peerKey: o.peerKey, expiresAt: o.expiresAt });
    return [...rows.filter(o => o.side === 'sell').sort((a, b) => cmp(a, b, 1)), ...rows.filter(o => o.side === 'buy').sort((a, b) => cmp(a, b, -1))].map(shown);
  }
}
