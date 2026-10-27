import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { cooperativeApply, summarizeApplyLogs } from '../../../peer/runtime/reader-scheduling.js';
import { replicateReader, READER_REPAIR_MS } from '../../../peer/runtime/reader-network.js';
import CoinContract from '../../../peer/vendor/reset/contract/contract.js';
import { runBare } from './pow-bare.mjs';
import { fileURLToPath } from 'node:url';

test('cached apply work yields to bridge timers without changing batch contents, ordering or flushes', async () => {
  const run = async scheduled => {
    const written = [], marker = [], nodes = Array.from({ length: 40 }, (_, i) => i);
    const batch = { get: async key => key, put: async (...args) => written.push(args), flush: async () => marker.push('flush'), close: async () => marker.push('close') };
    const apply = async (rows, view) => {
      const b = view.batch();
      for (const row of rows) {
        const start = performance.now(); while (performance.now() - start < 0.5) {} // cached verification/contract work
        await b.put(row, await b.get(row));
      }
      await b.flush(); await b.close(); marker.push('done');
    };
    const bridge = new Promise(resolve => setTimeout(() => { marker.push('bridge reply'); resolve(); }, 0));
    await (scheduled ? cooperativeApply(apply, { sliceMs: 2 }) : apply)(nodes, { batch: () => batch });
    await bridge;
    return { written, marker };
  };
  const before = await run(false), after = await run(true);
  assert.ok(before.marker.indexOf('bridge reply') > before.marker.indexOf('done'), 'reproduces event-loop starvation');
  assert.ok(after.marker.indexOf('bridge reply') < after.marker.indexOf('done'));
  assert.deepEqual(after.written, before.written);
  assert.deepEqual(after.marker.filter(x => x !== 'bridge reply'), ['flush', 'close', 'done']);
});

test('scheduling preserves the original apply error and storage receiver', async () => {
  const failure = new Error('read failed');
  const batch = { get() { assert.equal(this, batch); throw failure; } };
  const apply = cooperativeApply(async (_nodes, view) => view.batch().get('x'), { sliceMs: 0 });
  await assert.rejects(apply([], { batch: () => batch }), error => error === failure);
});

test('the frozen RESET contract produces identical writes and errors with cooperative storage scheduling', async () => {
  const from = 'a'.repeat(64), to = 'b'.repeat(64);
  const run = async scheduled => {
    const state = new Map([[`bal/${from}`, '1000']]), writes = [], errors = [], contract = new CoinContract({});
    const batch = { get: async key => state.has(key) ? { value: state.get(key) } : null,
      put: async (key, value) => { state.set(key, value); writes.push([key, value]); },
      del: async key => { state.delete(key); writes.push([key]); }, flush: async () => {}, close: async () => {} };
    const apply = async (amounts, view) => {
      const b = view.batch();
      for (const amount of amounts) {
        const result = await contract.execute({ type: 'tx', key: 'c'.repeat(64),
          value: { ipk: from, wp: to, dispatch: { type: 'transfer', value: { to, amount } } } }, b);
        errors.push(result?.message ?? result);
      }
      await b.flush(); await b.close();
    };
    await (scheduled ? cooperativeApply(apply, { sliceMs: 0 }) : apply)(['20', '30', '2000', 'bad'], { batch: () => batch });
    return { state: [...state], writes, errors };
  };
  const expected = await run(false);
  assert.deepEqual(expected.errors, [null, null, 'balance', 'transfer']);
  assert.deepEqual(await run(true), expected);
});

test('per-entry message logs are summarized while diagnostics survive unchanged', () => {
  const lines = [], logger = { log(...args) { lines.push(args); } }, original = logger.log;
  const stop = summarizeApplyLogs(logger);
  for (let i = 0; i < 1000; i++) logger.log(`#${i} | ${'a'.repeat(64)}: {"t":"work"}`);
  logger.log('RESET reader failed:', 'disk');
  logger.log('unrelated', { value: 1 });
  assert.deepEqual(lines, [['RESET reader failed:', 'disk'], ['unrelated', { value: 1 }]]);
  stop(); assert.equal(logger.log, original);
  assert.deepEqual(lines.at(-1), ['RESET reader applied 1000 messages']);
});

test('stalled reader recovery rotates one replica per cooldown and never touches the reader store or a closing swarm', async () => {
  let time = 0, refreshed = 0, destroyed = 0;
  class Swarm extends EventEmitter {
    constructor() {
      super(); this.maxPeers = 3;
      this.connections = new Set(Array.from({ length: 3 }, () => Object.assign(new EventEmitter(), {
        destroy() { this.destroyed = true; destroyed++; this.emit('close'); }
      })));
    }
    join() { return { refresh: async () => { refreshed++; } }; }
    async flush() {}
  }
  const reader = { config: { dhtBootstrap: [], channel: Buffer.alloc(32) }, base: {} };
  const logs = [];
  await replicateReader(reader, null, { Swarm, now: () => time, log: value => logs.push(value) });
  assert.equal(reader.recoverRead(), true); assert.equal(reader.recoverRead(), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(destroyed, 1); assert.equal(refreshed, 1);
  reader.swarm.connections.add(Object.assign(new EventEmitter(), { destroy() { this.destroyed = true; destroyed++; this.emit('close'); } }));
  time += READER_REPAIR_MS;
  assert.equal(reader.recoverRead(), true); assert.equal(destroyed, 2);
  time += READER_REPAIR_MS; reader.base.closing = true;
  assert.equal(reader.recoverRead(), false);
  reader.base.closing = false; reader.swarm.destroyed = true;
  assert.equal(reader.recoverRead(), false); assert.equal(logs.length, 2);
});

test('reader scheduling, bounded reads and log summaries run under Bare', async () => {
  const result = await runBare(fileURLToPath(new URL('./reader-runtime.mjs', import.meta.url)));
  assert.match(result.stdout, /Bare reader scheduling, signed reads and log summary passed/);
});
