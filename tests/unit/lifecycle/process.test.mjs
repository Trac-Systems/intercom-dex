import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveNetwork } from '../../../src/net/profile.js';
import { readLock, alive } from '../../../src/lifecycle/lock.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('installed managed Pear runtime reports an invalid config and exits without opening services', { timeout: 10000 }, async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dex-pear-'))), configFile = join(dir, 'invalid.json');
  writeFileSync(configFile, '{}');
  const child = spawn(process.execPath, ['peer/scripts/pear-runner.mjs', '--config', configFile], {
    cwd: root, env: { ...process.env, DEX_MANAGED_PEER: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  assert.notEqual(code, 0); assert.match(output, /Choose network: mainnet or local/);
});

test('concurrent processes cannot both reclaim a stale pid file', { timeout: 5000 }, async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dex-race-'))), children = [];
  writeFileSync(join(dir, 'dex.pid'), JSON.stringify({ id: 'stale', pid: 2147483647 }));
  t.after(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });
  const code = `import {acquireLock} from ${JSON.stringify(new URL('../../../src/lifecycle/lock.js', import.meta.url).href)};
try {acquireLock(${JSON.stringify(dir)});process.send('owned');process.on('message',()=>process.exit(0));}
catch {process.send('refused',()=>process.exit(0));}`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    children.push(child); child.once('message', resolve); child.once('error', reject);
  });
  const results = await Promise.all([run(), run()]);
  assert.deepEqual(results.sort(), ['owned', 'refused']);
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = new Promise(resolve => child.once('close', resolve));
    if (child.connected) child.send('stop', () => {});
    await closed;
  }
});

function command(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/dex.mjs', ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Test CLI timed out')); }, 15000);
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// Real CLI, detached supervisor, HTTP control and shutdown. Chain/peer boundaries are inert;
// the one HTTP listener binds 127.0.0.1:0 and publishes its assigned port into this test's config.
test('detached CLI survives launcher exit, reports status/link, rejects unsafe stop and shuts down in order', { timeout: 25000 }, async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dex-process-'))), configFile = join(dir, 'trader.json');
  const bridgeToken = join(dir, 'bridge-test.token'), controlToken = join(dir, 'control-test.token');
  const config = { network: 'mainnet', role: 'trader', dataDir: join(dir, 'data'), servicePeerKey: 'cd'.repeat(32),
    proof: { zkey: join(dir, 'unused-proof') }, bridge: { url: 'ws://127.0.0.1:1', tokenFile: bridgeToken },
    control: { port: 1, tokenFile: controlToken }, dashboard: { port: 0 }, solana: {} };
  writeFileSync(configFile, JSON.stringify(config));
  writeFileSync(join(dir, 'peer.json'), JSON.stringify({ network: 'mainnet', role: 'trader', servicePeerKey: config.servicePeerKey, bridge: { port: 1, tokenFile: bridgeToken } }));
  writeFileSync(bridgeToken, 'ab'.repeat(32), { mode: 0o600 });
  const sources = {
    '/peer/scripts/pear-runner.mjs': `import {appendFileSync} from 'node:fs';
console.log('DEX_PEER_READY {}');
const stop=()=>{appendFileSync(${JSON.stringify(join(dir, 'order.txt'))},'peer\\n');process.exit(0)};
process.on('message',m=>{if(m.type==='dex-stop')stop()});process.on('disconnect',stop);`,
    '/src/net/bridge.js': `export class Bridge { async connect(){return this} async info(){return {info:{role:'trader',servicePeerKey:'${config.servicePeerKey}',networkProfile:${JSON.stringify(resolveNetwork(config))}}}} on(){} close(){} }`,
    '/src/proof/lockproof.js': 'export async function checkProofFiles(){} export async function verifyLock(){} export async function proveLock(){} export async function makeLockCertificate(){}',
    '/src/roles/trader.js': `import {appendFileSync} from 'node:fs'; export class Trader {
constructor(input){Object.assign(this,input);this.host={trades:new Map([['trade',{key:'synthetic-trade',role:'buyer',state:{phase:'locking'}}]])};this.mine=new Map()}
async start(){} stop(){appendFileSync(${JSON.stringify(join(dir, 'order.txt'))},'trader\\n')}
onlineSigners(){return ['synthetic-signer']} status(){return {me:this.me}} }`,
    '/src/solana/adapter.js': 'export function createSolanaAdapter(){return {walletBalances:async()=>({USDC:"0",SOL:"0"})}}',
    '/src/trac/adapter.js': 'export function createTracAdapter(){return {balances:async()=>({TNK:"0",RESET:"0",feeTnk:"30000000000000000"}),close(){}}}',
    '/src/dashboard/server.js': 'export const locksControlHandler=({fallback})=>fallback; export async function startDashboard(){return {url:"http://127.0.0.1:0/?t=synthetic-access"}}',
  };
  const loader = join(dir, 'boundaries.mjs');
  writeFileSync(loader, `import ${JSON.stringify(new URL('../../../src/wallets/manager.js', import.meta.url).href)};
import {registerHooks} from 'node:module'; import http from 'node:http'; import {readFileSync,writeFileSync} from 'node:fs';
const sources=${JSON.stringify(sources)};
registerHooks({load(url,context,next){const key=Object.keys(sources).find(k=>url.endsWith(k));return key?{format:'module',source:sources[key],shortCircuit:true}:next(url,context)}});
const listen=http.Server.prototype.listen;
http.Server.prototype.listen=function(port,host,callback){if(host!=='127.0.0.1')throw Error('nonlocal test listener');return listen.call(this,0,host,()=>{
const file=${JSON.stringify(configFile)},c=JSON.parse(readFileSync(file));c.control.port=this.address().port;writeFileSync(file,JSON.stringify(c));callback?.()})};`, { mode: 0o600 });
  const password = 'synthetic-process-password';
  const env = { ...process.env, DEX_KEY_PASSWORD: password, NODE_OPTIONS: `--import=${pathToFileURL(loader).href}` };
  t.after(async () => {
    const record = readLock(config.dataDir);
    if (record) {
      await command(['stop', '--force', '--config', configFile], env).catch(() => {});
      // Only test-owned PIDs, captured from this test's private lock.
      for (const pid of [record.traderPid, record.peerPid, record.pid]) if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const started = await command(['start', '--config', configFile], env);
  assert.equal(started.code, 0, started.stderr);
  assert.equal(started.stdout.match(/synthetic-access/g)?.length, 1);
  const record = readLock(config.dataDir);
  assert.ok(alive(record.pid) && alive(record.peerPid) && alive(record.traderPid));
  const second = await command(['start', '--config', configFile], env);
  assert.equal(second.code, 1); assert.match(second.stderr, /already running/);
  const status = await command(['status', '--config', configFile], env), info = JSON.parse(status.stdout);
  assert.equal(status.code, 0, status.stderr); assert.equal(info.running, true); assert.deepEqual(info.signers, ['synthetic-signer']);
  assert.match(info.dashboard, /synthetic-access/);
  const unauthorized = await fetch(`http://127.0.0.1:${JSON.parse(readFileSync(configFile)).control.port}/lifecycle/stop`, { method: 'POST', body: JSON.stringify({ id: record.id, force: true }) });
  assert.equal(unauthorized.status, 401);
  const refused = await command(['stop', '--config', configFile], env);
  assert.equal(refused.code, 1); assert.match(refused.stderr, /synthetic-trade \(locking\)/);
  const logs = await command(['logs', 'trader', '--config', configFile], env);
  assert.equal(logs.code, 0); assert.match(logs.stdout, /DEX_ROLE_READY/);
  assert.equal(logs.stdout.includes(password), false); assert.equal(logs.stdout.includes('synthetic-access'), false);
  const stopped = await command(['stop', '--force', '--config', configFile], env);
  assert.equal(stopped.code, 0, stopped.stderr); assert.equal(JSON.parse(stopped.stdout).stopped, true);
  assert.equal(readLock(config.dataDir), null); assert.equal(alive(record.traderPid), false); assert.equal(alive(record.peerPid), false);
  assert.equal(readFileSync(join(dir, 'order.txt'), 'utf8'), 'trader\npeer\n');
});
