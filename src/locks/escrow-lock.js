import { PublicKey, Transaction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, createCloseAccountInstruction } from '@solana/spl-token';
import { sha256Hex, hexToBytes } from '../core/canonical.js';
import { scalarSigner } from './crypto/scalar-sign.js';
import { deriveVaultAta, buildClaimInstruction, deriveConfigPda, deriveTradeConfigPda, decodeConfigState, decodeTradeConfigState } from '../solana/escrow.js';
import { readAccountQuorum } from '../solana/quorum.js';
import { PROGRAM_ID } from '../solana/constants.js';
import { checkEscrow } from '../solana/check.js';

export function preimage(p) { hexToBytes(p, 32); return p; }
export function hash(p) { return sha256Hex(hexToBytes(preimage(p), 32)); }

export function initArgs({ A, escrowPreimage, H = hash(escrowPreimage),
  payer, mint, amount, expiryBlock, counted, now, recoveryMarginSec, refundAfter = now + (expiryBlock - counted) * 600 + recoveryMarginSec,
  expectedPlatformFeeBps, expectedTradeFeeBps = 0, tradeFeeCollector, programId }) {
  hexToBytes(A, 32);
  if (H !== hash(escrowPreimage)) throw new Error('Escrow preimage/hash mismatch');
  if (expectedTradeFeeBps !== 0) throw new Error('Put escrow collector must charge zero bps');
  if (!Number.isSafeInteger(refundAfter) || refundAfter < 0) throw new Error('Invalid recovery deadline');
  return { payer, payerTokenAccount: deriveVaultAta(payer, mint), recipient: new PublicKey(hexToBytes(A, 32)),
    refund: payer, refundAfter, paymentHashHex: H, mint, amount, expectedPlatformFeeBps, expectedTradeFeeBps,
    tradeFeeCollector, ...(programId ? { programId } : {}) };
}

export async function config({ endpoints, need = 2, escrowCollector, programId = PROGRAM_ID }) {
  if (!Number.isInteger(need) || need < 1 || !Array.isArray(endpoints) || endpoints.length < need) throw new Error('Escrow readers required');
  const read = async (derived, decode) => {
    const r = await readAccountQuorum(derived.pda, { endpoints, need, commitment: 'finalized', unanimous: true });
    if (!r.value || r.value.owner !== new PublicKey(programId).toBase58() || r.value.executable) throw new Error('Invalid escrow configuration account');
    const c = decode(r.value.data);
    if (c.bump !== derived.bump) throw new Error('Invalid escrow configuration bump');
    return c;
  };
  const platform = await read(deriveConfigPda(programId), decodeConfigState);
  const trade = await read(deriveTradeConfigPda(escrowCollector, programId), decodeTradeConfigState);
  if (trade.feeBps !== 0 || trade.feeCollector.toBase58() !== escrowCollector) throw new Error('Put escrow collector must charge zero bps');
  return { platformFeeBps: platform.feeBps, platformCollector: platform.feeCollector.toBase58(), tradeFeeBps: 0 };
}

async function check({ A, escrowPreimage, H = hash(escrowPreimage), payer, amount, mint, refundAfter, platformFeeBps, tradeFeeBps,
  platformCollector, escrowCollector, endpoints, need = 2, programId, timeoutMs, slotTolerance }, purpose) {
  if (!Number.isInteger(need) || need < 1 || !Array.isArray(endpoints) || endpoints.length < need) throw new Error('Escrow readers required');
  if (H !== hash(escrowPreimage) || tradeFeeBps !== 0) return { ok: false, reasons: [{ code: 'PUT_CONFIG', message: 'Invalid public preimage or nonzero escrow trade fee' }] };
  return checkEscrow({ hashHex: H, endpoints, need, commitment: 'finalized', programId, purpose, timeoutMs, slotTolerance,
    terms: { seller: { solRecipient: new PublicKey(hexToBytes(A, 32)).toBase58() }, buyer: { solPayer: payer },
      quoteAmount: amount, mint, refundAfter, fees: { platformFeeBps, tradeFeeBps, platformCollector, collector: escrowCollector } } });
}

export function verify(args) { return check(args, 'lock'); }

export async function settlement(args) {
  const result = await check(args, 'settlement');
  return { ...result, status: result.ok ? ['active', 'claimed', 'refunded'][result.state.status] : null };
}

export function claimAndSweep({ a, escrowPreimage, winnerSol, mint, amount, existingBalance = '0', tradeFeeCollector, programId, recentBlockhash }) {
  const signer = scalarSigner(a), recipient = new PublicKey(hexToBytes(signer.publicKey, 32)), winner = new PublicKey(winnerSol);
  if (winner.equals(recipient)) throw new Error('Winner must be distinct from lock');
  const total = BigInt(amount) + BigInt(existingBalance);
  if (BigInt(amount) <= 0n || BigInt(existingBalance) < 0n || total >= 2n ** 64n) throw new Error('Invalid sweep amount');
  const source = deriveVaultAta(recipient, mint), target = deriveVaultAta(winner, mint);
  const tx = new Transaction(); tx.feePayer = winner;
  tx.add(createAssociatedTokenAccountIdempotentInstruction(winner, source, recipient, new PublicKey(mint)),
    createAssociatedTokenAccountIdempotentInstruction(winner, target, winner, new PublicKey(mint)),
    buildClaimInstruction({ recipient, recipientTokenAccount: source, preimageHex: preimage(escrowPreimage), paymentHashHex: hash(escrowPreimage), mint, tradeFeeCollector, programId }),
    createTransferCheckedInstruction(source, new PublicKey(mint), target, recipient, total, 6),
    createCloseAccountInstruction(source, winner, recipient));
  if (recentBlockhash) { tx.recentBlockhash = recentBlockhash; tx.addSignature(recipient, Buffer.from(signer.sign(tx.serializeMessage()), 'hex')); }
  return tx;
}
