// Optional local stack telemetry, loaded only by the e2e runner's role processes.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Server } from 'node:http';
import { isMainThread } from 'node:worker_threads';

if (isMainThread && process.env.LOCKS_METRICS_FILE) {
  const [{ LocksClient }, { LockSigner }, { LockVenue }, { Bridge }] = await Promise.all([
    import('../../src/locks/client.js'), import('../../src/roles/lock-signer.js'), import('../../src/roles/lock-venue.js'), import('../../src/net/bridge.js')]);
  const output = fs.createWriteStream(process.env.LOCKS_METRICS_FILE, { flags: 'a' });
  const emit = row => output.write(JSON.stringify({ at: Date.now(), pid: process.pid, ...row }) + '\n');
  const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();
  let cpu = process.cpuUsage(), wall = performance.now(), reads = 0, writes = 0, ioMs = 0;
  const instances = new Map();
  for (const name of ['readFileSync', 'fsyncSync']) {
    const original = fs[name];
    fs[name] = function (...args) {
      const measured = name === 'fsyncSync' || String(args[0]).endsWith('.rec'), start = performance.now();
      try { return original.apply(this, args); }
      finally { if (measured) { ioMs += performance.now() - start; if (name === 'fsyncSync') writes++; else reads++; } }
    };
  }
  syncBuiltinESMExports();
  const request = Bridge.prototype.request;
  Bridge.prototype.request = function (...args) {
    const start = performance.now(), message = args[0];
    return request.apply(this, args).finally(() => emit({ type: 'bridge', method: message.type, command: message.command ?? message.method,
      kind: message.message?.kind, ms: performance.now() - start }));
  };
  for (const [Class, names] of [[LocksClient, ['status', 'refreshBook', 'onClock', 'receive', 'post', 'take', 'pay']],
    [LockSigner, ['handle', 'apply', 'reconcile', 'status']], [LockVenue, ['handle', 'apply', 'send', 'status']]]) {
    for (const name of names) {
      const original = Class.prototype[name]; if (!original) continue;
      Class.prototype[name] = function (...args) {
        instances.set(Class.name, this);
        const start = performance.now(), kind = name === 'send' ? args[1] : (name === 'apply' ? args[0] : args[1])?.kind;
        const end = error => emit({ type: 'method', role: Class.name, method: name, kind, ms: performance.now() - start, ...(error ? { error: error.message } : {}) });
        try {
          const result = original.apply(this, args);
          if (result?.then) return result.then(value => { end(); return value; }, error => { end(error); throw error; });
          end(); return result;
        } catch (error) { end(error); throw error; }
      };
    }
  }
  const originalEmit = Server.prototype.emit;
  Server.prototype.emit = function (event, ...args) {
    if (event === 'request') {
      const [req, res] = args, start = performance.now();
      res.once('finish', () => emit({ type: 'http', method: req.method, route: req.url.split('?')[0], status: res.statusCode, ms: performance.now() - start }));
    }
    return originalEmit.call(this, event, ...args);
  };
  setInterval(() => {
    const now = performance.now(), next = process.cpuUsage(), elapsed = now - wall;
    emit({ type: 'process', elapsedMs: elapsed, cpuPct: (next.user + next.system - cpu.user - cpu.system) / elapsed / 10,
      loopP99Ms: loop.percentile(99) / 1e6, loopMaxMs: loop.max / 1e6, loopMeanMs: loop.mean / 1e6,
      rss: process.memoryUsage().rss, recordReads: reads, fsyncs: writes, syncIoMs: ioMs,
      positions: Object.fromEntries([...instances].map(([name, role]) => [name, role.positions.size])) });
    loop.reset(); cpu = next; wall = now; reads = 0; writes = 0; ioMs = 0;
  }, 5000).unref();
}
