import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { PublicKey, Keypair, Transaction, SystemProgram } from '@solana/web3.js';
import * as v from '../../../src/locks/crypto/edvss.js';
import { scalarSigner } from '../../../src/locks/crypto/scalar-sign.js';
import * as escrow from '../../../src/locks/escrow-lock.js';
import * as trac from '../../../src/locks/trac-lock.js';
import { buildTnkTransfer, buildResetTransfer } from '../../../src/trac/transfers.js';
import { Clock, headerHash, headerTime } from '../../../src/locks/clock.js';
import { validate, selectCommittee, RegistryView } from '../../../src/locks/registry.js';
import { buildInitInstruction } from '../../../src/solana/escrow.js';
import { registry, sol, memoryStore } from './helpers.mjs';
const h = 'ab'.repeat(32);

test('ed25519 Feldman verifies, aggregates, reconstructs; invalid shares and degenerate points fail', () => {
  const ids = [1,2,3,4,5], a = v.split(42n, 3, ids), b = v.split(99n, 3, ids), C = v.aggregate([a.commitments,b.commitments]);
  const shares = a.shares.map((p,i) => ({ id:p.id, share:(p.share+b.shares[i].share)%v.SCALAR_ORDER }));
  assert.equal(v.reconstruct(shares,3,C),141n);
  assert.equal(v.reconstruct([shares[4],shares[1],shares[3]],3,C),141n);
  assert.equal(C[0], Buffer.from(ed25519.Point.BASE.multiply(141n).toBytes()).toString('hex'));
  for(const p of shares) assert.ok(v.verifyShare(p.id,p.share,C));
  assert.throws(()=>v.reconstruct([{...shares[0],share:1n},...shares.slice(1)],3,C));
  assert.throws(()=>v.reconstruct([shares[0],shares[0],shares[1]],3,C));
  assert.throws(()=>v.reconstruct(shares.slice(0,2),3,C));
  assert.equal(v.verifyShare(1,v.SCALAR_ORDER,C),false);
  assert.equal(v.validateCommitments(['00'.repeat(32)]),false);
  assert.equal(v.validateCommitments(['01'+'00'.repeat(31)]),false);
  assert.throws(()=>v.aggregate([v.split(1n,1,[1]).commitments,v.split(v.SCALAR_ORDER-1n,1,[1]).commitments]));
});

test('scalar signatures verify with noble, Solana addSignature, and both Trac builders', async () => {
  const a = 123456n, s = scalarSigner(a), msg = Buffer.from('locks vector');
  assert.equal(s.sign(msg),s.sign(msg));
  assert.ok(ed25519.verify(Buffer.from(s.sign(msg),'hex'),msg,Buffer.from(s.publicKey,'hex')));
  assert.equal(ed25519.verify(Buffer.from(s.sign(msg),'hex'),Buffer.from('other'),Buffer.from(s.publicKey,'hex')),false);
  assert.throws(()=>scalarSigner(0n)); assert.throws(()=>scalarSigner(v.SCALAR_ORDER));
  const pk = new PublicKey(Buffer.from(s.publicKey,'hex')), tx = new Transaction({ feePayer:pk,recentBlockhash:sol() });
  tx.add(SystemProgram.transfer({fromPubkey:pk,toPubkey:new PublicKey(sol()),lamports:1}));
  tx.addSignature(pk,Buffer.from(s.sign(tx.serializeMessage()),'hex')); assert.ok(tx.verifySignatures());
  const to = trac.address(v.publicOf(5n)), common={networkId:1,txv:h,tradeId:h,amount:'1',sign:s.sign};
  assert.equal((await buildTnkTransfer({...common,from:trac.address(s.publicKey),to})).type,13);
  assert.equal((await buildResetTransfer({...common,from:s.publicKey,to:v.publicOf(5n),writer:h,subnet:h,msb:h})).payload.type,12);
});

test('escrow init and atomic claim, sweep, close use scalar key and winner fee payer', () => {
  const a=99n, winner=Keypair.generate(), mint=sol(), collector=sol();
  const args=escrow.initArgs({A:v.publicOf(a),escrowPreimage:h,payer:sol(),mint,amount:'100',now:1000,counted:10,expiryBlock:20,recoveryMarginSec:700,
    expectedPlatformFeeBps:10,expectedTradeFeeBps:0,tradeFeeCollector:collector});
  assert.equal(args.refundAfter,7700); assert.equal(args.paymentHashHex,escrow.hash(h));
  assert.equal(buildInitInstruction(args).data[0],0);
  const tx=escrow.claimAndSweep({a,escrowPreimage:h,winnerSol:winner.publicKey,mint,amount:'100',existingBalance:'3',tradeFeeCollector:collector,recentBlockhash:sol()});
  assert.equal(tx.instructions.length,5); assert.equal(tx.instructions[2].data[0],1);
  assert.equal(tx.instructions[3].data.readBigUInt64LE(1),103n); assert.equal(tx.instructions[4].data[0],9);
  tx.partialSign(winner); assert.ok(tx.verifySignatures());
  assert.throws(()=>escrow.initArgs({...args,a,H:h}));
});

test('clock only accepts counted heights and correctly hashed 80-byte headers', async () => {
  const header=Buffer.alloc(80); header.writeUInt32LE(12345,68); const hash=headerHash(header);
  const bridge={call:async(type,p)=>type==='locks_clock'?{counted:20,hash}: {header:header.toString('hex')}};
  const c=new Clock({bridge}); assert.equal(await c.counted(),20); assert.equal(await c.T(20),12345);
  assert.throws(()=>headerTime(header,h)); await assert.rejects(c.T(21));
  assert.throws(()=>headerHash(Buffer.alloc(79)));
  const fallback=new Clock({bridge:{call:async type=>type==='locks_clock'?{counted:20,hash}:{}},fetchHeader:async()=>header});
  assert.equal(await fallback.T(20),12345);
});

test('registry validation, deterministic draws, pinned acceptance, snapshots and equivocation', () => {
  const r=registry(); validate(r); assert.deepEqual(selectCommittee(r,h),selectCommittee(r,h));
  for(const change of [r=>r.params.k=2,r=>r.params.n=17,r=>r.params.termBlocks.min=5,r=>r.fee.loanBps=1001,
    r=>r.limits.USDC.min='999999999999999999',r=>r.signers[1].boxKey=r.signers[0].boxKey,r=>r.params.payMarginSec=600]) {
    const x=structuredClone(r); change(x); assert.throws(()=>validate(x));
  }
  const store=memoryStore(), view=new RegistryView(h,store), offer=body=>({kind:'registry',from:h,body});
  assert.equal(view.offer({...offer(r),from:'cc'.repeat(32)},1000),false);
  assert.equal(view.offer(offer({...r,issuedAt:1061}),1000),false);
  assert.ok(view.offer(offer(r),1000)); assert.ok(view.offer(offer({...r,version:2}),1000));
  assert.equal(new RegistryView(h,store).snapshot(1).version,1);
  assert.equal(view.offer(offer({...r,issuedAt:999}),1000),false); assert.equal(view.usable,null);
});

test('Trac sweep waits for final RESET before TNK and keeps retry amounts stable', async () => {
  const journal=memoryStore(), calls=[], to=trac.address(v.publicOf(9n)); let final=false;
  const adapter={balances:async()=>({RESET:'100',TNK:'1000',feeTnk:'30'}),sendTransfer:async r=>{calls.push(r);return {ok:true};},
    withdrawalStatus:async()=>({ok:final,txHash:h})};
  const input={a:42n,to,adapter,positionId:h,journal,now:()=>1000};
  assert.equal((await trac.sweep(input)).pending,true); assert.equal(calls.length,1);
  final=true; assert.equal((await trac.sweep(input)).ok,true);
  assert.deepEqual(calls.map(r=>r.terms.base.id),['RESET','RESET','TNK']); assert.equal(calls[2].terms.baseAmount,'970');
  assert.equal((await trac.sweep(input)).ok,true); assert.equal(calls.length,3);
  assert.notEqual(trac.fundingNonce(h,'RESET'),trac.fundingNonce(h,'TNK'));
  await assert.rejects(trac.balances({A:v.publicOf(42n),adapter}));
});

test('escrow verifier requires public preimage and zero-fee matching finalized escrow and vault', async t => {
  const { wireAccount, wireVault, key, terms }=await import('../solana/vectors.mjs');
  const { deriveEscrowPda, deriveVaultAta }=await import('../../../src/solana/escrow.js');
  const endpoints=['http://127.0.0.1:1/a','http://127.0.0.1:1/b'],H=escrow.hash(h),pda=deriveEscrowPda(H),vault=deriveVaultAta(pda.pda,terms.mint);
  const account=wireAccount(),data=Buffer.from(account.data[0],'base64');
  // Existing escrow layout: rewrite the hash, zero trade fee, derived vault and bump.
  data.set(Buffer.from(H,'hex'),2);data.writeBigUInt64LE(0n,188);data.writeUInt16LE(0,196);data.set(vault.toBuffer(),230);data[262]=pda.bump;
  account.data=[data.toString('base64'),'base64'];
  const token=wireVault(),td=Buffer.from(token.data[0],'base64');td.set(pda.pda.toBuffer(),32);token.data=[td.toString('base64'),'base64'];
  let secondAccount,missing=false,unavailable=false;
  t.mock.method(globalThis,'fetch',async(url,req)=>{
    const body=JSON.parse(req.body);assert.equal(body.params[1].commitment,'finalized');
    if(unavailable&&String(url)===endpoints[1])throw Error('reader unavailable');
    const value=body.params[0]===pda.pda.toBase58()?(missing?null:String(url)===endpoints[1]&&secondAccount?secondAccount:account):token;
    return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result:{context:{slot:100},value}}));
  });
  const input={A:key(3).toBuffer().toString('hex'),escrowPreimage:h,payer:terms.buyer.solPayer,amount:terms.quoteAmount,mint:terms.mint,refundAfter:terms.refundAfter,
    platformFeeBps:10,tradeFeeBps:0,platformCollector:key(6).toBase58(),escrowCollector:key(5).toBase58(),endpoints};
  const good=await escrow.verify(input);assert.equal(good.ok,true,JSON.stringify(good.reasons));
  assert.equal((await escrow.verify({...input,amount:'1'})).ok,false);
  assert.equal((await escrow.verify({...input,A:v.publicOf(9n)})).ok,false);
  assert.equal((await escrow.verify({...input,H:'ff'.repeat(32)})).ok,false);
  assert.equal((await escrow.verify({...input,tradeFeeBps:50})).ok,false);
  await assert.rejects(escrow.verify({...input,need:0}));
  assert.equal((await escrow.settlement(input)).status,'active');
  data[1]=1;for(const offset of [138,146,188])data.writeBigUInt64LE(0n,offset);
  account.data=[data.toString('base64'),'base64'];td.writeBigUInt64LE(0n,64);token.data=[td.toString('base64'),'base64'];
  const claimed=await escrow.settlement(input);assert.equal(claimed.status,'claimed');assert.equal(claimed.reads.escrow.agreeing.length,2);
  assert.equal((await escrow.verify(input)).ok,false);
  secondAccount=structuredClone(account);data[1]=2;account.data=[data.toString('base64'),'base64'];
  assert.equal((await escrow.settlement(input)).status,null); // Claim/refund disagreement cannot decide H.
  secondAccount=null;assert.equal((await escrow.settlement(input)).status,'refunded');
  for(const change of [{A:v.publicOf(9n)},{payer:sol()},{mint:sol()},{refundAfter:input.refundAfter+1},{escrowCollector:sol()},{H:'ff'.repeat(32)}]){
    assert.equal((await escrow.settlement({...input,...change})).status,null);
  }
  missing=true;assert.equal((await escrow.settlement(input)).status,null);missing=false;
  unavailable=true;assert.equal((await escrow.settlement(input)).status,null);unavailable=false;
  await assert.rejects(escrow.settlement({...input,need:0}));
  await assert.rejects(escrow.settlement({...input,endpoints:undefined}));
  const owner=account.owner;account.owner=sol();assert.equal((await escrow.settlement(input)).status,null);account.owner=owner;
  data.writeBigUInt64LE(1n,138);account.data=[data.toString('base64'),'base64'];assert.equal((await escrow.settlement(input)).status,null);
  data.writeBigUInt64LE(0n,138);data[1]=3;account.data=[data.toString('base64'),'base64'];assert.equal((await escrow.settlement(input)).status,null);
});
