import test from 'node:test';
import assert from 'node:assert/strict';
import { LockSigner } from '../../../src/roles/lock-signer.js';
import { channel } from '../../../src/locks/transport.js';
import * as dkg from '../../../src/locks/dkg.js';
import { reconstruct, publicOf } from '../../../src/locks/crypto/edvss.js';
import { fromLe32 } from '../../../src/core/canonical.js';
import { stack } from '../../integration/locks/harness.mjs';

async function exercise(s,asset='RESET') {
  const id=await s.post('put',asset),takeId=await s.take(id);await s.pay(id,'open:'+takeId);
  for(const signer of s.signers)signer.clock.M=async()=>1500;
  await s.pay(id,'exercise',{blockTime:1500});
  assert.ok(s.signers.every(x=>x.positions.get(id).release?.winner==='taker'&&!x.positions.get(id).holders[takeId].release));
  return {id,takeId};
}
async function receipt(s,m) {
  const b=m.body,target=s.clients[b.winner==='maker'?0:1],ref={positionId:b.positionId,...(b.takeId?{takeId:b.takeId}:{})};
  await s.emit(target,'releaseReceipt',{...ref,j:b.j,releaseHash:dkg.releaseDigest(m),
    key:dkg.releaseReceiptKey(b.sealed,target.box.secretKey,{...ref,from:b.j,to:target.identity.publicKey})});await s.drain();
}
async function restore(s,signer,t) {
  signer.stop();signer.bridge.active=false;
  const bridge=s.bridge(),copy=new LockSigner({bridge,identity:signer.identity,box:signer.box,store:signer.store,serviceKey:signer.serviceKey,
    profile:signer.profile,products:signer.products,clock:signer.clock,payments:signer.payments,escrow:signer.escrow,now:()=>s.time.now,log:()=>{}});
  bridge.role=copy;await copy.start();t.after(()=>copy.stop());return copy;
}

test('E is published before settlement reads even when both readers are unavailable',async t=>{
  const s=await stack();t.after(s.stop);let reads=0;
  for(const signer of s.signers)signer.escrow={...signer.escrow,settlement:async()=>{
    assert.ok(s.sent.some(x=>x.raw.kind==='release'&&x.raw.from===signer.identity.publicKey&&!x.raw.body.takeId));
    reads++;throw Error('readers unavailable');
  }};
  await exercise(s);assert.equal(reads,5);
});

for(const asset of ['RESET','TNK'])test(`exercised ${asset} returns H to holder after finalized refund, without changing E`,async t=>{
  const s=await stack({balanceRead:()=>({final:true,RESET:'100',TNK:'1000000000000000100',feeTnk:'30'})});t.after(s.stop);
  const {id,takeId}=await exercise(s,asset),before=s.signers.map(x=>x.positions.get(id).release);
  assert.equal(s.signers[0].lockedTotals()[asset],asset==='TNK'?1000000000000000100n:100n);
  assert.equal(s.signers[0].lockedTotals().USDC,0n);
  s.chain.escrowStatus='refunded';await s.emit(s.clients[1],'releaseRequest',{positionId:id,takeId});await s.drain();
  for(const [i,signer]of s.signers.entries()){
    const p=signer.positions.get(id);assert.deepEqual(p.release,before[i]);
    assert.deepEqual(p.holders[takeId].decision,{winner:'taker',outcome:'exercised',escrowStatus:'refunded'});
    assert.equal(signer.lockedTotals()[asset],0n);assert.equal(signer.bridge.channels.has(channel(id)),false);
  }
  const target=s.clients[1],releases=s.sent.filter(x=>x.raw.kind==='release'&&x.raw.body.takeId===takeId).map(x=>x.raw.body);
  const shares=releases.slice(0,3).map(b=>({id:b.j,share:fromLe32(dkg.openShare(b.sealed,target.box.secretKey,
    {positionId:id,takeId,from:b.j,to:target.identity.publicKey},'release'))}));
  assert.equal(publicOf(reconstruct(shares,3,releases[0].C)),releases[0].A);
  s.chain.escrowStatus='claimed';s.time.now+=600;
  await s.emit(s.clients[0],'releaseRequest',{positionId:id});await s.drain();
  assert.ok(s.signers.every(x=>x.positions.get(id).holders[takeId].release.winner==='taker'));
});

test('pending H survives restart, throttles tick reads including errors, and authenticates explicit requests',async t=>{
  const s=await stack();t.after(s.stop);const {id,takeId}=await exercise(s);
  let reads=0,status='active';s.signers[0].escrow.settlement=async()=>{reads++;if(status==='error')throw Error('readers unavailable');return {ok:status!=='disagree',status};};
  const signer=await restore(s,s.signers[0],t);
  assert.ok(signer.bridge.channels.has(channel(id)));
  await signer.reconcile();s.time.now+=599;await signer.reconcile();assert.equal(reads,0);
  s.time.now++;status='error';await signer.reconcile();assert.equal(reads,1);
  for(let i=0;i<3;i++)await signer.reconcile();assert.equal(reads,1);
  const again=await restore(s,signer,t);await again.reconcile();assert.equal(reads,1);
  await again.release(structuredClone(again.positions.get(id)),'ff'.repeat(32));assert.equal(reads,1);
  status='disagree';await again.release(structuredClone(again.positions.get(id)),s.clients[1].identity.publicKey);
  assert.equal(reads,2);assert.equal(again.positions.get(id).holders[takeId].release,undefined);
  s.time.now+=60;status='claimed';await again.release(structuredClone(again.positions.get(id)),s.clients[1].identity.publicKey);
  assert.equal(reads,3);const release=again.positions.get(id).holders[takeId].release;assert.equal(release.winner,'maker');
  const final=await restore(s,again,t);s.time.now+=600;status='refunded';await final.reconcile();
  await final.release(structuredClone(final.positions.get(id)),s.clients[0].identity.publicKey);
  assert.equal(reads,3);assert.deepEqual(final.positions.get(id).holders[takeId].release,release);
});

test('H decision is saved before its ciphertext leaves and a failed write can be retried',async t=>{
  const s=await stack();t.after(s.stop);const {id,takeId}=await exercise(s),signer=s.signers[0],put=signer.store.put;
  s.chain.escrowStatus='claimed';signer.store.put=(k,v)=>{if(v.holders?.[takeId]?.release)throw Error('fsync failed');return put(k,v);};
  await assert.rejects(signer.settleHolder(structuredClone(signer.positions.get(id))),/fsync/);
  assert.equal(signer.positions.get(id).holders[takeId].decision,undefined);
  assert.equal(s.sent.filter(x=>x.raw.kind==='release'&&x.raw.body.takeId===takeId).length,0);
  signer.store.put=put;s.chain.escrowStatus='refunded';await signer.settleHolder(structuredClone(signer.positions.get(id)));
  assert.equal(signer.store.get('locks-position-'+id).holders[takeId].decision.escrowStatus,'refunded');
  assert.equal(s.sent.filter(x=>x.raw.kind==='release'&&x.raw.body.takeId===takeId).length,1);
});

test('a primary claim receipt rechecks H on the active channel before the next tick',async t=>{
  const s=await stack();t.after(s.stop);const {id,takeId}=await exercise(s);s.chain.escrowStatus='claimed';
  const releases=s.sent.filter(x=>x.raw.kind==='release'&&!x.raw.body.takeId).map(x=>x.raw);
  for(const m of releases)await receipt(s,m);
  assert.ok(s.signers.every(x=>x.positions.get(id).holders[takeId].release?.winner==='maker'));
});

for(const status of ['claimed','refunded'])test(`put credits wait for both release quorums and give ${status} H a full seven-day window`,async t=>{
  const s=await stack();t.after(s.stop);const {id,takeId}=await exercise(s),firstEnd=s.venue.positions.get(id).endedAt;
  const primary=s.sent.filter(x=>x.raw.kind==='release'&&!x.raw.body.takeId).map(x=>x.raw);
  s.time.now+=8*86400;s.venue.finalizeCredits();assert.equal(s.venue.positions.get(id).creditsFinal,undefined);
  await receipt(s,primary[0]);await receipt(s,primary[1]);assert.deepEqual(s.venue.signerCredits(),{});
  s.chain.escrowStatus=status;
  for(const signer of s.signers.slice(0,2))await signer.settleHolder(structuredClone(signer.positions.get(id)));await s.drain();
  assert.equal(s.venue.positions.get(id).settledAt,undefined);
  const partial=s.sent.filter(x=>x.raw.kind==='release'&&x.raw.body.takeId===takeId).map(x=>x.raw);
  for(const m of partial)await receipt(s,m);assert.deepEqual(s.venue.signerCredits(),{});
  for(const signer of s.signers.slice(2))await signer.settleHolder(structuredClone(signer.positions.get(id)));await s.drain();
  const p=s.venue.positions.get(id);assert.equal(p.holderWinner,status==='claimed'?'maker':'taker');
  assert.equal(p.settledAt,s.time.now);assert.ok(p.settledAt>firstEnd+7*86400);
  const row=s.venue.signerCredits()[primary[0].from][0];assert.equal(row.amount,'20');assert.equal(row.final,false);
  assert.equal(row.payableAfter,p.settledAt+7*86400);
  await assert.rejects(s.venue.markPaid(primary[0].from,[id]));
  s.time.now+=7*86400-1;assert.equal(s.venue.signerCredits()[primary[0].from][0].final,false);
  s.time.now++;assert.equal(s.venue.signerCredits()[primary[0].from][0].final,true);
  await receipt(s,primary[2]);await receipt(s,s.sent.find(x=>x.raw.kind==='release'&&x.raw.body.takeId===takeId&&x.raw.from===primary[2].from).raw);
  assert.equal(s.venue.signerCredits()[primary[2].from],undefined);
  assert.equal((await s.venue.markPaid(primary[0].from,[id])).amount,'20');
  const legacy=structuredClone(s.venue.positions.get(id));delete legacy.settledAt;s.venue.save(legacy);
  assert.equal(s.venue.signerCredits()[primary[0].from][0].payableAfter,legacy.endedAt+7*86400);
});
