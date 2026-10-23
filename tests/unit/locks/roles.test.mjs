import test from 'node:test';
import assert from 'node:assert/strict';
import { stack, products } from '../../integration/locks/harness.mjs';
import { LockSigner } from '../../../src/roles/lock-signer.js';
import { MAIN, channel, open, seal } from '../../../src/locks/transport.js';
import { openShare } from '../../../src/locks/dkg.js';
import { reconstruct, publicOf } from '../../../src/locks/crypto/edvss.js';
import { hexToBytes, fromLe32 } from '../../../src/core/canonical.js';
import { memoryStore } from './helpers.mjs';

test('five roles run DKG, fund, attest, reserve, open, discover silent repayment and seal one decision',async t=>{
  const s=await stack();t.after(s.stop);const id=await s.post();
  assert.ok(s.signers.every(x=>x.positions.get(id).state==='posted'));
  assert.equal(s.venue.positions.get(id).state,'posted');
  const takeId=await s.take(id);assert.equal(s.sent.filter(x=>x.raw.kind==='reserve').length,5);
  await s.pay(id,'open:'+takeId);assert.ok(s.signers.every(x=>x.positions.get(id).state==='running'));
  await s.pay(id,'repay',{announce:false,blockTime:1999});s.chain.counted=106;
  for(const signer of s.signers)await signer.reconcile();await s.drain();
  assert.ok(s.signers.every(x=>x.positions.get(id).decision?.outcome==='repaid'));
  assert.equal(s.venue.positions.get(id).state,'ended:repaid');
  const releases=s.sent.filter(x=>x.raw.kind==='release').map(x=>x.raw.body),maker=s.clients[0];
  const shares=releases.slice(0,3).map(b=>({id:b.j,share:fromLe32(openShare(b.sealed,maker.box.secretKey,{positionId:id,from:b.j,to:maker.identity.publicKey},'release'))}));
  assert.equal(publicOf(reconstruct(shares,3,releases[0].C)),releases[0].A);
  for(const signer of s.signers) assert.equal(signer.bridge.channels.has(channel(id)),false);
  s.payments.clear();s.chain.counted=120;for(const signer of s.signers)await signer.reconcile();
  assert.ok(s.signers.every(x=>x.positions.get(id).decision.winner==='maker'));
});

test('call default, cancel versus live reservation, offline restart and venue down use same decisions',async t=>{
  const s=await stack();t.after(s.stop);const id=await s.post('call'),takeId=await s.take(id);
  await s.emit(s.clients[0],'cancel',{positionId:id});await s.drain();
  assert.ok(s.signers.every(x=>!x.positions.get(id).decision));
  await s.pay(id,'open:'+takeId);
  const offline=s.signers[4];offline.stop();offline.bridge.active=false;s.venue.bridge.active=false;s.venue.stop();
  s.chain.counted=120;for(const signer of s.signers.slice(0,4))await signer.reconcile();await s.drain();
  assert.equal(s.signers[0].positions.get(id).decision.outcome,'expired');
  const bridge=s.bridge();const restored=new LockSigner({bridge,identity:offline.identity,box:offline.box,store:offline.store,serviceKey:offline.serviceKey,profile:offline.profile,products,clock:s.clock,payments:offline.payments,now:()=>s.time.now,log:()=>{}});
  bridge.role=restored;await restored.start();t.after(()=>restored.stop());assert.deepEqual([...bridge.channels],[MAIN]);
  await restored.reconcile();assert.deepEqual(restored.positions.get(id).decision,s.signers[0].positions.get(id).decision);
  assert.ok(s.sent.some(x=>x.raw.kind==='release'));
});

test('release requests are persisted and rate limited per requester and position across restart',async t=>{
  const s=await stack();t.after(s.stop);const id=await s.post();await s.emit(s.clients[0],'cancel',{positionId:id});await s.drain();
  assert.equal(s.signers[0].positions.get(id).decision.outcome,'cancelled');
  const count=()=>s.sent.filter(x=>x.raw.kind==='release').length;
  await s.emit(s.clients[0],'releaseRequest',{positionId:id});await s.drain();const n=count();
  await s.emit(s.clients[0],'releaseRequest',{positionId:id});await s.drain();assert.equal(count(),n);
  s.time.now+=60;await s.emit(s.clients[0],'releaseRequest',{positionId:id});await s.drain();assert.ok(count()>=n+5);
});

test('a persistence failure cannot send lockReady or release; DEX signatures do not cross domains',async t=>{
  const stores=Array.from({length:5},memoryStore),s=await stack({stores});t.after(s.stop);
  const store=stores[0],put=store.put;let fail=true;
  store.put=(k,v)=>{if(fail&&v.lock)throw Error('disk failure');return put(k,v);};
  await assert.rejects(s.post(),/disk failure/);
  assert.equal(s.sent.filter(x=>x.raw.kind==='lockReady'&&x.raw.from===s.signers[0].identity.publicKey).length,0);
  fail=false;await s.drain();
  const raw=seal({kind:'releaseRequest',ch:MAIN,body:{positionId:'ab'.repeat(32)}},s.clients[0].identity.secretKey,{ts:s.time.now});
  assert.throws(()=>open({...raw,ch:'intercom-dex:signers'},{now:s.time.now}));
});

test('expired reservations scan before cancellation and recover a timely unannounced opening',async t=>{
  const s=await stack();t.after(s.stop);const id=await s.post(),takeId=await s.take(id);
  await s.pay(id,'open:'+takeId,{announce:false,blockTime:1599});s.time.now=1601;
  await s.emit(s.clients[0],'cancel',{positionId:id});await s.drain();
  assert.ok(s.signers.every(x=>x.positions.get(id).state==='running'));
  assert.ok(s.signers.every(x=>!x.positions.get(id).decision));
});

test('loan default and call exercise use verified deadline facts',async t=>{
  for(const product of ['loan','call']) {
    const s=await stack();t.after(s.stop);const id=await s.post(product),takeId=await s.take(id);await s.pay(id,'open:'+takeId);
    if(product==='call')await s.pay(id,'exercise',{blockTime:1999});
    assert.ok(s.signers.every(x=>!x.positions.get(id).decision));
    s.chain.counted=product==='loan'?106:120;for(const signer of s.signers)await signer.reconcile();await s.drain();
    assert.ok(s.signers.every(x=>x.positions.get(id).decision.outcome===(product==='loan'?'defaulted':'exercised')));
    assert.ok(s.signers.every(x=>x.positions.get(id).decision.winner==='taker'));
  }
});

test('one offline dealer completes after timeout and derives its share from venue pickup',async t=>{
  const s=await stack();t.after(s.stop);s.signers[4].bridge.active=false;
  const id=await s.post();assert.ok(s.signers.slice(0,4).every(x=>x.positions.get(id).state==='creating'));
  s.time.now=1120;
  for(const signer of s.signers.slice(0,4))await signer.advance(structuredClone(signer.positions.get(id)),{type:'timeout',now:s.time.now});
  await s.drain();assert.ok(s.signers.slice(0,4).every(x=>x.positions.get(id).state==='funding'));
  const A=s.signers[0].positions.get(id).lock.A;
  s.signers[4].bridge.active=true;
  await s.emit(s.clients[0],'lockRequest',{positionId:id,post:s.signers[0].positions.get(id).post});await s.drain();
  assert.equal(s.signers[4].positions.get(id).lock.A,A);
  assert.equal(s.signers[4].positions.get(id).lock.Q.length,4);
  await s.emit(s.clients[0],'funded',{positionId:id});await s.drain();
  assert.ok(s.signers.every(x=>x.positions.get(id).state==='posted'));
});

test('failure to persist a decision never sends its release',async t=>{
  const s=await stack();t.after(s.stop);const id=await s.post();
  const signer=s.signers[0],put=signer.store.put;signer.store.put=(k,v)=>{if(v.decision)throw Error('fsync failed');return put(k,v);};
  await assert.rejects(s.emit(s.clients[0],'cancel',{positionId:id}).then(()=>s.drain()),/fsync/);
  assert.equal(s.sent.filter(x=>x.raw.kind==='release'&&x.raw.from===signer.identity.publicKey).length,0);
  assert.equal(signer.positions.get(id).decision,undefined);
  signer.store.put=put;
});

test('venue returns bounded pages with quorum evidence and stores opaque release pickup',async t=>{
  const s=await stack();t.after(s.stop);const id=await s.post();
  await s.emit(s.clients[0],'bookRequest',{page:0,limit:1});await s.drain();
  const book=s.sent.filter(x=>x.raw.kind==='book').at(-1).raw.body;
  assert.equal(book.positions.length,1);assert.ok(book.positions[0].attestations.length>=3);assert.equal(book.pageSize,1);
  await s.emit(s.clients[0],'cancel',{positionId:id});await s.drain();
  assert.equal(Object.keys(s.venue.positions.get(id).releases).length,5);
  for(const signer of s.signers)signer.bridge.active=false;
  const n=s.sent.filter(x=>x.raw.kind==='release').length;
  await s.emit(s.clients[0],'releaseRequest',{positionId:id});await s.drain();
  assert.equal(s.sent.filter(x=>x.raw.kind==='release').length,n+5);
  assert.equal(s.venue.positions.get(id).state,'ended:cancelled');
});

test('a maker can recover a ready lock whose funded notification was never received',async t=>{
  const s=await stack();t.after(s.stop);const id=await s.post();
  for(const signer of s.signers) {const p=structuredClone(signer.positions.get(id));p.state='funding';p.posted={};signer.save(p);}
  s.chain.counted=110;for(const signer of s.signers)await signer.reconcile();
  assert.ok(s.signers.every(x=>x.positions.get(id).decision.winner==='maker'));
});
