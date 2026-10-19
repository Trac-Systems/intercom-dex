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

export const amount = (units, asset) => ({ units: String(units), text: formatUnits(units, DECIMALS[asset]), unit: asset });

export const shortKey = key => (typeof key === 'string' && key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : String(key ?? ''));
