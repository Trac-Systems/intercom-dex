import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { deriveConfigPda, deriveTradeConfigPda, deriveVaultAta } from '../../../src/solana/escrow.js';
import { chainFixture } from './chain.mjs';

test('fresh collector config uses main transaction payer, collector signature and atomic rent funding; never edits an old config', async t => {
  const f = chainFixture(t), collector = Keypair.generate(), a = f.adapter();
  const result = await a.createCollectorConfig({ collectorKeypair: collector, feeBps: 75 }); assert.equal(result.ok, true, result.reason);
  const tx = f.chain.sends[0].tx;
  assert.ok(tx.feePayer.equals(f.main.publicKey)); assert.equal(tx.signatures.length, 2);
  assert.ok(tx.instructions[0].programId.equals(SystemProgram.programId)); assert.equal(tx.instructions[0].data.readBigUInt64LE(4), 1365120n);
  assert.ok(tx.instructions[0].keys[1].pubkey.equals(collector.publicKey)); assert.equal(tx.instructions[1].data[0], 6);
  assert.equal((await f.adapter().createCollectorConfig({ collectorKeypair: collector, feeBps: 75 })).ok, true);
  assert.equal(f.chain.configs, 1); assert.equal(f.chain.sends.length, 1);
  const changed = await a.createCollectorConfig({ collectorKeypair: collector, feeBps: 80 });
  assert.equal(changed.ok, false); assert.match(changed.reason, /different bps/); assert.equal(f.chain.sends.length, 1);
  assert.equal((await a.createCollectorConfig({ collectorKeypair: collector, feeBps: 1001 })).ok, false);
  assert.equal((await f.adapter(f.main, { intents: null }).createCollectorConfig({ collectorKeypair: Keypair.generate(), feeBps: 20 })).ok, false);
});

test('confirmed collector config and lost response recover through journal, finalized readback gates publication', async t => {
  const f = chainFixture(t), collector = Keypair.generate(); f.chain.final = false; f.chain.drop = true;
  const fee = { collector: collector.publicKey.toBase58(), tradeFeeBps: 75, platformFeeBps: 10 };
  const first = await f.adapter().createCollectorConfig({ collectorKeypair: collector, feeBps: 75 });
  assert.equal(first.unknown, true); assert.ok(first.signature);
  await assert.rejects(f.adapter().assertFeeConfig(fee), /matching finalized/);
  f.chain.final = true;
  assert.equal((await f.adapter().createCollectorConfig({ collectorKeypair: collector, feeBps: 75 })).ok, true);
  await f.adapter().assertFeeConfig(fee, f.platform.publicKey.toBase58());
  assert.equal(f.chain.sends.length, 1); assert.equal(f.chain.configs, 1);
  assert.ok(f.chain.reads.filter(r => r.method === 'getAccountInfo').every(r => r.params[1].commitment === 'finalized'));
});

test('registry validation refuses absent, wrong-bps, wrong-platform, malformed and unavailable finalized configs', async t => {
  const f = chainFixture(t), a = f.adapter(), fee = { collector: f.main.publicKey.toBase58(), tradeFeeBps: 50, platformFeeBps: 10 };
  await a.assertFeeConfig(fee, f.platform.publicKey.toBase58());
  assert.deepEqual(await a.platformFeeConfig(), { feeBps: 10, authority: f.platform.publicKey.toBase58(), collector: f.platform.publicKey.toBase58() });
  for (const patch of [{ collector: Keypair.generate().publicKey.toBase58() }, { tradeFeeBps: 51 }, { platformFeeBps: 11 }]) await assert.rejects(a.assertFeeConfig({ ...fee, ...patch }));
  await assert.rejects(a.assertFeeConfig(fee, f.buyer.publicKey.toBase58()), /platform/);
  const saved = f.accounts.get(deriveTradeConfigPda(f.main.publicKey).pda.toBase58()); saved.owner = SystemProgram.programId.toBase58();
  await assert.rejects(a.assertFeeConfig(fee), /owner/);
  f.accounts.delete(deriveConfigPda().pda.toBase58()); await assert.rejects(a.platformFeeConfig(), /missing/);
  t.mock.method(globalThis, 'fetch', async () => { throw Error('offline'); });
  await assert.rejects(a.assertFeeConfig(fee), /quorum/i);
});

test('old and new terms lock and claim into distinct collectors after rotation with exact balances', async t => {
  const f = chainFixture(t), collector = Keypair.generate(), a = f.adapter();
  const terms = { buyer: { solPayer: f.buyer.publicKey.toBase58() }, seller: { solRecipient: f.seller.publicKey.toBase58() },
    mint: f.mint.toBase58(), quoteAmount: '1000000', sendBy: Math.floor(Date.now() / 1000) + 1000, refundAfter: Math.floor(Date.now() / 1000) + 2000,
    fees: { platformFeeBps: 10, platformCollector: f.platform.publicKey.toBase58(), tradeFeeBps: 50, collector: f.main.publicKey.toBase58() } };
  assert.equal((await a.createCollectorConfig({ collectorKeypair: collector, feeBps: 75 })).ok, true);
  const newTerms = { ...terms, fees: { ...terms.fees, tradeFeeBps: 75, collector: collector.publicKey.toBase58() } };
  for (const [i, agreed] of [terms, newTerms].entries()) {
    const preimageHex = (i ? '23' : '22').repeat(32), hashHex = createHash('sha256').update(Buffer.from(preimageHex, 'hex')).digest('hex');
    const input = { terms: agreed, hashHex, preimageHex };
    const locked = await f.adapter(f.buyer).lockEscrow(input); assert.equal(locked.ok, true, locked.reason);
    assert.equal((await f.adapter().checkEscrow(input)).ok, true);
    const claimed = await f.adapter(f.seller).claim(input); assert.equal(claimed.ok, true, claimed.reason);
    assert.equal((await f.adapter().checkEscrow({ ...input, purpose: 'settlement' })).status, 'claimed');
  }
  assert.equal(f.configBalance(f.main.publicKey), 5000n); assert.equal(f.configBalance(collector.publicKey), 7500n);
  assert.equal(f.balance(deriveVaultAta(f.buyer.publicKey, f.mint)), 97985500n);
  assert.equal(f.balance(deriveVaultAta(f.seller.publicKey, f.mint)), 2000000n);
  assert.equal(f.balance(deriveVaultAta(deriveConfigPda().pda, f.mint)), 2000n);
});

test('platform SetConfig is authority signed, finalized and recoverable without storing the authority secret', async t => {
  const f = chainFixture(t), input = { id: 'ab'.repeat(32), feeBps: 30, authority: f.platform.publicKey.toBase58(), authorityKeypair: f.platform };
  f.chain.final = false; f.chain.drop = true;
  const first = await f.adapter().setPlatformConfig(input); assert.equal(first.unknown, true);
  const tx = f.chain.sends[0].tx; assert.ok(tx.feePayer.equals(f.main.publicKey)); assert.equal(tx.instructions[0].data[0], 4);
  assert.equal(tx.signatures.length, 2);
  assert.ok(!JSON.stringify([...f.records.values()]).includes(Buffer.from(f.platform.secretKey).toString('hex')));
  f.chain.final = true;
  const next = await f.adapter().setPlatformConfig({ ...input, authorityKeypair: null }); assert.equal(next.ok, true, next.reason);
  assert.equal(f.chain.sends.length, 1);
  const fee = { collector: f.main.publicKey.toBase58(), tradeFeeBps: 50, platformFeeBps: 30 };
  await f.adapter().assertFeeConfig(fee);
  assert.equal((await f.adapter().setPlatformConfig({ ...input, id: 'bc'.repeat(32), feeBps: 40, authorityKeypair: null })).ok, false);
  assert.match((await f.adapter().setPlatformConfig({ ...input, authority: f.buyer.publicKey.toBase58() })).reason, /authority/);
  assert.equal((await f.adapter().setPlatformConfig({ ...input, feeBps: 501 })).ok, false);
});

test('old platform terms fail plainly before a lock signs or moves funds', async t => {
  const f = chainFixture(t); f.config(f.platform.publicKey, 30, false);
  const terms = { buyer: { solPayer: f.buyer.publicKey.toBase58() }, seller: { solRecipient: f.seller.publicKey.toBase58() },
    mint: f.mint.toBase58(), quoteAmount: '1000000', sendBy: Math.floor(Date.now() / 1000) + 1000, refundAfter: Math.floor(Date.now() / 1000) + 2000,
    fees: { platformFeeBps: 10, platformCollector: f.platform.publicKey.toBase58(), tradeFeeBps: 50, collector: f.main.publicKey.toBase58() } };
  const result = await f.adapter(f.buyer).lockEscrow({ terms, hashHex: '22'.repeat(32) });
  assert.deepEqual(result, { ok: false, reason: 'platform fee changed, take again' });
  assert.equal(f.chain.sends.length, 0); assert.equal(f.records.size, 0);
  assert.equal(f.balance(deriveVaultAta(f.buyer.publicKey, f.mint)), 100000000n);
});

test('a platform attempt expiring during recovery asks for the authority again before signing a replacement', async t => {
  const f = chainFixture(t), id = 'de'.repeat(32), originalFetch = globalThis.fetch;
  let sent = false, expire = false;
  t.mock.method(globalThis, 'fetch', async (url, req) => {
    const { method } = JSON.parse(req.body);
    const reply = result => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    if (method === 'sendTransaction') { sent = true; throw Error('dropped before acceptance'); }
    if (method === 'getSignatureStatuses') { if (expire) f.chain.height = 201; return reply({ value: [null] }); }
    return originalFetch(url, req);
  });
  const input = { id, feeBps: 30, authority: f.platform.publicKey.toBase58(), authorityKeypair: f.platform };
  const first = await f.adapter().setPlatformConfig(input); assert.equal(first.unknown, true); assert.ok(sent);
  const restarted = f.adapter(); await restarted.pendingIntents();
  expire = true;
  const next = await restarted.setPlatformConfig({ ...input, authorityKeypair: null });
  assert.equal(next.ok, false); assert.match(next.reason, /authority keypair required/);
  assert.equal(f.chain.reads.filter(r => r.method === 'getLatestBlockhash').length, 1, 'no replacement blockhash or signature');
});

test('balances and sweeps cover every retained collector, each with its own journaled transaction', async t => {
  const f = chainFixture(t), other = Keypair.generate(), target = Keypair.generate().publicKey;
  f.config(other.publicKey, 75); f.token(deriveTradeConfigPda(f.main.publicKey).pda, 5000n); f.token(deriveTradeConfigPda(other.publicKey).pda, 7500n);
  const collectors = () => [f.main, other].map((keypair, i) => ({ collector: keypair.publicKey.toBase58(), feeBps: i ? 75 : 50, keypair }));
  const a = f.adapter(f.main, { collectors });
  const balances = await a.walletBalances(undefined, { fees: true });
  assert.equal(balances.collectedFees, '12500'); assert.equal(balances.USDC, '3012500'); assert.equal(balances.collectors.length, 2);
  for (const [i, c] of balances.collectors.entries()) {
    const input = { id: String(i + 1).repeat(64), asset: 'USDC', amount: c.balance, to: target.toBase58(), collector: c.collector };
    const result = await a.walletWithdraw(input); assert.equal(result.ok, true, result.reason);
    const again = await f.adapter(f.main, { collectors }).walletWithdraw(input); assert.equal(again.signature, result.signature);
  }
  assert.equal(f.chain.sends.length, 2); assert.equal(f.balance(deriveVaultAta(target, f.mint)), 12500n);
  assert.equal(f.configBalance(f.main.publicKey), 0n); assert.equal(f.configBalance(other.publicKey), 0n);
  assert.ok(f.chain.sends.every(({ tx }) => tx.feePayer.equals(f.main.publicKey) && tx.instructions.length === 4));
  assert.match((await a.walletWithdraw({ id: '33'.repeat(32), asset: 'USDC', amount: '1', to: target.toBase58(), collector: f.buyer.publicKey.toBase58() })).reason, /Invalid collector/);
  await assert.rejects(f.adapter().tradeFeeBalances(), /source/);
  f.config(other.publicKey, 76); await assert.rejects(a.tradeFeeBalances(), /keyring/);
});
