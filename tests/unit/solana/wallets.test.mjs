import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { Keypair, Transaction, SystemProgram, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { createSolanaAdapter } from '../../../src/solana/adapter.js';
import { deriveVaultAta, deriveTradeConfigPda } from '../../../src/solana/escrow.js';
import { USDC_MINT } from '../../../src/solana/constants.js';
import { tokenBytes, configBytes, wireAccount, key } from './vectors.mjs';

function fixture(t) {
  const owner = Keypair.generate(), target = Keypair.generate().publicKey, records = new Map();
  const chain = { sends: [], wires: new Map(), final: false, lost: false, expired: false, badOwner: false, delivered: 1000000, targetOwner: null, clock: null };
  const intents = { get: id => records.get(id), put: (id, value) => records.set(id, structuredClone(value)), delete: id => records.delete(id) };
  const respond = result => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  const config = deriveTradeConfigPda(owner.publicKey);
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const { method, params } = JSON.parse(request.body);
    if (method === 'getAccountInfo') {
      const address = params[0]; let account = null;
      if (address === owner.publicKey.toBase58()) account = { ...wireAccount(Buffer.alloc(0), SystemProgram.programId.toBase58()), lamports: 50000000 };
      for (const wallet of [owner.publicKey, config.pda]) if (address === deriveVaultAta(wallet, USDC_MINT).toBase58()) {
        const bytes = tokenBytes(); new (owner.publicKey.constructor)(USDC_MINT).toBuffer().copy(bytes, 0);
        (chain.badOwner ? target : wallet).toBuffer().copy(bytes, 32); bytes.writeBigUInt64LE(wallet.equals(config.pda) ? 7000000n : 3000000n, 64);
        account = wireAccount(bytes, TOKEN_PROGRAM_ID.toBase58());
      }
      if (address === target.toBase58() && chain.targetOwner) account = wireAccount(Buffer.alloc(165), chain.targetOwner);
      if (address === SYSVAR_CLOCK_PUBKEY.toBase58() && chain.clock !== null) {
        const bytes = Buffer.alloc(40); bytes.writeBigInt64LE(BigInt(chain.clock), 32);
        account = wireAccount(bytes, 'Sysvar1111111111111111111111111111111111111');
      }
      if (address === config.pda.toBase58()) {
        const bytes = configBytes(); owner.publicKey.toBuffer().copy(bytes, 1); owner.publicKey.toBuffer().copy(bytes, 33); bytes[67] = config.bump;
        account = wireAccount(bytes);
      }
      return respond({ context: { slot: 100 }, value: account });
    }
    if (method === 'getLatestBlockhash') return respond({ value: { blockhash: key(8).toBase58(), lastValidBlockHeight: 200 } });
    if (method === 'getBlockHeight') return respond(chain.expired ? 201 : 100);
    if (method === 'getSlot') return respond(200);
    if (method === 'getSignatureStatuses') return respond({ value: [chain.final && chain.sends.length ? { slot: 100, err: null, confirmationStatus: 'finalized' } : null] });
    if (method === 'getTransaction') {
      const wire = chain.wires.get(params[0]);
      if (!wire || !chain.final) return respond(null);
      const keys = Transaction.from(Buffer.from(wire, 'base64')).compileMessage().accountKeys, lamports = keys.map(() => 1000);
      const wallet = keys.findIndex(k => k.equals(target)), ata = keys.findIndex(k => k.equals(deriveVaultAta(target, USDC_MINT)));
      return respond({ slot: 100, transaction: [wire, 'base64'], meta: { err: null, preBalances: lamports,
        postBalances: lamports.map((n, i) => i === wallet ? n + chain.delivered : n), preTokenBalances: [],
        postTokenBalances: ata < 0 ? [] : [{ accountIndex: ata, mint: USDC_MINT.toBase58(), uiTokenAmount: { amount: String(chain.delivered), decimals: 6 } }] } });
    }
    if (method === 'sendTransaction') {
      const tx = Transaction.from(Buffer.from(params[0], 'base64'));
      chain.wires.set(bs58.encode(tx.signature), params[0]);
      assert.ok([...records.values()].some(r => r.entries.some(e => e.wire === params[0] && e.sent)), 'signed transaction is durable before send');
      chain.sends.push(tx);
      if (chain.lost) throw Error('lost response');
      chain.final = true; return respond(bs58.encode(tx.signature));
    }
    assert.fail(method);
  });
  const create = options => createSolanaAdapter({ endpoints: ['http://127.0.0.1:12345'], need: 1, sendEndpoint: 'http://127.0.0.1:12345',
    keypair: owner, intents, commitment: 'finalized', finality: 'finalized', confirmationTimeoutMs: 400, ...options });
  return { owner, target, chain, create, records };
}

test('wallet balances use validated mint/owner accounts and include service collected fees', async t => {
  const f = fixture(t), a = f.create();
  assert.deepEqual(await a.walletBalances(), { SOL: '50000000', USDC: '3000000', collectedFees: '0' });
  assert.deepEqual(await a.walletBalances(f.owner.publicKey, { fees: true }), { SOL: '50000000', USDC: '10000000', collectedFees: '7000000' });
  f.chain.badOwner = true; await assert.rejects(a.walletBalances(), /owner/);
});

for (const asset of ['SOL', 'USDC']) test(`${asset} wallet withdrawal: destination owner, idempotent ATA, exact amounts and restart without double send`, async t => {
  const f = fixture(t), input = { id: 'ab'.repeat(32), asset, amount: '1000000', to: f.target.toBase58() };
  const result = await f.create().walletWithdraw(input); assert.equal(result.ok, true, result.reason);
  const tx = f.chain.sends[0]; assert.ok(tx.verifySignatures()); assert.ok(tx.feePayer.equals(f.owner.publicKey));
  if (asset === 'SOL') { assert.equal(tx.instructions.length, 1); assert.ok(tx.instructions[0].programId.equals(SystemProgram.programId)); assert.equal(tx.instructions[0].data.readBigUInt64LE(4), 1000000n); }
  else {
    assert.ok(tx.instructions[0].programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)); assert.equal(tx.instructions[0].data[0], 1);
    assert.ok(tx.instructions[0].keys[2].pubkey.equals(f.target));
    assert.ok(tx.instructions[1].programId.equals(TOKEN_PROGRAM_ID)); assert.equal(tx.instructions[1].data[0], 12);
    assert.equal(tx.instructions[1].data.readBigUInt64LE(1), 1000000n);
    assert.ok(tx.instructions[1].keys[2].pubkey.equals(deriveVaultAta(f.target, USDC_MINT)));
  }
  const restarted = f.create(), status = await restarted.walletWithdrawalStatus(input.id);
  assert.deepEqual(status, { ok: true, unknown: false, signature: result.signature, slot: 100 });
  assert.equal((await restarted.walletWithdraw(input)).signature, result.signature); assert.equal(f.chain.sends.length, 1);
  const mismatch = await restarted.walletWithdraw({ ...input, amount: '2' }); assert.equal(mismatch.ok, false); assert.match(mismatch.reason, /differ/);
  // Confirmation needs the amount to arrive in the transaction's own balance records.
  f.chain.delivered = 999999;
  const short = await f.create().walletWithdrawalStatus(input.id); assert.equal(short.ok, false); assert.equal(short.unknown, undefined);
  assert.match(short.reason, /do not match/);
});

test('a withdrawal never recorded as signed is definitely not sent', async t => {
  const status = await fixture(t).create().walletWithdrawalStatus('ef'.repeat(32));
  assert.deepEqual(status, { ok: false, unknown: false, reason: 'Not sent: no signed withdrawal was recorded' });
});

test('an expired withdrawal with no status after expiry is not executed; one too old to search stays unconfirmed; neither is signed again', async t => {
  for (const old of [false, true]) {
    const f = fixture(t); f.chain.lost = true;
    const input = { id: 'bc'.repeat(32), asset: 'SOL', amount: '1000000', to: f.target.toBase58() };
    const first = await f.create().walletWithdraw(input); assert.equal(first.unknown, true); assert.ok(f.chain.sends.length);
    const count = f.chain.sends.length; f.chain.expired = true;
    if (old) for (const journal of f.records.values()) journal.entries[0].createdAt -= 7 * 3600 * 1000;
    const next = await f.create().walletWithdrawalStatus(input.id);
    if (old) { assert.equal(next.unknown, true); assert.match(next.reason, /unknown/); }
    else assert.deepEqual(next, { ok: false, unknown: false, signature: first.signature, reason: 'Not executed: the transaction expired without landing; nothing was sent' });
    assert.equal(f.chain.sends.length, count);
  }
});

test('account owner reads report the owning program, or null for a missing account', async t => {
  const f = fixture(t), a = f.create(), to = f.target.toBase58();
  assert.equal(await a.accountOwner(to), null);
  f.chain.targetOwner = TOKEN_PROGRAM_ID.toBase58(); assert.equal(await a.accountOwner(to), TOKEN_PROGRAM_ID.toBase58());
});

test('chain time is the median Clock of the readers that answer, at least need of them', async t => {
  const urls = ['http://127.0.0.1:12345/', 'http://127.0.0.1:12346/', 'http://127.0.0.1:12347/'], times = { [urls[0]]: 1000, [urls[1]]: 1002, [urls[2]]: 999999 };
  let down = [];
  t.mock.method(globalThis, 'fetch', async url => {
    if (down.includes(String(url))) throw Error('down');
    const bytes = Buffer.alloc(40); bytes.writeBigInt64LE(BigInt(times[String(url)]), 32);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 100 }, value: wireAccount(bytes, 'Sysvar1111111111111111111111111111111111111') } }));
  });
  const a = createSolanaAdapter({ endpoints: urls, need: 2 });
  assert.equal(await a.chainTime(), 1002);
  down = [urls[2]]; assert.equal(await a.chainTime(), 1000);
  down = [urls[1], urls[2]]; await assert.rejects(a.chainTime(), /Too few endpoints/);
});

test('service withdrawal atomically pulls fee vault funds to collector ATA then pays destination owner', async t => {
  const f = fixture(t);
  const result = await f.create().walletWithdraw({ id: 'cd'.repeat(32), asset: 'USDC', amount: '5000000', to: f.target.toBase58(), fees: true });
  assert.equal(result.ok, true, result.reason); assert.equal(f.chain.sends[0].instructions.length, 4);
  const [targetAta, ownAta, fees, transfer] = f.chain.sends[0].instructions;
  assert.ok(ownAta.keys[2].pubkey.equals(f.owner.publicKey)); assert.ok(targetAta.keys[2].pubkey.equals(f.target));
  assert.equal(fees.data.readBigUInt64LE(1), 2000000n); assert.equal(transfer.data.readBigUInt64LE(1), 5000000n);
  assert.equal((await f.create({ intents: null }).walletWithdraw({ id: 'de'.repeat(32), asset: 'SOL', amount: '1', to: f.target.toBase58() })).ok, false);
});

test('a balance read retries while two readers straddle a change, and gives up after four disagreements or on errors', async t => {
  const owner = Keypair.generate(), urls = ['http://127.0.0.1:12345/', 'http://127.0.0.1:12346/'];
  let calls = 0, settleAfter = 3, fail = false;
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    // Only the SOL account changes here; the token account does not exist.
    if (JSON.parse(request.body).params[0] !== owner.publicKey.toBase58()) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 100 }, value: null } }));
    calls++;
    if (fail && String(url) === urls[1]) throw Error('down');
    // The second reader sees the newer value until the change has reached both.
    const lamports = String(url) === urls[1] && calls <= settleAfter * 2 ? 2 : 1;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 100 },
      value: { ...wireAccount(Buffer.alloc(0), SystemProgram.programId.toBase58()), lamports } } }));
  });
  const a = createSolanaAdapter({ endpoints: urls, need: 2, commitment: 'finalized', finality: 'finalized' });
  const read = () => a.walletBalances(owner.publicKey.toBase58());
  assert.equal((await read()).SOL, '1'); assert.ok(calls >= 8);
  calls = 0; settleAfter = 10; await assert.rejects(read(), /No fresh account quorum/); assert.ok(calls <= 4 * 4);
  calls = 0; settleAfter = 0; fail = true; await assert.rejects(read(), /No fresh account quorum/); assert.ok(calls <= 4, 'errors are not retried');
});
