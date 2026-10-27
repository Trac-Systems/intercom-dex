import { RESET_PAUSED_MESSAGE } from './gateway-status.js';

// Units: TNK has 18 decimals (MSB), RESET 8 (contract), USDC 6 (SPL mint). Prices are USDC per whole base token,
// as decimal strings with at most 12 decimals. All arithmetic is integer; quotes round down.
export const ASSET_KINDS = Object.freeze({
  'trac-native': Object.freeze({ id: 'TNK', decimals: 18, adapter: 'msb' }),
  'trac-contract-token': Object.freeze({ id: 'RESET', decimals: 8, adapter: 'reset' }),
  'usdc-solana': Object.freeze({ id: 'USDC', decimals: 6, adapter: 'solana' }),
});
const PRICE_DECIMALS = 12;

export function supportedBase(base) {
  const kind = ASSET_KINDS[base?.kind];
  return !!kind && kind.adapter !== 'solana' && kind.id === base.id && kind.decimals === base.decimals;
}

export function registryPair(registry, pair, { open = true } = {}) {
  const entry = registry?.pairs.find(p => p.pair === pair);
  if (!entry) throw new Error('Unknown registry pair');
  if (!supportedBase(entry.base)) throw new Error('Pair needs a newer version');
  if (open && entry.status !== 'open') throw new Error('Pair paused');
  return entry;
}

export function pairStatus(registry, gatewayHealth) {
  return (registry?.pairs ?? []).map(p => {
    const paused = gatewayHealth !== undefined && p.base.id === 'RESET' && gatewayHealth?.ok !== true;
    return { ...p, ...(paused ? { status: 'paused', reason: RESET_PAUSED_MESSAGE } : {}),
      availability: supportedBase(p.base) ? paused ? 'paused' : p.status : 'needs a newer version' };
  });
}

export function priceUnits(price) {
  const m = /^(0|[1-9][0-9]{0,30})(?:\.([0-9]{1,12}))?$/.exec(price);
  if (!m) throw new Error('Invalid price');
  return BigInt(m[1]) * 10n ** BigInt(PRICE_DECIMALS) + BigInt((m[2] ?? '').padEnd(PRICE_DECIMALS, '0'));
}

export function formatPrice(units) {
  const whole = units / 10n ** BigInt(PRICE_DECIMALS), frac = (units % 10n ** BigInt(PRICE_DECIMALS)).toString().padStart(PRICE_DECIMALS, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function quoteAmount(pair, baseAmount, price) {
  if (!supportedBase(pair?.base)) throw new Error('Unsupported base asset');
  const q = BigInt(baseAmount) * priceUnits(price) * 10n ** 6n /
    10n ** BigInt(pair.base.decimals + PRICE_DECIMALS);
  if (q <= 0n) throw new Error('Trade too small');
  return q.toString();
}

// The price actually paid, from integer amounts (rounded down to 12 decimals).
export function tradePrice(pair, baseAmount, quote) {
  if (!supportedBase(pair?.base)) throw new Error('Unsupported base asset');
  return formatPrice(BigInt(quote) * 10n ** BigInt(pair.base.decimals + PRICE_DECIMALS) /
    (BigInt(baseAmount) * 10n ** 6n));
}
