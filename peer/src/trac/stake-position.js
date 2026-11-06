import b4a from 'b4a';

const hex = x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
const uint = x => Number.isSafeInteger(x) && x >= 0;
const active = new WeakSet();

// Pin the signed Hyperbee prefix, including its Merkle root. Unindexed tails
// never define the delivery cutoff. The original core must remain available.
export async function signedPosition(msb, requested = null) {
  const core = msb?.state?.base?.view?.core;
  if (!core || !uint(core.signedLength) || core.signedLength < 1) throw new Error('MSB signed view unavailable');
  const bootstrap = b4a.toString(msb.config.bootstrap, 'hex'), coreKey = b4a.toString(core.key, 'hex');
  const length = requested?.length ?? core.signedLength;
  if (!uint(length) || length < 1 || length > core.signedLength || requested &&
      (Object.keys(requested).sort().join(',') !== 'bootstrap,coreKey,length,root' || requested.bootstrap !== bootstrap ||
       requested.coreKey !== coreKey || !hex(requested.root))) throw new Error('Invalid or unavailable MSB position');
  const root = b4a.toString(await core.treeHash(length), 'hex');
  if (!hex(root) || requested && root !== requested.root || coreKey !== b4a.toString(core.key, 'hex') || length > core.signedLength)
    throw new Error('MSB position changed');
  return { bootstrap, coreKey, length, root };
}

// Reads one submitted hash, never scans transfer history. A bounded checkout
// gives a proof of membership/non-membership in an authenticated prefix only.
export async function readAtPosition(msb, txHash, position, timeoutMs = 5000) {
  if (!hex(txHash) || !uint(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid position read');
  const base = msb?.state?.base;
  if (!base || active.has(base)) throw new Error('MSB position reader busy');
  active.add(base);
  let view, closing, timer, cancelled = false;
  const close = () => closing ??= Promise.resolve().then(() => view?.close());
  const work = Promise.resolve().then(async () => {
    await signedPosition(msb, position);
    if (cancelled) throw new Error('MSB position read timed out');
    view = base.view.checkout(position.length);
    try {
      const row = await view.get(txHash, { timeout: timeoutMs, update: false, extension: false });
      await signedPosition(msb, position);
      return row?.value ?? null;
    } finally { await close(); }
  }).finally(() => active.delete(base));
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => { cancelled = true; reject(new Error('MSB position read timed out')); if (view) void close().catch(() => {}); }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
