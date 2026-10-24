import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, writeFileSync, realpathSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireLock, readLock, saveLock, releaseLock, requestStop } from '../../../src/lifecycle/lock.js';
import { rotatingLog, tailLog } from '../../../src/lifecycle/logs.js';
import { startDex, stopDex, statusDex, dexLogs, ensureTrader } from '../../../src/lifecycle/manager.js';
import { superviseDex, launchRole } from '../../../src/lifecycle/supervisor.mjs';
import { lifecycleHandler, stopBlockers } from '../../../src/lifecycle/control.js';
import { runManaged } from '../../../peer/scripts/pear-runner.mjs';

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dex-lifecycle-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configFile = join(dir, 'trader.json'), peerConfig = join(dir, 'peer.json');
  const config = { role: 'trader', network: 'local', dataDir: dir, servicePeerKey: 'a'.repeat(64),
    bridge: { url: 'ws://127.0.0.1:1', tokenFile: join(dir, 'unused-token') }, control: { port: 1, tokenFile: join(dir, 'unused-control') } };
  writeFileSync(configFile, JSON.stringify(config));
  writeFileSync(peerConfig, JSON.stringify({ role: 'trader', network: 'local', servicePeerKey: config.servicePeerKey,
    bridge: { port: 1, tokenFile: config.bridge.tokenFile } }));
  return { dir, configFile, peerConfig, config };
}

let nextPid = 900000;
function fakeChild(onSend = () => {}) {
  const child = new EventEmitter();
  Object.assign(child, { pid: ++nextPid, connected: true, stdout: new PassThrough(), stderr: new PassThrough(), stdio: [null, null, null, new PassThrough()],
    send(message, callback) { onSend(message, child); callback?.(); },
    disconnect() { child.connected = false; }, unref() {},
    kill(signal) { child.finish(null, signal); },
    finish(code = 0, signal = null) { child.stdout.end(); child.stderr.end(); child.emit('exit', code, signal); child.emit('close', code, signal); },
  });
  return child;
}

test('start detaches without a window, hands password only through env, refuses second start, status and stop', async t => {
  const f = fixture(t), password = 'synthetic-launch-password';
  let child, options, args, prompts = 0;
  const live = new Set([process.pid]);
  const spawnChild = (_exe, argv, opts) => {
    options = opts; args = argv;
    child = fakeChild(message => {
      if (message.type !== 'launch') return;
      assert.equal(JSON.stringify(message).includes(password), false);
      queueMicrotask(() => {
        const record = { ...message.record, phase: 'running', peerPid: 810001, traderPid: 810002 };
        live.add(record.peerPid); live.add(record.traderPid); saveLock(record);
        child.emit('message', { type: 'ready', status: { running: true, dashboard: 'private-link', logs: {} } });
      });
    });
    live.add(child.pid); return child;
  };
  assert.equal((await startDex(f.configFile, { spawnChild, env: {}, prompt: async () => { prompts++; return password; }, isAlive: pid => live.has(pid) })).running, true);
  assert.equal(prompts, 1); assert.equal(options.env.DEX_KEY_PASSWORD, password);
  assert.equal(options.detached, true); assert.equal(options.windowsHide, true); assert.deepEqual(options.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
  assert.equal(args.join(' ').includes(password), false);
  assert.equal(readFileSync(join(f.dir, 'dex.pid'), 'utf8').includes(password), false);
  await assert.rejects(startDex(f.configFile, { spawnChild, env: {}, prompt: () => { throw Error('must not prompt twice'); }, isAlive: pid => live.has(pid) }), /already running/);
  const record = readLock(f.dir), order = [];
  const request = async (_config, method, path, body) => {
    if (method === 'GET') return { id: record.id, pid: record.traderPid, dataDir: f.dir, software: '0.1.32', node: 'v23', signers: ['signer'], dashboard: 'private-link', blockers: [] };
    assert.equal(path, '/lifecycle/stop'); assert.equal(body.force, false);
    order.push('trader'); live.delete(record.traderPid); order.push('peer'); live.delete(record.peerPid); live.delete(record.pid); releaseLock(record);
    return { forced: false, blockers: [] };
  };
  const status = await statusDex(f.configFile, { request, isAlive: pid => live.has(pid) });
  assert.equal(status.running, true); assert.equal(status.dashboard, 'private-link'); assert.deepEqual(status.signers, ['signer']);
  assert.equal((await stopDex(f.configFile, { request, isAlive: pid => live.has(pid) })).stopped, true);
  assert.deepEqual(order, ['trader', 'peer']); assert.equal(readLock(f.dir), null);
  assert.equal((await statusDex(f.configFile)).phase, 'stopped');
});

test('stale locks recover; live children, reused live PIDs and unreadable locks are never replaced', t => {
  const f = fixture(t), old = acquireLock(f.dir);
  assert.throws(() => acquireLock(f.dir), /already running/);
  const fresh = acquireLock(f.dir, { isAlive: () => false });
  assert.notEqual(fresh.id, old.id);
  releaseLock(old); assert.equal(readLock(f.dir).id, fresh.id);
  saveLock({ ...fresh, pid: 999999, traderPid: 999998 });
  assert.throws(() => acquireLock(f.dir, { isAlive: pid => pid === 999998 }), /already running/);
  writeFileSync(join(f.dir, 'dex.pid'), '{partial');
  assert.throws(() => acquireLock(f.dir), /uncertain lock/);
});

test('start rejects mismatched peer config and failed/short password without leaving a lock', async t => {
  const f = fixture(t);
  await assert.rejects(startDex(f.configFile, { env: {}, prompt: async () => 'short' }), /12 characters/);
  assert.equal(readLock(f.dir), null);
  writeFileSync(f.peerConfig, JSON.stringify({ role: 'signer' }));
  await assert.rejects(startDex(f.configFile, { env: {} }), /must agree/);
  assert.equal(readLock(f.dir), null);
});

test('spawn failure releases the startup lock', async t => {
  const f = fixture(t);
  await assert.rejects(startDex(f.configFile, { env: { DEX_KEY_PASSWORD: 'synthetic-password' }, spawnChild: () => { throw Error('spawn failed'); } }), /spawn failed/);
  assert.equal(readLock(f.dir), null);
});

test('supervisor waits for peer then trader markers, rotates logs and stops trader before peer', async t => {
  const f = fixture(t), record = acquireLock(f.dir), children = [], order = [], password = 'synthetic-password';
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const done = superviseDex({ ...f, record }, { env: { DEX_KEY_PASSWORD: password }, stopMs: 30, timeoutMs: 100,
    notify: value => { if (value.type === 'ready') resolveReady(value); else assert.fail(value.error); },
    spawnChild: (_exe, args, opts) => {
      const name = children.length ? 'trader' : 'peer'; order.push('start ' + name);
      assert.equal(opts.windowsHide, true); assert.equal(opts.detached, true);
      if (name === 'peer') assert.equal(opts.env.DEX_KEY_PASSWORD, undefined);
      else { assert.equal(opts.env.DEX_KEY_PASSWORD, password); assert.equal(opts.env.DEX_LIFECYCLE_ID, record.id); }
      const child = fakeChild(message => { if (message.type === 'dex-stop') { order.push('stop ' + name); queueMicrotask(() => child.finish()); } });
      children.push(child);
      queueMicrotask(() => {
        child.stdout.write(`DEX_${name === 'peer' ? 'PEER' : 'ROLE'}_READY {}\n`);
        if (name === 'trader') {
          child.stderr.write('synthetic-'); child.stderr.write('password\n');
          child.emit('message', { type: 'role-ready', dashboard: 'private-link' });
        }
      });
      return child;
    } });
  const result = await ready;
  assert.equal(result.status.dashboard, 'private-link'); assert.equal(readLock(f.dir).phase, 'running');
  assert.deepEqual(order, ['start peer', 'start trader']);
  // This is the actual trader-first stop path: the trader exits after its authenticated stop request.
  requestStop(record); order.push('stop trader'); children[1].finish(); await done;
  assert.deepEqual(order, ['start peer', 'start trader', 'stop trader', 'stop peer']);
  assert.equal(readLock(f.dir), null);
  assert.equal(readFileSync(join(f.dir, 'trader.log'), 'utf8').includes(password), false);
  assert.match(dexLogs(f.configFile, 'trader'), /redacted/);
  assert.throws(() => dexLogs(f.configFile, 'unknown'), /Expected/);
});

test('repeated startup failures give up and clean children and the lock', async t => {
  for (const failPeer of [false, true]) {
    const f = fixture(t), record = acquireLock(f.dir), children = [], stopped = [], notifications = [];
    await superviseDex({ ...f, record }, { timeoutMs: 15, stopMs: 15, wait: async () => {}, notify: x => notifications.push(x), spawnChild: (_exe, args) => {
      const name = args[0].includes('pear-runner') ? 'peer' : 'trader';
      const child = fakeChild(message => { if (message.type === 'dex-stop') { stopped.push(name); queueMicrotask(() => child.finish()); } });
      children.push(child);
      if (name === 'peer' && !failPeer) queueMicrotask(() => child.stdout.write('DEX_PEER_READY {}\n'));
      if (name === 'trader') queueMicrotask(() => child.finish(1));
      return child;
    } });
    assert.equal(children.length, failPeer ? 5 : 6); assert.deepEqual(stopped, Array(failPeer ? 5 : 1).fill('peer'));
    assert.equal(notifications[0].type, 'failed'); assert.equal(readLock(f.dir), null);
  }
});

test('readiness requires a complete marker and trader IPC acknowledgement, not log substrings', async t => {
  const f = fixture(t), log = rotatingLog(join(f.dir, 'trader.log')), child = fakeChild();
  const runtime = launchRole('trader', 'unused', 'unused', {}, log, { spawnChild: () => child, timeoutMs: 100 });
  let ready = false; runtime.ready.then(() => { ready = true; });
  child.stdout.write('prefix DEX_ROLE_READY {}\nDEX_ROLE_');
  await Promise.resolve(); assert.equal(ready, false);
  child.stdout.write('READY {}\n'); await Promise.resolve(); assert.equal(ready, false);
  child.emit('message', { type: 'role-ready', dashboard: null }); await runtime.ready;
  child.finish(); await runtime.closed; log.close();
});

test('rotation stays bounded including huge writes and tails stay bounded', t => {
  const f = fixture(t), path = join(f.dir, 'test.log'), log = rotatingLog(path, { maxBytes: 32, copies: 3 });
  log.write('x'.repeat(1000)); log.write('\nlast line\n'); log.close();
  const files = readdirSync(f.dir).filter(x => x.startsWith('test.log'));
  assert.equal(files.length, 4);
  for (const file of files) assert.ok(statSync(join(f.dir, file)).size <= 32);
  assert.match(tailLog(path, 15), /last line/);
});

function invoke(handler, method, url, body) {
  return new Promise(resolve => {
    const req = new EventEmitter(); Object.assign(req, { method, url });
    let code;
    handler(req, { writeHead: value => { code = value; }, end: text => resolve({ code, body: JSON.parse(text) }) });
    if (body !== undefined) req.emit('data', JSON.stringify(body)); req.emit('end');
  });
}

test('live stop guard names every unfinished trade, checks buyer lock state, and force is explicit', async t => {
  const f = fixture(t), role = { host: { trades: new Map([['t', { key: 'trade-1', role: 'buyer', state: { phase: 'aborted', locked: true } }]]) }, onlineSigners: () => ['s'] };
  assert.equal(stopBlockers(role).length, 1);
  const trade = role.host.trades.get('t'); trade.state.locked = false; assert.equal(stopBlockers(role).length, 0);
  trade.state.phase = 'locking';
  let stops = 0;
  const handler = lifecycleHandler({ id: 'instance', config: f.config, role, dashboard: () => 'link', stop: () => { stops++; }, fallback: () => assert.fail('fallback') });
  assert.equal((await invoke(handler, 'GET', '/lifecycle')).body.dashboard, 'link');
  const refused = await invoke(handler, 'POST', '/lifecycle/stop', { id: 'instance' });
  assert.equal(refused.code, 409); assert.match(refused.body.error, /trade-1 \(locking\)/); assert.equal(stops, 0);
  assert.equal((await invoke(handler, 'POST', '/lifecycle/stop', { id: 'wrong', force: true })).code, 409);
  assert.equal((await invoke(handler, 'POST', '/lifecycle/stop', { id: 'instance', force: 'true' })).code, 400);
  assert.equal((await invoke(handler, 'POST', '/lifecycle/stop', { id: 'instance', force: true })).body.forced, true);
  await invoke(handler, 'POST', '/lifecycle/stop', { id: 'instance', force: true }); assert.equal(stops, 1);
  role.locks = { positions: new Map([['p', { positionId: 'p', state: 'taking' }]]) };
  assert.deepEqual(stopBlockers(role, { pending: () => [{ id: 'w', status: 'unconfirmed' }] }).map(b => b.kind), ['trade', 'withdrawal', 'position']);
});

test('stop and status never act on a different instance or data folder; stale stop is harmless', async t => {
  const f = fixture(t), record = acquireLock(f.dir); record.traderPid = process.pid; record.phase = 'running'; saveLock(record);
  let posts = 0;
  const request = async (_config, method) => { if (method === 'POST') posts++; return { id: 'different', dataDir: f.dir, pid: process.pid }; };
  assert.equal((await statusDex(f.configFile, { request })).phase, 'unreachable');
  await assert.rejects(stopDex(f.configFile, { request, force: true }), /another DEX instance/); assert.equal(posts, 0);
  assert.equal((await stopDex(f.configFile, { isAlive: () => false })).stale, true); assert.equal(readLock(f.dir), null);
});

test('a failed stop request remains retryable and is not reported as accepted', async t => {
  const f = fixture(t); let attempts = 0;
  const handler = lifecycleHandler({ id: 'instance', config: f.config, role: { onlineSigners: () => [] },
    dashboard: () => null, fallback: () => assert.fail('fallback'), stop: () => {
      if (++attempts === 1) throw Error('DEX pid file is busy; retry');
    } });
  const call = () => invoke(handler, 'POST', '/lifecycle/stop', { id: 'instance' });
  assert.equal((await call()).code, 400);
  assert.equal((await invoke(handler, 'GET', '/lifecycle')).body.stopping, false);
  assert.equal((await call()).code, 200); assert.equal(attempts, 2);
  assert.equal((await invoke(handler, 'GET', '/lifecycle')).body.stopping, true);
});

test('MCP reuses the correct trader, auto-starts only on absence, and propagates other errors', async t => {
  const f = fixture(t); let starts = 0;
  const start = async (_file, options) => { starts++; assert.equal(options.peerConfig, f.peerConfig); return { running: true }; };
  assert.equal((await ensureTrader(f.configFile, { start, request: async () => ({ storage: { dataDir: resolve(f.dir) } }) })).existing, true);
  for (const error of [Object.assign(Error('missing'), { code: 'ENOENT' }), Object.assign(Error('connect'), { cause: { code: 'ECONNREFUSED' } })]) {
    assert.equal((await ensureTrader(f.configFile, { start, peerConfig: f.peerConfig, request: async () => { throw error; } })).running, true);
  }
  assert.equal(starts, 2);
  await assert.rejects(ensureTrader(f.configFile, { start, request: async () => ({ storage: { dataDir: '/different' } }) }), /another data folder/);
  await assert.rejects(ensureTrader(f.configFile, { start, request: async () => { throw Error('unauthorized'); } }), /unauthorized/);
  assert.equal(starts, 2);
});

test('managed Pear applies hidden/detached options to the runtime binary and uses a shutdown pipe', () => {
  const child = fakeChild(); let options, args;
  runManaged({ binary: '/synthetic/bare', spawnChild: (binary, argv, opts) => { assert.equal(binary, '/synthetic/bare'); args = argv; options = opts; return child; } });
  assert.equal(options.detached, true); assert.equal(options.windowsHide, true); assert.match(args[0], /managed-peer.js$/);
  assert.deepEqual(options.stdio, ['ignore', 'inherit', 'inherit', 'overlapped']);
  child.finish();
});
