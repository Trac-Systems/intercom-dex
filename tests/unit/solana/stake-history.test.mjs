import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { stakeEscrowHistory } from '../../../src/solana/stake-history.js';
import { buildInitInstruction, buildRefundInstruction, deriveVaultAta } from '../../../src/solana/escrow.js';
import { qualifyingLock } from '../../../src/stake/proof-clock.js';
import { terms as baseTerms, hashHex, key } from './vectors.mjs';
const endpoints = ['http://127.0.0.1:40001', 'http://127.0.0.1:40002'];
function fixture({ paged = false, actualAmount, at = 879 } = {}) {
  const payer = Keypair.generate(), terms = { ...baseTerms, buyer: { solPayer: payer.publicKey.toBase58() } };
  const ix = buildInitInstruction({ payer: payer.publicKey, payerTokenAccount: deriveVaultAta(payer.publicKey, terms.mint),
    paymentHashHex: hashHex, recipient: terms.seller.solRecipient, refund: payer.publicKey, mint: terms.mint,
    refundAfter: BigInt(terms.refundAfter), amount: BigInt(actualAmount ?? terms.quoteAmount), expectedPlatformFeeBps: terms.fees.platformFeeBps,
    expectedTradeFeeBps: terms.fees.tradeFeeBps, tradeFeeCollector: terms.fees.collector });
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: key(99).toBase58() }).add(ix); tx.sign(payer);
  const sig = bs58.encode(tx.signature), wire = tx.serialize().toString('base64'), calls = [];
  const spam = Array.from({ length: 100 }, (_, i) => { const b = Buffer.alloc(64, 11); b.writeUInt32LE(i, 0);
    return { signature: bs58.encode(b), slot: 500 - i, err: { InstructionError: [0, 'InvalidArgument'] } }; });
  const row = { signature: sig, slot: 200, err: null };
  const read = async (url, method, params) => {
    calls.push({ url, method, params });
    if (method === 'getSlot') return 600;
    if (method === 'getFirstAvailableBlock') return 0;
    if (method === 'getSignaturesForAddress') return paged && !params[1].before ? spam : [row];
    if (method === 'getTransaction') return { slot: 200, blockTime: at, meta: { err: null }, transaction: [wire, 'base64'] };
    if (method === 'getBlockTime') return at;
    assert.fail(method);
  };
  return { calls, read, payer, input: { terms, hashHex, fromSlot: 100, throughSlot: 600, endpoints, read,
    inspect: async () => ({ ok: true, state: { status: 0 } }) } };
}
test('complete stake history pages beyond 100 rows and proves the exact original lock and historical time', async () => {
  const f = fixture({ paged: true }), result = await stakeEscrowHistory(f.input);
  assert.equal(result.status, 'complete'); assert.equal(result.locks.length, 1); assert.equal(result.locks[0].exact, true);
  assert.equal(result.escrowState, 'active'); assert.equal(result.locks[0].includedAt, 879);
  assert.equal(qualifyingLock({ ...result.locks[0], finalized: result.finalized, historyComplete: result.historyComplete }, 1000, 120), true);
  assert.equal(f.calls.filter(c => c.method === 'getSignaturesForAddress').length, 4);
  assert.ok(f.calls.filter(c => c.method === 'getSignaturesForAddress').some(c => c.params[1].before));
  assert.equal((await stakeEscrowHistory({ ...f.input, maxPages: 1 })).historyComplete, false);
  const late = await stakeEscrowHistory(fixture({ at: 880 }).input);
  assert.equal(qualifyingLock({ ...late.locks[0], finalized: true, historyComplete: true }, 1000, 120), false);
});

test('refund history binds the original buyer authority and rejects an altered signed receipt', async () => {
  const f = fixture(), terms = f.input.terms;
  const withRefund = (signer, alter = false) => {
    const ix = buildRefundInstruction({ paymentHashHex: hashHex, mint: terms.mint, refund: signer.publicKey,
      refundTokenAccount: deriveVaultAta(signer.publicKey, terms.mint) });
    const tx = new Transaction({ feePayer: signer.publicKey, recentBlockhash: key(99).toBase58() }).add(ix); tx.sign(signer);
    const signature = bs58.encode(tx.signature), raw = tx.serialize(); if (alter) raw[1] ^= 1;
    return { ...f.input, inspect: async () => ({ ok: true, state: { status: 2 } }),
      read: async (url, method, params, options) => {
        if (method === 'getSignaturesForAddress') return [{ signature, slot: 300, err: null }, ...await f.read(url, method, params, options)];
        if (method === 'getTransaction' && params[0] === signature)
          return { slot: 300, blockTime: 1000, meta: { err: null }, transaction: [raw.toString('base64'), 'base64'] };
        if (method === 'getBlockTime' && params[0] === 300) return 1000;
        return f.read(url, method, params, options);
      } };
  };
  const result = await stakeEscrowHistory(withRefund(f.payer));
  assert.equal(result.status, 'complete'); assert.equal(result.locks[0].exact, true);
  assert.equal(result.escrowState, 'refunded'); assert.equal(result.settlements[0].state, 'refunded');
  assert.equal(result.settlements[0].includedAt, 1000);
  assert.equal((await stakeEscrowHistory(withRefund(Keypair.generate()))).historyComplete, false);
  assert.equal((await stakeEscrowHistory(withRefund(f.payer, true))).historyComplete, false);
});
test('wrong amount is not exact and absent account, missing receipt, pruned range or repeated page stay unknown', async () => {
  assert.equal((await stakeEscrowHistory(fixture({ actualAmount: '1234568' }).input)).locks[0].exact, false);
  const f = fixture({ paged: true });
  assert.equal((await stakeEscrowHistory({ ...f.input, inspect: async () => ({ ok: false }) })).status, 'unknown');
  for (const [method, value] of [['getFirstAvailableBlock', 101], ['getSlot', 599], ['getTransaction', null], ['getBlockTime', null]]) {
    const result = await stakeEscrowHistory({ ...f.input, read: (...args) => args[1] === method ? value : f.read(...args) });
    assert.equal(result.status, 'unknown', method); assert.equal(result.historyComplete, false);
  }
  const repeated = await stakeEscrowHistory({ ...f.input, read: (url, method, params, opts) =>
    f.read(url, method, method === 'getSignaturesForAddress' ? [params[0], { limit: 100 }] : params, opts) });
  assert.equal(repeated.status, 'unknown');
});
test('readers must agree on historical time; a complete empty range is distinct from a failed read', async () => {
  const f = fixture();
  const disagreement = await stakeEscrowHistory({ ...f.input, read: async (url, method, params, opts) => {
    const r = await f.read(url, method, params, opts);
    if (url.includes('40002') && method === 'getBlockTime') return 900;
    if (url.includes('40002') && method === 'getTransaction') return { ...r, blockTime: 900 };
    return r;
  } });
  assert.equal(disagreement.reason, 'history_disagrees');
  const empty = await stakeEscrowHistory({ ...f.input, read: (...args) => args[1] === 'getSignaturesForAddress' ? [] : f.read(...args) });
  assert.equal(empty.historyComplete, true); assert.deepEqual(empty.locks, []);
  assert.equal((await stakeEscrowHistory({ ...f.input, read: async () => { throw Error('offline'); } })).status, 'unknown');
  for (const bad of [{ endpoints: [endpoints[0]] }, { need: 1 }, { fromSlot: 601 }, { maxPages: 0 }, { hashHex: 'bad' }])
    await assert.rejects(stakeEscrowHistory({ ...f.input, ...bad }));
});
