import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { LockSigner } from '../../../src/roles/lock-signer.js';
import { openStore } from '../../../src/roles/store.js';
import { MAIN, seal, receiver, HEARTBEAT_MS } from '../../../src/locks/transport.js';
import { sealShare } from '../../../src/locks/dkg.js';
import { le32 } from '../../../src/core/canonical.js';
import { identity, box, registry, memoryStore } from './helpers.mjs';

test('locks store encrypts shares; durable release throttle survives restarts without channel rejoin',async t=>{
  const area=resolve('.test-tmp/locks-unit');mkdirSync(area,{recursive:true});const dir=mkdtempSync(join(area,'store-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const key=randomBytes(32),store=openStore(dir,key),id='ab'.repeat(32),maker=identity(),recipient=box(),signer=identity(),ownBox=box();
  const share='91'.repeat(32),sealed=sealShare(le32(123n),recipient.publicKey,{positionId:id,from:1,to:maker.publicKey},'release');
  const record={positionId:id,state:'ended:cancelled',post:{maker:{lockKey:maker.publicKey}},requests:{},decision:{winner:'maker',outcome:'cancelled'},
    lock:{share},release:{positionId:id,j:1,winner:'maker',outcome:'cancelled',A:'cc'.repeat(32),C:['cc'.repeat(32)],sealed}};
  store.put('locks-position-'+id,record);
  assert.equal(readdirSync(join(dir,'records')).some(f=>readFileSync(join(dir,'records',f)).includes(Buffer.from(share))),false);
  let now=1000;const make=()=>{const bridge=new EventEmitter(),sent=[],joined=[];
    bridge.join=async c=>joined.push(c);bridge.leave=async()=>{};bridge.send=async(c,m)=>sent.push(m);
    const role=new LockSigner({bridge,identity:signer,box:ownBox,store:openStore(dir,key),serviceKey:'dd'.repeat(32),profile:{},products:{},now:()=>now,log:()=>{}});
    return {role,sent,joined};};
  const a=make();await a.role.start();assert.deepEqual(a.joined,[MAIN]);assert.equal(HEARTBEAT_MS,30000);
  const request=()=>seal({kind:'releaseRequest',ch:MAIN,body:{positionId:id}},maker.secretKey,{ts:now});
  await a.role.handle(MAIN,request());assert.equal(a.sent.filter(m=>m.kind==='release').length,1);a.role.stop();
  const b=make();await b.role.start();t.after(()=>b.role.stop());assert.deepEqual(b.joined,[MAIN]);
  await b.role.handle(MAIN,request());assert.equal(b.sent.length,0);
  now+=60;const put=b.role.store.put;b.role.store.put=()=>{throw Error('fsync failed');};
  await assert.rejects(b.role.handle(MAIN,request()),/fsync/);assert.equal(b.sent.length,0);
  b.role.store.put=put;await b.role.handle(MAIN,request());assert.equal(b.sent.filter(m=>m.kind==='release').length,1);
});

test('locks receiver rejects signature tampering, extra keys, replay and DEX domain',()=>{
  const key=identity(),m=seal({kind:'releaseRequest',ch:MAIN,body:{positionId:'ab'.repeat(32)}},key.secretKey,{ts:1000}),read=receiver(()=>1000);
  assert.ok(read(m));assert.equal(read(m),null);assert.equal(read({...m,extra:true}),null);
  assert.equal(read({...m,body:{positionId:'cc'.repeat(32)}}),null);assert.equal(read({...m,ch:'intercom-dex'}),null);
});
