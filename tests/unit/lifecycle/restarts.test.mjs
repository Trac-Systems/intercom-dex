import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { restartPolicy } from '../../../src/lifecycle/restarts.js';
import { superviseDex } from '../../../src/lifecycle/supervisor.mjs';
import { acquireLock, readLock, saveLock, requestStop, launchLocked } from '../../../src/lifecycle/lock.js';
import { stopDex, statusDex } from '../../../src/lifecycle/manager.js';

test('backoff doubles from 2s to 60s, resets after ten healthy minutes, and bounds a rolling failure window', () => {
  let now = 0;
  const policy = restartPolicy({ now: () => now });
  const delays = [];
  for (let i = 0; i < 8; i++) {
    policy.healthy(); now += 160000;
    const result = policy.failed(); delays.push(result.delayMs); assert.equal(result.exhausted, false);
  }
  assert.deepEqual(delays, [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  policy.healthy(); now += 600000;
  assert.equal(policy.failed().delayMs, 2000);
  for (let i = 0; i < 3; i++) assert.equal(policy.failed().exhausted, false);
  assert.equal(policy.failed().exhausted, true);
  now += 600000;
  assert.equal(policy.failed().exhausted, false);
  assert.equal(policy.failed().delayMs, 60000, 'elapsed downtime alone does not reset backoff');
});

async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw Error('Fake supervisor did not advance'); await tick(); }
}

let pid = 950000;
function harness(t, { fail, wait = async () => {}, now = Date.now } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dex-restarts-'))), configFile = join(dir, 'trader.json');
  writeFileSync(configFile, JSON.stringify({ role: 'trader', dataDir: dir, control: { port: 1, tokenFile: join(dir, 'unused') } }));
  const record = acquireLock(dir), children = [], events = [], notifications = [], waits = [];
  let cancel;
  const done = superviseDex({ configFile, peerConfig: 'unused', record }, { timeoutMs: 5000, stopMs: 10, pollMs: 1, now,
    env: { DEX_KEY_PASSWORD: 'synthetic-restart-password' }, onCancel: fn => { cancel = fn; },
    wait: (ms, signal) => { waits.push(ms); return wait(ms, signal); }, notify: value => notifications.push(value),
    spawnChild: (_exe, args, opts) => {
      const name = args[0].includes('pear-runner') ? 'peer' : 'trader';
      events.push('start ' + name);
      if (name === 'peer') assert.equal(opts.env.DEX_KEY_PASSWORD, undefined);
      else assert.equal(opts.env.DEX_KEY_PASSWORD, 'synthetic-restart-password');
      const child = Object.assign(new EventEmitter(), { pid: ++pid, name, connected: true, stdout: new PassThrough(), stderr: new PassThrough(), ended: false,
        finish(code = 0, signal = null) {
          if (this.ended) return;
          this.ended = true; this.stdout.end(); this.stderr.end(); this.emit('exit', code, signal); this.emit('close', code, signal);
        },
        send(message, callback) { if (message.type === 'dex-stop') { events.push('stop ' + name); queueMicrotask(() => this.finish()); } callback?.(); },
        kill(signal) { this.finish(null, signal); },
      });
      children.push(child);
      queueMicrotask(() => {
        if (fail?.(child, children)) return;
        child.stdout.write(`DEX_${name === 'peer' ? 'PEER' : 'ROLE'}_READY {}\n`);
        if (name === 'trader') child.emit('message', { type: 'role-ready', dashboard: 'private-link' });
      });
      return child;
    },
  });
  t.after(async () => { cancel(); await done; rmSync(dir, { recursive: true, force: true }); });
  const running = () => until(() => readLock(dir)?.phase === 'running');
  const isAlive = value => value === process.pid || children.some(c => c.pid === value && !c.ended);
  const request = async () => {
    const current = readLock(dir);
    return { id: record.id, pid: current.traderPid, dataDir: dir, signers: ['signer'], dashboard: 'private-link', blockers: [] };
  };
  return { dir, configFile, record, children, events, notifications, waits, done, cancel, running, isAlive, request };
}

test('trader crash and bridge exit 75 restart only trader; status reports count and last exit', async t => {
  const h = harness(t); await h.running();
  const peerPid = readLock(h.dir).peerPid;
  for (const [code, signal] of [[null, 'SIGKILL'], [75, null], [0, null]]) {
    const previous = readLock(h.dir).traderPid;
    h.children.at(-1).finish(code, signal);
    await until(() => readLock(h.dir)?.phase === 'running' && readLock(h.dir).traderPid !== previous);
    const status = await statusDex(h.configFile, h);
    assert.equal(status.running, true); assert.equal(status.pids.peer, peerPid);
    assert.equal(status.lastExit.role, 'trader'); assert.equal(status.lastExit.code, code); assert.equal(status.lastExit.signal, signal);
    assert.equal(status.restarts, h.waits.length); assert.deepEqual(status.signers, ['signer']);
  }
  assert.deepEqual(h.waits, [2000, 4000, 8000]);
  assert.equal(h.notifications.filter(n => n.type === 'ready').length, 1);
  requestStop(h.record); await h.done;
  assert.equal(readLock(h.dir), null);
});

test('peer crash stops trader, waits for replacement peer readiness, then starts trader', async t => {
  let replacement;
  const h = harness(t, { fail: (child, children) => {
    if (child.name === 'peer' && children.length > 2) { replacement = child; return true; }
  } });
  await h.running(); h.children[0].finish(1);
  await until(() => replacement);
  assert.deepEqual(h.events, ['start peer', 'start trader', 'stop trader', 'start peer']);
  replacement.stdout.write('DEX_PEER_READY {}\n'); await h.running();
  assert.equal(h.events.at(-1), 'start trader');
  assert.equal(readLock(h.dir).lastExit.role, 'peer'); assert.equal(readLock(h.dir).restarts, 1);
});

test('five failures within ten minutes give up, log the reason, and release the lock', async t => {
  const h = harness(t, { fail: child => { if (child.name === 'trader') { child.finish(75); return true; } } });
  await h.done;
  assert.deepEqual(h.waits, [2000, 4000, 8000, 16000]);
  assert.equal(h.children.filter(c => c.name === 'trader').length, 5);
  assert.ok(h.children.every(c => c.ended)); assert.equal(readLock(h.dir), null);
  assert.match(h.notifications.at(-1).error, /5 failures within 10 minutes/);
  assert.match(readFileSync(join(h.dir, 'trader.log'), 'utf8'), /Giving up after 5 failures within 10 minutes/);
});

test('a peer lost during trader startup restarts the pair without waiting for the trader timeout', async t => {
  const h = harness(t, { fail: (child, children) => {
    if (child.name === 'trader' && children.length === 2) { children[0].finish(1); return true; }
  } });
  await h.running();
  assert.deepEqual(h.events, ['start peer', 'start trader', 'stop trader', 'start peer', 'start trader']);
  assert.equal(readLock(h.dir).restarts, 1);
});

test('stop during backoff cancels pending restart without needing a live trader API', async t => {
  const h = harness(t, { wait: () => new Promise(() => {}) });
  await h.running(); h.children.at(-1).finish(75);
  await until(() => h.waits.length);
  const status = await statusDex(h.configFile, { ...h, request: () => assert.fail('no trader API') });
  assert.equal(status.phase, 'restarting'); assert.equal(status.lastExit.code, 75);
  const stopped = await stopDex(h.configFile, { ...h, request: () => assert.fail('no trader API'), timeoutMs: 1000 });
  await h.done;
  assert.equal(stopped.stopped, true); assert.equal(h.children.length, 2); assert.equal(readLock(h.dir), null);
});

test('accepted stop followed immediately by child exit never restarts, even before the next poll', async t => {
  const h = harness(t); await h.running();
  requestStop(h.record); h.children.at(-1).finish(0); await h.done;
  assert.deepEqual(h.waits, []); assert.equal(h.children.length, 2); assert.equal(readLock(h.dir), null);
});

test('stop while a replacement peer is starting cancels startup and never launches its trader', async t => {
  const h = harness(t, { fail: (child, children) => child.name === 'peer' && children.length > 2 });
  await h.running(); h.children[0].finish(1);
  await until(() => h.children.length === 3);
  assert.equal(requestStop(h.record, { idleOnly: true }), true);
  await h.done;
  assert.equal(h.children.length, 3); assert.ok(h.children.every(child => child.ended));
  assert.equal(readLock(h.dir), null);
});

test('a simultaneous peer failure and bridge exit restart the pair only once', async t => {
  const h = harness(t); await h.running();
  h.children[0].finish(1); h.children[1].finish(75);
  await until(() => h.children.length === 4 && readLock(h.dir)?.phase === 'running');
  assert.deepEqual(h.waits, [2000]); assert.equal(readLock(h.dir).lastExit.role, 'peer');
});

test('cancelling initial startup cleans up without retrying or launching trader', async t => {
  const h = harness(t, { fail: () => true });
  await until(() => h.children.length === 1); h.cancel(); await h.done;
  assert.deepEqual(h.waits, []); assert.equal(h.children.length, 1); assert.equal(readLock(h.dir), null);
  assert.match(h.notifications.at(-1).error, /cancelled/);
});

test('stop flags survive stale saves and atomically prevent launches; idle stop cannot race a live trader', async t => {
  const h = harness(t); await h.running();
  assert.equal(requestStop(h.record, { idleOnly: true }), false);
  assert.throws(() => requestStop(h.record, { traderPid: 123 }), /instance changed/);
  requestStop(h.record);
  saveLock({ ...h.record, stopRequested: false });
  assert.equal(readLock(h.dir).stopRequested, true);
  assert.equal(launchLocked(h.record, 'trader', () => assert.fail('launch after stop')), null);
  await h.done;
});
