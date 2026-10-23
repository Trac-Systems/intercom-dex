import test from 'node:test';
import assert from 'node:assert/strict';
import * as dkg from '../../../src/locks/dkg.js';
import { reconstruct, publicOf } from '../../../src/locks/crypto/edvss.js';
import { fromLe32, hexToBytes, le32 } from '../../../src/core/canonical.js';
import { box, identity } from './helpers.mjs';
const positionId='ab'.repeat(32);
export function fixture() {
  const keys=Array.from({length:5},()=>({box:box(),identity:identity()}));
  const committee=keys.map(k=>({boxKey:k.box.publicKey,lockKey:k.identity.publicKey}));
  const deals=keys.map((_,i)=>dkg.deal({positionId,i:i+1,committee,k:3}));
  const states=keys.map((key,i)=>dkg.create({positionId,committee,k:3,j:i+1,boxSecret:key.box.secretKey,ownDeal:deals[i],chain:'trac',now:1000}));
  return {keys,committee,deals,states};
}
function receive(s,b,committee,now=1001) {return dkg.step(s,{now,message:{kind:'dkgDeal',from:committee[b.i-1].lockKey,body:b}});}

test('five independent dealers generate identical ready only after durable persistence and any three reconstruct',()=>{
  const {committee,deals,states}=fixture(),ready=[],shares=[];
  for(let state of states) {
    const before=structuredClone(state);
    assert.equal(dkg.step(state,{type:'resume',now:1000}).actions[0].kind,'dkgDeal');
    assert.deepEqual(state,before);
    for(const deal of [...deals].reverse()) state=receive(state,deal,committee).state;
    assert.equal(state.phase,'persisting');
    assert.equal(dkg.step(state,{type:'persisted',positionId,ok:false,now:1001}).actions.length,0);
    const result=dkg.step(state,{type:'persisted',positionId,ok:true,now:1001});
    assert.equal(result.state.phase,'ready'); assert.equal(result.actions[0].kind,'lockReady');
    ready.push({kind:'lockReady',from:committee[state.j-1].lockKey,body:result.actions[0].body});
    shares.push({id:state.j,share:fromLe32(hexToBytes(state.share,32))});
  }
  assert.equal(dkg.identicalReady(ready.slice(0,3),committee,positionId),null);
  const lock=dkg.identicalReady(ready,committee,positionId),a=reconstruct(shares.slice(1,4),3,lock.C);
  assert.equal(publicOf(a),lock.A);
  const conflict=structuredClone(ready); conflict[0].body.A='cc'.repeat(32);
  assert.throws(()=>dkg.identicalReady(conflict,committee,positionId));
});

test('cheating dealer, wrong AAD, spoofed dealer and missing dealer fail safely',()=>{
  const {keys,committee,deals,states}=fixture(),bad=structuredClone(deals[1]);
  bad.sealed[0]=dkg.sealShare(le32(1n),keys[0].box.publicKey,{positionId,from:2,to:1});
  assert.equal(receive(states[0],bad,committee).state.phase,'failed');
  assert.throws(()=>dkg.openShare(bad.sealed[0],keys[0].box.secretKey,{positionId,from:3,to:1}));
  assert.throws(()=>dkg.openShare(bad.sealed[0],keys[0].box.secretKey,{positionId,from:2,to:1},'release'));
  const spoof=dkg.step(states[0],{now:1001,message:{kind:'dkgDeal',from:committee[0].lockKey,body:deals[1]}});
  assert.equal(Object.keys(spoof.state.deals).length,0);
  let state=states[0]; for(const deal of deals.slice(0,3)) state=receive(state,deal,committee).state;
  const expired=dkg.step(state,{type:'timeout',now:1120}); assert.equal(expired.state.phase,'failed');
  assert.equal(expired.actions[0].kind,'dkgFail');
  assert.equal(receive(expired.state,deals[4],committee,1121).state.phase,'failed');
});

test('n minus one qualified dealers reconstruct with a late member; altered pickup and cross-lock shares fail',()=>{
  const {keys,committee,deals,states}=fixture(),ready=[],shares=[];
  for(let state of states.slice(0,4)){
    for(const b of deals.slice(0,4))state=receive(state,b,committee).state;
    assert.equal(state.phase,'dealing');state=dkg.step(state,{type:'timeout',now:1120}).state;
    assert.deepEqual(state.Q,[1,2,3,4]);
    const r=dkg.step(state,{type:'persisted',positionId,ok:true,now:1120});
    ready.push({kind:'lockReady',from:committee[state.j-1].lockKey,body:r.actions[0].body});
    shares.push({id:state.j,share:fromLe32(hexToBytes(state.share,32))});
  }
  const messages=deals.slice(0,4).map(b=>({kind:'dkgDeal',from:committee[b.i-1].lockKey,body:b}));
  const late=dkg.step(states[4],{type:'recover',now:1130,ready,deals:messages});assert.equal(late.state.phase,'persisting');
  assert.equal(dkg.step(late.state,{type:'persisted',positionId,ok:false,now:1130}).actions.length,0);
  assert.equal(publicOf(reconstruct([shares[0],shares[1],{id:5,share:fromLe32(hexToBytes(late.state.share,32))}],3,late.state.C)),late.state.A);
  const bad=structuredClone(messages);bad[0].body.sealed[4].ciphertext='ff'.repeat(48);
  assert.throws(()=>dkg.step(states[4],{type:'recover',now:1130,ready,deals:bad}));
  const alternate=structuredClone(ready);alternate[0].body.Q=[1,2,3,5];assert.throws(()=>dkg.identicalReady(alternate,committee,positionId));
  const takeId='cd'.repeat(32),holder=dkg.deal({positionId,takeId,i:1,committee,k:3});
  assert.throws(()=>dkg.openShare(holder.sealed[0],keys[0].box.secretKey,{positionId,from:1,to:1}));
  assert.equal(dkg.openShare(holder.sealed[0],keys[0].box.secretKey,{positionId,takeId,from:1,to:1}).length,32);
});
