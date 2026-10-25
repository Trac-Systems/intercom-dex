import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { Keypair, Transaction, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { createSolanaAdapter } from '../../../src/solana/adapter.js';
import { readRpcQuorum } from '../../../src/solana/read-quorum.js';
import { calculateFees, deriveTradeConfigPda, buildInitInstruction } from '../../../src/solana/escrow.js';
import { PROGRAM_ID } from '../../../src/solana/constants.js';
import { terms, hashHex, key, addresses, wireAccount, wireVault, configBytes } from './vectors.mjs';

const endpoints = ['http://127.0.0.1:18899', 'http://localhost:18899'];
const make = options => createSolanaAdapter({ endpoints, sendEndpoint: endpoints[0], ...options });
const response = result => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
const rpcError = () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'simulation failed' } }));
const state = (bytes, overrides = {}) => ({ context: { slot: 100 }, value: bytes === null ? null : { ...wireAccount(bytes), ...overrides } });

function mockAccounts(t, { escrow = wireAccount(), vault = wireVault() } = {}) {
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const body = JSON.parse(request.body);
    assert.equal(body.method, 'getAccountInfo');
    return response({ context: { slot: 100 }, value: body.params[0] === addresses.escrowPda.toBase58() ? escrow : vault });
  });
}

test('adapter constructor validates required parameters and read-only use fails cleanly', async () => {
  for (const bad of [{ endpoints: [] }, { endpoints: [endpoints[0], endpoints[0]] }, { need: 3 }, { need: 0 }, { commitment: 'processed' }, { endpoints: ['file:///bad'] }, { keypair: Keypair.generate(), sendEndpoint: undefined }, { timeoutMs: 0 }]) assert.throws(() => make(bad));
  const a = make();
  for (const result of [await a.lockEscrow({ terms, hashHex }), await a.claim({ terms, hashHex }), await a.refund({ terms, hashHex }), await a.ensureTradeConfig({ feeBps: 50 }), await a.withdrawTradeFees({ amount: '1', to: key(1) })]) {
    assert.equal(result.ok, false); assert.match(result.reason, /Read-only/);
  }
  await assert.rejects(a.tradeFeeBalance(), /Read-only/);
});

test('deposit math is additive, independently rounded, exact and overflow checked', () => {
  assert.deepEqual(calculateFees('1234567', 10, 50), { netAmount: 1234567n, platformFeeAmount: 1234n, tradeFeeAmount: 6172n, totalAmount: 1241973n });
  assert.equal(calculateFees('199', 10, 50).totalAmount, 199n);
  assert.throws(() => calculateFees('18446744073709551615', 10, 50));
});

test('runner result mapping: active, missing, pending and actual mismatch', async t => {
  mockAccounts(t);
  assert.deepEqual(await make().checkEscrow({ terms, hashHex }), { ok: true, hashHex, purpose: 'lock', status: 'active' });
  mockAccounts(t, { escrow: null });
  assert.equal((await make().checkEscrow({ terms, hashHex })).status, 'missing');
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  assert.equal((await make().checkEscrow({ terms, hashHex })).status, 'pending');
  mockAccounts(t);
  const altered = { ...terms, fees: { ...terms.fees, tradeFeeBps: 51 } };
  const result = await make().checkEscrow({ terms: altered, hashHex });
  assert.equal(result.status, 'mismatch'); assert.ok(result.reasons.some(r => r.code === 'TRADE_FEE_BPS'));
  for (const changed of [{ ...terms, quoteAmount: 1 }, { ...terms, quoteAmount: '01' }, { ...terms, quoteAmount: '1\n' }, { ...terms, quoteAmount: '0' }]) assert.equal((await make().checkEscrow({ terms: changed, hashHex })).status, 'mismatch');
  assert.equal((await make().checkEscrow({ terms, hashHex: hashHex + '\n' })).status, 'mismatch');
  assert.equal((await make().checkEscrow({ terms, hashHex, purpose: 'other' })).status, 'mismatch');
});

test('successful history reads without the original deposit reject settlement proof', async t => {
  const escrow = wireAccount(); const b = Buffer.from(escrow.data[0], 'base64');
  b[1] = 1; b.writeBigUInt64LE(0n, 138); b.writeBigUInt64LE(0n, 146); b.writeBigUInt64LE(0n, 188); escrow.data[0] = b.toString('base64');
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const body = JSON.parse(request.body);
    if (body.method === 'getSignaturesForAddress') return response([]);
    return response({ context: { slot: 100 }, value: body.params[0] === addresses.escrowPda.toBase58() ? escrow : wireVault() });
  });
  const result = await make().checkEscrow({ terms, hashHex, purpose: 'settlement' });
  assert.equal(result.ok, false); assert.equal(result.status, 'mismatch');
});

test('quorum reads canonicalize object order, reject disagreement and expose provider errors', async t => {
  t.mock.method(globalThis, 'fetch', async url => response(String(url).includes('localhost') ? { b: 2, a: 1 } : { a: 1, b: 2 }));
  assert.deepEqual((await readRpcQuorum('getBlock', [], { endpoints })).value, { a: 1, b: 2 });
  t.mock.method(globalThis, 'fetch', async url => response(String(url).includes('localhost') ? 2 : 1));
  await assert.rejects(readRpcQuorum('getSlot', [], { endpoints }), /No RPC quorum/);
  await assert.rejects(readRpcQuorum('getSlot', [], { endpoints, need: 1 }), /Ambiguous/);
  for (const options of [{ endpoints: [] }, { endpoints: [endpoints[0], endpoints[0]] }, { endpoints: ['file:///bad'] }, { endpoints, need: 0 }]) await assert.rejects(readRpcQuorum('getSlot', [], options));
  await assert.rejects(readRpcQuorum('getSlot', [], { endpoints, select: () => { throw new Error('bad format'); } }), e => e.reports.every(r => r.message === 'bad format'));
});

test('the finalized slot is the highest one that two nodes have reached, also when they differ', async t => {
  const three = ['http://127.0.0.1:18899', 'http://localhost:18899', 'http://127.0.0.2:18899'].map(u => new URL(u).href);
  let slots = [100, 101, 103];
  t.mock.method(globalThis, 'fetch', async url => response(slots[three.indexOf(new URL(url).href)]));
  const a = createSolanaAdapter({ endpoints: three, sendEndpoint: three[0] });
  assert.equal(await a.finalizedSlot(), 101);
  slots = [100, 'x', 'y']; await assert.rejects(a.finalizedSlot(), /quorum/);
});

test('nodes with different history and a node that is behind still agree on the first finalized block', async t => {
  const three = ['http://127.0.0.1:18899', 'http://localhost:18899', 'http://127.0.0.2:18899'];
  let behind = false;
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    const { method, params } = JSON.parse(request.body), node = three.map(u => new URL(u).href).indexOf(new URL(url).href);
    if (method === 'getSlot') return response(20);
    // Real providers keep different amounts of history; the third no longer holds slot 5.
    if (method === 'getFirstAvailableBlock') return response([0, 4, 9][node]);
    if (method === 'getBlocks') { assert.notEqual(node, 2); return response(behind ? (node === 0 ? [7, 9] : []) : node === 1 ? [7] : [7, 9, 11]); }
    if (method === 'getBlock') { assert.equal(params[0], 7); return response({ blockhash: key(8).toBase58() }); }
    assert.fail(method);
  });
  const a = createSolanaAdapter({ endpoints: three, sendEndpoint: three[0] });
  assert.deepEqual(await a.firstFinalizedBlockAtLeast(5), { slot: 7, blockhash: '08'.repeat(32), finalized: true });
  // One node has the block and one is behind: undecided, never a later block.
  behind = true; await assert.rejects(a.firstFinalizedBlockAtLeast(5), /quorum/);
});

test('finality requires quorum for finalized tip, skipped slots and blockhash; refuses pruned history', async t => {
  let pruned = false, divergent = false;
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    const { method, params } = JSON.parse(request.body);
    if (method === 'getSlot') { assert.equal(params[0].commitment, 'finalized'); return response(20); }
    if (method === 'getFirstAvailableBlock') return response(pruned ? 10 : 0);
    if (method === 'getBlocks') { assert.equal(params[2].commitment, 'finalized'); assert.equal(params[0], 5); return response([7, 9, 11]); }
    if (method === 'getBlock') { assert.equal(params[0], 7); assert.equal(params[1].commitment, 'finalized'); return response({ blockhash: key(divergent && String(url).includes('localhost') ? 9 : 8).toBase58() }); }
    assert.fail(method);
  });
  const a = make();
  assert.equal(await a.finalizedSlot(), 20);
  assert.deepEqual(await a.firstFinalizedBlockAtLeast(5), { slot: 7, blockhash: '08'.repeat(32), finalized: true });
  await assert.rejects(a.firstFinalizedBlockAtLeast(21), /not finalized/);
  await assert.rejects(a.firstFinalizedBlockAtLeast(-1));
  divergent = true; await assert.rejects(a.firstFinalizedBlockAtLeast(5), /quorum/);
  divergent = false; pruned = true; await assert.rejects(a.firstFinalizedBlockAtLeast(5), /pruned/);
  t.mock.method(globalThis, 'fetch', async () => response(-1));
  await assert.rejects(a.finalizedSlot(), /quorum/);
});

test('service submissions resend identical signed bytes across lost responses, and confirm by quorum', async t => {
  const collector = Keypair.generate();
  const wire = [];
  let signature, accepted = false;
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const { method, params } = JSON.parse(request.body);
    if (method === 'getAccountInfo') return response(state(null));
    if (method === 'getLatestBlockhash') return response({ value: { blockhash: key(8).toBase58(), lastValidBlockHeight: 200 } });
    if (method === 'getBlockHeight') return response(100);
    if (method === 'getSignatureStatuses') return response({ value: [accepted ? { slot: 101, err: null, confirmationStatus: 'confirmed' } : null] });
    if (method === 'sendTransaction') {
      wire.push(params[0]); const tx = Transaction.from(Buffer.from(params[0], 'base64'));
      assert.ok(tx.verifySignatures()); signature = bs58.encode(tx.signature);
      if (wire.length === 1) throw new Error('response lost before acceptance known');
      accepted = true; return response(signature);
    }
    assert.fail(method);
  });
  const result = await make({ keypair: collector }).ensureTradeConfig({ feeBps: 50 });
  assert.deepEqual(result, { ok: true, signature }); assert.equal(wire.length, 2); assert.equal(wire[0], wire[1]);
});

test('ambiguous submission stays signed across invocation retries and never refreshes its blockhash', async t => {
  const collector = Keypair.generate(); let latestCalls = 0, recover = false; const wire = [];
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const { method, params } = JSON.parse(request.body);
    if (method === 'getAccountInfo') return response(state(null));
    if (method === 'getLatestBlockhash') { latestCalls++; return response({ value: { blockhash: key(8).toBase58(), lastValidBlockHeight: 200 } }); }
    if (method === 'getBlockHeight') return response(100);
    if (method === 'getSignatureStatuses') return response({ value: [recover ? { slot: 101, err: null, confirmationStatus: 'confirmed' } : null] });
    if (method === 'sendTransaction') { wire.push(params[0]); throw new Error('lost response'); }
    assert.fail(method);
  });
  const a = make({ keypair: collector, confirmationTimeoutMs: 100 });
  const failed = await a.ensureTradeConfig({ feeBps: 50 }); assert.equal(failed.ok, false); assert.match(failed.reason, /Pending transaction/);
  recover = true;
  const result = await a.ensureTradeConfig({ feeBps: 50 }); assert.equal(result.ok, true); assert.equal(latestCalls, 2); // one call per quorum endpoint, not a new signed tx
  assert.equal(result.signature, bs58.encode(Transaction.from(Buffer.from(wire[0], 'base64')).signature));
});

test('simulation failure and expiry fail cleanly; finalized commitment does not accept confirmed status', async t => {
  const collector = Keypair.generate(); let height = 100, sent = 0, mode = 'simulation';
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const { method } = JSON.parse(request.body);
    if (method === 'getAccountInfo') return response(state(null));
    if (method === 'getLatestBlockhash') return response({ value: { blockhash: key(8).toBase58(), lastValidBlockHeight: 200 } });
    if (method === 'getBlockHeight') return response(height);
    if (method === 'getSlot') return response(100);
    if (method === 'getSignatureStatuses') return response({ value: [mode === 'finality' ? { slot: 101, err: null, confirmationStatus: 'confirmed' } : null] });
    if (method === 'sendTransaction') { sent++; return rpcError(); }
    assert.fail(method);
  });
  let result = await make({ keypair: collector }).ensureTradeConfig({ feeBps: 50 }); assert.equal(result.ok, false); assert.match(result.reason, /simulation failed/);
  height = 201; result = await make({ keypair: collector, confirmationTimeoutMs: 50 }).ensureTradeConfig({ feeBps: 50 }); assert.equal(result.ok, false); assert.match(result.reason, /expired/); assert.equal(sent, 1);
  height = 100; mode = 'finality'; result = await make({ keypair: collector, commitment: 'finalized', confirmationTimeoutMs: 50 }).ensureTradeConfig({ feeBps: 50 }); assert.equal(result.ok, false); assert.match(result.reason, /Pending/);
});

test('refund eligibility uses chain Clock rather than wall time; signer mismatch fails before reading', async t => {
  const buyer = Keypair.generate();
  const localTerms = { ...terms, buyer: { solPayer: buyer.publicKey.toBase58() } };
  const escrow = wireAccount(); const b = Buffer.from(escrow.data[0], 'base64'); buyer.publicKey.toBuffer().copy(b, 66); escrow.data[0] = b.toString('base64');
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const { method, params } = JSON.parse(request.body); assert.equal(method, 'getAccountInfo');
    if (params[0] === SYSVAR_CLOCK_PUBKEY.toBase58()) { const clock = Buffer.alloc(40); clock.writeBigInt64LE(1n, 32); return response(state(clock, { owner: 'Sysvar1111111111111111111111111111111111111' })); }
    return response({ context: { slot: 100 }, value: params[0] === addresses.escrowPda.toBase58() ? escrow : wireVault() });
  });
  const a = make({ keypair: buyer });
  const result = await a.refund({ terms: localTerms, hashHex }); assert.equal(result.ok, false); assert.match(result.reason, /chain Clock/);
  t.mock.method(globalThis, 'fetch', async () => assert.fail('must not read'));
  assert.match((await a.lockEscrow({ terms, hashHex })).reason, /Signer does not match/);
});


test('settlement result mapping checks immutable terms and the cleared original deposit', async t => {
  const buyer = Keypair.generate();
  const localTerms = { ...terms, buyer: { solPayer: buyer.publicKey.toBase58() } };
  const ix = buildInitInstruction({ payer: buyer.publicKey, payerTokenAccount: key(2), recipient: key(3), refund: buyer.publicKey,
    refundAfter: terms.refundAfter, amount: terms.quoteAmount, mint: key(4), paymentHashHex: hashHex,
    expectedPlatformFeeBps: 10, expectedTradeFeeBps: 50, tradeFeeCollector: key(5) });
  const tx = new Transaction({ feePayer: buyer.publicKey, recentBlockhash: key(8).toBase58() }).add(ix);
  tx.sign(buyer);
  const signature = bs58.encode(tx.signature);
  for (const [status, label] of [[1, 'claimed'], [2, 'refunded']]) {
    const escrow = wireAccount(), b = Buffer.from(escrow.data[0], 'base64');
    buyer.publicKey.toBuffer().copy(b, 66); b[1] = status;
    b.writeBigUInt64LE(0n, 138); b.writeBigUInt64LE(0n, 146); b.writeBigUInt64LE(0n, 188); escrow.data[0] = b.toString('base64');
    t.mock.method(globalThis, 'fetch', async (_url, request) => {
      const { method, params } = JSON.parse(request.body);
      if (method === 'getSignaturesForAddress') return response([{ signature, slot: 95, err: null }]);
      if (method === 'getTransaction') return response({ slot: 95, meta: { err: null }, transaction: [tx.serialize().toString('base64'), 'base64'] });
      return response({ context: { slot: 100 }, value: params[0] === addresses.escrowPda.toBase58() ? escrow : wireVault() });
    });
    assert.deepEqual(await make().checkEscrow({ terms: localTerms, hashHex, purpose: 'settlement' }), { ok: true, hashHex, purpose: 'settlement', status: label });
    assert.deepEqual(await make().checkEscrow({ terms: localTerms, hashHex }), { ok: false, hashHex, purpose: 'lock', status: label });
    assert.equal((await make().checkEscrow({ terms: { ...localTerms, quoteAmount: '1' }, hashHex, purpose: 'settlement' })).status, 'mismatch');
    assert.equal(await make().settlementSignature({ terms: localTerms, hashHex }), null, 'successful history contains no matching claim/refund');
  }
});

test('service config and withdrawal reject malformed config, amounts and destination ownership', async t => {
  const collector = Keypair.generate();
  const config = deriveTradeConfigPda(collector.publicKey);
  const data = configBytes(); collector.publicKey.toBuffer().copy(data, 1); collector.publicKey.toBuffer().copy(data, 33);
  data.writeUInt16LE(50, 65); data[67] = config.bump;
  let wrongOwner = false;
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const { params } = JSON.parse(request.body);
    if (params[0] === config.pda.toBase58()) return response(state(data, { owner: wrongOwner ? key(9).toBase58() : PROGRAM_ID.toBase58() }));
    return response(state(null));
  });
  const a = make({ keypair: collector });
  assert.deepEqual(await a.ensureTradeConfig({ feeBps: 50 }), { ok: true, signature: null });
  assert.equal(await a.tradeFeeBalance(), '0');
  assert.equal((await a.ensureTradeConfig({ feeBps: 1001 })).ok, false);
  for (const amount of ['-1', '1.2', '18446744073709551616', 1]) assert.equal((await a.withdrawTradeFees({ amount, to: key(1) })).ok, false);
  assert.match((await a.withdrawTradeFees({ amount: '1', to: key(1) })).reason, /balance/);
  assert.match((await a.withdrawTradeFees({ amount: '0', to: key(1) })).reason, /missing/);
  wrongOwner = true;
  assert.match((await a.ensureTradeConfig({ feeBps: 50 })).reason, /owner/);
  await assert.rejects(a.tradeFeeBalance(), /owner/);
});

test('decisive escrow and settlement reads default to finalized; confirmed requires explicit opt-in', async t => {
  for (const finality of [undefined, 'confirmed']) {
    const wanted = finality ?? 'finalized';
    t.mock.method(globalThis, 'fetch', async (_url, request) => {
      const { method, params } = JSON.parse(request.body);
      assert.equal(method, 'getAccountInfo'); assert.equal(params[1].commitment, wanted);
      return response({ context: { slot: 100 }, value: params[0] === addresses.escrowPda.toBase58() ? wireAccount() : wireVault() });
    });
    const adapter = make({ finality });
    assert.equal((await adapter.checkEscrow({ terms, hashHex })).ok, true);
    assert.equal((await adapter.checkEscrow({ terms, hashHex, purpose: 'settlement' })).ok, true);
  }
  assert.throws(() => make({ finality: 'processed' }));
  assert.throws(() => make({ intents: {} }));
});

test('chain tip is the highest processed slot any endpoint reports, and needs enough answers', async t => {
  let n = 0;
  t.mock.method(globalThis, 'fetch', async () => { n++; return response(n === 1 ? 500 : 480); });
  assert.equal(await make().tipSlot(), 500);
  t.mock.method(globalThis, 'fetch', async url => (String(url).includes('localhost') ? rpcError() : response(7)));
  await assert.rejects(make().tipSlot(), /Too few endpoints/);
});

test('an absent journal is not proof of nonexecution; a finalized escrow still proves the lock landed', async t => {
  let escrow = null;
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const { method, params } = JSON.parse(request.body);
    if (method === 'getSlot') return response(100);
    assert.equal(method, 'getAccountInfo'); assert.equal(params[1].commitment, 'finalized');
    return response({ context: { slot: 100 }, value: params[0] === addresses.escrowPda.toBase58() ? escrow : wireVault() });
  });
  const adapter = make({ keypair: Keypair.generate() });
  assert.deepEqual(await adapter.lockOutcome({ terms, hashHex }), { ok: true, outcome: 'unknown' });
  escrow = wireAccount();
  assert.deepEqual(await adapter.lockOutcome({ terms, hashHex }), { ok: true, outcome: 'landed' });
});

test('no deposit is signed once the trade send deadline has passed', async () => {
  const payer = Keypair.generate();
  const late = { ...terms, buyer: { ...terms.buyer, solPayer: payer.publicKey.toBase58() }, sendBy: Math.floor(Date.now() / 1000) - 1 };
  const result = await make({ keypair: payer }).lockEscrow({ terms: late, hashHex });
  assert.equal(result.ok, false); assert.equal(result.unknown, undefined); assert.match(result.reason, /Signing window closed/);
});

test('unavailable escrow/history quorum is pending; successful absent or mismatched reads are definitive', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw Error('RPC offline'); });
  assert.equal((await make().checkEscrow({ terms, hashHex, purpose: 'settlement' })).status, 'pending');
  assert.deepEqual(await make().settlementSignature({ terms, hashHex }), { status: 'pending' });
  mockAccounts(t, { escrow: null });
  assert.equal(await make().settlementSignature({ terms, hashHex }), null);
  const escrow = wireAccount(), b = Buffer.from(escrow.data[0], 'base64');
  b[1] = 1; b.writeBigUInt64LE(0n, 138); b.writeBigUInt64LE(0n, 146); b.writeBigUInt64LE(0n, 188); escrow.data[0] = b.toString('base64');
  let history = 'offline';
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    const { method, params } = JSON.parse(request.body);
    if (method === 'getSignaturesForAddress') {
      if (history === 'offline') throw Error('history unavailable');
      return response(history === 'disagree' && String(url).includes('localhost') ? [{ signature: '2'.repeat(88), slot: 95, err: null }] : []);
    }
    return response({ context: { slot: 100 }, value: params[0] === addresses.escrowPda.toBase58() ? escrow : wireVault() });
  });
  for (history of ['offline', 'disagree']) {
    assert.equal((await make().checkEscrow({ terms, hashHex, purpose: 'settlement' })).status, 'pending');
    assert.deepEqual(await make().settlementSignature({ terms, hashHex }), { status: 'pending' });
  }
  history = 'empty';
  assert.equal((await make().checkEscrow({ terms, hashHex, purpose: 'settlement' })).status, 'mismatch');
  assert.equal(await make().settlementSignature({ terms, hashHex }), null);
});
