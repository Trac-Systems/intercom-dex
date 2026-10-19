import test from 'node:test';
import assert from 'node:assert/strict';
import { checkEscrow } from '../../../src/solana/check.js';
import { terms, hashHex, addresses, wireAccount, wireVault, key } from './vectors.mjs';

const endpoints = ['http://127.0.0.1:18060/a', 'http://127.0.0.1:18060/b', 'http://127.0.0.1:18060/c'];

function fixture(t, { escrow = wireAccount(), vault = wireVault(), escrowError = false, vaultError = false } = {}) {
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const body = JSON.parse(request.body);
    const isEscrow = body.params[0] === addresses.escrowPda.toBase58();
    if (isEscrow ? escrowError : vaultError) throw new Error('offline');
    if (!isEscrow) assert.equal(body.params[1].minContextSlot, 100);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 100 }, value: isEscrow ? escrow : vault } }));
  });
}

function changed(value, modify) {
  const result = structuredClone(value);
  const b = Buffer.from(result.data[0], 'base64'); modify(b);
  result.data[0] = b.toString('base64'); return result;
}

test('seller accepts matching terms, exact fees, sufficient vault and overfunding', async t => {
  fixture(t);
  const result = await checkEscrow({ terms, hashHex, endpoints });
  assert.equal(result.ok, true); assert.deepEqual(result.reasons, []);
  assert.equal(result.address, addresses.escrowPda.toBase58()); assert.equal(result.reads.vault.agreeing.length, 3);
  assert.equal((await checkEscrow({ terms: { ...terms, quoteAmount: '1' }, hashHex, endpoints })).reasons[0].code, 'NET_AMOUNT');
  fixture(t, { vault: changed(wireVault(), b => b.writeBigUInt64LE(2000000n, 64)) });
  assert.equal((await checkEscrow({ terms, hashHex, endpoints })).ok, true);
});

test('every escrow rejection has a structured reason', async t => {
  const changes = [
    ['STATUS', b => { b[1] = 1; }], ['HASH', b => { b[2] ^= 1; }], ['BUMP', b => { b[262] ^= 1; }],
    ['RECIPIENT', b => { b[34] ^= 1; }], ['REFUND_AUTHORITY', b => { b[66] ^= 1; }], ['MINT', b => { b[106] ^= 1; }],
    ['NET_AMOUNT', b => b.writeBigUInt64LE(1n, 138)], ['REFUND_AFTER', b => b.writeBigInt64LE(1n, 98)],
    ['PLATFORM_FEE_BPS', b => b.writeUInt16LE(9, 154)], ['TRADE_FEE_BPS', b => b.writeUInt16LE(49, 196)],
    ['PLATFORM_COLLECTOR', b => { b[156] ^= 1; }], ['TRADE_COLLECTOR', b => { b[198] ^= 1; }],
    ['FEE_AMOUNTS', b => b.writeBigUInt64LE(1n, 146)], ['FEE_AMOUNTS', b => b.writeUInt16LE(501, 154)],
    ['VAULT_ADDRESS', b => { b[230] ^= 1; }], ['ESCROW_DATA', b => { b[0] = 1; }],
  ];
  for (const [code, mutate] of changes) {
    fixture(t, { escrow: changed(wireAccount(), mutate) });
    const result = await checkEscrow({ terms, hashHex, endpoints });
    assert.equal(result.ok, false, code); assert.ok(result.reasons.some(r => r.code === code), code);
  }
  for (const [code, config] of [
    ['ESCROW_MISSING', { escrow: null }], ['ESCROW_OWNER', { escrow: { ...wireAccount(), owner: key(9).toBase58() } }],
    ['ESCROW_OWNER', { escrow: { ...wireAccount(), executable: true } }], ['ESCROW_QUORUM', { escrowError: true }],
  ]) {
    fixture(t, config); assert.equal((await checkEscrow({ terms, hashHex, endpoints })).reasons[0].code, code);
  }
});

test('every vault rejection has a structured reason', async t => {
  for (const [code, mutate] of [
    ['VAULT_MINT', b => { b[0] ^= 1; }], ['VAULT_AUTHORITY', b => { b[32] ^= 1; }],
    ['VAULT_STATE', b => { b[108] = 0; }], ['VAULT_STATE', b => { b[108] = 2; }],
    ['VAULT_CONTROL', b => { b.writeUInt32LE(1, 72); key(9).toBuffer().copy(b, 76); }],
    ['VAULT_CONTROL', b => { b.writeUInt32LE(1, 129); key(9).toBuffer().copy(b, 133); }],
    ['VAULT_BALANCE', b => b.writeBigUInt64LE(1234567n, 64)],
  ]) {
    fixture(t, { vault: changed(wireVault(), mutate) });
    const result = await checkEscrow({ terms, hashHex, endpoints });
    assert.equal(result.ok, false, code); assert.ok(result.reasons.some(r => r.code === code), code);
  }
  for (const [code, config] of [
    ['VAULT_MISSING', { vault: null }], ['VAULT_OWNER', { vault: { ...wireVault(), owner: key(9).toBase58() } }],
    ['VAULT_OWNER', { vault: { ...wireVault(), executable: true } }],
    ['VAULT_DATA', { vault: { ...wireVault(), data: ['AA==', 'base64'] } }], ['VAULT_QUORUM', { vaultError: true }],
  ]) {
    fixture(t, config); assert.equal((await checkEscrow({ terms, hashHex, endpoints })).reasons[0].code, code);
  }
});

test('missing or malformed terms fail without making RPC calls', async t => {
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('must not fetch'); });
  for (const bad of [null, {}, { ...terms, quoteAmount: 0 }, { ...terms, quoteAmount: 2 ** 64 }, { ...terms, refundAfter: '9223372036854775808' }, { ...terms, fees: {} }]) {
    assert.equal((await checkEscrow({ terms: bad, hashHex, endpoints })).reasons[0].code, 'INVALID_TERMS');
  }
  assert.equal((await checkEscrow({ terms, hashHex: 'bad', endpoints })).reasons[0].code, 'INVALID_TERMS');
});
