import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from '@solana/spl-token';
import bs58 from 'bs58';
import { deriveVaultAta } from '../solana/escrow.js';
import { rpcCall } from '../solana/rpc.js';
import { stableJSON } from '../core/canonical.js';

export const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export function memo(positionId, step) {
  if (!/^[0-9a-f]{64}$/.test(positionId) || !/^(repay|exercise|open:[0-9a-f]{64})$/.test(step)) throw new Error('Invalid payment memo');
  return `intercom-locks:v1:${positionId}:${step}`;
}
const units = x => {
  if (typeof x === 'bigint') x = x.toString();
  if (typeof x !== 'string' || !/^(0|[1-9][0-9]*)$/.test(x) || BigInt(x) >= 2n ** 64n) throw new Error('Invalid token amount');
  return BigInt(x);
};
export function feeAmount(amount, bps) {
  if (!Number.isInteger(bps) || bps < 0 || bps > 1000) throw new Error('Invalid fee bps');
  return units(amount) * BigInt(bps) / 10000n;
}

export function openingFee(amount, product, fee) {
  const n = units(amount);
  let value = feeAmount(amount, product === 'loan' ? fee.loanBps : fee.optionBps);
  if (product !== 'loan') value = value > units(fee.optionMin) ? value : units(fee.optionMin);
  return value > n ? n : value;
}
export function buildExercise({ payer, memo: text }) {
  if (!/^intercom-locks:v1:[0-9a-f]{64}:exercise$/.test(text)) throw new Error('Invalid exercise memo');
  const p = new PublicKey(payer), tx = new Transaction(); tx.feePayer = p;
  return tx.add(new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [{ pubkey: p, isSigner: true, isWritable: false }], data: Buffer.from(text) }));
}

// Always include idempotent ATA creation; building requires no network access.
export function build({ payer, payee, amount, fee = '0', collector, mint, memo: text }) {
  const p = new PublicKey(payer), q = new PublicKey(payee), m = new PublicKey(mint);
  const n = units(amount), f = units(fee);
  if ((!n && !f) || p.equals(q) || !/^intercom-locks:v1:[0-9a-f]{64}:(repay|exercise|open:[0-9a-f]{64})$/.test(text)) throw new Error('Invalid payment');
  const source = deriveVaultAta(p, m), target = deriveVaultAta(q, m), tx = new Transaction();
  tx.feePayer = p;
  if (n) {
    tx.add(createAssociatedTokenAccountIdempotentInstruction(p, target, q, m));
    tx.add(createTransferCheckedInstruction(source, m, target, p, n, 6));
  }
  if (f) {
    const c = new PublicKey(collector), dest = deriveVaultAta(c, m);
    if (c.equals(p) || c.equals(q)) throw new Error('Collector must be distinct');
    tx.add(createAssociatedTokenAccountIdempotentInstruction(p, dest, c, m));
    tx.add(createTransferCheckedInstruction(source, m, dest, p, f, 6));
  }
  tx.add(new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(text) }));
  return tx;
}

const sameInstruction = (a, b) => a.programId.equals(b.programId) && a.data.equals(b.data) &&
  a.keys.length === b.keys.length && a.keys.every((k, i) => k.pubkey.equals(b.keys[i].pubkey));

export function inspect(receipt, { signature, allowOverpay = false, beforeTime, expiresAt, fromSlot, ...expected }) {
  if (!receipt || receipt.meta?.err !== null || !Number.isSafeInteger(receipt.slot) || receipt.slot < 0 ||
      !Number.isSafeInteger(receipt.blockTime) || receipt.blockTime < 0 || receipt.transaction?.[1] !== 'base64') throw new Error('Finalized successful transaction required');
  if (beforeTime !== undefined && receipt.blockTime >= beforeTime || expiresAt !== undefined && receipt.blockTime > expiresAt) throw new Error('Payment is late');
  if (fromSlot !== undefined && receipt.slot < fromSlot) throw new Error('Payment predates reservation');
  const tx = Transaction.from(Buffer.from(receipt.transaction[0], 'base64'));
  if (!tx.verifySignatures() || bs58.encode(tx.signature) !== signature || !tx.feePayer.equals(new PublicKey(expected.payer))) throw new Error('Wrong payment signer');
  if (expected.memoOnly) {
    const want = buildExercise(expected);
    if (tx.instructions.length !== 1 || !sameInstruction(tx.instructions[0], want.instructions[0])) throw new Error('Exercise memo mismatch');
    return { ok: true, signature, slot: receipt.slot, blockTime: receipt.blockTime, memoOnly: true };
  }
  let amount = units(expected.amount);
  if (allowOverpay) {
    const transfers = tx.instructions.filter(i => i.data.length === 10 && i.data[0] === 12);
    if (!transfers.length) throw new Error('Transfer missing');
    const actual = transfers[0].data.readBigUInt64LE(1);
    if (actual < amount) throw new Error('Partial payment');
    amount = actual;
  }
  const want = build({ ...expected, amount });
  // ATA creation may be omitted when the accounts already exist.
  const required = want.instructions.filter(i => !i.programId.equals(want.instructions[0].programId));
  const actual = tx.instructions.filter(i => !i.programId.equals(want.instructions[0].programId));
  if (actual.length !== required.length || actual.some((ix, i) => !sameInstruction(ix, required[i])) ||
      tx.instructions.some(ix => ix.programId.equals(want.instructions[0].programId) && !want.instructions.some(w => sameInstruction(ix, w)))) throw new Error('Payment instructions mismatch');
  return { ok: true, signature, slot: receipt.slot, blockTime: receipt.blockTime, amount: amount.toString() };
}

function readers(endpoints, need) {
  // An operator's own endpoint is trusted on its own (need 1), as for the DEX; public endpoints need two that agree.
  if (!Array.isArray(endpoints) || !Number.isInteger(need) || need < 1 || endpoints.length < need) throw new Error('Solana RPC readers required');
  const urls = endpoints.map(endpoint => {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.hash || url.username || url.password) throw new Error('Invalid RPC endpoint');
    return url.href;
  });
  if (new Set(urls).size !== urls.length) throw new Error('Distinct RPC readers required');
}
async function agree(endpoints, need, fn) {
  readers(endpoints, need);
  const rows = await Promise.allSettled(endpoints.map(fn)), groups = new Map();
  for (const r of rows) if (r.status === 'fulfilled') {
    const key = stableJSON(r.value), group = groups.get(key) ?? { count: 0, value: r.value };
    group.count++; groups.set(key, group);
  }
  if (groups.size !== 1 || [...groups.values()][0].count < need) throw new Error('Payment RPC quorum unavailable or disagrees');
  return [...groups.values()][0].value;
}

// `fetched` marks a transaction that was read and is simply not this payment (no second read needed to prove history).
export async function verify({ endpoints, need = 2, rpc = rpcCall, ...expected }) {
  let receipt;
  try {
    receipt = await agree(endpoints, need, async endpoint => {
      const r = await rpc(endpoint, 'getTransaction', [expected.signature,
        { commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 0 }]);
      if (!r) throw new Error('Transaction unavailable');
      if (!r.meta || !Object.hasOwn(r.meta, 'err')) throw new Error('Transaction outcome unavailable');
      return { slot: r.slot, blockTime: r.blockTime, meta: { err: r.meta.err }, transaction: r.transaction };
    });
  } catch (error) { return { ok: false, reason: error.message }; }
  try { return inspect(receipt, expected); } catch (error) { return { ok: false, reason: error.message, fetched: true }; }
}

export async function finalizedSlot({ endpoints, need = 2, rpc = rpcCall }) {
  readers(endpoints, need);
  const results = await Promise.allSettled(endpoints.map(endpoint => rpc(endpoint, 'getSlot', [{ commitment: 'finalized' }])));
  const slots = results.filter(r => r.status === 'fulfilled' && Number.isSafeInteger(r.value) && r.value >= 0).map(r => r.value);
  if (slots.length < need) throw new Error('Finalized slot quorum unavailable');
  return slots.sort((a, b) => a - b)[0];
}

// Same retained-history and first-block lookup as the DEX adapter, with explicit readers.
export async function firstFinalizedBlockAtLeast(drawSlot, { endpoints, need = 2, rpc = rpcCall }) {
  if (!Number.isSafeInteger(drawSlot) || drawSlot < 0) throw new Error('Invalid draw slot');
  const tip = await finalizedSlot({ endpoints, need, rpc });
  if (tip < drawSlot) throw new Error('Draw slot not finalized');
  await agree(endpoints, need, async endpoint => {
    const first = await rpc(endpoint, 'getFirstAvailableBlock', []);
    if (!Number.isSafeInteger(first) || first > drawSlot) throw new Error('Draw history pruned');
    return true;
  });
  for (let start = drawSlot; start <= tip; start += 512) {
    const end = Math.min(tip, start + 511);
    const slot = await agree(endpoints, need, async endpoint => {
      const slots = await rpc(endpoint, 'getBlocks', [start, end, { commitment: 'finalized' }]);
      if (!Array.isArray(slots) || slots.some((s, i) => !Number.isSafeInteger(s) || s < start || s > end || i && s <= slots[i - 1])) throw new Error('Invalid draw block range');
      return slots[0] ?? null;
    });
    if (slot === null) continue;
    const blockhash = await agree(endpoints, need, async endpoint => {
      const b = await rpc(endpoint, 'getBlock', [slot, { commitment: 'finalized', transactionDetails: 'none', rewards: false, maxSupportedTransactionVersion: 0 }]);
      if (!b) throw new Error('Draw block unavailable');
      return new PublicKey(b.blockhash).toBuffer().toString('hex');
    });
    return { slot, blockhash, finalized: true };
  }
  throw new Error('No finalized draw block');
}

// An incomplete/pruned history must never authorize a default or expiry decision.
// `until`: the newest signature a previous complete scan with the same arguments already checked; only newer history
// is read. A complete result returns `newest` for the next scan.
export async function scan({ endpoints, need = 2, rpc = rpcCall, maxPages = 100, beforeTime, fromSlot, until, ...expected }) {
  readers(endpoints, need);
  if (!Number.isSafeInteger(fromSlot) || fromSlot < 0) throw new Error('Payment history lower slot bound required');
  await agree(endpoints, need, async endpoint => {
    const first = await rpc(endpoint, 'getFirstAvailableBlock', []);
    if (!Number.isSafeInteger(first) || first > fromSlot) throw new Error('Payment history pruned');
    return true;
  });
  if (beforeTime !== undefined) {
    await agree(endpoints, need, async endpoint => {
      const slot = await rpc(endpoint, 'getSlot', [{ commitment: 'finalized' }]);
      const time = await rpc(endpoint, 'getBlockTime', [slot]);
      if (!Number.isSafeInteger(time) || time < beforeTime) throw new Error('Solana finality has not reached deadline');
      return true;
    });
  }
  const account = expected.memoOnly || BigInt(expected.amount ?? '0') === 0n ? new PublicKey(expected.payer).toBase58() : deriveVaultAta(expected.payee, expected.mint).toBase58(), payments = [];
  let before, oldest = Infinity, ordered = true, newest = until;
  for (let page = 0; page < maxPages; page++) {
    const rows = await agree(endpoints, need, endpoint => rpc(endpoint, 'getSignaturesForAddress', [account,
      { commitment: 'finalized', limit: 1000, ...(before ? { before } : {}), ...(until ? { until } : {}) }]));
    if (!Array.isArray(rows) || rows.length > 1000) throw new Error('Invalid payment history');
    if (page === 0 && rows.length) newest = rows[0].signature;
    for (const row of rows) {
      if (!Number.isSafeInteger(row.slot) || row.slot < 0 || row.slot > oldest) ordered = false;
      if (Number.isSafeInteger(row.slot)) oldest = row.slot;
      if (row.err !== null) continue;
      if (row.slot < fromSlot) continue;
      if (row.memo !== null && row.memo !== undefined && !row.memo.endsWith(expected.memo)) continue;
      const verdict = await verify({ ...expected, endpoints, need, rpc, signature: row.signature, beforeTime, fromSlot });
      if (verdict.ok) payments.push(verdict);
      // A failed fetch is not proof of absence; fetch the transaction independently of its expected shape.
      else if (!verdict.fetched) await agree(endpoints, need, async endpoint => {
        const r = await rpc(endpoint, 'getTransaction', [row.signature, { commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 0 }]);
        if (!r) throw new Error('Payment history pruned');
        return r;
      });
    }
    // Finalized signature pages are newest first; older transactions cannot belong to this position.
    if (rows.length < 1000 || ordered && oldest < fromSlot) return { complete: true, payments, newest };
    const next = rows.at(-1).signature;
    if (next === before) throw new Error('Payment history cursor stalled');
    before = next;
  }
  throw new Error('Payment history scan limit reached');
}

export const scanByMemo = scan;
