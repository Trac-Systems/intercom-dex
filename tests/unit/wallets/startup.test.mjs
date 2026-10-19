import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveNetwork } from '../../../src/net/profile.js';

// Run the production entrypoint with chain/proof/transport boundaries stubbed.
// Key creation, encrypted files, wallet manager and HTTP request dispatch remain real.
test('role entrypoint automatically creates wallets and serves safe wallet/status responses on first start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'first-start-')), file = join(dir, 'role.json'), tokenFile = join(dir, 'token');
  const config = { network: 'mainnet', role: 'trader', dataDir: join(dir, 'data'), keyPasswordEnv: 'STARTUP_TEST_PASSWORD', servicePeerKey: 'cd'.repeat(32),
    proof: { zkey: join(dir, 'unused-proof') }, bridge: { url: 'ws://127.0.0.1:1', tokenFile }, control: { port: 12345, tokenFile }, solana: {} };
  writeFileSync(file, JSON.stringify(config)); writeFileSync(tokenFile, 'abababababababababababababababababababababababababababababababab', { mode: 0o600 });
  const sources = {
    '/src/net/bridge.js': `export class Bridge { async connect(){return this} async info(){return {info:{role:'trader',servicePeerKey:'${'cd'.repeat(32)}',networkProfile:${JSON.stringify(resolveNetwork(config))}}}} on(){} close(){} }`,
    '/src/proof/lockproof.js': 'export async function checkProofFiles(){} export async function verifyLock(){} export async function proveLock(){} export async function makeLockCertificate(){}',
    '/src/roles/trader.js': 'export class Trader { constructor(input){Object.assign(this,input);this.host={trades:new Map()};this.mine=new Map()} async start(){} stop(){} status(){return {me:this.me}} }',
    '/src/solana/adapter.js': 'export function createSolanaAdapter(){return {walletBalances:async()=>({USDC:"0",SOL:"0"})}}',
    '/src/trac/adapter.js': 'export function createTracAdapter(){return {balances:async()=>({TNK:"0",RESET:"0",feeTnk:"30000000000000000"}),close(){}}}',
  };
  const loader = join(dir, 'boundaries.mjs');
  writeFileSync(loader, `import '${new URL('../../../src/wallets/manager.js', import.meta.url).href}';
import {registerHooks,syncBuiltinESMExports} from 'node:module';
import http from 'node:http'; import {EventEmitter} from 'node:events';
const sources=${JSON.stringify(sources)};
registerHooks({load(url,context,next){const key=Object.keys(sources).find(k=>url.endsWith(k));return key?{format:'module',source:sources[key],shortCircuit:true}:next(url,context)}});
http.createServer=handler=>({listen(port,host){if(host!=='127.0.0.1')throw Error('nonlocal'); setImmediate(async()=>{
for(const url of ['/wallets','/status','/export'])await new Promise(resolve=>{const req=new EventEmitter();Object.assign(req,{method:'GET',url,headers:{authorization:'Bearer abababababababababababababababababababababababababababababababab'}});let code;handler(req,{writeHead(c){code=c},end(text){console.log('TEST_CONTROL '+JSON.stringify({url,code,body:JSON.parse(text)}));resolve()}});req.emit('end')});process.exit(0)});return this}});
syncBuiltinESMExports();`, { mode: 0o600 });
  const run = () => spawnSync(process.execPath, ['--import', loader, 'bin/dex.mjs', '--config', file], {
    env: { ...process.env, STARTUP_TEST_PASSWORD: 'synthetic-startup-password' }, encoding: 'utf8', timeout: 30000 });
  const first = run(); assert.equal(first.status, 0, first.stderr);
  const rows = first.stdout.split('\n').filter(s => s.startsWith('TEST_CONTROL ')).map(s => JSON.parse(s.slice(13)));
  const info = rows[0].body;
  assert.equal(rows[0].code, 200); assert.match(info.addresses.trac, /^trac1/); assert.ok(info.addresses.solana);
  assert.equal(info.storage.passwordEnv, 'STARTUP_TEST_PASSWORD'); assert.equal(info.balances.SOL.free, '0');
  assert.deepEqual(rows[1].body.wallets.addresses, info.addresses); assert.equal(rows[2].code, 404);
  assert.ok(!first.stdout.includes('synthetic-startup-password')); assert.ok(!first.stdout.includes('mnemonic:'));
  assert.ok(!first.stderr.includes('shown once'));
  const before = ['keyring.json','trac-wallet.json'].map(n=>readFileSync(join(config.dataDir,n)));
  const second = run(); assert.equal(second.status, 0, second.stderr);
  ['keyring.json','trac-wallet.json'].forEach((name,i)=>assert.ok(before[i].equals(readFileSync(join(config.dataDir,name)))));
});
