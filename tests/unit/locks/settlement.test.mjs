import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { Clock, headerHash } from '../../../src/locks/clock.js';
import * as pay from '../../../src/locks/solana-pay.js';
import * as dkg from '../../../src/locks/dkg.js';
import * as trac from '../../../src/locks/trac-lock.js';
import { selectCommittee, validate } from '../../../src/locks/registry.js';
import { scalarSigner } from '../../../src/locks/crypto/scalar-sign.js';
import { fromLe32 } from '../../../src/core/canonical.js';
import { peerTransport, handleLocksJoin } from '../../../peer/features/locks-bridge.js';
import { dexTransport } from '../../../peer/features/dex-transport.js';
import { stack } from '../../integration/locks/harness.mjs';
import { identity, box, registry, sol, memoryStore } from './helpers.mjs';
const id='ab'.repeat(32),endpoints=['http://127.0.0.1:1/a','http://127.0.0.1:1/b'];

export function headers(times) {
  const rows=new Map(times.map((time,i)=>{const b=Buffer.alloc(80);b.writeUInt32LE(time,68);b.writeUInt32LE(i,76);return [100+i,{header:b.toString('hex'),hash:headerHash(b)}];}));
  return {rows,bridge:{call:async(type,{height})=>type==='locks_clock'?{counted:110,hash:rows.get(height)?.hash}:rows.get(height)}};
}

test('median time uses all eleven independently verified headers, with unordered timestamps',async()=>{
  const {rows,bridge}=headers([200,50,900,400,1,600,700,800,300,1000,500]),clock=new Clock({bridge});
  assert.equal(await clock.M(110),500);assert.equal(await clock.M(),500);
  rows.get(100).hash='00'.repeat(32);await assert.rejects(clock.M(110),/hash mismatch/);
  await assert.rejects(clock.M(9),/Eleven/);await assert.rejects(clock.M(111));
});

test('committee draw uses first finalized retained block and enforces operator minimum',async()=>{
  const keys=Array.from({length:9},()=>({identity:identity(),box:box()})),r=registry(keys);r.signers.slice(4).forEach(s=>s.group='external');
  const hash=sol(),calls=[];
  const rpc=async(_,method,params)=>{calls.push([method,params]);return ({getSlot:150,getFirstAvailableBlock:0,getBlocks:[133,134],getBlock:{blockhash:hash}})[method];};
  const draw=await pay.firstFinalizedBlockAtLeast(132,{endpoints,rpc});assert.equal(draw.slot,133);
  const a=selectCommittee(r,id,draw.blockhash);assert.equal(a.length,5);assert.ok(a.filter(s=>s.group==='operator').length>=3);
  assert.deepEqual(a,selectCommittee(r,'cd'.repeat(32),draw.blockhash));assert.throws(()=>selectCommittee(r,id));
  r.params.minOperatorSigners=5;assert.throws(()=>selectCommittee(r,id,draw.blockhash));
  r.params.minOperatorSigners=6;assert.throws(()=>validate(r));
  await assert.rejects(pay.firstFinalizedBlockAtLeast(151,{endpoints,rpc}),/not finalized/);
  await assert.rejects(pay.firstFinalizedBlockAtLeast(132,{endpoints,rpc:async(u,m,p)=>m==='getFirstAvailableBlock'?140:rpc(u,m,p)}),/quorum/);
  await assert.rejects(pay.firstFinalizedBlockAtLeast(132,{endpoints,rpc:async(u,m,p)=>m==='getBlocks'&&u===endpoints[1]?[134]:rpc(u,m,p)}),/quorum/);
  assert.ok(calls.filter(x=>x[0]==='getBlocks').every(x=>x[1][2].commitment==='finalized'));
});

test('deducted opening fee floors loans, caps option minimum, and memo exercise rejects all transfers',async()=>{
  const fee=registry().fee;assert.equal(pay.openingFee('1001','loan',fee),5n);assert.equal(pay.openingFee('1','put',fee),1n);
  assert.equal(pay.openingFee('1000000','call',fee),100000n);
  const payer=Keypair.generate(),input={payer:payer.publicKey.toBase58(),payee:sol(),amount:'0',fee:'100',collector:sol(),mint:sol(),memo:pay.memo(id,'open:'+'cd'.repeat(32))};
  const receiptOf=tx=>{tx.recentBlockhash=sol();tx.sign(payer);return {signature:bs58.encode(tx.signature),receipt:{slot:50,blockTime:1000,meta:{err:null},transaction:[tx.serialize().toString('base64'),'base64']}};};
  const paid=receiptOf(pay.build(input));assert.equal(pay.inspect(paid.receipt,{...input,signature:paid.signature}).ok,true);
  const exercise={...input,memo:pay.memo(id,'exercise'),memoOnly:true},proof=receiptOf(pay.buildExercise(exercise));
  assert.equal(pay.inspect(proof.receipt,{...exercise,signature:proof.signature}).memoOnly,true);
  assert.throws(()=>pay.inspect(proof.receipt,{...exercise,signature:proof.signature,beforeTime:1000}),/late/);
  const transfer=receiptOf(pay.build({...exercise,amount:'1',fee:'0'}));
  assert.throws(()=>pay.inspect(transfer.receipt,{...exercise,signature:transfer.signature}),/memo mismatch/);
  const queried=[];const rpc=async(_,method,params)=>{if(method==='getSignaturesForAddress')queried.push(params[0]);return method==='getFirstAvailableBlock'?0:method==='getTransaction'?proof.receipt:[{signature:proof.signature,slot:50,err:null,memo:null}];};
  assert.equal((await pay.scan({...exercise,endpoints,rpc,fromSlot:40})).payments.length,1);
  assert.deepEqual(new Set(queried),new Set([input.payer]));
});

test('TNK lock funding includes amount and reserve and sweeps one native transfer',async()=>{
  assert.equal(trac.funded({final:true,RESET:'0',TNK:'110'},{asset:'TNK',amount:'100',tnkReserve:'10'}),true);
  assert.equal(trac.funded({final:true,RESET:'1000',TNK:'109'},{asset:'TNK',amount:'100',tnkReserve:'10'}),false);
  const calls=[],adapter={balances:async()=>({RESET:'999',TNK:'110',feeTnk:'3'}),sendTransfer:async x=>{calls.push(x);return {ok:true};},withdrawalStatus:async()=>({ok:true})};
  await trac.sweep({a:99n,to:trac.address(scalarSigner(100n).publicKey),adapter,asset:'TNK',positionId:id,journal:memoryStore()});
  assert.deepEqual(calls.map(x=>[x.terms.base.id,x.terms.baseAmount]),[['TNK','107']]);
});

test('trader switch adds locks channels and preserves existing DEX policy and disabled defaults',async()=>{
  const config={role:'trader',servicePeerKey:id},old=dexTransport(config),combined=peerTransport({...config,locks:true});
  assert.deepEqual(peerTransport(config).sidechannel.channels,old.sidechannel.channels);
  for(const ch of old.sidechannel.channels)assert.ok(combined.sidechannel.channels.includes(ch));
  assert.ok(combined.sidechannel.powRequiredPrefixes.includes('intercom-locks:p:'));
  assert.deepEqual(combined.sidechannel.ownerKeys,old.sidechannel.ownerKeys);
  assert.deepEqual(combined.sidechannel.powLowKinds,old.sidechannel.powLowKinds);
  assert.deepEqual(combined.relay,old.relay);
  const replies=[],bridge={requireAuth:true,info:{role:'trader',locks:true},_broadcastToClient:(_,r)=>replies.push(r),sidechannel:{openChannels:new Set(),addChannel:async()=>true}};
  handleLocksJoin(bridge,{authed:true},{type:'locks_join',channel:'intercom-locks'});await Promise.resolve();assert.equal(replies[0].type,'joined');
});

for(const asset of ['RESET','TNK'])for(const exercised of [true,false])test(`put ${asset} ${exercised?'exercise then claim':'expiry'} releases independent E and H to opposite parties`,async t=>{
  const reserve='1000000000000000000',s=await stack({balanceRead:()=>({final:true,RESET:'100',TNK:(BigInt(reserve)+100n).toString(),feeTnk:'30'})});t.after(s.stop);
  const id=await s.post('put',asset),takeId=await s.take(id);await s.pay(id,'open:'+takeId);
  for(const signer of s.signers){const p=signer.positions.get(id);assert.equal(p.state,'running');assert.notEqual(p.lock.A,p.holders[takeId].lock.A);}
  if(exercised)await s.pay(id,'exercise',{blockTime:1999});s.chain.counted=120;
  for(const signer of s.signers)await signer.reconcile();await s.drain();
  if(exercised){
    assert.ok(s.signers.every(x=>!x.positions.get(id).holders[takeId].release));
    s.chain.escrowStatus='claimed';await s.emit(s.clients[1],'releaseRequest',{positionId:id,takeId});await s.drain();
  }
  for(const signer of s.signers){const p=signer.positions.get(id);assert.equal(p.release.winner,exercised?'taker':'maker');assert.equal(p.holders[takeId].release.winner,exercised?'maker':'taker');}
  for(const holder of [false,true]){
    const releases=s.sent.filter(x=>x.raw.kind==='release'&&!!x.raw.body.takeId===holder).slice(0,3).map(x=>x.raw.body);
    const target=s.clients[(holder?!exercised:exercised)?1:0];
    for(const b of releases)assert.equal(typeof fromLe32(dkg.openShare(b.sealed,target.box.secretKey,{positionId:id,...(holder?{takeId}:{}),from:b.j,to:target.identity.publicKey},'release')),'bigint');
  }
});

test('funded holder lock returns on unpaid lapse and can never be reused by a later take',async t=>{
  const s=await stack();t.after(s.stop);const id=await s.post('put'),first=await s.take(id);s.time.now=1601;
  for(const signer of s.signers)await signer.reconcile();await s.drain();
  assert.ok(s.signers.every(x=>x.positions.get(id).holders[first].release?.outcome==='unfunded'));
  const next=await s.take(id);assert.notEqual(next,first);
  for(const signer of s.signers)assert.notEqual(signer.positions.get(id).holders[first].lock.A,signer.positions.get(id).holders[next].lock.A);
  await s.pay(id,'open:'+first);assert.ok(s.signers.every(x=>x.positions.get(id).state==='posted'));
});

test('real verified median headers authorize early repayment and boundary equality, never a newer payment',async t=>{
  for(const blockTime of [1500,1501]){
    const h=headers([1000,1100,1200,1300,1400,1500,1600,1700,1800,1900,2000]),clock=new Clock({bridge:h.bridge});
    const s=await stack({clockAdapter:{counted:async()=>110,T:n=>clock.T(n),M:n=>clock.M(n)}});t.after(s.stop);
    s.chain.counted=110; // Loan take anchor follows the counted view.
    // Creation's offer must be beyond the clock; use a local adapter height until funded/taken.
    s.signers.forEach(x=>x.clock={counted:async()=>s.chain.counted,T:n=>clock.T(n)});s.chain.counted=100;
    const id=await s.post('loan','RESET',{termBlocks:20}),takeId=await s.take(id);await s.pay(id,'open:'+takeId);
    for(const signer of s.signers)signer.clock.M=n=>clock.M(n);
    s.chain.counted=110;await s.pay(id,'repay',{blockTime});
    assert.ok(s.signers.every(x=>!!x.positions.get(id).decision===(blockTime===1500)));
  }
});

test('venue credits only valid delivered Q shares, adjusts provisional split, freezes at seven days and exports unpaid credits',async t=>{
  const s=await stack();t.after(s.stop);const id=await s.post(),takeId=await s.take(id);await s.pay(id,'open:'+takeId);s.chain.counted=106;
  for(const signer of s.signers)await signer.reconcile();await s.drain();
  const records=s.sent.filter(x=>x.raw.kind==='release').map(x=>x.raw),target=s.clients[1];
  const receipt=async(m,bad=false)=>{const b=m.body,context={positionId:id,from:b.j,to:target.identity.publicKey};
    await s.emit(target,'releaseReceipt',{positionId:id,j:b.j,releaseHash:dkg.releaseDigest(m),key:bad?'ff'.repeat(32):dkg.releaseReceiptKey(b.sealed,target.box.secretKey,context)});await s.drain();};
  await assert.rejects(receipt(records[0],true));s.pending.length=0;
  assert.deepEqual(s.venue.signerCredits(),{});
  await receipt(records[0]);assert.equal(s.venue.signerCredits()[records[0].from][0].amount,'2');
  await receipt(records[1]);assert.equal(s.venue.signerCredits()[records[0].from][0].amount,'1');
  await assert.rejects(s.venue.markPaid(records[0].from,[id]));
  s.time.now+=7*86400;assert.equal(s.venue.signerCredits()[records[0].from][0].final,true);
  await receipt(records[2]);assert.equal(s.venue.signerCredits()[records[2].from],undefined);
  assert.equal((await s.venue.markPaid(records[0].from,[id])).amount,'1');await assert.rejects(s.venue.markPaid(records[0].from,[id]));
});

for(const product of ['loan','call'])test(`${product} TNK uses its asset limit and deducted opening payment`,async t=>{
  const s=await stack({balanceRead:()=>({final:true,RESET:'0',TNK:'1000000000000000100',feeTnk:'30'})});t.after(s.stop);
  const id=await s.post(product,'TNK'),takeId=await s.take(id),p=s.signers[0].positions.get(id),args=s.signers[0].paymentArgs(p,'open:'+takeId);
  assert.equal(BigInt(args.amount)+BigInt(args.fee),BigInt(p.post.terms.principal??p.post.terms.premium));
  await s.pay(id,'open:'+takeId);s.chain.counted=product==='loan'?106:120;
  for(const signer of s.signers)await signer.reconcile();await s.drain();assert.ok(s.signers.every(x=>x.positions.get(id).decision));
});

test('put opening requires final holder funding, surplus reserve, and a timely funded observation',async t=>{
  let tnk='1000000000000000000';const s=await stack({balanceRead:()=>({final:true,RESET:'0',TNK:tnk,feeTnk:'30'})});t.after(s.stop);
  const id=await s.post('put','TNK'),takeId=await s.take(id);await s.pay(id,'open:'+takeId);
  assert.ok(s.signers.every(x=>x.positions.get(id).state==='posted'));
  tnk='1000000000000000100';await s.emit(s.clients[1],'funded',{positionId:id,takeId});await s.drain();await s.pay(id,'open:'+takeId);
  assert.ok(s.signers.every(x=>x.positions.get(id).state==='running'));
});

test('signers reject escrow mismatch, short recovery window, paused assets and oversized TNK',async t=>{
  const s=await stack({escrowAdapter:{config:async()=>({platformFeeBps:10,tradeFeeBps:0,platformCollector:sol()}),verify:async()=>({ok:false})}});t.after(s.stop);
  const id=await s.post('put');assert.ok(s.signers.every(x=>x.positions.get(id).state==='funding'));
  await s.emit(s.clients[0],'funded',{positionId:id,escrow:{refundAfter:1001}});await s.drain();assert.ok(s.signers.every(x=>x.positions.get(id).state==='funding'));
  const signer=s.signers[0],post=structuredClone(signer.positions.get(id).post),r=structuredClone(s.r);
  const {sha256Hex,stableJSON}=await import('../../../src/core/canonical.js');
  r.assets.RESET='paused';assert.throws(()=>signer.validatePost(post,sha256Hex(stableJSON(post)),r,100),/Asset/);
  r.assets.RESET='open';post.terms.asset='TNK';post.terms.amount=(BigInt(r.limits.TNK.max)+1n).toString();assert.throws(()=>signer.validatePost(post,sha256Hex(stableJSON(post)),r,100),/limits/);
});

test('a fee-only opening is discovered without any maker ATA transfer',async()=>{
  const payer=Keypair.generate(),input={payer:payer.publicKey.toBase58(),payee:sol(),amount:'0',fee:'100',collector:sol(),mint:sol(),memo:pay.memo(id,'open:'+'cd'.repeat(32))};
  const tx=pay.build(input);tx.recentBlockhash=sol();tx.sign(payer);
  const signature=bs58.encode(tx.signature),receipt={slot:50,blockTime:1000,meta:{err:null},transaction:[tx.serialize().toString('base64'),'base64']};
  const rpc=async(_,method,params)=>{
    if(method==='getSignaturesForAddress'){assert.equal(params[0],input.payer);return [{signature,slot:50,err:null,memo:null}];}
    return method==='getFirstAvailableBlock'?0:receipt;
  };
  assert.equal((await pay.scan({...input,endpoints,rpc,fromSlot:40})).payments[0].signature,signature);
  assert.notEqual(trac.fundingNonce(id,'TNK','cd'.repeat(32)),trac.fundingNonce(id,'TNK','ef'.repeat(32)));
});

test('book filters TNK and a proven early payment releases even when history scanning is unavailable',async t=>{
  const s=await stack({balanceRead:()=>({final:true,RESET:'100',TNK:'1000000000000000100',feeTnk:'30'})});t.after(s.stop);
  await s.post('loan');const id=await s.post('loan','TNK');
  await s.emit(s.clients[0],'bookRequest',{asset:'TNK'});await s.drain();
  const rows=s.sent.filter(x=>x.raw.kind==='book').at(-1).raw.body.positions;assert.deepEqual(rows.map(x=>x.positionId),[id]);
  const takeId=await s.take(id);await s.pay(id,'open:'+takeId);
  for(const signer of s.signers){signer.clock.M=async()=>1500;signer.payments.scan=async()=>{throw Error('history unavailable');};}
  await s.pay(id,'repay',{blockTime:1500});assert.ok(s.signers.every(x=>x.positions.get(id).decision?.outcome==='repaid'));
});

test('aggregate exposure includes TNK reserves for RESET and both cash and asset locks for puts',async t=>{
  const s=await stack();t.after(s.stop);await s.post('loan');const put=await s.post('put');await s.take(put);
  const totals=s.signers[0].lockedTotals();assert.equal(totals.RESET,200n);assert.equal(totals.TNK,2000000000000000000n);assert.equal(totals.USDC,1000n);
  s.signers.forEach(x=>x.registry.current.limits.totalLocked.TNK='2000000000000000000');
  await assert.rejects(s.post('call'),/exposure limit/);
});
