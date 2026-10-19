import {
  PublicKey, Transaction, TransactionInstruction, SystemProgram,
  SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY, ComputeBudgetProgram,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PROGRAM_ID } from './constants.js';

const pk = value => new PublicKey(value);
const meta = (key, isSigner = false, isWritable = false) => ({ pubkey: pk(key), isSigner, isWritable });
const u64Max = (1n << 64n) - 1n;

function integer(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  throw new TypeError('Expected an exact integer (bigint, decimal string, or safe integer)');
}

function uint64(value) {
  const n = integer(value);
  if (n < 0n || n > u64Max) throw new RangeError('Amount outside u64');
  return n;
}

function le64(value, signed = false) {
  const data = Buffer.alloc(8);
  if (signed) data.writeBigInt64LE(integer(value));
  else data.writeBigUInt64LE(uint64(value));
  return data;
}

function bps(value, max) {
  if (!Number.isInteger(value) || value < 0 || value > max) throw new RangeError(`Fee bps outside 0..${max}`);
  const data = Buffer.alloc(2);
  data.writeUInt16LE(value);
  return data;
}

function hex32(value) {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) throw new TypeError('Expected 32-byte hex');
  return Buffer.from(value, 'hex');
}

function pda(seeds, programId) {
  const [address, bump] = PublicKey.findProgramAddressSync(seeds, pk(programId));
  return { pda: address, bump };
}

export function deriveEscrowPda(paymentHashHex, programId = PROGRAM_ID) {
  return pda([Buffer.from('escrow'), hex32(paymentHashHex)], programId);
}

export function deriveConfigPda(programId = PROGRAM_ID) {
  return pda([Buffer.from('config')], programId);
}

export function deriveTradeConfigPda(feeCollector, programId = PROGRAM_ID) {
  return pda([Buffer.from('trade_config'), pk(feeCollector).toBuffer()], programId);
}

// Applies to escrow, platform config, and trade config PDA owners.
export function deriveVaultAta(owner, mint) {
  return getAssociatedTokenAddressSync(pk(mint), pk(owner), true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}

export function escrowAddresses({ paymentHashHex, mint, tradeFeeCollector, programId = PROGRAM_ID }) {
  const escrow = deriveEscrowPda(paymentHashHex, programId);
  const config = deriveConfigPda(programId);
  const tradeConfig = deriveTradeConfigPda(tradeFeeCollector, programId);
  return {
    escrowPda: escrow.pda, bump: escrow.bump, configPda: config.pda, tradeConfigPda: tradeConfig.pda,
    vault: deriveVaultAta(escrow.pda, mint),
    platformFeeVault: deriveVaultAta(config.pda, mint),
    tradeFeeVault: deriveVaultAta(tradeConfig.pda, mint),
  };
}

// Each fee is floored independently, added on top of the recipient's net amount.
export function calculateFees(amount, platformFeeBps, tradeFeeBps) {
  const netAmount = uint64(amount);
  bps(platformFeeBps, 500);
  bps(tradeFeeBps, 1000);
  const platformFeeAmount = netAmount * BigInt(platformFeeBps) / 10_000n;
  const tradeFeeAmount = netAmount * BigInt(tradeFeeBps) / 10_000n;
  const totalAmount = uint64(netAmount + platformFeeAmount + tradeFeeAmount);
  return { netAmount, platformFeeAmount, tradeFeeAmount, totalAmount };
}

function instruction(programId, data, keys) {
  return new TransactionInstruction({ programId: pk(programId), data, keys });
}

function configInstruction({ authority, feeCollector, feeBps, programId = PROGRAM_ID }, trade, init) {
  const config = trade ? deriveTradeConfigPda(feeCollector, programId).pda : deriveConfigPda(programId).pda;
  const tag = trade ? (init ? 6 : 7) : (init ? 3 : 4);
  const data = Buffer.concat([Buffer.from([tag]), pk(feeCollector).toBuffer(), bps(feeBps, trade ? 1000 : 500)]);
  const keys = [meta(authority, true, init), meta(config, false, true)];
  if (init) keys.push(meta(SystemProgram.programId), meta(SYSVAR_RENT_PUBKEY));
  return instruction(programId, data, keys);
}

export function buildInitConfigInstruction(options) {
  return configInstruction({ ...options, authority: options.payer }, false, true);
}

export function buildSetConfigInstruction(options) {
  return configInstruction(options, false, false);
}

export function buildInitTradeConfigInstruction(options) {
  return configInstruction({ ...options, authority: options.payer }, true, true);
}

export function buildSetTradeConfigInstruction(options) {
  return configInstruction(options, true, false);
}

function withdrawInstruction({ feeCollector, destination, mint, amount = 0n, programId = PROGRAM_ID }, trade) {
  const config = trade ? deriveTradeConfigPda(feeCollector, programId).pda : deriveConfigPda(programId).pda;
  return instruction(programId, Buffer.concat([Buffer.from([trade ? 8 : 5]), le64(amount)]), [
    meta(feeCollector, true), meta(config), meta(deriveVaultAta(config, mint), false, true),
    meta(destination, false, true), meta(TOKEN_PROGRAM_ID),
  ]);
}

export function buildWithdrawFeesInstruction(options) {
  return withdrawInstruction(options, false);
}

export function buildWithdrawTradeFeesInstruction(options) {
  return withdrawInstruction(options, true);
}

export function buildInitInstruction(options) {
  const {
    payer, payerTokenAccount, paymentHashHex, recipient, refund, refundAfter, amount, mint,
    expectedPlatformFeeBps, expectedTradeFeeBps, tradeFeeCollector, programId = PROGRAM_ID,
  } = options;
  calculateFees(amount, expectedPlatformFeeBps, expectedTradeFeeBps);
  const a = escrowAddresses(options);
  const data = Buffer.concat([
    Buffer.from([0]), hex32(paymentHashHex), pk(recipient).toBuffer(), pk(refund).toBuffer(),
    le64(refundAfter, true), le64(amount), bps(expectedPlatformFeeBps, 500),
    bps(expectedTradeFeeBps, 1000), pk(tradeFeeCollector).toBuffer(),
  ]);
  return instruction(programId, data, [
    meta(payer, true, true), meta(payerTokenAccount, false, true), meta(a.escrowPda, false, true),
    meta(a.vault, false, true), meta(mint), meta(SystemProgram.programId), meta(TOKEN_PROGRAM_ID),
    meta(ASSOCIATED_TOKEN_PROGRAM_ID), meta(SYSVAR_RENT_PUBKEY), meta(a.configPda),
    meta(a.platformFeeVault, false, true), meta(a.tradeConfigPda), meta(a.tradeFeeVault, false, true),
  ]);
}

export function buildClaimInstruction(options) {
  const { recipient, recipientTokenAccount, preimageHex, programId = PROGRAM_ID } = options;
  const a = escrowAddresses(options);
  return instruction(programId, Buffer.concat([Buffer.from([1]), hex32(preimageHex)]), [
    meta(recipient, true), meta(a.escrowPda, false, true), meta(a.vault, false, true),
    meta(recipientTokenAccount, false, true), meta(a.platformFeeVault, false, true),
    meta(a.tradeFeeVault, false, true), meta(TOKEN_PROGRAM_ID),
  ]);
}

export function buildRefundInstruction({ paymentHashHex, refund, refundTokenAccount, mint, programId = PROGRAM_ID }) {
  const { pda: escrow } = deriveEscrowPda(paymentHashHex, programId);
  return instruction(programId, Buffer.from([2]), [
    meta(refund, true), meta(escrow, false, true), meta(deriveVaultAta(escrow, mint), false, true),
    meta(refundTokenAccount, false, true), meta(TOKEN_PROGRAM_ID), meta(SYSVAR_CLOCK_PUBKEY),
  ]);
}

function stateBytes(data, size, version) {
  if (!(data instanceof Uint8Array)) throw new TypeError('State must be bytes');
  const b = Buffer.from(data);
  if (b.length !== size) throw new RangeError(`Expected ${size} state bytes`);
  if (b[0] !== version) throw new Error(`Unsupported state version ${b[0]}`);
  return b;
}

export function decodeEscrowState(data) {
  const b = stateBytes(data, 263, 3);
  if (b[1] > 2) throw new Error('Invalid escrow status');
  return {
    v: b[0], status: b[1], paymentHashHex: b.subarray(2, 34).toString('hex'),
    recipient: pk(b.subarray(34, 66)), refund: pk(b.subarray(66, 98)), refundAfter: b.readBigInt64LE(98),
    mint: pk(b.subarray(106, 138)), netAmount: b.readBigUInt64LE(138),
    platformFeeAmount: b.readBigUInt64LE(146), platformFeeBps: b.readUInt16LE(154),
    platformFeeCollector: pk(b.subarray(156, 188)), tradeFeeAmount: b.readBigUInt64LE(188),
    tradeFeeBps: b.readUInt16LE(196), tradeFeeCollector: pk(b.subarray(198, 230)),
    vault: pk(b.subarray(230, 262)), bump: b[262],
  };
}

function decodeConfig(data) {
  const b = stateBytes(data, 68, 1);
  return { v: b[0], authority: pk(b.subarray(1, 33)), feeCollector: pk(b.subarray(33, 65)), feeBps: b.readUInt16LE(65), bump: b[67] };
}

export function decodeConfigState(data) {
  return decodeConfig(data);
}

export function decodeTradeConfigState(data) {
  return decodeConfig(data);
}

// Builds and signs, but never submits. Use the returned blockhash strategy when confirming.
export async function buildTransaction({ connection, payer, instructions, signers = [], computeUnitLimit, computeUnitPriceMicroLamports }) {
  if (!Array.isArray(instructions) || instructions.length === 0) throw new TypeError('Instructions required');
  const tx = new Transaction();
  if (computeUnitLimit !== undefined) {
    if (!Number.isSafeInteger(computeUnitLimit) || computeUnitLimit < 1 || computeUnitLimit > 1_400_000) throw new RangeError('Invalid compute unit limit');
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }));
  }
  if (computeUnitPriceMicroLamports !== undefined) {
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: uint64(computeUnitPriceMicroLamports) }));
  }
  tx.add(...instructions);
  const latest = await connection.getLatestBlockhash('confirmed');
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = latest.blockhash;
  const unique = new Map([payer, ...signers].map(s => [s.publicKey.toBase58(), s]));
  tx.sign(...unique.values());
  return { tx, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight };
}
