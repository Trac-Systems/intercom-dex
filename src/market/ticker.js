import { priceUnits, formatPrice, tradePrice } from './assets.js';

const DAY = 24 * 3600 * 1000;

// 24-hour statistics per pair from logged trades (ts in milliseconds). Volume is in quote units.
export function ticker(pair, trades, now) {
  const day = trades.filter(t => t.pair === pair.pair && t.ts > now - DAY && t.ts <= now).sort((a, b) => a.ts - b.ts);
  const all = trades.filter(t => t.pair === pair.pair && t.ts <= now).sort((a, b) => a.ts - b.ts);
  const prices = day.map(t => priceUnits(tradePrice(pair, t.baseAmount, t.quoteAmount)));
  const last = all.length ? tradePrice(pair, all.at(-1).baseAmount, all.at(-1).quoteAmount) : '0';
  return {
    pair: pair.pair, ts: now, last,
    volume24h: day.reduce((s, t) => s + BigInt(t.quoteAmount), 0n).toString(),
    high24h: prices.length ? formatPrice(prices.reduce((a, b) => (b > a ? b : a))) : '0',
    low24h: prices.length ? formatPrice(prices.reduce((a, b) => (b < a ? b : a))) : '0',
    trades24h: day.length,
  };
}
