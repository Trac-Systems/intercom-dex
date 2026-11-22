// Stake adjudication reads the complete escrow history from two independent readers that agree. A signer whose trade
// reads trust one own endpoint (need 1) could never read it (11-10..11-22: no delivered or unfunded reservation
// closed), so the history uses the stake readers, which are the two-reader clock endpoints when configured and the
// trade endpoints otherwise. An unreadable escrow is not read again for a while: the coordinator asks every five
// seconds and the public readers also serve the stake clock.
export const HISTORY_RETRY_MS = 300000;

export function stakeHistoryReader({ solana, rpc, retryMs = HISTORY_RETRY_MS, now = Date.now, max = 1000 }) {
  const readers = rpc?.endpoints ? { endpoints: [...rpc.endpoints], need: rpc.need ?? Math.min(2, rpc.endpoints.length) } : {};
  const waiting = new Map();
  return async args => {
    const key = args?.hashHex, until = waiting.get(key);
    if (until !== undefined && until > now()) return { status: 'unknown', historyComplete: false, reason: 'history_retry_wait' };
    let result;
    try { result = await solana.stakeEscrowHistory({ ...args, ...readers }); }
    catch (error) { result = { status: 'unknown', historyComplete: false, reason: String(error?.message ?? error).slice(0, 200) }; }
    waiting.delete(key);
    if (result?.status !== 'complete') {
      waiting.set(key, now() + retryMs);
      if (waiting.size > max) waiting.delete(waiting.keys().next().value);
    }
    return result;
  };
}
