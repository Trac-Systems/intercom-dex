import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadMetrics } from '../../../peer/runtime/read-metrics.js';

test('read metrics preserve cumulative latency/failure counters while throttling repeats and exposing recovery', () => {
  const lines = [], base = { view: { core: { signedLength: 1746752, length: 1746755, peers: [{}, {}] } } };
  const swarm = { connections: new Set([{}, {}, { destroyed: true }]), connecting: 1, peers: new Map([['a', {}], ['b', {}]]) };
  let at = 100000;
  const observe = createReadMetrics({ base, swarm, label: 'RESET', now: () => at,
    log: line => lines.push(JSON.parse(line.slice('[trac-read] '.length))) });
  const good = { code: null, elapsedMs: 10, signedLength: 1746752, blockReads: 12, blockWaits: 0, waitingSeq: null };
  const bad = { ...good, code: 'BALANCE_READ_TIMEOUT', elapsedMs: 5000, blockWaits: 1, waitingSeq: 1746751 };
  observe(good); observe(good); at++; observe(bad);
  assert.equal(lines.length, 2, 'first failure is visible immediately');
  for (let i = 0; i < 100; i++) observe(bad);
  assert.equal(lines.length, 2);
  at += 30000; observe({ ...bad, code: 'BALANCE_READ_BUSY', elapsedMs: 0 });
  const failed = lines.at(-1);
  assert.equal(failed.reads, 104); assert.equal(failed.failures, 102); assert.equal(failed.timeouts, 101); assert.equal(failed.busy, 1);
  assert.equal(failed.elapsedMsTotal, 505020); assert.equal(failed.elapsedMsMax, 5000); assert.equal(failed.consecutiveFailures, 102);
  assert.equal(failed.lastSuccessAt, 100000); assert.equal(failed.connected, 2); assert.equal(failed.connecting, 1);
  assert.equal(failed.corePeers, 2); assert.equal(failed.currentSignedLength, 1746752); assert.equal(failed.waitingSeq, 1746751);
  at++; observe(good);
  assert.equal(lines.at(-1).status, 'ok'); assert.equal(lines.at(-1).consecutiveFailures, 0);
  assert.equal(lines.at(-1).lastSuccessAt, at); assert.equal(lines.at(-1).version, 2);
});
