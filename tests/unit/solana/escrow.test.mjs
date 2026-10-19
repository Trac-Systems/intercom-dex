import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY, ComputeBudgetProgram } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import * as e from '../../../src/solana/escrow.js';
import { PROGRAM_ID, PLATFORM_CONFIG, USDC_MINT, USDC_DECIMALS, PROGRAM_ERRORS, DEFAULT_ENDPOINTS } from '../../../src/solana/constants.js';
import { key, options, addresses, escrowBytes, configBytes } from './vectors.mjs';

const keys = ix => ix.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable]);
const m = (k, s = false, w = false) => [k.toBase58(), s, w];

test('constants and PDA seeds match the Rust program', () => {
  assert.equal(PROGRAM_ID.toBase58(), '4RS6xpspM1V2K7FKSqeSH6VVaZbtzHzhJqacwrz8gJrF');
  assert.equal(USDC_MINT.toBase58(), 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  assert.equal(USDC_DECIMALS, 6);
  assert.equal(PROGRAM_ERRORS[17], 'FeeMismatch');
  assert.equal(DEFAULT_ENDPOINTS.length, 6);
  assert.ok(e.deriveConfigPda().pda.equals(PLATFORM_CONFIG));
  for (const [seeds, actual] of [
    [[Buffer.from('escrow'), Buffer.from(options.paymentHashHex, 'hex')], e.deriveEscrowPda(options.paymentHashHex)],
    [[Buffer.from('config')], e.deriveConfigPda()],
    [[Buffer.from('trade_config'), key(5).toBuffer()], e.deriveTradeConfigPda(key(5))],
  ]) {
    const [want, bump] = PublicKey.findProgramAddressSync(seeds, PROGRAM_ID);
    assert.ok(actual.pda.equals(want)); assert.equal(actual.bump, bump);
  }
  for (const [owner, vault] of [[addresses.escrowPda, addresses.vault], [addresses.configPda, addresses.platformFeeVault], [addresses.tradeConfigPda, addresses.tradeFeeVault]]) {
    const [want] = PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), key(4).toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID);
    assert.ok(e.deriveVaultAta(owner, key(4)).equals(want)); assert.ok(vault.equals(want));
  }
  assert.throws(() => e.deriveEscrowPda('gg'.repeat(32)));
  assert.throws(() => e.deriveEscrowPda('00'));
  assert.throws(() => e.deriveConfigPda('invalid'));
  assert.throws(() => e.deriveTradeConfigPda('invalid'));
  assert.throws(() => e.deriveVaultAta(key(1), 'invalid'));
  assert.throws(() => e.escrowAddresses({ ...options, mint: 'invalid' }));
});

test('Init bytes and all account metas are exact', () => {
  const ix = e.buildInitInstruction(options);
  const expected = '00' + '11'.repeat(32) + '03'.repeat(32) + '01'.repeat(32) +
    '00f1536500000000' + '87d6120000000000' + '0a00' + '3200' + '05'.repeat(32);
  assert.equal(ix.data.toString('hex'), expected);
  assert.equal(ix.data.length, 149);
  assert.ok(ix.programId.equals(PROGRAM_ID));
  assert.deepEqual(keys(ix), [
    m(key(1), true, true), m(key(2), false, true), m(addresses.escrowPda, false, true),
    m(addresses.vault, false, true), m(key(4)), m(SystemProgram.programId), m(TOKEN_PROGRAM_ID),
    m(ASSOCIATED_TOKEN_PROGRAM_ID), m(SYSVAR_RENT_PUBKEY), m(addresses.configPda),
    m(addresses.platformFeeVault, false, true), m(addresses.tradeConfigPda), m(addresses.tradeFeeVault, false, true),
  ]);
  assert.equal(e.buildInitInstruction({ ...options, refundAfter: -1n }).data.subarray(97,105).toString('hex'), 'ff'.repeat(8));
  for (const change of [{ amount: -1n }, { amount: 2n ** 64n }, { amount: 2 ** 64 }, { amount: '01' }, { refundAfter: 2n ** 63n }, { expectedPlatformFeeBps: 501 }, { expectedTradeFeeBps: 1001 }, { recipient: 'bad' }]) {
    assert.throws(() => e.buildInitInstruction({ ...options, ...change }));
  }
});

test('Claim and Refund layouts and failure inputs', () => {
  const claim = e.buildClaimInstruction({ ...options, preimageHex: 'ab'.repeat(32), recipientTokenAccount: key(7) });
  assert.equal(claim.data.toString('hex'), '01' + 'ab'.repeat(32));
  assert.deepEqual(keys(claim), [m(key(3), true), m(addresses.escrowPda, false, true), m(addresses.vault, false, true), m(key(7), false, true), m(addresses.platformFeeVault, false, true), m(addresses.tradeFeeVault, false, true), m(TOKEN_PROGRAM_ID)]);
  const refund = e.buildRefundInstruction({ ...options, refundTokenAccount: key(2) });
  assert.equal(refund.data.toString('hex'), '02');
  assert.deepEqual(keys(refund), [m(key(1), true), m(addresses.escrowPda, false, true), m(addresses.vault, false, true), m(key(2), false, true), m(TOKEN_PROGRAM_ID), m(SYSVAR_CLOCK_PUBKEY)]);
  assert.throws(() => e.buildClaimInstruction({ ...options, preimageHex: 'aa', recipientTokenAccount: key(7) }));
  assert.throws(() => e.buildRefundInstruction({ ...options, refundTokenAccount: 'bad' }));
});

test('platform and trade configuration / withdrawal vectors', () => {
  for (const [builder, tag, init, trade] of [
    [e.buildInitConfigInstruction, 3, true, false], [e.buildSetConfigInstruction, 4, false, false],
    [e.buildInitTradeConfigInstruction, 6, true, true], [e.buildSetTradeConfigInstruction, 7, false, true],
  ]) {
    const args = { payer: key(6), authority: key(6), feeCollector: key(6), feeBps: 258 };
    const ix = builder(args);
    assert.equal(ix.data.toString('hex'), `0${tag}` + '06'.repeat(32) + '0201');
    const expected = [m(key(6), true, init), m(trade ? e.deriveTradeConfigPda(key(6)).pda : PLATFORM_CONFIG, false, true)];
    if (init) expected.push(m(SystemProgram.programId), m(SYSVAR_RENT_PUBKEY));
    assert.deepEqual(keys(ix), expected);
    assert.throws(() => builder({ ...args, feeBps: trade ? 1001 : 501 }));
    assert.throws(() => builder({ ...args, feeBps: 0.5 }));
  }
  for (const [builder, tag, trade] of [[e.buildWithdrawFeesInstruction, 5, false], [e.buildWithdrawTradeFeesInstruction, 8, true]]) {
    const args = { feeCollector: key(6), destination: key(7), mint: key(4), amount: 0x0102030405060708n };
    const ix = builder(args);
    assert.equal(ix.data.toString('hex'), `0${tag}0807060504030201`);
    const config = trade ? e.deriveTradeConfigPda(key(6)).pda : PLATFORM_CONFIG;
    assert.deepEqual(keys(ix), [m(key(6), true), m(config), m(e.deriveVaultAta(config, key(4)), false, true), m(key(7), false, true), m(TOKEN_PROGRAM_ID)]);
    assert.equal(builder({ ...args, amount: undefined }).data.subarray(1).toString('hex'), '00'.repeat(8));
    assert.throws(() => builder({ ...args, amount: -1n }));
  }
});

test('fee math floors separately and checks u64 overflow', () => {
  assert.deepEqual(e.calculateFees(1234567n, 10, 50), { netAmount: 1234567n, platformFeeAmount: 1234n, tradeFeeAmount: 6172n, totalAmount: 1241973n });
  assert.deepEqual(e.calculateFees(199n, 10, 50), { netAmount: 199n, platformFeeAmount: 0n, tradeFeeAmount: 0n, totalAmount: 199n });
  assert.equal(e.calculateFees('18446744073709551615', 0, 0).totalAmount, (1n << 64n) - 1n);
  for (const args of [[-1n, 10, 50], [(1n << 64n) - 1n, 10, 50], [1, -1, 50], [1, 10, 1001], [true, 10, 50], [1.1, 10, 50]]) assert.throws(() => e.calculateFees(...args));
});

test('state decoders accept only exact Rust layouts', () => {
  const state = e.decodeEscrowState(escrowBytes());
  assert.equal(state.v, 3); assert.equal(state.status, 0); assert.equal(state.paymentHashHex, options.paymentHashHex);
  assert.ok(state.recipient.equals(key(3))); assert.ok(state.refund.equals(key(1))); assert.ok(state.mint.equals(key(4)));
  assert.equal(state.refundAfter, 1700000000n); assert.equal(state.netAmount, 1234567n);
  assert.equal(state.platformFeeAmount, 1234n); assert.equal(state.platformFeeBps, 10); assert.ok(state.platformFeeCollector.equals(key(6)));
  assert.equal(state.tradeFeeAmount, 6172n); assert.equal(state.tradeFeeBps, 50); assert.ok(state.tradeFeeCollector.equals(key(5)));
  assert.ok(state.vault.equals(addresses.vault)); assert.equal(state.bump, addresses.bump);
  const signed = escrowBytes(); signed.writeBigInt64LE(-1n, 98); assert.equal(e.decodeEscrowState(signed).refundAfter, -1n);
  for (const decode of [e.decodeConfigState, e.decodeTradeConfigState]) {
    const state = decode(configBytes());
    assert.equal(state.v, 1); assert.equal(state.bump, 254); assert.equal(state.feeBps, 10);
    assert.ok(state.authority.equals(key(6))); assert.ok(state.feeCollector.equals(key(6)));
  }
  for (const [decode, good] of [[e.decodeEscrowState, escrowBytes()], [e.decodeConfigState, configBytes()], [e.decodeTradeConfigState, configBytes()]]) {
    assert.throws(() => decode(good.subarray(1))); assert.throws(() => decode(Buffer.concat([good, Buffer.alloc(1)])));
    const bad = Buffer.from(good); bad[0] = 99; assert.throws(() => decode(bad)); assert.throws(() => decode('bad'));
  }
  const bad = escrowBytes(); bad[1] = 3; assert.throws(() => e.decodeEscrowState(bad));
});

test('transaction helper signs all instruction types, includes budgets and propagates failures', async () => {
  const payer = Keypair.generate();
  const blockhash = key(9).toBase58();
  const connection = { getLatestBlockhash: async commitment => { assert.equal(commitment, 'confirmed'); return { blockhash, lastValidBlockHeight: 321 }; } };
  const opts = { ...options, payer: payer.publicKey, refund: payer.publicKey, recipient: payer.publicKey, authority: payer.publicKey, feeCollector: payer.publicKey, feeBps: 10, destination: key(7), recipientTokenAccount: key(7), refundTokenAccount: key(2), preimageHex: 'ab'.repeat(32) };
  for (const builder of [e.buildInitInstruction, e.buildClaimInstruction, e.buildRefundInstruction, e.buildInitConfigInstruction, e.buildSetConfigInstruction, e.buildWithdrawFeesInstruction, e.buildInitTradeConfigInstruction, e.buildSetTradeConfigInstruction, e.buildWithdrawTradeFeesInstruction]) {
    const result = await e.buildTransaction({ connection, payer, instructions: [builder(opts)], signers: [payer], computeUnitLimit: 400000, computeUnitPriceMicroLamports: 1n });
    assert.equal(result.blockhash, blockhash); assert.equal(result.lastValidBlockHeight, 321);
    assert.ok(result.tx.verifySignatures()); assert.equal(result.tx.instructions.length, 3);
    assert.ok(result.tx.instructions[0].programId.equals(ComputeBudgetProgram.programId));
  }
  for (const change of [{ instructions: [] }, { computeUnitLimit: 0 }, { computeUnitLimit: 1400001 }, { computeUnitPriceMicroLamports: -1n }]) await assert.rejects(e.buildTransaction({ connection, payer, instructions: [e.buildInitConfigInstruction(opts)], ...change }));
  await assert.rejects(e.buildTransaction({ connection: { getLatestBlockhash: async () => { throw new Error('offline'); } }, payer, instructions: [e.buildInitConfigInstruction(opts)] }), /offline/);
  const second = Keypair.generate();
  const ix = SystemProgram.transfer({ fromPubkey: second.publicKey, toPubkey: payer.publicKey, lamports: 1 });
  assert.ok((await e.buildTransaction({ connection, payer, signers: [second], instructions: [ix] })).tx.verifySignatures());
});
