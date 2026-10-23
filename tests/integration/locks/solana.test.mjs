import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { getAccount } from '@solana/spl-token';
import { startValidator, setupMarket, send, balance, chainTime, LOCAL_RPC } from '../solana/harness.mjs';
import * as pay from '../../../src/locks/solana-pay.js';
import * as escrow from '../../../src/locks/escrow-lock.js';
import { stack } from './harness.mjs';
import { Clock, headerHash } from '../../../src/locks/clock.js';
import { openShare } from '../../../src/locks/dkg.js';
import { fromLe32 } from '../../../src/core/canonical.js';
import { publicOf, reconstruct } from '../../../src/locks/crypto/edvss.js';
import { buildInitInstruction, buildRefundInstruction, buildInitTradeConfigInstruction, deriveVaultAta } from '../../../src/solana/escrow.js';
const endpoints=[LOCAL_RPC,LOCAL_RPC.replace('127.0.0.1','localhost')];
async function finalized(connection,signature) {
  const end=Date.now()+45000;
  while(Date.now()<end) {
    const status=(await connection.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0];
    if(status?.err)throw Error(JSON.stringify(status.err));
    if(status?.confirmationStatus==='finalized')return;
    await delay(250);
  }
  throw Error('Finality timeout');
}

test('local real escrow binary: locks direct payment, scalar claim+sweep+close, and timed refund', {timeout:360000},async t=>{
  const validator=await startValidator({maxLifetimeMs:370000});t.after(()=>validator.stop());
  const m=await setupMarket(validator),{connection,buyer,seller,mint,venue,platform,stranger,atas}=m;
  await send(connection,stranger,[buildInitTradeConfigInstruction({payer:stranger.publicKey,feeCollector:stranger.publicKey,feeBps:0})]);
  await t.test('direct USDC and fee, finalized quorum and memo scan',async()=>{
    const fromSlot=await pay.finalizedSlot({endpoints});
    const args={payer:buyer.publicKey,payee:seller.publicKey,amount:'995000',fee:'5000',collector:venue.publicKey,mint,memo:pay.memo('ab'.repeat(32),'open:'+'cd'.repeat(32))};
    const tx=pay.build(args);tx.recentBlockhash=(await connection.getLatestBlockhash()).blockhash;tx.sign(buyer);
    const signature=await connection.sendRawTransaction(tx.serialize(),{preflightCommitment:'confirmed',maxRetries:0});await finalized(connection,signature);
    const verdict=await pay.verify({...args,signature,endpoints});assert.equal(verdict.ok,true,verdict.reason);
    assert.equal((await pay.verify({...args,amount:'999999',signature,endpoints})).ok,false);
    assert.equal((await pay.scan({...args,endpoints,fromSlot})).payments.length,1);
    assert.equal(await balance(connection,atas.seller),995000n);assert.equal(await balance(connection,atas.venue),5000n);
  });
  await t.test('known-scalar fixture claims, sweeps all USDC and closes the lock ATA atomically',async()=>{
    const a=123456789n,escrowPreimage=randomBytes(32).toString('hex'),amount='1234567',refundAfter=Number(await chainTime(connection))+300;
    const args=escrow.initArgs({A:publicOf(a),escrowPreimage,payer:buyer.publicKey,mint,amount,refundAfter,expectedPlatformFeeBps:10,expectedTradeFeeBps:0,tradeFeeCollector:stranger.publicKey});
    const funded=await send(connection,buyer,[buildInitInstruction(args)]);await finalized(connection,funded);
    assert.equal((await escrow.verify({A:publicOf(a),escrowPreimage,payer:buyer.publicKey,amount,mint,refundAfter,platformFeeBps:10,tradeFeeBps:0,
      platformCollector:platform.publicKey,escrowCollector:stranger.publicKey.toBase58(),endpoints})).ok,true);
    const before=await balance(connection,atas.seller),block=await connection.getLatestBlockhash();
    const tx=escrow.claimAndSweep({a,escrowPreimage,winnerSol:seller.publicKey,mint,amount,tradeFeeCollector:stranger.publicKey,recentBlockhash:block.blockhash});
    tx.partialSign(seller);assert.ok(tx.verifySignatures());
    const signature=await connection.sendRawTransaction(tx.serialize(),{preflightCommitment:'confirmed',maxRetries:0});await finalized(connection,signature);
    assert.equal(await balance(connection,atas.seller)-before,BigInt(amount));
    const lock=new PublicKey(Buffer.from(publicOf(a),'hex'));
    assert.equal(await connection.getAccountInfo(deriveVaultAta(lock,mint),'finalized'),null);
  });
  await t.test('writer recovers net plus fees after refundAfter on the real Clock',async()=>{
    const a=987654321n,escrowPreimage=randomBytes(32).toString('hex'),amount='100000',refundAfter=Number(await chainTime(connection))+5;
    const before=await balance(connection,atas.buyer),args=escrow.initArgs({A:publicOf(a),escrowPreimage,payer:buyer.publicKey,mint,amount,refundAfter,expectedPlatformFeeBps:10,expectedTradeFeeBps:0,tradeFeeCollector:stranger.publicKey});
    await send(connection,buyer,[buildInitInstruction(args)]);
    const end=Date.now()+15000;while(Number(await chainTime(connection))<refundAfter){assert.ok(Date.now()<end);await delay(200);}
    const sig=await send(connection,buyer,[buildRefundInstruction({paymentHashHex:args.paymentHashHex,refund:buyer.publicKey,refundTokenAccount:atas.buyer,mint})]);await finalized(connection,sig);
    assert.equal(await balance(connection,atas.buyer),before);
  });
  await t.test('put roles claim, refund after exercise, and expire with public escrow and verified local headers',async()=>{
    for(const scenario of ['claimed','refunded','expired']){
    const exercised=scenario!=='expired',refunded=scenario==='refunded';
    const localHeaders=new Map();let counted=100;
    const clock=new Clock({bridge:{call:async(type,{height})=>type==='locks_clock'?{counted,hash:localHeaders.get(height)?.hash}:localHeaders.get(height)}});
    const paymentAdapter={finalizedSlot:()=>pay.finalizedSlot({endpoints}),verify:args=>pay.verify({...args,endpoints}),scan:args=>pay.scan({...args,endpoints})};
    const s=await stack({mint:mint.toBase58(),paymentAdapter,clockAdapter:{counted:async()=>counted,T:n=>clock.T(n)},
      escrowAdapter:{config:args=>escrow.config({...args,endpoints}),verify:args=>escrow.verify({...args,endpoints}),settlement:args=>escrow.settlement({...args,endpoints})},
      registryChange:r=>{r.fee.collector=venue.publicKey.toBase58();r.fee.escrowCollector=stranger.publicKey.toBase58();if(refunded)r.params.recoveryMarginSec=1;}});
    try {
      // The refund scenario advances the signer wall clock after funding to model a long outage locally.
      s.time.now=Number(await chainTime(connection))-(refunded?13000:0);s.clients[0].sol=buyer.publicKey.toBase58();s.clients[1].sol=seller.publicKey.toBase58();
      s.signers[4].bridge.active=false;
      const id=await s.post('put','RESET',{premium:'100000',strikeTotal:'1000000'},false);s.time.now+=120;
      for(const signer of s.signers.slice(0,4))await signer.advance(structuredClone(signer.positions.get(id)),{type:'timeout',now:s.time.now});await s.drain();
      s.signers[4].bridge.active=true;await s.emit(s.clients[0],'lockRequest',{positionId:id,post:s.signers[0].positions.get(id).post});await s.drain();
      const p=s.signers[0].positions.get(id),refundAfter=refunded?Number(await chainTime(connection))+60:s.time.now+12000+s.r.params.recoveryMarginSec;
      assert.ok(s.signers.every(x=>x.positions.get(id).lock.A===p.lock.A));assert.equal(p.lock.Q.length,4);
      const args=escrow.initArgs({A:p.lock.A,escrowPreimage:p.post.escrowPreimage,payer:buyer.publicKey,mint,amount:p.post.terms.strikeTotal,refundAfter,
        expectedPlatformFeeBps:10,tradeFeeCollector:stranger.publicKey});
      await finalized(connection,await send(connection,buyer,[buildInitInstruction(args)]));
      await s.emit(s.clients[0],'funded',{positionId:id,escrow:{refundAfter}});await s.drain();assert.ok(s.signers.every(x=>x.positions.get(id).state==='posted'));
      if(refunded)s.time.now=Number(await chainTime(connection));
      const takeId=await s.take(id),opening=s.signers[0].paymentArgs(s.signers[0].positions.get(id),'open:'+takeId);
      assert.equal(BigInt(opening.amount)+BigInt(opening.fee),100000n);assert.equal(opening.fee,'50000');
      const submit=async(tx,key)=>{tx.recentBlockhash=(await connection.getLatestBlockhash()).blockhash;tx.sign(key);const signature=await connection.sendRawTransaction(tx.serialize());await finalized(connection,signature);return signature;};
      const signature=await submit(pay.build(opening),seller);await s.emit(s.clients[1],'paid',{positionId:id,step:'open:'+takeId,signature});await s.drain();
      assert.ok(s.signers.every(x=>x.positions.get(id).state==='running'));
      if(exercised){
        const exercise=await submit(pay.buildExercise({payer:seller.publicKey,memo:pay.memo(id,'exercise')}),seller);
        const receipt=await connection.getTransaction(exercise,{commitment:'finalized'});assert.ok(receipt.blockTime);
        for(let height=100;height<=110;height++){const b=Buffer.alloc(80);b.writeUInt32LE(receipt.blockTime+height-105,68);b.writeUInt32LE(height,76);localHeaders.set(height,{header:b.toString('hex'),hash:headerHash(b)});}
        counted=110;for(const signer of s.signers)signer.clock.M=n=>clock.M(n);
        await s.emit(s.clients[1],'paid',{positionId:id,step:'exercise',signature:exercise});await s.drain();
      }else{
        counted=120;const receipt=await connection.getTransaction(signature,{commitment:'finalized'}),b=Buffer.alloc(80);b.writeUInt32LE(receipt.blockTime,68);
        localHeaders.set(120,{header:b.toString('hex'),hash:headerHash(b)});
        for(const signer of s.signers)await signer.reconcile();await s.drain();
      }
      assert.ok(s.signers.every(x=>x.positions.get(id).decision?.outcome===(exercised?'exercised':'expired')));
      if(exercised)assert.ok(s.signers.every(x=>!x.positions.get(id).holders[takeId].release));
      const releases=s.sent.filter(x=>x.raw.kind==='release'&&!x.raw.body.takeId).map(x=>x.raw.body),holder=s.clients[exercised?1:0],winner=exercised?seller:buyer,winnerAta=exercised?atas.seller:atas.buyer;
      const shares=releases.slice(0,3).map(b=>({id:b.j,share:fromLe32(openShare(b.sealed,holder.box.secretKey,{positionId:id,from:b.j,to:holder.identity.publicKey},'release'))}));
      const a=reconstruct(shares,3,p.lock.C);assert.equal(publicOf(a),p.lock.A);
      if(refunded){
        const before=await balance(connection,atas.buyer),holderBefore=await balance(connection,atas.seller),end=Date.now()+70000;
        while(Number(await chainTime(connection))<refundAfter){assert.ok(Date.now()<end);await delay(200);}
        await finalized(connection,await send(connection,buyer,[buildRefundInstruction({paymentHashHex:args.paymentHashHex,refund:buyer.publicKey,refundTokenAccount:atas.buyer,mint})]));
        assert.equal(await balance(connection,atas.buyer)-before,1001000n);assert.equal(await balance(connection,atas.seller),holderBefore);
      }else{
        const before=await balance(connection,winnerAta),block=await connection.getLatestBlockhash();
        const tx=escrow.claimAndSweep({a,escrowPreimage:p.post.escrowPreimage,winnerSol:winner.publicKey,mint,amount:p.post.terms.strikeTotal,tradeFeeCollector:stranger.publicKey,recentBlockhash:block.blockhash});
        tx.partialSign(winner);await finalized(connection,await connection.sendRawTransaction(tx.serialize()));
        assert.equal(await balance(connection,winnerAta)-before,1000000n);
      }
      assert.equal(await connection.getAccountInfo(deriveVaultAta(new PublicKey(Buffer.from(p.lock.A,'hex')),mint),'finalized'),null);
      await s.emit(s.clients[1],'releaseRequest',{positionId:id,takeId});await s.drain();
      const holderWinner=scenario==='claimed'?'maker':'taker';
      assert.ok(s.signers.every(x=>x.positions.get(id).holders[takeId].release?.winner===holderWinner));
      if(exercised)assert.ok(s.signers.every(x=>x.positions.get(id).holders[takeId].decision.escrowStatus===scenario));
      const assetReleases=[...new Map(s.sent.filter(x=>x.raw.kind==='release'&&x.raw.body.takeId===takeId).map(x=>[x.raw.body.j,x.raw.body])).values()];
      const assetWinner=s.clients[holderWinner==='maker'?0:1],assetShares=assetReleases.slice(0,3).map(b=>({id:b.j,share:fromLe32(openShare(b.sealed,assetWinner.box.secretKey,
        {positionId:id,takeId,from:b.j,to:assetWinner.identity.publicKey},'release'))}));
      assert.equal(publicOf(reconstruct(assetShares,3,assetReleases[0].C)),s.signers[0].positions.get(id).holders[takeId].lock.A);
    } finally {s.stop();}
    }
  });

});
