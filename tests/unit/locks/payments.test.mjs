import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import * as pay from '../../../src/locks/solana-pay.js';
import { sol } from './helpers.mjs';
const endpoints=['http://127.0.0.1:1/a','http://127.0.0.1:1/b'];
function fixture(change={}) {
  const payer=Keypair.generate(), input={payer:payer.publicKey.toBase58(),payee:sol(),amount:'1000',fee:'5',collector:sol(),mint:sol(),memo:pay.memo('ab'.repeat(32),'open:'+'cd'.repeat(32))};
  const tx=pay.build({...input,...change}); tx.recentBlockhash=sol(); tx.sign(payer);
  const signature=bs58.encode(tx.signature), receipt={slot:100,blockTime:1000,meta:{err:null},transaction:[tx.serialize().toString('base64'),'base64']};
  return {input:{...input,signature},receipt,tx};
}

test('direct payment exact transfers, fee, memo and signer via mocked finalized RPC',async()=>{
  const {input,receipt}=fixture(); let reads=0;
  const rpc=async(_,method,params)=>{reads++;assert.equal(method,'getTransaction');assert.equal(params[1].commitment,'finalized');return receipt;};
  assert.equal((await pay.verify({...input,endpoints,rpc})).ok,true); assert.equal(reads,2);
  for(const patch of [{payer:sol()},{payee:sol()},{amount:'999'},{fee:'6'},{collector:sol()},{mint:sol()},
    {memo:pay.memo('ab'.repeat(32),'repay')},{signature:'bad'},{beforeTime:1000},{expiresAt:999}])
    assert.equal((await pay.verify({...input,...patch,endpoints,rpc})).ok,false,JSON.stringify(patch));
  assert.equal((await pay.verify({...input,expiresAt:1000,endpoints,rpc})).ok,true);
  assert.equal((await pay.verify({...input,endpoints:[endpoints[0]],need:0,rpc})).ok,false);
  assert.equal((await pay.verify({...input,endpoints:[endpoints[0]],need:1,rpc})).ok,true, 'an operator\'s own endpoint is trusted on its own');
  for(const patch of [{meta:{err:'failed'}},{blockTime:null},{transaction:['AA==','base64']},{slot:-1}])
    assert.equal((await pay.verify({...input,endpoints,rpc:async()=>({...receipt,...patch})})).ok,false);
  assert.equal((await pay.verify({...input,endpoints,rpc:async endpoint=>({...receipt,blockTime:endpoint===endpoints[0]?1000:1001})})).ok,false);
});

test('overpay permitted explicitly, partial is never accepted, history scan finds unannounced payment',async()=>{
  const {input,receipt}=fixture({amount:'1001'});
  assert.equal((await pay.verify({...input,allowOverpay:true,endpoints,rpc:async()=>receipt})).ok,true);
  assert.equal((await pay.verify({...input,amount:'1002',allowOverpay:true,endpoints,rpc:async()=>receipt})).ok,false);
  const rpc=async(_,method)=>method==='getFirstAvailableBlock'?0:method==='getSlot'?101:method==='getBlockTime'?1002:method==='getTransaction'?receipt:[{signature:input.signature,err:null,memo:null}];
  const scan=await pay.scan({...input,fromSlot:0,allowOverpay:true,endpoints,rpc,beforeTime:1001});
  assert.equal(scan.complete,true); assert.equal(scan.payments.length,1);
  await assert.rejects(pay.scan({...input,fromSlot:0,endpoints,rpc,beforeTime:1003}),/quorum/);
  await assert.rejects(pay.scan({...input,fromSlot:0,endpoints,rpc:async(_,m)=>m==='getTransaction'?null:[{signature:input.signature,err:null,memo:null}]}));
});

test('payment history stops below the admission slot without paging through finished positions',async()=>{
  const {input}=fixture();let pages=0;
  const rows=Array.from({length:1000},(_,i)=>({signature:'old-'+i,slot:2000-i,err:null,memo:'another position'}));
  const rpc=async(_,method)=>{if(method==='getFirstAvailableBlock')return 0;assert.equal(method,'getSignaturesForAddress');pages++;return rows;};
  const result=await pay.scan({...input,endpoints,rpc,fromSlot:1500,maxPages:1});
  assert.deepEqual(result,{complete:true,payments:[],newest:'old-0'});assert.equal(pages,2);
  rows[1].slot=3000;
  await assert.rejects(pay.scan({...input,endpoints,rpc,fromSlot:1500,maxPages:1}),/scan limit/);
});

test('history includes every transaction in the admission slot across page boundaries',async()=>{
  const {input}=fixture();let pages=0;
  const rpc=async(_,method,args)=>{
    if(method==='getFirstAvailableBlock')return 0;
    assert.equal(method,'getSignaturesForAddress');pages++;
    return args[1].before?[{signature:'older',slot:1499,err:'failed',memo:null}]
      :Array.from({length:1000},(_,i)=>({signature:'same-slot-'+i,slot:1500,err:'failed',memo:null}));
  };
  assert.equal((await pay.scan({...input,endpoints,rpc,fromSlot:1500,maxPages:2})).complete,true);
  assert.equal(pages,4);
});

test('history scans continue from the newest checked transaction and read an unrelated transaction once',async()=>{
  const {input,receipt}=fixture(), other=fixture(), calls={};
  const history=[{signature:'new-1',slot:120,err:null,memo:null},{signature:other.input.signature,slot:110,err:null,memo:null}];
  const rpc=async(_,method,args)=>{
    calls[method]=(calls[method]??0)+1;
    if(method==='getFirstAvailableBlock')return 0;
    if(method==='getTransaction')return args[0]===other.input.signature?other.receipt:args[0]==='new-1'?receipt:null;
    const until=args[1].until; const i=until?history.findIndex(r=>r.signature===until):-1;
    return i>=0?history.slice(0,i):history;
  };
  const first=await pay.scan({...input,endpoints:[endpoints[0]],need:1,rpc,fromSlot:100});
  assert.equal(first.complete,true); assert.equal(first.newest,'new-1');
  assert.equal(calls.getTransaction,2,'each transaction read once: a read that is not this payment needs no second read');
  history.unshift({signature:'new-2',slot:130,err:null,memo:'intercom-locks:v1:other'});
  const second=await pay.scan({...input,endpoints:[endpoints[0]],need:1,rpc,fromSlot:100,until:first.newest});
  assert.deepEqual([second.complete,second.newest,calls.getTransaction],[true,'new-2',2],'only the newer page is read; a foreign memo is not fetched');
});
