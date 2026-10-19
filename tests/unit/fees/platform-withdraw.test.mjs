import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { createFeeReader } from '../../../src/solana/fee-reader.js';
import { withdrawPlatform } from '../../../src/fees/platform-withdraw.js';
import { readAuthorityKeypair } from '../../../src/fees/input.js';
import { deriveConfigPda, deriveVaultAta } from '../../../src/solana/escrow.js';
import { PROGRAM_ID } from '../../../src/solana/constants.js';
import { chainFixture } from './chain.mjs';

const root = resolve('.test-tmp/wallet-fees'); mkdirSync(root, { recursive: true });
function setup(t) {
  const f = chainFixture(t), records = new Map(), dir = mkdtempSync(join(root, 'withdraw-'));
  const authorityFile = join(dir, 'throwaway-authority.json'); writeFileSync(authorityFile, JSON.stringify([...f.platform.secretKey]), { mode: 0o600 });
  const store = { get: key => structuredClone(records.get(key)), put: (key, value) => records.set(key, structuredClone(value)) };
  const reader = createFeeReader({ endpoints: ['http://127.0.0.1:12345'], need: 1, programId: PROGRAM_ID, mint: f.mint });
  const load = () => readAuthorityKeypair(authorityFile);
  const run = (extra = {}) => {
    const authority = extra.authority ?? load();
    return withdrawPlatform({ store, reader, solana: f.adapter(authority), authority, mint: f.mint.toBase58(), to: f.buyer.publicKey.toBase58(), ...extra });
  };
  f.token(deriveConfigPda().pda, 12345n);
  return { ...f, records, store, reader, load, run, authorityFile };
}

test('platform withdrawal pays through authority ATA atomically, checks finalized balances and wipes the signing buffer', async t => {
  const f = setup(t), authority = f.load();
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, request) => {
    if (JSON.parse(request.body).method === 'sendTransaction') assert.ok(authority.secretKey.every(b => b === 0), 'wiped before sending');
    return fetch(url, request);
  });
  const result = await f.run({ authority, amount: '0.01' }); assert.equal(result.ok, true);
  assert.equal(f.balance(deriveVaultAta(deriveConfigPda().pda, f.mint)), 2345n);
  assert.equal(f.balance(deriveVaultAta(f.buyer.publicKey, f.mint)), 100010000n);
  assert.equal(f.balance(deriveVaultAta(f.platform.publicKey, f.mint)), 0n);
  assert.ok(authority.secretKey.every(b => b === 0));
  const tx = f.chain.sends[0].tx;
  assert.ok(tx.feePayer.equals(f.platform.publicKey)); assert.equal(tx.signatures.length, 1);
  assert.equal(tx.instructions[1].data[0], 5); assert.equal(tx.instructions.at(-1).data[0], 12);
  const stored = JSON.stringify([...f.records.values(), ...f.intents.get(`solana-intents/v1/${PROGRAM_ID}/${f.platform.publicKey}`).entries]);
  assert.ok(!stored.includes(f.authorityFile)); assert.ok(!stored.includes(Buffer.from(f.platform.secretKey).toString('hex')));
  assert.ok(f.chain.reads.filter(r => r.method === 'getTransaction').every(r => r.params[1].commitment === 'finalized'));
  const own = await f.run({ to: f.platform.publicKey.toBase58() }); assert.equal(own.ok, true);
  assert.equal(f.balance(deriveVaultAta(f.platform.publicKey, f.mint)), 2345n); assert.equal(f.chain.sends[1].tx.instructions.length, 2);
  assert.deepEqual(await f.run(), { ok: true, empty: true, message: 'Platform fee vault is empty' });
});

test('arbitrary SPL mint uses its actual decimals, not the profile USDC precision', async t => {
  const f = setup(t), mint = Keypair.generate().publicKey;
  const account = structuredClone(f.accounts.get(f.mint.toBase58())), bytes = Buffer.from(account.data[0], 'base64'); bytes[44] = 9; account.data[0] = bytes.toString('base64'); f.accounts.set(mint.toBase58(), account);
  f.token(deriveConfigPda().pda, 123456789n, mint);
  assert.equal((await f.run({ mint: mint.toBase58(), amount: '0.123456789' })).ok, true);
  assert.equal(f.balance(deriveVaultAta(f.buyer.publicKey, mint)), 123456789n);
  assert.equal(f.chain.sends[0].tx.instructions.at(-1).data[9], 9);
});

test('wrong authority, invalid/oversize amounts and invalid mint fail before signing; all on empty is successful', async t => {
  const f = setup(t);
  for (const amount of ['0', '-1', '01', '1e2', '0.0000001', '999999999999999999999999', '0.02']) await assert.rejects(f.run({ amount }));
  const stranger = { publicKey: f.seller.publicKey, secretKey: f.seller.secretKey };
  await assert.rejects(f.run({ authority: stranger }), /authority/); assert.ok(stranger.secretKey.every(b => b === 0));
  await assert.rejects(f.run({ mint: Keypair.generate().publicKey.toBase58() }), /mint/);
  assert.equal(f.chain.sends.length, 0); assert.equal(f.records.size, 0);
  f.token(deriveConfigPda().pda, 0n); assert.equal((await f.run()).empty, true);
});

test('lost response at confirmed recovers the same signed attempt only after finalized, with no second payment', async t => {
  const f = setup(t); f.chain.final = false; f.chain.drop = true;
  const authority = f.load();
  await assert.rejects(f.run({ authority, solana: f.adapter(authority, { commitment: 'confirmed' }) }), /Pending transaction/);
  assert.equal([...f.records.values()][0].phase, 'requested');
  await assert.rejects(f.run({ to: f.seller.publicKey.toBase58() }), /pending/);
  const sends = f.chain.sends.length;
  f.chain.final = true;
  const result = await f.run(); assert.equal(result.ok, true);
  assert.equal(f.chain.sends.length, sends);
  assert.equal(f.balance(deriveVaultAta(f.buyer.publicKey, f.mint)), 100012345n);
});

test('crashes before signing and after payment but before completion preserve request id and cannot pay twice', async t => {
  const f = setup(t);
  await assert.rejects(f.run({ solana: { withdrawPlatformFees: async () => { throw Error('crash before signing'); } } }), /before signing/);
  const id = [...f.records.values()][0].id;
  const put = f.store.put; f.store.put = (key, value) => { if (value.phase === 'complete') throw Error('crash after payment'); return put(key, value); };
  await assert.rejects(f.run(), /after payment/);
  const sends = f.chain.sends.length; f.store.put = put;
  assert.equal((await f.run()).ok, true); assert.equal(f.chain.sends.length, sends);
  assert.equal([...f.records.values()][0].id, id); assert.equal(f.balance(deriveVaultAta(f.buyer.publicKey, f.mint)), 100012345n);
});

test('missing or contradictory finalized balance evidence stays pending and a retry never signs another withdrawal', async t => {
  const f = setup(t), original = globalThis.fetch;
  let lie = true;
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    const result = await original(url, request);
    if (JSON.parse(request.body).method !== 'getTransaction' || !lie) return result;
    const value = await result.json(); value.result.meta.postTokenBalances = [];
    return new Response(JSON.stringify(value));
  });
  await assert.rejects(f.run(), /quorum/i);
  assert.equal([...f.records.values()][0].phase, 'requested'); const sends = f.chain.sends.length;
  lie = false; assert.equal((await f.run()).ok, true); assert.equal(f.chain.sends.length, sends);
});

test('crash after durable completion replays an explicit amount; fresh fees permit another withdrawal', async t => {
  const f = setup(t), put = f.store.put;
  f.store.put = (key, value) => { put(key, value); if (value.phase === 'complete') throw Error('crash before stdout'); };
  await assert.rejects(f.run({ amount: '0.005' }), /before stdout/);
  f.store.put = put;
  const result = await f.run({ amount: '0.005' }); assert.equal(result.existing, true); assert.equal(f.chain.sends.length, 1);
  assert.equal(f.balance(deriveVaultAta(deriveConfigPda().pda, f.mint)), 7345n);
  assert.ok(f.chain.reads.some(r => r.method === 'getAccountInfo' && r.params[1].minContextSlot === 100));
  f.token(deriveConfigPda().pda, 12345n); f.chain.generation++;
  assert.equal((await f.run({ amount: '0.005' })).ok, true); assert.equal(f.chain.sends.length, 2);
  assert.equal(f.balance(deriveVaultAta(f.buyer.publicKey, f.mint)), 100010000n);
});

test('expired sent withdrawal: too old for a history search it stays unknown; proven absent it is signed again for the same request', async t => {
  const f = setup(t), original = globalThis.fetch, id = `solana-intents/v1/${PROGRAM_ID}/${f.platform.publicKey}`;
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    if (JSON.parse(request.body).method === 'sendTransaction') throw Error('lost before acceptance');
    return original(url, request);
  });
  await assert.rejects(f.run(), /Pending/); f.chain.height = 201;
  const journal = f.intents.get(id), createdAt = journal.entries[0].createdAt;
  journal.entries[0].createdAt = createdAt - 7 * 3600 * 1000; f.intents.put(id, journal);
  await assert.rejects(f.run(), /unknown/);
  assert.equal(f.intents.get(id).entries[0].attempt, 1); assert.equal([...f.records.values()][0].phase, 'requested');
  journal.entries[0].createdAt = createdAt; f.intents.put(id, journal);
  // No status anywhere after expiry: the first attempt never executed, so this authority signs a second one.
  await assert.rejects(f.run(), /sign again/);
  assert.equal(f.intents.get(id).entries[0].attempt, 2); assert.equal([...f.records.values()][0].phase, 'requested');
});
