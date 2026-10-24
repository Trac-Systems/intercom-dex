import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { SOFTWARE } from '../core/software.js';
import { saveLock, releaseLock, readLock, launchLocked } from './lock.js';
import { restartPolicy } from './restarts.js';
import { logPaths, rotatingLog } from './logs.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
export function launchRole(name, file, configFile, env, log, { spawnChild = spawn, timeoutMs = 180000 } = {}) {
  const child = spawnChild(process.execPath, [file, '--config', configFile], {
    cwd: root, env, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let exited = false, exit = null;
  const closed = new Promise(resolve => {
    child.once('exit', (code, signal) => { exited = true; exit = { code, signal }; });
    child.once('close', () => { exited = true; resolve(exit); });
    child.once('error', () => { exited = true; exit = { code: null, signal: null }; resolve(exit); });
  });
  const secrets = [env[env.DEX_PASSWORD_NAME], env[env.DEX_TRAC_PASSWORD_NAME], env.DEX_KEY_PASSWORD].filter(Boolean).flatMap(value => value.split(/\r?\n/)).filter(Boolean);
  const ready = new Promise((resolve, reject) => {
    let info, dashboard = null, acknowledged = name === 'peer';
    const timeout = setTimeout(() => reject(new Error(`${name} startup timed out; see ${name}.log`)), timeoutMs);
    const finish = (error, info) => { clearTimeout(timeout); error ? reject(error) : resolve(info); };
    const checkReady = () => { if (info && acknowledged) finish(null, { ...info, dashboard }); };
    child.on('message', message => {
      if (name === 'trader' && message.type === 'role-ready') { acknowledged = true; dashboard = message.dashboard; checkReady(); }
    });
    child.once('error', () => finish(new Error(`${name} failed to launch; see ${name}.log`)));
    child.once('exit', code => finish(new Error(`${name} exited (${code}); see ${name}.log`)));
    for (const stream of [child.stdout, child.stderr]) {
      let pending = '', discarding = false;
      const decoder = new StringDecoder('utf8');
      const consume = line => {
        for (const secret of secrets) line = line.split(secret).join('[redacted]');
        log.write(line + '\n');
        const marker = name === 'peer' ? 'DEX_PEER_READY ' : 'DEX_ROLE_READY ';
        if (stream === child.stdout && line.startsWith(marker)) {
          try { info = JSON.parse(line.slice(marker.length)); checkReady(); } catch { finish(new Error(`Invalid ${name} readiness message`)); }
        }
      };
      stream.on('data', chunk => {
        pending += decoder.write(chunk);
        let at;
        while ((at = pending.indexOf('\n')) >= 0) {
          consume(discarding || at > 65536 ? '[oversized log line omitted]' : pending.slice(0, at));
          pending = pending.slice(at + 1); discarding = false;
        }
        // Do not split an oversized line: a secret could cross the split.
        if (pending.length > 65536 || discarding) { pending = ''; discarding = true; }
      });
      stream.on('end', () => { pending += decoder.end(); if (discarding) consume('[oversized log line omitted]'); else if (pending) consume(pending); });
    }
  });
  return { child, ready, closed, get exited() { return exited; }, get exit() { return exit; } };
}

export async function superviseDex({ configFile, peerConfig, record }, {
  spawnChild = spawn, env = process.env, notify = () => {}, timeoutMs = 180000, stopMs = 90000,
  onCancel = () => {}, now = Date.now, wait = (ms, signal) => delay(ms, undefined, { signal }), pollMs = 100,
} = {}) {
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  const paths = logPaths(record.dataDir), logs = { peer: rotatingLog(paths.peer), trader: rotatingLog(paths.trader) };
  const policy = restartPolicy({ now }), cancellation = new AbortController();
  const cancelled = new Promise(resolve => cancellation.signal.addEventListener('abort', () => resolve(null), { once: true }));
  const cancel = () => cancellation.abort();
  let peer, trader, announced = false, restarting = false, stage = 'peer';
  record.restarts = 0; record.lastExit = null;
  const stopping = () => {
    if (record.stopRequested || readLock(record.dataDir)?.stopRequested) cancel();
    return cancellation.signal.aborted;
  };
  const poll = setInterval(() => {
    try { stopping(); } catch { cancel(); }
  }, pollMs);
  onCancel(cancel);
  const halt = async runtime => {
    if (!runtime) return;
    if (!runtime.exited) {
      if (runtime.child.connected) runtime.child.send({ type: 'dex-stop' }, () => {});
      else runtime.child.kill('SIGTERM');
    }
    let timer;
    const done = await Promise.race([runtime.closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), stopMs); })]);
    clearTimeout(timer);
    if (!done) { runtime.child.kill('SIGKILL'); await runtime.closed; }
  };
  const launch = (name, file, config, environment) => launchLocked(record, name, () => {
    const runtime = launchRole(name, file, config, environment, logs[name], { spawnChild, timeoutMs });
    if (restarting) { record.restarts++; restarting = false; }
    return runtime;
  });
  const traderEnv = { ...env, DEX_LIFECYCLE_ID: record.id, DEX_PASSWORD_NAME: config.keyPasswordEnv ?? 'DEX_KEY_PASSWORD',
    DEX_TRAC_PASSWORD_NAME: config.trac?.passwordEnv ?? config.keyPasswordEnv ?? 'DEX_KEY_PASSWORD' };
  const peerEnv = { ...env, DEX_MANAGED_PEER: '1', PEAR_RUNNER_STDIN: '0' };
  for (const key of new Set(['DEX_KEY_PASSWORD', traderEnv.DEX_PASSWORD_NAME, traderEnv.DEX_TRAC_PASSWORD_NAME])) delete peerEnv[key];
  try {
    record.versions = { dex: SOFTWARE, peer: JSON.parse(readFileSync(join(root, 'peer/package.json'))).version, node: process.version };
    while (!stopping()) {
      try {
        if (!peer || peer.exited) {
          await halt(trader); trader = null; record.traderPid = null;
          await halt(peer);
          if (stopping()) break;
          stage = 'peer';
          peer = launch('peer', join(root, 'peer/scripts/pear-runner.mjs'), peerConfig, peerEnv);
          if (!peer) break;
          await Promise.race([peer.ready, cancelled]);
          if (stopping()) break;
          if (peer.exited) throw new Error('Peer exited during startup');
        }
        stage = 'trader';
        trader = launch('trader', join(root, 'bin/dex.mjs'), configFile, traderEnv);
        if (!trader) break;
        const info = await Promise.race([trader.ready, cancelled,
          peer.closed.then(() => { throw new Error('Peer exited during trader startup'); })]);
        if (stopping()) break;
        if (peer.exited || trader.exited) throw new Error('Child exited during startup');
        record.phase = 'running'; saveLock(record); policy.healthy();
        if (!announced) {
          announced = true;
          notify({ type: 'ready', status: { running: true, versions: record.versions, dashboard: info.dashboard, logs: paths,
            restarts: record.restarts, lastExit: record.lastExit,
            pids: { supervisor: record.pid, peer: record.peerPid, trader: record.traderPid } } });
        }
        await Promise.race([peer.closed, trader.closed, cancelled]);
        if (stopping()) break;
        throw new Error('Child exited unexpectedly');
      } catch (error) {
        if (stopping()) break;
        const name = peer?.exited ? 'peer' : stage;
        const runtime = name === 'peer' ? peer : trader;
        const failure = policy.failed();
        record.lastExit = { role: name, code: runtime?.exit?.code ?? null, signal: runtime?.exit?.signal ?? null,
          at: new Date(failure.at).toISOString(), reason: error.message };
        record.phase = 'restarting'; saveLock(record);
        logs[name].write(`[supervisor] ${name} exited: code=${record.lastExit.code} signal=${record.lastExit.signal}; ${error.message}\n`);
        await halt(trader); trader = null; record.traderPid = null;
        if (name === 'peer') { await halt(peer); peer = null; record.peerPid = null; }
        saveLock(record);
        if (stopping()) break;
        if (failure.exhausted) throw new Error('Giving up after 5 failures within 10 minutes');
        logs[name].write(`[supervisor] Restarting ${name === 'peer' ? 'peer then trader' : 'trader'} in ${failure.delayMs / 1000}s\n`);
        await Promise.race([wait(failure.delayMs, cancellation.signal), cancelled]);
        if (stopping()) break;
        restarting = true;
      }
    }
  } catch (error) {
    if (!stopping()) {
      logs.trader.write(`[supervisor] ${error.message}; stopping DEX and releasing lock\n`);
      notify({ type: 'failed', error: error.message });
    }
  } finally {
    clearInterval(poll);
    record.phase = 'stopping'; saveLock(record);
    await halt(trader); await halt(peer);
    logs.trader.close(); logs.peer.close(); releaseLock(record);
    if (!announced && cancellation.signal.aborted) notify({ type: 'failed', error: 'DEX startup cancelled' });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let cancel = () => {}, started = false, ready = false;
  process.on('disconnect', () => { if (!ready) cancel(); });
  process.on('message', message => {
    if (message.type === 'cancel') return cancel();
    if (message.type !== 'launch' || started) return;
    started = true;
    void superviseDex(message, { onCancel: fn => { cancel = fn; }, notify: message => {
      if (message.type === 'ready') ready = true;
      if (process.connected) process.send(message);
    } }).finally(() => process.exit(0));
  });
}
