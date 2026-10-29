import process from 'process';

// Process-local cumulative counters, emitted on health transitions and otherwise
// at most once per 30 seconds of read activity. No addresses, balances or timers.
export function createReadMetrics({ base, swarm, label, now = Date.now, log = console.log, intervalMs = 30000 }) {
  const since = now();
  let reads = 0, failures = 0, timeouts = 0, busy = 0, consecutiveFailures = 0;
  let elapsedMsTotal = 0, elapsedMsMax = 0, lastSuccessAt = null, emittedAt = -Infinity, status;
  return sample => {
    reads++;
    const at = now(), failed = sample.code !== null;
    if (failed) { failures++; consecutiveFailures++; }
    else { consecutiveFailures = 0; lastSuccessAt = at; }
    if (['BALANCE_READ_TIMEOUT', 'REQUEST_TIMEOUT'].includes(sample.code)) timeouts++;
    if (sample.code === 'BALANCE_READ_BUSY') busy++;
    elapsedMsTotal += sample.elapsedMs;
    elapsedMsMax = Math.max(elapsedMsMax, sample.elapsedMs);
    const next = failed ? 'unavailable' : 'ok';
    if (next === status && at - emittedAt < intervalMs) return;
    status = next; emittedAt = at;
    log(`[trac-read] ${JSON.stringify({ chain: label, event: 'balance_read', version: 2, pid: process.pid, since, at, status,
      reads, failures, timeouts, busy, consecutiveFailures, elapsedMsTotal, elapsedMsMax, lastSuccessAt,
      ...sample, currentSignedLength: base.view?.core?.signedLength ?? null, viewLength: base.view?.core?.length ?? null,
      corePeers: base.view?.core?.peers?.length ?? 0,
      connected: [...(swarm?.connections ?? [])].filter(c => !c.destroyed && !c.destroying).length,
      connecting: swarm?.connecting ?? 0, known: swarm?.peers?.size ?? 0 })}`);
  };
}
