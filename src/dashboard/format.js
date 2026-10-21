export const DECIMALS = Object.freeze({ USDC: 6, SOL: 9, TNK: 18, RESET: 8 });

// Integer base units as a plain decimal ("1.5"), trailing zeroes dropped, at most `places` decimals shown
// (rounded down: a display never shows more than there is; a nonzero dust amount reads "<0.000001").
export function formatUnits(units, decimals, places = 6) {
  const v = BigInt(units), neg = v < 0n, a = neg ? -v : v, scale = 10n ** BigInt(decimals);
  const whole = (a / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (a % scale).toString().padStart(decimals, '0').slice(0, places).replace(/0+$/, '');
  if (a > 0n && whole === '0' && !frac) return `${neg ? '>-' : '<'}0.${'0'.repeat(places - 1)}1`;
  return (neg ? '-' : '') + (frac ? `${whole}.${frac}` : whole);
}

// Up to 8 decimals: every RESET unit shows, and TNK amounts stay readable.
export const amount = (units, asset) => ({ units: String(units), text: formatUnits(units, DECIMALS[asset], Math.min(DECIMALS[asset], 8)), unit: asset });

export function decimalAmount(value, asset) {
  const decimals = DECIMALS[asset];
  if (typeof value !== 'string' || value.length > 100 || decimals === undefined ||
      !new RegExp(`^(0|[1-9][0-9]*)(\\.[0-9]{1,${decimals}})?$(?![\\s\\S])`).test(value)) throw new Error('Invalid decimal amount');
  const [whole, fraction = ''] = value.split('.');
  return amount(BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0')), asset);
}

export const shortKey = key => (typeof key === 'string' && key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : String(key ?? ''));
