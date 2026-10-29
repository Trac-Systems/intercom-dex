import { bufferToBigInt } from 'trac-msb/src/utils/amountSerialization.js';
import nodeEntry from 'trac-msb/src/core/state/utils/nodeEntry.js';
import b4a from 'b4a';

export const BALANCE_READ_MS = 5000;
export const BALANCE_STALL_MS = 1000;
const activeReads = new WeakMap();
const background = (callback, value) => {
  try { Promise.resolve(callback?.(value)).catch(() => {}); } catch { /* Diagnostics/repair cannot fail a read. */ }
};

export async function signedBalanceRead(base, key, label, timeoutMs = BALANCE_READ_MS,
  { onStall, onRead, stallMs = BALANCE_STALL_MS, now = Date.now } = {}) {
  const started = now(), core = base?.view?.core;
  const sample = { signedLength: core?.signedLength ?? null, coreKey: core?.key ? b4a.toString(core.key, 'hex') : null,
    blockReads: 0, blockWaits: 0, waitingSeq: null };
  let failure;
  try { return await readSigned(base, key, label, timeoutMs, { onStall, stallMs, now, started, sample }); }
  catch (error) { failure = error; throw error; }
  finally { background(onRead, { ...sample, elapsedMs: Math.max(0, now() - started),
    code: failure ? failure.code ?? 'READ_FAILED' : null, stage: failure?.stage ?? null }); }
}

// A signed Hyperbee can be sparse after fast-forward. Fetch missing blocks with a deadline, not an
// unbounded replication wait; a missing block must never become a zero balance. Closing this checkout
// cancels its pending I/O if the complete tree traversal exceeds the deadline.
async function readSigned(base, key, label, timeoutMs, { onStall, stallMs, now, started, sample }) {
  const length = sample.signedLength;
  if (!Number.isSafeInteger(length) || length < 1) throw new Error(`${label} signed view is not ready`);
  let active = activeReads.get(base);
  if (!active) activeReads.set(base, active = new Set());
  // A timeout bounds the caller even if snapshot close itself stalls. Retain
  // that slot until close settles so repeated polls cannot leak more snapshots.
  if (active.has(key) || active.size >= 64) throw Object.assign(new Error(`${label} balance read still closing or busy; retry shortly`), { code: 'BALANCE_READ_BUSY' });
  const view = base.view.checkout(length);
  active.add(key);
  let timer, stallTimer, closing, repaired = false, finished = false, stage = 'read';
  const onseq = () => {
    if (finished) return;
    sample.blockReads++;
    sample.waitingSeq = null;
    clearTimeout(stallTimer);
  };
  const onwait = seq => {
    if (finished) return;
    sample.blockWaits++;
    sample.waitingSeq = seq;
    clearTimeout(stallTimer);
    // Let normal sparse replication work first. If one block stops progressing,
    // repair while this exact signed checkout still has time to receive it.
    // Never restart the read, chase a moving tip, or extend its overall deadline.
    if (onStall && !repaired) stallTimer = setTimeout(() => {
      if (stage !== 'read' || now() - started >= timeoutMs) return;
      repaired = true;
      background(onStall, { code: 'BALANCE_READ_STALLED', stage, ...sample, elapsedMs: Math.max(0, now() - started) });
    }, stallMs);
  };
  const close = () => closing ??= Promise.resolve().then(() => view.close()).finally(() => active.delete(key));
  const work = Promise.resolve().then(async () => {
    let value, failure;
    try { value = await view.get(key, { timeout: timeoutMs, update: false, extension: false, onseq, onwait }); }
    catch (error) { failure = error; }
    finally { clearTimeout(stallTimer); }
    if (!failure) sample.waitingSeq = null;
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
      : `${label} balance unavailable: ${error.message} (signed length ${length})`),
    { code: error.code, stage, ...sample, elapsedMs: Math.max(0, now() - started) });
  } finally {
    finished = true;
    clearTimeout(timer);
    clearTimeout(stallTimer);
    // A stalled close must not turn the bounded read back into an unbounded bridge request.
    void close().catch(() => {});
  }
}

export async function readBalances({ bus, resetPeer, address, key }) {
  const options = owner => ({ onStall: error => owner.recoverRead?.(error), onRead: sample => owner.observeRead?.(sample) });
  const recover = owner => error => {
    if (error.stage === 'read' && ['BALANCE_READ_TIMEOUT', 'REQUEST_TIMEOUT', 'BLOCK_NOT_AVAILABLE'].includes(error.code)) {
      // Recovery is background transport work. Even an asynchronous recovery
      // failure must neither delay this reply nor replace the original error.
      background(error => owner.recoverRead?.(error), error);
    }
    throw error;
  };
  const reads = await Promise.allSettled([
    signedBalanceRead(bus.state.base, address, 'MSB', BALANCE_READ_MS, options(bus)).catch(recover(bus)),
    signedBalanceRead(resetPeer.base, `bal/${key.toString('hex')}`, 'RESET', BALANCE_READ_MS, options(resetPeer)).catch(recover(resetPeer)),
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
