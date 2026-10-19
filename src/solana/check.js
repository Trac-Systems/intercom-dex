import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, unpackAccount } from '@solana/spl-token';
import { PROGRAM_ID } from './constants.js';
import { deriveEscrowPda, deriveVaultAta, decodeEscrowState, calculateFees } from './escrow.js';
import { readAccountQuorum } from './quorum.js';

function exactUnsigned(value) {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  throw new TypeError('Expected unsigned exact integer');
}

export async function checkEscrow({ terms, hashHex, endpoints, need = 2, timeoutMs = 5000, slotTolerance, programId = PROGRAM_ID, commitment = 'confirmed', purpose = 'lock', minContextSlot }) {
  const reasons = [];
  const reads = {};
  let escrow, expected, state;
  const fail = (code, message) => reasons.push({ code, message });
  const verdict = () => ({ ok: reasons.length === 0, reasons, address: escrow?.pda.toBase58() ?? null, state, reads });
  try {
    if (!['lock', 'settlement'].includes(purpose)) throw new TypeError('Invalid purpose');
    escrow = deriveEscrowPda(hashHex, programId);
    expected = {
      recipient: new PublicKey(terms.seller.solRecipient), refund: new PublicKey(terms.buyer.solPayer),
      mint: new PublicKey(terms.mint), amount: exactUnsigned(terms.quoteAmount),
      refundAfter: exactUnsigned(terms.refundAfter),
      platformCollector: new PublicKey(terms.fees.platformCollector), tradeCollector: new PublicKey(terms.fees.collector),
      platformBps: terms.fees.platformFeeBps, tradeBps: terms.fees.tradeFeeBps,
    };
    if (expected.amount === 0n || expected.refundAfter > (1n << 63n) - 1n) throw new RangeError('Invalid trade amount or refund time');
    calculateFees(expected.amount, expected.platformBps, expected.tradeBps);
  } catch (error) {
    fail('INVALID_TERMS', error.message);
    return verdict();
  }
  // A seller sends base coins on this verdict: every reader that answers must agree.
  const options = { endpoints, need, timeoutMs, slotTolerance, commitment, minContextSlot, unanimous: true };
  try { reads.escrow = await readAccountQuorum(escrow.pda, options); }
  catch (error) {
    reads.escrow = { reports: error.reports ?? [] };
    fail('ESCROW_QUORUM', error.message);
    return verdict();
  }
  const account = reads.escrow.value;
  if (!account) { fail('ESCROW_MISSING', 'Escrow does not exist'); return verdict(); }
  if (account.owner !== new PublicKey(programId).toBase58() || account.executable) {
    fail('ESCROW_OWNER', 'Escrow must be a non-executable account owned by the escrow program');
    return verdict();
  }
  try { state = decodeEscrowState(account.data); }
  catch (error) { fail('ESCROW_DATA', error.message); return verdict(); }
  const settled = purpose === 'settlement' && state.status !== 0;
  if (state.status !== 0 && !settled) fail('STATUS', 'Escrow is not active');
  if (settled && (state.netAmount !== 0n || state.platformFeeAmount !== 0n || state.tradeFeeAmount !== 0n)) fail('SETTLED_AMOUNTS', 'Settled escrow amounts must be zero');
  if (state.paymentHashHex !== hashHex.toLowerCase()) fail('HASH', 'Payment hash mismatch');
  if (state.bump !== escrow.bump) fail('BUMP', 'Escrow PDA bump mismatch');
  if (!state.recipient.equals(expected.recipient)) fail('RECIPIENT', 'Recipient mismatch');
  if (!state.refund.equals(expected.refund)) fail('REFUND_AUTHORITY', 'Refund authority mismatch');
  if (!state.mint.equals(expected.mint)) fail('MINT', 'Mint mismatch');
  if (!settled && state.netAmount !== expected.amount) fail('NET_AMOUNT', 'Net amount differs from trade terms');
  if (state.refundAfter !== expected.refundAfter) fail('REFUND_AFTER', 'Refund deadline mismatch');
  if (state.platformFeeBps !== expected.platformBps) fail('PLATFORM_FEE_BPS', 'Platform fee bps mismatch');
  if (state.tradeFeeBps !== expected.tradeBps) fail('TRADE_FEE_BPS', 'Trade fee bps mismatch');
  if (!state.platformFeeCollector.equals(expected.platformCollector)) fail('PLATFORM_COLLECTOR', 'Platform collector mismatch');
  if (!state.tradeFeeCollector.equals(expected.tradeCollector)) fail('TRADE_COLLECTOR', 'Trade collector mismatch');
  let total;
  try {
    const fees = calculateFees(state.netAmount, state.platformFeeBps, state.tradeFeeBps);
    total = fees.totalAmount;
    if (state.platformFeeAmount !== fees.platformFeeAmount || state.tradeFeeAmount !== fees.tradeFeeAmount) fail('FEE_AMOUNTS', 'Stored fee amounts do not match the program fee formula');
  } catch (error) { fail('FEE_AMOUNTS', error.message); }
  const vault = deriveVaultAta(escrow.pda, expected.mint);
  if (!state.vault.equals(vault)) fail('VAULT_ADDRESS', 'Escrow vault is not the expected ATA');
  // No vault read is needed after a failed escrow check.
  if (reasons.length) return verdict();
  try { reads.vault = await readAccountQuorum(vault, { ...options, minContextSlot: reads.escrow.slot }); }
  catch (error) {
    reads.vault = { reports: error.reports ?? [] };
    fail('VAULT_QUORUM', error.message);
    return verdict();
  }
  const vaultInfo = reads.vault.value;
  if (!vaultInfo) { fail('VAULT_MISSING', 'Vault does not exist'); return verdict(); }
  if (vaultInfo.owner !== TOKEN_PROGRAM_ID.toBase58() || vaultInfo.executable) {
    fail('VAULT_OWNER', 'Vault must belong to the SPL Token program');
    return verdict();
  }
  if (vaultInfo.data.length !== 165 || vaultInfo.data[108] > 2 ||
      [72, 109, 129].some(offset => vaultInfo.data.readUInt32LE(offset) > 1)) {
    fail('VAULT_DATA', 'Invalid SPL token account layout');
    return verdict();
  }
  let token;
  try { token = unpackAccount(vault, { ...vaultInfo, owner: new PublicKey(vaultInfo.owner) }, TOKEN_PROGRAM_ID); }
  catch { fail('VAULT_DATA', 'Invalid SPL token account'); return verdict(); }
  if (!token.mint.equals(expected.mint)) fail('VAULT_MINT', 'Vault token mint mismatch');
  if (!token.owner.equals(escrow.pda)) fail('VAULT_AUTHORITY', 'Vault authority mismatch');
  if (!token.isInitialized || token.isFrozen) fail('VAULT_STATE', 'Vault is uninitialized or frozen');
  if (token.delegate || token.closeAuthority || token.isNative) fail('VAULT_CONTROL', 'Unexpected vault delegate, close authority, or native token');
  if (token.amount < total) fail('VAULT_BALANCE', 'Vault does not cover net amount plus both fees');
  return verdict();
}
