import { priceUnits } from './assets.js';

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

  get(offerId, now) {
    const o = this.offers.get(offerId);
    return o && o.expiresAt > now && now - o.lastSeen < 300 ? o : null;
  }

  // Sells ascending, buys descending; ties by expiry then id. Expired offers are dropped.
  snapshot(pair, now) {
    for (const [id, o] of this.offers) if (o.expiresAt <= now || now - o.lastSeen >= 300) this.offers.delete(id);
    // Retain the oldest 20 live offers per maker, across all pairs.
    const counts = new Map();
    const rows = [...this.offers.values()].sort((a, b) => a.firstSeen - b.firstSeen || a.offerId.localeCompare(b.offerId)).filter(o => {
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
