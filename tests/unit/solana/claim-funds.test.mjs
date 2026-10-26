import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, Message, SystemProgram } from '@solana/web3.js';
import { ACCOUNT_SIZE, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { createSolanaAdapter } from '../../../src/solana/adapter.js';
import { deriveVaultAta } from '../../../src/solana/escrow.js';
import { PROGRAM_ID } from '../../../src/solana/constants.js';
import { requireSellerClaimFunds } from '../../../src/roles/seller-claim-funds.js';
import { key, tokenBytes, wireAccount } from './vectors.mjs';

function fixture(t, { balance = 5000, missing = false, fee = 5000, rent = 2039280, disagree = false } = {}) {
  const owner = Keypair.generate().publicKey, mint = key(4), collector = key(5), reads = [];
  const address = owner.toBase58(), ata = deriveVaultAta(owner, mint).toBase58();
  const endpoints = ['http://127.0.0.1:18899/a', 'http://127.0.0.1:18899/b'];
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.ok(endpoints.includes(String(url)));
    const { method, params } = JSON.parse(request.body); reads.push({ method, params });
    const reply = result => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    if (method === 'getAccountInfo') {
      let value = null;
      if (params[0] === address && balance !== 0) value = { ...wireAccount(Buffer.alloc(0), SystemProgram.programId.toBase58()), lamports: balance };
      else if (params[0] === ata && !missing) {
        const bytes = tokenBytes(); owner.toBuffer().copy(bytes, 32);
        value = wireAccount(bytes, TOKEN_PROGRAM_ID.toBase58());
      } else assert.ok(params[0] === address || params[0] === ata);
      return reply({ context: { slot: 100 }, value });
    }
    if (method === 'getLatestBlockhash') return reply({ value: { blockhash: key(8).toBase58(), lastValidBlockHeight: 200 } });
    if (method === 'getMinimumBalanceForRentExemption') { assert.equal(params[0], ACCOUNT_SIZE); return reply(rent); }
    if (method === 'getFeeForMessage') {
      const message = Message.from(Buffer.from(params[0], 'base64'));
      assert.equal(message.header.numRequiredSignatures, 1); assert.ok(message.accountKeys[0].equals(owner));
      assert.equal(message.instructions.length, 2);
      assert.ok(message.accountKeys[message.instructions[0].programIdIndex].equals(ASSOCIATED_TOKEN_PROGRAM_ID));
      assert.ok(message.accountKeys[message.instructions[1].programIdIndex].equals(PROGRAM_ID));
      assert.ok(message.accountKeys.some(k => k.toBase58() === ata));
      return reply({ context: { slot: 100 }, value: disagree && String(url).endsWith('/b') ? fee + 1 : fee });
    }
    assert.fail(`Unexpected RPC (admission must not send): ${method}`);
  });
  const solana = createSolanaAdapter({ endpoints, need: 2, mint });
  const input = { solana, address, mint: mint.toBase58(), collector: collector.toBase58() };
  return { reads, input, check: () => solana.claimFunds(input), require: () => requireSellerClaimFunds(input) };
}

test('existing USDC ATA: the exact RPC-quoted claim fee is enough, with no rent charge', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.require(), { ok: true, balance: '5000', fee: '5000', rent: '0', required: '5000', shortfall: '0' });
  assert.equal(f.reads.filter(r => r.method === 'getMinimumBalanceForRentExemption').length, 0);
  assert.equal(f.reads.filter(r => r.method === 'getFeeForMessage').length, 2);
});

test('one lamport short refuses selling and names the precise additional SOL and recipient', async t => {
  const f = fixture(t, { balance: 4999 });
  await assert.rejects(f.require(), error => error.message.startsWith(`Add at least 0.000000001 SOL to ${f.input.address} to receive USDC`));
});

test('missing ATA adds actual SPL account rent to the claim fee, including a new zero-SOL wallet', async t => {
  const f = fixture(t, { balance: 0, missing: true });
  assert.deepEqual(await f.check(), { ok: false, balance: '0', fee: '5000', rent: '2039280', required: '2044280', shortfall: '2044280' });
  await assert.rejects(f.require(), /Add at least 0\.00204428 SOL .*claim fee and USDC account rent/);
  assert.equal(f.reads.filter(r => r.method === 'getMinimumBalanceForRentExemption').length, 4);
});

test('missing ATA is admitted with exactly the fee plus the current rent quote', async t => {
  const f = fixture(t, { balance: 3006000, fee: 6000, rent: 3000000, missing: true });
  assert.equal((await f.require()).ok, true);
});

test('missing or disagreeing fee quotes refuse admission instead of assuming the wallet is funded', async t => {
  for (const options of [{ fee: null }, { disagree: true }]) {
    const f = fixture(t, options);
    await assert.rejects(f.require(), /Cannot check SOL needed to receive USDC.*Try again before selling/);
  }
});
