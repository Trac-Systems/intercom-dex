import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startLocalDevnet } from '../trac/local-devnet.mjs';
import { resetSourceURL } from '../../reset-source.mjs';
import { Bridge } from '../../../src/net/bridge.js';
import { Clock } from '../../../src/locks/clock.js';
import * as trac from '../../../src/locks/trac-lock.js';
import { scalarSigner } from '../../../src/locks/crypto/scalar-sign.js';
import { createTracAdapter } from '../../../src/trac/adapter.js';
import { openStore } from '../../../src/roles/store.js';
import { MAIN, join as joinLocks, seal } from '../../../src/locks/transport.js';
import { identity, sol } from '../../unit/locks/helpers.mjs';

async function port() {const s=net.createServer();await new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',r);});const n=s.address().port;await new Promise(r=>s.close(r));return n;}
async function until(fn,label,ms=90000) {const end=Date.now()+ms;let error;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch(e){error=e;}await delay(200);}throw Error(label+': '+(error?.message??'timeout'));}
async function peer(config,root) {
  const file=join(root,'peer.json');await writeFile(file,JSON.stringify(config));
  const child=spawn(process.execPath,['scripts/pear-runner.mjs','--config',file],{cwd:resolve('peer'),env:{...process.env,PEAR_RUNNER_STDIN:'0',DEX_LEGACY_PEAR_RUN:'0',XDG_CONFIG_HOME:join(root,'pear-config'),XDG_DATA_HOME:join(root,'pear-data')},stdio:['ignore','pipe','pipe']});
  let log='',buffer='',info,error,finished=false;
  const exited=new Promise(r=>{child.once('exit',(code,signal)=>{finished=true;error??=Error(`Peer exited ${code??signal}`);r();});child.once('error',e=>{finished=true;error=e;r();});});
  child.stdout.on('data',b=>{log+=b;buffer+=b;let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(line.startsWith('DEX_PEER_READY '))info=JSON.parse(line.slice(15));}});child.stderr.on('data',b=>{log+=b;});
  const close=async()=>{if(!finished)child.kill('SIGTERM');const kill=setTimeout(()=>{if(!finished)child.kill('SIGKILL');},5000);await exited;clearTimeout(kill);await writeFile(join(root,'peer.log'),log);};
  try {await until(()=>{if(error)throw error;return info;},'locks peer startup',150000);return {info,close};}catch(e){await close();throw e;}
}

test('local RESET devnet: trader locks switch, median headers, RESET and TNK sweeps', {timeout:480000},async t=>{
  const area=resolve('.test-tmp/trac/locks');await mkdir(area,{recursive:true});const root=await mkdtemp(join(area,'run-'));
  let network,p,bridge,adapter;
  try {
    await port();network=await startLocalDevnet(root);
    assert.ok(network.manifest.dhtBootstrap.every(x=>x.startsWith('127.0.0.1:')));
    const {beaconOptions}=await import(resetSourceURL('tests/helpers/chain.mjs'));
    const bridgePort=await port(),token=randomBytes(32).toString('hex'),tokenFile=join(root,'bridge.token');await writeFile(tokenFile,token,{mode:0o600});
    const config={role:'trader',locks:true,servicePeerKey:randomBytes(32).toString('hex'),network:'local',mint:sol(),platformCollector:sol(),
      environment:'development',msbNetworkId:network.validator.config.networkId,msbBootstrap:network.manifest.msbBootstrap,msbChannel:'local-foundation-msb',
      msbDhtBootstrap:network.manifest.dhtBootstrap,peerDhtBootstrap:network.manifest.dhtBootstrap,storeDirectory:join(root,'locks-peer'),
      subnetChannel:'locks-local-smoke',validatorKey:network.validator.wallet.publicKey.toString('hex'),bridge:{port:bridgePort,tokenFile},
      trac:{reset:{bootstrap:network.manifest.indexer.subnetBootstrap,channel:'local-foundation-subnet',dhtBootstrap:network.manifest.dhtBootstrap,beaconOptions}}};
    p=await peer(config,root);bridge=await new Bridge({url:p.info.bridge,token,timeoutMs:60000}).connect();
    const clock=new Clock({bridge}),counted=await until(async()=>{const n=await clock.counted();return n>0?n:null;},'counted blocks');
    assert.equal(typeof await clock.hash(counted),'string');assert.ok(await clock.T(counted)>0);
    await network.pauseMining();
    for(let i=0;i<20&&(await clock.counted())<12;i++)await network.mineOne();
    await until(async()=>await clock.counted()>=12,'eleven counted headers');
    const medianHeight=await clock.counted(),times=await Promise.all(Array.from({length:11},(_,i)=>clock.T(medianHeight-10+i)));
    assert.equal(await clock.M(medianHeight),times.sort((a,b)=>a-b)[5]);
    const page=await bridge.call('locks_headers',{cursor:0,limit:1000});assert.ok(page.rows.length>0);
    await joinLocks(bridge,MAIN);const who=identity();await bridge.send(MAIN,seal({kind:'releaseRequest',ch:MAIN,body:{positionId:'ab'.repeat(32)}},who.secretKey));
    const a=123456789n,wallet=scalarSigner(a);wallet.address=trac.address(wallet.publicKey);const to=trac.address(scalarSigner(987654321n).publicKey);
    await network.local.fund(network.validator,{address:wallet.address},1000000000000000000n);await network.gift(wallet.publicKey,'100');
    await until(async()=>{const b=await trac.balances({A:wallet.publicKey,bridge});return b.RESET==='100'&&BigInt(b.TNK)>0n;},'lock funding');
    adapter=createTracAdapter({bridge,wallet,resetGatewayUrl:network.manifest.gateways[0].gatewayUrl,intentFolder:join(root,'sweep-intents')});
    const journal=openStore(join(root,'sweep'),randomBytes(32)),positionId=randomBytes(32).toString('hex');
    await until(async()=>{const r=await trac.sweep({a,to,adapter,positionId,journal});if(!r.ok&&!r.pending)throw Error(r.reason);return r.ok;},'scalar sweep',120000);
    const after=await trac.balances({A:wallet.publicKey,bridge});assert.equal(after.RESET,'0');assert.equal(after.TNK,'0');
    const received=await bridge.call('locks_balances',{address:to});assert.equal(received.RESET,'100');assert.equal(received.TNK,'940000000000000000');
    const native=scalarSigner(432198765n);native.address=trac.address(native.publicKey);
    await network.local.fund(network.validator,{address:native.address},1000000000000000000n);
    await until(async()=>trac.funded(await trac.balances({A:native.publicKey,bridge}),{asset:'TNK',amount:'100000000000000000',tnkReserve:'900000000000000000'}),'TNK lock funding');
    adapter.close();adapter=createTracAdapter({bridge,wallet:native,resetGatewayUrl:network.manifest.gateways[0].gatewayUrl,intentFolder:join(root,'native-intents')});
    const nativeId=randomBytes(32).toString('hex'),nativeJournal=openStore(join(root,'native-sweep'),randomBytes(32));
    await until(async()=>{const r=await trac.sweep({a:432198765n,to,adapter,asset:'TNK',positionId:nativeId,journal:nativeJournal});return r.ok;},'TNK sweep',120000);
    assert.equal((await trac.balances({A:native.publicKey,bridge})).TNK,'0');
    assert.equal((await bridge.call('locks_balances',{address:to})).TNK,'1910000000000000000');
    t.diagnostic('Artifacts: '+root);
  } finally {adapter?.close();bridge?.close();try{await p?.close();}finally{await network?.close();}}
});
