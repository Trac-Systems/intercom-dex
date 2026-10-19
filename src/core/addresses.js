const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const HRP = [3, 3, 3, 3, 0, 20, 18, 1, 3];

// Ported from reset/signer/lib/trac-address.mjs (bech32m, 32-byte key).
export function isTracAddress(text) {
  if (typeof text !== 'string' || text.length > 90) return false;
  const s = text === text.toUpperCase() ? text.toLowerCase() : text;
  if (s !== s.toLowerCase() || !s.startsWith('trac1') || s.lastIndexOf('1') !== 4) return false;
  const data = [...s.slice(5)].map(c => CHARSET.indexOf(c));
  if (data.length < 7 || data.some(v => v < 0)) return false;
  let chk = 1;
  for (const v of [...HRP, ...data]) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  if ((chk >>> 0) !== 0x2bc830a3) return false;
  let acc = 0, bits = 0, count = 0;
  for (const v of data.slice(0, -6)) {
    acc = ((acc << 5) | v) & 0xfff;
    bits += 5;
    while (bits >= 8) { bits -= 8; count++; }
  }
  return bits < 5 && (acc & ((1 << bits) - 1)) === 0 && count === 32;
}

export function isSolanaAddress(text) {
  if (typeof text !== 'string' || text.length < 32 || text.length > 44) return false;
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const c of text) {
    const digit = alphabet.indexOf(c);
    if (digit < 0) return false;
    value = value * 58n + BigInt(digit);
  }
  let bytes = 0;
  while (value > 0n) { bytes++; value >>= 8n; }
  return bytes + (text.match(/^1*/)[0].length) === 32;
}
