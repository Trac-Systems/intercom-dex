import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Keypair } from '@solana/web3.js';
import { createSolanaAdapter } from '../../../src/solana/adapter.js';
import { deriveEscrowPda, deriveVaultAta } from '../../../src/solana/escrow.js';
import { startValidator, setupMarket, balance, chainTime, LOCAL_RPC, send } from './harness.mjs';
import { SystemProgram } from '@solana/web3.js';

const endpoints = [LOCAL_RPC, 'http://localhost:18899'];
const fresh = () => { const bytes = randomBytes(32); return { hashHex: createHash('sha256').update(bytes).digest('hex'), preimageHex: bytes.toString('hex') }; };

test('role adapter on the deployed binary in a local validator', { timeout: 120000 }, async t => {
  const validator = await startValidator(); t.after(() => validator.stop());
  t.diagnostic(`validator PID ${validator.pid}; artifacts ${validator.runDir}`);
  const market = await setupMarket(validator);
  const { connection, buyer, seller, venue, platform, mint, atas } = market;
  const make = keypair => createSolanaAdapter({ endpoints, sendEndpoint: LOCAL_RPC, keypair, mint, finality: 'confirmed' });
  const payer = make(buyer), recipient = make(seller), service = make(venue), reader = make(null);
  const terms = {
    seller: { solRecipient: seller.publicKey.toBase58() }, buyer: { solPayer: buyer.publicKey.toBase58() },
    mint: mint.toBase58(), quoteAmount: '1234567', refundAfter: Number(await chainTime(connection)) + 120,
    fees: { platformFeeBps: 10, tradeFeeBps: 50, platformCollector: platform.publicKey.toBase58(), collector: venue.publicKey.toBase58() },
  };
  const trade = { terms, ...fresh() };
  let firstClaim;
  await t.test('lock → active → claim → settlement; retry retrieves original signatures', async () => {
    assert.equal((await reader.checkEscrow(trade)).status, 'missing');
    const before = await balance(connection, atas.buyer);
    const lock = await payer.lockEscrow(trade); assert.equal(lock.ok, true, lock.reason);
    assert.equal(before - await balance(connection, atas.buyer), 1241973n);
    assert.equal((await payer.lockEscrow(trade)).signature, lock.signature);
    assert.deepEqual(await reader.checkEscrow(trade), { ok: true, hashHex: trade.hashHex, purpose: 'lock', status: 'active' });
    const wrong = await recipient.claim({ ...trade, preimageHex: '00'.repeat(32) }); assert.equal(wrong.ok, false); assert.match(wrong.reason, /Preimage/);
    const mismatch = await reader.checkEscrow({ ...trade, terms: { ...terms, quoteAmount: '99999999' } }); assert.equal(mismatch.status, 'mismatch');
    const claim = await recipient.claim(trade); assert.equal(claim.ok, true, claim.reason); firstClaim = claim.claimSignature;
    assert.equal(await balance(connection, atas.seller), 1234567n);
    const checked = await reader.checkEscrow({ ...trade, purpose: 'settlement' });
    assert.deepEqual(checked, { ok: true, hashHex: trade.hashHex, purpose: 'settlement', status: 'claimed' });
    assert.equal((await recipient.claim(trade)).claimSignature, firstClaim);
    assert.equal((await recipient.claim({ terms, hashHex: trade.hashHex })).claimSignature, firstClaim);
    assert.equal((await make(seller).claim(trade)).claimSignature, firstClaim);
    const altered = await reader.checkEscrow({ ...trade, terms: { ...terms, quoteAmount: '1' }, purpose: 'settlement' });
    assert.equal(altered.status, 'mismatch');
    assert.equal((await payer.refund(trade)).ok, false);
  });
  await t.test('refund uses chain Clock, returns net and fees, and retries idempotently', async () => {
    const short = { terms: { ...terms, refundAfter: Number(await chainTime(connection)) + 5 }, ...fresh() };
    const before = await balance(connection, atas.buyer);
    const lock = await payer.lockEscrow(short); assert.equal(lock.ok, true, lock.reason);
    const early = await payer.refund(short); assert.equal(early.ok, false); assert.match(early.reason, /chain Clock/);
    const deadline = Date.now() + 15000;
    while (await chainTime(connection) < BigInt(short.terms.refundAfter)) { assert.ok(Date.now() < deadline); await delay(200); }
    const refund = await payer.refund(short); assert.equal(refund.ok, true, refund.reason);
    assert.equal(await balance(connection, atas.buyer), before);
    assert.equal((await make(buyer).refund(short)).refundSignature, refund.refundSignature);
    const checked = await reader.checkEscrow({ ...short, purpose: 'settlement' }); assert.equal(checked.status, 'refunded'); assert.equal(checked.ok, true);
    assert.deepEqual(await recipient.claim(short), { ok: false, reason: 'escrow_refunded' });
    assert.equal(await balance(connection, deriveVaultAta(deriveEscrowPda(short.hashHex).pda, mint)), 0n);
  });
  await t.test('service config create/update, fee balance and collector-only withdrawal', async () => {
    assert.equal(await service.tradeFeeBalance(), '6172');
    assert.deepEqual(await service.ensureTradeConfig({ feeBps: 50 }), { ok: true, signature: null });
    assert.equal((await service.ensureTradeConfig({ feeBps: 60 })).ok, true);
    assert.equal((await service.ensureTradeConfig({ feeBps: 50 })).ok, true);
    const freshCollector = Keypair.generate();
    await send(connection, buyer, [SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: freshCollector.publicKey, lamports: 100000000 })]);
    assert.equal((await make(freshCollector).ensureTradeConfig({ feeBps: 25 })).ok, true);
    assert.equal((await service.withdrawTradeFees({ amount: '1', to: atas.seller })).ok, false);
    assert.equal((await service.withdrawTradeFees({ amount: '6173', to: atas.venue })).ok, false);
    const withdraw = await service.withdrawTradeFees({ amount: '0', to: atas.venue }); assert.equal(withdraw.ok, true, withdraw.reason);
    assert.equal(await service.tradeFeeBalance(), '0'); assert.equal(await balance(connection, atas.venue), 6172n);
  });
  await t.test('first finalized block agrees between independent adapter instances and URL aliases', async () => {
    const minSlot = 2;
    const deadline = Date.now() + 25000;
    while (await reader.finalizedSlot() < minSlot) { assert.ok(Date.now() < deadline); await delay(300); }
    const result = await reader.firstFinalizedBlockAtLeast(minSlot);
    assert.ok(result.slot >= minSlot); assert.match(result.blockhash, /^[0-9a-f]{64}$/); assert.equal(result.finalized, true);
    assert.deepEqual(await make(null).firstFinalizedBlockAtLeast(minSlot), result);
    await assert.rejects(reader.firstFinalizedBlockAtLeast(Number.MAX_SAFE_INTEGER), /not finalized/);
  });
});
