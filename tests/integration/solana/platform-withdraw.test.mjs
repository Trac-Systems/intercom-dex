import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, MINT_SIZE, createInitializeMint2Instruction, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from '@solana/spl-token';
import { startValidator, setupMarket, send, balance, chainTime, LOCAL_RPC } from './harness.mjs';
import { createSolanaAdapter } from '../../../src/solana/adapter.js';
import { createFeeReader } from '../../../src/solana/fee-reader.js';
import { buildInitInstruction, buildClaimInstruction, deriveConfigPda, deriveVaultAta, calculateFees } from '../../../src/solana/escrow.js';
import { PROGRAM_ID } from '../../../src/solana/constants.js';
import { openStore } from '../../../src/roles/store.js';
import { readAuthorityKeypair } from '../../../src/fees/input.js';
import { withdrawPlatform } from '../../../src/fees/platform-withdraw.js';

test('real escrow platform fees: authority file, exact payouts, crash replay, alternate SPL mint and empty vault', { timeout: 240000 }, async t => {
  const validator = await startValidator({ maxLifetimeMs: 230000 }); t.after(() => validator.stop());
  t.diagnostic(`owned validator PID ${validator.pid}; artifacts ${validator.runDir}`);
  const m = await setupMarket(validator), { connection, buyer, seller, platform, venue, stranger, mint, runDir } = m;
  const authorityFile = join(runDir, 'throwaway-platform.json'), wrongFile = join(runDir, 'throwaway-wrong.json');
  await writeFile(authorityFile, JSON.stringify([...platform.secretKey]), { mode: 0o600 });
  await writeFile(wrongFile, JSON.stringify([...stranger.secretKey]), { mode: 0o600 });
  const store = openStore(join(runDir, 'records-store'), randomBytes(32));
  const journalName = id => 'intent-' + createHash('sha256').update(id).digest('hex');
  const intents = { get: id => store.get(journalName(id)), put: (id, value) => store.put(journalName(id), value), delete: id => store.delete(journalName(id)) };
  const reader = createFeeReader({ endpoints: [LOCAL_RPC], need: 1, programId: PROGRAM_ID, mint });
  const run = async (options = {}) => {
    const authority = readAuthorityKeypair(options.file ?? authorityFile);
    const solana = createSolanaAdapter({ endpoints: [LOCAL_RPC], sendEndpoint: LOCAL_RPC, need: 1, keypair: authority,
      intents, mint, commitment: 'finalized', confirmationTimeoutMs: 60000 });
    try { return await withdrawPlatform({ store, reader, solana, authority, mint: mint.toBase58(), to: stranger.publicKey.toBase58(), ...options }); }
    finally { assert.ok(authority.secretKey.every(b => b === 0), 'authority buffer wiped'); }
  };
  const collect = async (tokenMint, amount) => {
    const preimage = randomBytes(32), paymentHashHex = createHash('sha256').update(preimage).digest('hex');
    const args = { payer: buyer.publicKey, payerTokenAccount: deriveVaultAta(buyer.publicKey, tokenMint), recipient: seller.publicKey,
      refund: buyer.publicKey, refundAfter: await chainTime(connection) + 300n, amount, mint: tokenMint, paymentHashHex,
      expectedPlatformFeeBps: 10, expectedTradeFeeBps: 50, tradeFeeCollector: venue.publicKey };
    await send(connection, buyer, [buildInitInstruction(args)]);
    const recipientTokenAccount = deriveVaultAta(seller.publicKey, tokenMint);
    await send(connection, seller, [createAssociatedTokenAccountIdempotentInstruction(seller.publicKey, recipientTokenAccount, seller.publicKey, tokenMint),
      buildClaimInstruction({ ...args, preimageHex: preimage.toString('hex'), recipientTokenAccount })]);
    // Wait for the actual fee vault from the claim to enter finalized quorum reads.
    const fee = calculateFees(amount, 10, 50).platformFeeAmount;
    const deadline = Date.now() + 60000;
    while (BigInt(await reader.platformBalance(tokenMint)) !== fee) {
      if (Date.now() >= deadline) throw new Error('Claim fee did not finalize');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return fee;
  };
  const fee = await collect(mint, 1234567n); assert.equal(fee, 1234n);
  await assert.rejects(run({ file: wrongFile }), /authority/);
  assert.equal(await balance(connection, m.atas.stranger), 0n);
  const put = store.put;
  store.put = (key, value) => { put(key, value); if (key.startsWith('platform-withdraw-') && value.phase === 'complete') throw new Error('crash before stdout'); };
  await assert.rejects(run({ amount: '0.001' }), /crash before stdout/); store.put = put;
  const result = await run({ amount: '0.001' }); assert.ok(result.signature); assert.equal(result.existing, true);
  assert.equal(await balance(connection, m.atas.stranger), 1000n);
  assert.equal(await balance(connection, deriveVaultAta(deriveConfigPda().pda, mint)), 234n);
  // Crash after finalized execution, before marking the owner command complete.
  store.put = (key, value) => { if (key.startsWith('platform-withdraw-') && value.phase === 'complete') throw new Error('crash after finalized payout'); return put(key, value); };
  await assert.rejects(run(), /crash after finalized payout/); store.put = put;
  const recovered = await run(); assert.ok(recovered.signature);
  assert.equal(await balance(connection, m.atas.stranger), 1234n);
  assert.equal(await balance(connection, m.atas.platform), 0n);
  assert.equal((await run()).empty, true);
  // Older escrows may use a different mint and precision.
  const other = Keypair.generate();
  await send(connection, buyer, [SystemProgram.createAccount({ fromPubkey: buyer.publicKey, newAccountPubkey: other.publicKey,
    lamports: await connection.getMinimumBalanceForRentExemption(MINT_SIZE), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
  createInitializeMint2Instruction(other.publicKey, 9, buyer.publicKey, null),
  createAssociatedTokenAccountIdempotentInstruction(buyer.publicKey, deriveVaultAta(buyer.publicKey, other.publicKey), buyer.publicKey, other.publicKey),
  createMintToInstruction(other.publicKey, deriveVaultAta(buyer.publicKey, other.publicKey), buyer.publicKey, 1000000000n)], [other]);
  const otherFee = await collect(other.publicKey, 123456789n);
  assert.equal((await run({ mint: other.publicKey.toBase58(), to: platform.publicKey.toBase58() })).ok, true);
  assert.equal(await balance(connection, deriveVaultAta(platform.publicKey, other.publicKey)), otherFee);
  assert.equal(await balance(connection, deriveVaultAta(deriveConfigPda().pda, other.publicKey)), 0n);
});
