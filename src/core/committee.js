import { concatBytes, hexToBytes, sha256Hex } from './canonical.js';
import { amount, hexKey, registrySchema } from './schemas.js';
import { meetsVersion } from './software.js';
import { registryPair } from '../market/assets.js';

export function selectCommittee(registry, R, { n, k, quoteAmount, pair, exclude = [] }) {
  const valid = registrySchema.parse(registry);
  hexKey.parse(R);
  amount.parse(quoteAmount);
  if (!Number.isSafeInteger(n) || n < 1 || n > 16 || !Number.isSafeInteger(k) || k < 1 || k > n ||
      !Array.isArray(exclude)) throw new RangeError('Invalid committee parameters');
  exclude.forEach(key => hexKey.parse(key));
  const excluded = new Set(exclude);
  const asset = registryPair(valid, pair).base.id;
  const pool = valid.signers.filter(s => s.status === 'active' && s.assets.includes(asset) && meetsVersion(s.software, valid.minSoftware) &&
    BigInt(s.limitUsdc) >= BigInt(quoteAmount) && !excluded.has(s.dexKey))
    .sort((a, b) => a.dexKey < b.dexKey ? -1 : a.dexKey > b.dexKey ? 1 : 0);
  if (pool.length < n) throw new RangeError('Too few eligible signers');
  const selected = [], seed = hexToBytes(R, 32);
  let counter = 0;
  while (selected.length < n) {
    if (counter > 0xffffffff) throw new RangeError('Committee sampling exhausted');
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, counter++);
    const random = BigInt('0x' + sha256Hex(concatBytes(seed, bytes)));
    const size = BigInt(pool.length), ceiling = (1n << 256n) / size * size;
    if (random >= ceiling) continue;
    selected.push(pool.splice(Number(random % size), 1)[0]);
  }
  return selected;
}
