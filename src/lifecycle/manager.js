import { readFileSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readPrivateFile } from '../roles/keyring.js';
import { hiddenInput } from '../wallets/input.js';
import { acquireLock, alive, lockAlive, readLock, releaseLock, saveLock, requestStop } from './lock.js';
import { logPaths, tailLog } from './logs.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
export function traderConfig(configFile) {
  if (!isAbsolute(configFile ?? '')) throw new Error('--config must be an absolute path');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  if (config.role !== 'trader') throw new Error('Background lifecycle commands are for traders; servers keep their supervisor');
  if (!isAbsolute(config.dataDir ?? '')) throw new Error('Absolute trader dataDir required');
  if (!Number.isInteger(config.control?.port) || config.control.port < 1 || config.control.port > 65535 || !isAbsolute(config.control.tokenFile ?? '')) throw new Error('Trader control port and absolute tokenFile required');
  return config;
}

export async function lifecycleCall(config, method, route, body) {
  const token = readPrivateFile(config.control.tokenFile, 256).trim();
  const response = await fetch(`http://127.0.0.1:${config.control.port}${route}`, { method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `Control HTTP ${response.status}`);
  return value;
}

export async function startDex(configFile, { peerConfig, env = process.env, prompt = hiddenInput, spawnChild = spawn, timeoutMs = 400000, isAlive = alive } = {}) {
  const config = traderConfig(configFile);
  peerConfig ??= join(dirname(configFile), 'peer.json');
  if (!isAbsolute(peerConfig)) throw new Error('--peer-config must be an absolute path');
  const peer = JSON.parse(readFileSync(peerConfig, 'utf8'));
  if (peer.role !== 'trader' || peer.network !== config.network || peer.servicePeerKey !== config.servicePeerKey ||
      config.bridge?.url !== `ws://127.0.0.1:${peer.bridge?.port}` || peer.bridge?.tokenFile !== config.bridge?.tokenFile) throw new Error('Peer and trader configs must agree on role, network, venue and bridge');
  const record = acquireLock(config.dataDir, { isAlive });
  let child;
  try {
    const passwordName = config.keyPasswordEnv ?? 'DEX_KEY_PASSWORD';
    const password = env[passwordName] ?? env.DEX_KEY_PASSWORD ?? await prompt('Keyring password: ');
    if (typeof password !== 'string' || password.length < 12) throw new Error('Keyring password of at least 12 characters required');
    const childEnv = { ...env, [passwordName]: password };
    if (config.trac?.passwordEnv && !childEnv[config.trac.passwordEnv]) childEnv[config.trac.passwordEnv] = password;
    child = spawnChild(process.execPath, [join(root, 'src/lifecycle/supervisor.mjs')], {
      cwd: root, env: childEnv, detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { child.send?.({ type: 'cancel' }, () => {}); reject(new Error('DEX startup timed out; cleanup requested')); }, timeoutMs);
      const finish = (error, value) => { clearTimeout(timeout); error ? reject(error) : resolve(value); };
      child.once('error', error => finish(error));
      child.once('exit', code => finish(new Error(`DEX launcher exited (${code}); see ${config.dataDir}`)));
      child.on('message', message => {
        if (message.type === 'ready') finish(null, message.status);
        if (message.type === 'failed') finish(new Error(message.error));
      });
    });
    if (child.pid) { record.pid = child.pid; saveLock(record); }
    child.send({ type: 'launch', configFile, peerConfig, record }, error => { if (error) child.emit('error', error); });
    const status = await ready;
    child.disconnect(); child.unref();
    return status;
  } catch (error) {
    if (!child?.pid || !isAlive(child.pid)) releaseLock(record);
    child?.unref();
    throw error;
  }
}

export async function statusDex(configFile, { request = lifecycleCall, isAlive = alive } = {}) {
  const config = traderConfig(configFile), record = readLock(config.dataDir);
  const result = { running: false, phase: record ? 'stale' : 'stopped', logs: logPaths(config.dataDir), versions: record?.versions ?? null,
    pids: record ? { supervisor: record.pid, peer: record.peerPid ?? null, trader: record.traderPid ?? null } : null, signers: [], dashboard: null,
    restarts: record?.restarts ?? 0, lastExit: record?.lastExit ?? null, trades: [] };
  if (!record || !lockAlive(record, isAlive)) return result;
  result.phase = record.stopRequested ? 'stopping' : record.phase;
  if (!record.traderPid) return result;
  try {
    const info = await request(config, 'GET', '/lifecycle');
    if (info.id !== record.id || info.pid !== record.traderPid || info.dataDir !== realpathSync(config.dataDir)) throw new Error('Control API belongs to another DEX instance');
    return { ...result, running: !record.stopRequested && !info.stopping && record.phase === 'running' && isAlive(record.peerPid) && isAlive(record.traderPid),
      phase: info.stopping ? 'stopping' : result.phase,
      versions: { ...record.versions, trader: info.software, node: info.node }, signers: info.signers, dashboard: info.dashboard, blockers: info.blockers,
      trades: info.trades ?? [] };
  } catch (error) { return { ...result, phase: ['starting', 'restarting', 'stopping'].includes(result.phase) ? result.phase : 'unreachable', error: error.message }; }
}

export async function stopDex(configFile, { force = false, request = lifecycleCall, isAlive = alive, timeoutMs = 100000 } = {}) {
  const config = traderConfig(configFile), record = readLock(config.dataDir);
  if (!record) return { stopped: true };
  if (!lockAlive(record, isAlive)) { releaseLock(record); return { stopped: true, stale: true }; }
  let response = { forced: force, blockers: [] };
  if (!requestStop(record, { idleOnly: true })) {
    const info = await request(config, 'GET', '/lifecycle');
    if (info.id !== record.id || info.pid !== record.traderPid || info.dataDir !== realpathSync(config.dataDir)) throw new Error('Control API belongs to another DEX instance; refusing to stop');
    response = await request(config, 'POST', '/lifecycle/stop', { id: record.id, force });
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = readLock(config.dataDir);
    if (!current || current.id !== record.id) return { stopped: true, forced: response.forced, blockers: response.blockers };
    if (!lockAlive(current, isAlive)) { releaseLock(current); return { stopped: true }; }
    await delay(100);
  }
  throw new Error('Shutdown still in progress; check status and logs');
}

export function dexLogs(configFile, name) {
  if (name !== undefined && !['peer', 'trader'].includes(name)) throw new Error('Expected logs [peer|trader]');
  const paths = logPaths(traderConfig(configFile).dataDir);
  return (name ? [name] : ['peer', 'trader']).map(key => `== ${key}: ${paths[key]} ==\n${tailLog(paths[key])}`).join('\n');
}

export async function ensureTrader(configFile, { request = lifecycleCall, start = startDex, peerConfig } = {}) {
  const config = traderConfig(configFile);
  let info;
  try {
    info = await request(config, 'GET', '/wallets');
  } catch (error) {
    if (error.code !== 'ENOENT' && error.cause?.code !== 'ECONNREFUSED') throw error;
    return start(configFile, { peerConfig, prompt: async () => { throw new Error('Start DEX in your terminal with dex start, or set DEX_KEY_PASSWORD in the launch environment'); } });
  }
  if (info.storage?.dataDir !== resolve(config.dataDir)) throw new Error('Control API belongs to another data folder');
  return { existing: true };
}
