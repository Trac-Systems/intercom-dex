import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveNetwork } from '../../../src/net/profile.js';
import { fixture } from '../core/helpers.mjs';
import { createKeyring } from '../../../src/roles/keyring.js';
import { PublicKey } from '@solana/web3.js';

test('fee CLI dispatches validated requests to authenticated loopback control; platform always requires --yes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fee-cli-')), configFile = join(dir, 'role.json'), tokenFile = join(dir, 'control.token'), loader = join(dir, 'boundary.mjs');
  const config = { role: 'service', control: { port: 12345, tokenFile } };
  writeFileSync(configFile, JSON.stringify(config)); writeFileSync(tokenFile, 'synthetic-token', { mode: 0o600 });
  writeFileSync(loader, `globalThis.fetch = async (url, request) => {
    if (new URL(url).hostname !== '127.0.0.1' || request.headers.authorization !== 'Bearer synthetic-token') throw Error('bad authentication or host');
    return new Response(JSON.stringify({route:new URL(url).pathname,method:request.method,body:JSON.parse(request.body)}));
  };`);
  const run = (...args) => spawnSync(process.execPath, ['--import', loader, 'bin/dex.mjs', ...args, '--config', configFile], { encoding: 'utf8', timeout: 15000 });
  const set = run('fee', 'set', '--trade-fee', '0.75', '--signer-share', '60'); assert.equal(set.status, 0, set.stderr);
  assert.deepEqual(JSON.parse(set.stdout), { route: '/fee/set', method: 'POST', body: { tradeFee: '0.75', signerShare: '60' } });
  assert.equal(run('fee', 'set', '--signer-share', '60').status, 0);
  for (const args of [['fee', 'set'], ['fee', 'set', '--trade-fee', '10.01'], ['fee', 'set', '--signer-share', '100.01'], ['fee', 'set', '--yes'], ['fee', 'platform', '--bps', '501', '--yes', '--authority-keypair', '/unused']]) assert.notEqual(run(...args).status, 0);
  const gated = run('fee', 'platform', '--bps', '30', '--authority-keypair', '/unused');
  assert.notEqual(gated.status, 0); assert.match(gated.stderr, /platform fee changed, take again/); assert.match(gated.stderr, /Pass --yes/); assert.equal(gated.stdout, '');
  const platform = run('fee', 'platform', '--bps', '30', '--authority-keypair', '/unused', '--yes');
  assert.equal(platform.status, 0, platform.stderr); assert.match(platform.stderr, /global platform fee/);
  assert.deepEqual(JSON.parse(platform.stdout), { route: '/fee/platform', method: 'POST', body: { bps: 30, authorityKeypair: '/unused', yes: true } });
  writeFileSync(configFile, JSON.stringify({ ...config, role: 'trader' }));
  const wrongRole = run('fee', 'set', '--trade-fee', '0.75'); assert.notEqual(wrongRole.status, 0); assert.match(wrongRole.stderr, /service only/);
});

test('running service control authenticates fee routes; the same dispatch is absent for traders', async () => {
  for (const role of ['service', 'trader']) {
    const dir = mkdtempSync(join(tmpdir(), 'fee-routes-')), tokenFile = join(dir, 'token'), configFile = join(dir, 'role.json');
    const pub = await createKeyring(join(dir, 'keyring.json'), 'synthetic-route-password', { withSolana: true });
    const config = { role, network: 'mainnet', dataDir: dir, servicePeerKey: 'cd'.repeat(32), proof: { zkey: join(dir, 'unused') },
      bridge: { url: 'ws://127.0.0.1:1', tokenFile }, control: { port: 12345, tokenFile }, solana: {},
      registry: { ...fixture().registry, fee: { platformFeeBps: 10, tradeFeeBps: 50, signerShareBps: 5000, collector: new PublicKey(Buffer.from(pub.solana, 'hex')).toBase58() } } };
    writeFileSync(configFile, JSON.stringify(config)); writeFileSync(tokenFile, 'ab'.repeat(32), { mode: 0o600 });
    const sources = {
      '/src/net/bridge.js': `export class Bridge { async connect(){return this} async info(){return {info:{role:'${role}',servicePeerKey:'${'cd'.repeat(32)}',peerPubkey:'${'cd'.repeat(32)}',networkProfile:${JSON.stringify(resolveNetwork(config))}}}} on(){} close(){} }`,
      '/src/proof/lockproof.js': 'export async function checkProofFiles(){} export async function verifyLock(){} export async function proveLock(){} export async function makeLockCertificate(){}',
      '/src/roles/service.js': `export class Service {constructor(input){Object.assign(this,input);this.registry=input.registryInput;this.host={trades:new Map()}} async start(){} stop(){} status(){return {}} async publishFees(fee){return this.registry={...this.registry,version:this.registry.version+1,fee}}}`,
      '/src/roles/trader.js': 'export class Trader {constructor(input){Object.assign(this,input);this.host={trades:new Map()};this.mine=new Map()} async start(){} stop(){} status(){return {}}}',
      '/src/solana/adapter.js': 'export function createSolanaAdapter(){return {assertFeeConfig:async()=>{},walletBalances:async()=>({USDC:"0",SOL:"0"})}}',
      '/src/trac/adapter.js': 'export function createTracAdapter(){return {balances:async()=>({TNK:"0",RESET:"0",feeTnk:"30000000000000000"}),close(){}}}',
    };
    const loader = join(dir, 'boundaries.mjs');
    writeFileSync(loader, `import '${new URL('../../../src/wallets/manager.js', import.meta.url).href}';
import {registerHooks,syncBuiltinESMExports} from 'node:module';
import http from 'node:http'; import {EventEmitter} from 'node:events';
const sources=${JSON.stringify(sources)};
registerHooks({load(url,context,next){const key=Object.keys(sources).find(k=>url.endsWith(k));return key?{format:'module',source:sources[key],shortCircuit:true}:next(url,context)}});
http.createServer=handler=>({listen(port,host){if(host!=='127.0.0.1')throw Error('nonlocal'); setImmediate(async()=>{
for(const [url,authorized,body] of [['/fee/set',false,{signerShare:'60'}],['/fee/set',true,{signerShare:'60'}],['/fee/platform',true,{bps:30,yes:false}]])await new Promise(resolve=>{
 const req=new EventEmitter();Object.assign(req,{method:'POST',url,headers:{authorization:authorized?'Bearer ${'ab'.repeat(32)}':'Bearer wrong'}});
 let code;handler(req,{writeHead(c){code=c},end(text){console.log('FEE_CONTROL '+JSON.stringify({code,body:JSON.parse(text)}));resolve()}});req.emit('data',JSON.stringify(body));req.emit('end');
});process.exit(0)});return this}});syncBuiltinESMExports();`);
    const result = spawnSync(process.execPath, ['--import', loader, 'bin/dex.mjs', '--config', configFile], {
      env: { ...process.env, DEX_KEY_PASSWORD: 'synthetic-route-password' }, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    const rows = result.stdout.split('\n').filter(s => s.startsWith('FEE_CONTROL ')).map(s => JSON.parse(s.slice(12)));
    assert.equal(rows[0].code, 401);
    assert.equal(rows[1].code, role === 'service' ? 200 : 404);
    assert.equal(rows[2].code, role === 'service' ? 400 : 404);
    if (role === 'service') { assert.equal(rows[1].body.fee.signerShareBps, 6000); assert.match(rows[2].body.error, /--yes/); }
  }
});
