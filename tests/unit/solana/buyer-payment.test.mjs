import test from 'node:test';
import assert from 'node:assert/strict';
import { SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { buyerPayment } from '../../../src/solana/buyer-payment.js';
import { terms, wireAccount, addresses } from './vectors.mjs';
const endpoints = ['http://127.0.0.1:18899', 'http://localhost:18899'];
const after = terms.refundAfter - 900;
function mock(t, { rows = [], time = after, scanSlot = 100, badClock = false, secondRows = rows } = {}) {
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    const { method, params } = JSON.parse(request.body); let result;
    if (method === 'getAccountInfo') {
      assert.equal(params[0], SYSVAR_CLOCK_PUBKEY.toBase58()); assert.equal(params[1].commitment, 'finalized');
      const bytes = Buffer.alloc(40); bytes.writeBigInt64LE(BigInt(time), 32);
      result = { context: { slot: 100 }, value: badClock ? null : { owner: 'Sysvar1111111111111111111111111111111111111', executable: false,
        lamports: 1, data: [bytes.toString('base64'), 'base64'] } };
    } else {
      assert.equal(method, 'getProgramAccounts'); assert.equal(params[1].minContextSlot, 100);
      assert.equal(params[1].commitment, 'finalized'); assert.equal(params[1].withContext, true);
      assert.deepEqual(params[1].filters, [{ dataSize: 263 }, { memcmp: { offset: 66, bytes: terms.buyer.solPayer } }]);
      result = { context: { slot: scanSlot }, value: String(url).includes('localhost') ? secondRows : rows };
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  });
}
const scan = () => buyerPayment({ terms, after, endpoints });
const payment = () => ({ pubkey: addresses.escrowPda.toBase58(), account: wireAccount() });

test('buyer no-deal absence requires a complete finalized payer scan after the deadline on agreeing readers', async t => {
  mock(t); assert.deepEqual(await scan(), { ok: true, seen: false, chainTime: after });
  mock(t, { time: after - 1 }); assert.deepEqual(await scan(), { ok: false, reason: 'chain-behind' });
  mock(t, { rows: [payment()] }); assert.equal((await scan()).seen, true);
});

test('any matching active, claimed or refunded payment attempt exempts even when amount differs', async t => {
  for (const status of [0, 1, 2]) {
    const row = payment(), bytes = Buffer.from(row.account.data[0], 'base64');
    bytes[1] = status; bytes.writeBigUInt64LE(1n, 138); row.account.data[0] = bytes.toString('base64');
    mock(t, { rows: [row] }); assert.equal((await scan()).seen, true);
  }
});

test('unavailable, truncated, stale, malformed or disagreeing scans never prove absence', async t => {
  for (const options of [{ rows: null }, { scanSlot: 99 }, { badClock: true }, { rows: [{}] },
    { rows: [], secondRows: [payment()] }, { rows: [{ ...payment(), pubkey: terms.mint }] }]) {
    mock(t, options); await assert.rejects(scan(), undefined, JSON.stringify(options));
  }
  t.mock.method(globalThis, 'fetch', async () => { throw Error('offline'); }); await assert.rejects(scan());
});
