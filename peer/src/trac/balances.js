import { bufferToBigInt } from 'trac-msb/src/utils/amountSerialization.js';
import nodeEntry from 'trac-msb/src/core/state/utils/nodeEntry.js';

export const BALANCE_READ_MS = 5000;

// A signed Hyperbee can be sparse after fast-forward. Fetch missing blocks with a deadline, not an
// unbounded replication wait; a missing block must never become a zero balance. Closing this checkout
// cancels its pending I/O if the complete tree traversal exceeds the deadline.
export async function signedBalanceRead(base, key, label, timeoutMs = BALANCE_READ_MS) {
  const length = base?.view?.core?.signedLength;
  if (!Number.isSafeInteger(length) || length < 1) throw new Error(`${label} signed view is not ready`);
  const view = base.view.checkout(length);
  let timer, closing, stage = 'read';
  const close = () => closing ??= Promise.resolve().then(() => view.close());
  const work = Promise.resolve().then(async () => {
    const value = await view.get(key, { timeout: timeoutMs, update: false });
    stage = 'snapshot close';
    await close();
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
      : `${label} balance unavailable: ${error.message} (signed length ${length})`), { code: error.code });
  } finally {
    clearTimeout(timer);
    // A stalled close must not turn the bounded read back into an unbounded bridge request.
    void close().catch(() => {});
  }
}

export async function readBalances({ bus, resetPeer, address, key }) {
  const reads = await Promise.allSettled([
    signedBalanceRead(bus.state.base, address, 'MSB'),
    signedBalanceRead(resetPeer.base, `bal/${key.toString('hex')}`, 'RESET').catch(error => {
      if (['BALANCE_READ_TIMEOUT', 'REQUEST_TIMEOUT', 'BLOCK_NOT_AVAILABLE'].includes(error.code)) {
        try { resetPeer.recoverRead?.(); } catch { /* Preserve the original read error. */ }
      }
      throw error;
    }),
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
