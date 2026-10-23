import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLocksHandlers, handleLocksJoin, locksTransport } from '../../../peer/features/locks-bridge.js';
import { headerHash } from '../../../src/locks/clock.js';
import { address } from '../../../src/locks/trac-lock.js';
import { publicOf } from '../../../src/locks/crypto/edvss.js';

test('bridge reads only the signed RESET view and verifies applied headers against counted hash',async()=>{
  const h=Buffer.alloc(80);h.writeUInt32LE(1000,68);const hash=headerHash(h),bootstrap='ab'.repeat(32),A=publicOf(42n);let closes=0;
  const rows=new Map([['beacon/state',{counted:10}],['hash/10',hash],['msgl',2],['msg/0',{msg:'invalid'}],['msg/1',{msg:JSON.stringify({t:'header',p:{hx:[h.toString('hex')]}})}],['bal/'+A,'42']]);
  const peer={base:{key:Buffer.from(bootstrap,'hex'),view:{core:{signedLength:123},checkout(n){assert.equal(n,123);return {version:123,get:async k=>rows.has(k)?{value:rows.get(k),seq:7}:null,close:async()=>{closes++;}};}}}};
  const bus={state:{getNodeEntry:async()=>null,getFee:()=>Buffer.alloc(16)}};
  const handlers=makeLocksHandlers({bus,config:{trac:{reset:{bootstrap}}},resetPeer:peer});
  assert.deepEqual(await handlers.locks_clock({height:10}),{counted:10,hash,signedLength:123});
  assert.equal((await handlers.locks_header({height:10,hash})).header,h.toString('hex'));
  assert.equal((await handlers.locks_balances({address:address(A)})).RESET,'42');assert.equal(closes,3);
  await assert.rejects(handlers.locks_header({height:10,hash:'cc'.repeat(32)}));assert.equal(closes,4);
});

test('locks joins require authenticated dedicated peers and keep separate proof-of-work channels',async()=>{
  const replies=[],bridge={requireAuth:true,info:{role:'trader'},_broadcastToClient:(_,r)=>replies.push(r),sidechannel:{openChannels:new Set(),addChannel:async()=>true}};
  assert.equal(handleLocksJoin(bridge,{authed:false},{type:'locks_join',channel:'intercom-locks',id:1}),true);assert.match(replies.pop().error,/Unauthorized/);
  handleLocksJoin(bridge,{authed:true},{type:'locks_join',channel:'intercom-locks'});assert.match(replies.pop().error,/dedicated/);
  bridge.info.role='lock-signer';handleLocksJoin(bridge,{authed:true},{type:'locks_join',channel:'intercom-locks'});await Promise.resolve();assert.equal(replies.pop().type,'joined');
  const transport=locksTransport({role:'lock-venue',servicePeerKey:'ab'.repeat(32)});assert.deepEqual(transport.sidechannel.channels,['intercom-locks']);assert.equal(transport.sidechannel.powDifficulty,20);
});
