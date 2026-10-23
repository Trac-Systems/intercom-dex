import { EventEmitter } from 'node:events';
import { Keypair } from '@solana/web3.js';
import { randomBytes } from 'node:crypto';
import { LockSigner } from '../../../src/roles/lock-signer.js';
import { LockVenue } from '../../../src/roles/lock-venue.js';
import { MAIN, channel, seal } from '../../../src/locks/transport.js';
import { sha256Hex, stableJSON } from '../../../src/core/canonical.js';
import { scalarSigner } from '../../../src/locks/crypto/scalar-sign.js';
import { address } from '../../../src/locks/trac-lock.js';
import { identity, box, registry, memoryStore, sol } from '../../unit/locks/helpers.mjs';

// Deliberately small product doubles. Production product rules belong to the separate products module.
export const products = Object.fromEntries(['loan','call','put'].map(product=>[product,{ decide(p,f) {
  if(p.state!=='running') return f.cancelAccepted || f.counted>=p.terms.offerUntilBlock ? {winner:'maker',outcome:'cancelled'} : {winner:null,outcome:null};
  const N=p.dueBlock??p.terms.expiryBlock, step=product==='loan'?'repay':'exercise';
  if(f.T!==undefined && f.payments.some(x=>x.step===step&&x.ok&&x.blockTime<f.T)) return {winner:product==='loan'?'maker':'taker',outcome:product==='loan'?'repaid':'exercised'};
  return f.counted>=N && f.T!==undefined ? {winner:product==='loan'?'taker':'maker',outcome:product==='loan'?'defaulted':'expired'} : {winner:null,outcome:null};
} }]));

export async function stack({ stores = null, paymentAdapter = null, clockAdapter = null, balanceRead = null, escrowAdapter = null, productRules = products, registryChange = null, mint: mintInput = null }={}) {
  const nodes=[], pending=[], sent=[], chain={counted:100,T:2000,escrowStatus:'active'}, time={now:1000}, payments=new Map();
  function bridge() {
    const b=new EventEmitter(); b.channels=new Set(); b.active=true; nodes.push(b);
    b.join=async ch=>b.channels.add(ch); b.leave=async ch=>b.channels.delete(ch);
    b.send=async(ch,raw)=>{sent.push({ch,raw});pending.push({ch,raw});};
    b.call=async(type,args)=>{
      if(type==='locks_balances') return balanceRead?balanceRead(args):{final:true,RESET:'1000000000',TNK:'1000000000000000000',feeTnk:'30'};
      throw Error('Unexpected bridge read '+type);
    }; return b;
  }
  const keys=Array.from({length:5},()=>({identity:identity(),box:box()})), venueKey=identity(), r=registry(keys), mint=mintInput??sol();
  registryChange?.(r);
  const rpc=paymentAdapter??{finalizedSlot:async()=>0,verify:async({signature})=>payments.get(signature)??{ok:false},scan:async args=>({complete:true,payments:[...payments.values()].filter(p=>p.memo===args.memo&&(args.beforeTime===undefined||p.blockTime<args.beforeTime)&&(args.expiresAt===undefined||p.blockTime<=args.expiresAt))})};
  const clock=clockAdapter??{counted:async()=>chain.counted,T:async()=>chain.T};
  const signers=keys.map((key,i)=>new LockSigner({bridge:bridge(),...key,store:stores?.[i]??memoryStore(),serviceKey:venueKey.publicKey,profile:{mint},
    products:productRules,clock,payments:rpc,escrow:escrowAdapter??{config:async()=>({platformFeeBps:10,tradeFeeBps:0,platformCollector:sol()}),verify:async()=>({ok:true}),
      settlement:async()=>({ok:true,status:chain.escrowStatus})},now:()=>time.now,log:()=>{}}));
  const venue=new LockVenue({bridge:bridge(),identity:venueKey,store:memoryStore(),registryInput:r,now:()=>time.now,log:()=>{}});
  for(const signer of signers) signer.bridge.role=signer; venue.bridge.role=venue;
  const clients=Array.from({length:2},(_,i)=>({identity:identity(),box:box(),trac:address(scalarSigner(BigInt(i+501)).publicKey),sol:Keypair.generate().publicKey.toBase58(),bridge:bridge()}));
  for(const c of clients) await c.bridge.join(MAIN);
  const party=c=>({lockKey:c.identity.publicKey,boxKey:c.box.publicKey,trac:c.trac,sol:c.sol});
  const emit=async(c,kind,body,ch=kind==='lockRequest'||kind==='releaseRequest'||kind==='bookRequest'?MAIN:channel(body.positionId))=>{
    if(ch!==MAIN) await c.bridge.join(ch); await c.bridge.send(ch,seal({kind,ch,body},c.identity.secretKey,{ts:time.now}));
  };
  async function drain() {
    let count=0;
    while(pending.length) {
      if(++count>2000) throw Error('Message loop');
      const {ch,raw}=pending.shift();
      for(const node of nodes) if(node.active&&node.channels.has(ch)&&node.role) await node.role.handle(ch,raw);
    }
  }
  for(const signer of signers) await signer.start(); await venue.start(); await drain();
  async function post(product='loan', asset='RESET', termsPatch={},fund=true) {
    const p={v:1,product,maker:party(clients[0]),terms:product==='loan'?{asset,collateral:'100',principal:'1000',repay:'1100',termBlocks:6,offerUntilBlock:110}:
      {asset,amount:'100',premium:'100',strikeTotal:'1000',expiryBlock:120,offerUntilBlock:110},registryVersion:r.version,createdAt:time.now,nonce:randomBytes(32).toString('hex')};
    Object.assign(p.terms,termsPatch);
    if(product==='put')p.escrowPreimage=randomBytes(32).toString('hex');
    const id=sha256Hex(stableJSON(p)); await clients[0].bridge.join(channel(id));
    await emit(clients[0],'lockRequest',{positionId:id,post:p}); await drain();
    if(fund)await emit(clients[0],'funded',{positionId:id,...(product==='put'?{escrow:{refundAfter:time.now+20000+r.params.recoveryMarginSec}}:{})}); await drain(); return id;
  }
  async function take(id) {
    const takeId=randomBytes(32).toString('hex');
    await emit(clients[1],'take',{positionId:id,takeId,taker:party(clients[1]),takeAnchor:chain.counted}); await drain();
    if(signers[0].positions.get(id).post.product==='put'){await emit(clients[1],'funded',{positionId:id,takeId});await drain();}
    return takeId;
  }
  async function pay(id,step,{announce=true,blockTime=time.now}={}) {
    const signature=Keypair.generate().publicKey.toBase58()+Keypair.generate().publicKey.toBase58();
    const memo=`intercom-locks:v1:${id}:${step}`;
    payments.set(signature,{ok:true,signature,slot:1,blockTime,amount:'1100',memo});
    if(announce) {await emit(step==='repay'?clients[0]:clients[1],'paid',{positionId:id,step,signature});await drain();}
    return signature;
  }
  const stop=()=>{for(const signer of signers)signer.stop();venue.stop();};
  return {signers,venue,clients,party,r,mint,time,chain,clock,keys,sent,pending,nodes,payments,emit,drain,post,take,pay,stop,bridge};
}
