import { bufferToBigInt } from 'trac-msb/src/utils/amountSerialization.js';
import nodeEntry from 'trac-msb/src/core/state/utils/nodeEntry.js';

export const BALANCE_READ_MS = 5000;
const activeReads = new WeakMap();

// A signed Hyperbee can be sparse after fast-forward. Fetch missing blocks with a deadline, not an
// unbounded replication wait; a missing block must never become a zero balance. Closing this checkout
// cancels its pending I/O if the complete tree traversal exceeds the deadline.
export async function signedBalanceRead(base, key, label, timeoutMs = BALANCE_READ_MS) {
  const length = base?.view?.core?.signedLength;
  if (!Number.isSafeInteger(length) || length < 1) throw new Error(`${label} signed view is not ready`);
  let active = activeReads.get(base);
  if (!active) activeReads.set(base, active = new Set());
  // A timeout bounds the caller even if snapshot close itself stalls. Retain
  // that slot until close settles so repeated polls cannot leak more snapshots.
  if (active.has(key) || active.size >= 64) throw Object.assign(new Error(`${label} balance read still closing or busy; retry shortly`), { code: 'BALANCE_READ_BUSY' });
  const view = base.view.checkout(length);
  active.add(key);
  let timer, closing, stage = 'read';
  const close = () => closing ??= Promise.resolve().then(() => view.close()).finally(() => active.delete(key));
  const work = Promise.resolve().then(async () => {
    let value, failure;
    try { value = await view.get(key, { timeout: timeoutMs, update: false }); }
    catch (error) { failure = error; }
    stage = 'snapshot close';
    await close();
    if (failure) { stage = 'read'; throw failure; }
    return value;
  });
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`${stage} timed out after ${timeoutMs} ms`), { code: 'BALANCE_READ_TIMEOUT' }));
      void close().catch(() => {});
    }, timeoutMs);
  });
  try { return await Promise.race([work, deadline]); }
  catch (error) {
    throw Object.assign(new Error(error.code === 'BLOCK_NOT_AVAILABLE'
      ? `${label} signed balance data is still syncing (signed length ${length})`
      : `${label} balance unavailable: ${error.message} (signed length ${length})`), { code: error.code, stage, signedLength: length });
  } finally {
    clearTimeout(timer);
    // A stalled close must not turn the bounded read back into an unbounded bridge request.
    void close().catch(() => {});
  }
}

export async function readBalances({ bus, resetPeer, address, key }) {
  const recover = owner => error => {
    if (error.stage === 'read' && ['BALANCE_READ_TIMEOUT', 'REQUEST_TIMEOUT', 'BLOCK_NOT_AVAILABLE'].includes(error.code)) {
      // Recovery is background transport work. Even an asynchronous recovery
      // failure must neither delay this reply nor replace the original error.
      try { Promise.resolve(owner.recoverRead?.(error)).catch(() => {}); } catch { /* Preserve the read error. */ }
    }
    throw error;
  };
  const reads = await Promise.allSettled([
    signedBalanceRead(bus.state.base, address, 'MSB').catch(recover(bus)),
    signedBalanceRead(resetPeer.base, `bal/${key.toString('hex')}`, 'RESET').catch(recover(resetPeer)),
  ]);
  // Keep the address's in-flight slot until both bounded reads finish, even if one fails immediately.
  const failed = reads.find(read => read.status === 'rejected');
  if (failed) throw failed.reason;
  const [tnk, reset] = reads.map(read => read.value);
  const entry = tnk ? nodeEntry.decode(tnk.value) : null;
  if (tnk && !entry) throw new Error('Invalid MSB balance record');
  const value = reset?.value ?? '0';
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('Invalid RESET balance');
  return { TNK: entry ? bufferToBigInt(entry.balance).toString() : '0', RESET: value,
    feeTnk: bufferToBigInt(bus.state.getFee()).toString() };
}
