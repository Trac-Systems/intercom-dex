// Lock signer load: N running positions on one signer, the real payment scan against a counting fake Solana RPC
// (each call takes RPC_MS) and the real Bitcoin clock against a counting fake peer.
//   node tests/bench/locks-signer-load.mjs [N=2000] [rounds=3] [RPC_MS=20]
// Prints per reconcile round: wall time, Solana RPC calls by method, peer (bridge) reads, encrypted store writes.
import { randomBytes } from 'node:crypto';
import { Keypair, Transaction, TransactionInstruction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { stack } from '../integration/locks/harness.mjs';
import { Clock, headerHash } from '../../src/locks/clock.js';
import * as solanaPay from '../../src/locks/solana-pay.js';

const [N = 2000, ROUNDS = 3, RPC_MS = 20] = process.argv.slice(2).map(Number);
const C = 972800, BASE = 1792700000, sleep = ms => new Promise(r => setTimeout(r, ms));

// Bitcoin: header h has time BASE + 600 h; the peer answers locks_clock / locks_header.
const headers = new Map();
const header = h => {
  if (!headers.has(h)) { const b = Buffer.alloc(80); b.writeUInt32LE(h & 0xffffffff, 4); b.writeUInt32LE(BASE + 600 * (h - C), 68); headers.set(h, b.toString('hex')); }
  return headers.get(h);
};
const bridgeCalls = {};
const peer = { call: async (type, args = {}) => {
  bridgeCalls[type] = (bridgeCalls[type] ?? 0) + 1;
  if (type === 'locks_clock') return args.height === undefined ? { counted: C } : { counted: C, hash: headerHash(header(args.height)) };
  if (type === 'locks_header') return { header: header(args.height) };
  throw new Error('unexpected ' + type);
} };

// Solana: every account has the same 20 unrelated finalized transfers (memo null) newer than any position's start.
const unrelated = Array.from({ length: 20 }, (_, i) => {
  const k = Keypair.generate(), tx = new Transaction({ feePayer: k.publicKey, recentBlockhash: bs58.encode(randomBytes(32)) });
  tx.add(new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: [], data: Buffer.from('x' + i) }));
  tx.sign(k);
  return { signature: bs58.encode(tx.signature), slot: 4000 - i, raw: tx.serialize().toString('base64') };
});
const rpcCalls = {};
const rpc = async (_endpoint, method, params) => {
  rpcCalls[method] = (rpcCalls[method] ?? 0) + 1; await sleep(RPC_MS);
  if (method === 'getFirstAvailableBlock') return 0;
  if (method === 'getSlot') return 5000;
  if (method === 'getBlockTime') return BASE + 10 ** 6;
  if (method === 'getSignaturesForAddress') {
    const { before, until } = params[1] ?? {};
    let rows = unrelated;
    if (before) rows = rows.slice(rows.findIndex(r => r.signature === before) + 1);
    if (until) { const i = rows.findIndex(r => r.signature === until); if (i >= 0) rows = rows.slice(0, i); }
    return rows.map(r => ({ signature: r.signature, slot: r.slot, err: null, memo: null }));
  }
  if (method === 'getTransaction') {
    const row = unrelated.find(r => r.signature === params[0]);
    return row ? { slot: row.slot, blockTime: BASE, meta: { err: null }, transaction: [row.raw, 'base64'] } : null;
  }
  throw new Error('unexpected ' + method);
};

const s = await stack();
const id = await s.post(); const takeId = await s.take(id); await s.pay(id, 'open:' + takeId);
const signer = s.signers[0];
for (const x of s.signers) x.stop();
const template = signer.positions.get(id);
if (template.state !== 'running') throw new Error('template not running: ' + template.state);
signer.clock = new Clock({ bridge: peer });
signer.payments = solanaPay;
signer.rpc = { endpoints: ['https://rpc.invalid/'], need: 1, rpc };
let writes = 0; const put = signer.store.put.bind(signer.store); signer.store.put = (k, v) => { writes++; return put(k, v); };
for (let i = 0; i < N; i++) {
  const p = structuredClone(template);
  p.positionId = randomBytes(32).toString('hex'); p.dueBlock = C + 50 + (i % 400);
  p.taker = { ...p.taker, sol: Keypair.generate().publicKey.toBase58() };
  p.openSlot = 1; p.payments = p.payments.map(x => ({ ...x, slot: 1 }));
  // every tenth one is paid back already and waits for Bitcoin's median time
  if (i % 10 === 0) p.payments.push({ ok: true, signature: 'paid' + i, slot: 4100, blockTime: BASE + 10 ** 6, step: 'repay' });
  signer.positions.set(p.positionId, p); signer.store.put(`locks-position-${p.positionId}`, p);
}
signer.positions.delete(id);
const reset = o => { for (const k of Object.keys(o)) delete o[k]; };
console.log(JSON.stringify({ positions: signer.positions.active.size, rpcMs: RPC_MS }));
for (let round = 1; round <= ROUNDS; round++) {
  reset(rpcCalls); reset(bridgeCalls); writes = 0;
  const t0 = performance.now(); await signer.reconcile(); const ms = Math.round(performance.now() - t0);
  const rpcTotal = Object.values(rpcCalls).reduce((a, b) => a + b, 0);
  console.log(JSON.stringify({ round, seconds: ms / 1000, rpcTotal, rpcPerSecond: Math.round(rpcTotal / (ms / 1000)), rpc: { ...rpcCalls }, bridge: { ...bridgeCalls }, storeWrites: writes }));
}
process.exit(0);
