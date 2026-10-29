import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { readAccount } from './rpc.js';
import { readRpcQuorum } from './read-quorum.js';
import { decodeEscrowState, deriveEscrowPda } from './escrow.js';
import { PROGRAM_ID } from './constants.js';

// Read-only absence evidence, including buyers who never disclosed a deal hash. Escrow accounts remain after claim
// and refund. Any matching attempt exempts (even a wrong amount/hash); this is not settlement verification.
// First fence the scan after a finalized chain clock past the deadline. Unsupported scans, bad accounts, stale
// contexts, RPC disagreements and unavailable clocks throw: callers must exempt, never turn these into absence.
export async function buyerPayment({ terms, after, endpoints, need = 2, timeoutMs = 3000, programId = PROGRAM_ID }) {
  const program = new PublicKey(programId), payer = new PublicKey(terms.buyer.solPayer);
  if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid payment observation deadline');
  const options = { endpoints, need, timeoutMs, unanimous: true };
  // Clocks change each slot, so require each answering reader to have passed the deadline rather than identical
  // sysvar bytes. The fence is a slot at least `need` finalized readers have reached.
  const clocks = (await Promise.allSettled(endpoints.map(async endpoint => {
    const clock = await readAccount(endpoint, SYSVAR_CLOCK_PUBKEY, { timeoutMs, commitment: 'finalized' });
    if (!clock.value || clock.value.owner !== 'Sysvar1111111111111111111111111111111111111' || clock.value.data.length !== 40) throw new Error('Unreadable finalized clock');
    const time = Number(clock.value.data.readBigInt64LE(32));
    if (!Number.isSafeInteger(time)) throw new Error('Invalid finalized clock time');
    return { slot: clock.slot, time };
  }))).filter(r => r.status === 'fulfilled').map(r => r.value);
  if (clocks.length < need) throw new Error('Finalized clock quorum unavailable');
  const chainTime = Math.min(...clocks.map(c => c.time));
  if (chainTime < after) return { ok: false, reason: 'chain-behind' };
  const minContextSlot = clocks.map(c => c.slot).sort((a, b) => b - a)[need - 1];
  const result = await readRpcQuorum('getProgramAccounts', [program.toBase58(), {
    commitment: 'finalized', encoding: 'base64', withContext: true, minContextSlot,
    filters: [{ dataSize: 263 }, { memcmp: { offset: 66, bytes: payer.toBase58() } }],
  }], { ...options, select: answer => {
    if (!Number.isSafeInteger(answer?.context?.slot) || answer.context.slot < minContextSlot || !Array.isArray(answer.value)) throw new Error('Unreadable or stale payment scan');
    let seen = false;
    for (const row of answer.value) {
      const account = row?.account;
      if (account?.owner !== program.toBase58() || account.executable !== false || account.data?.[1] !== 'base64' ||
          typeof account.data[0] !== 'string') throw new Error('Invalid payment account');
      const data = Buffer.from(account.data[0], 'base64'), s = decodeEscrowState(data);
      if (data.toString('base64') !== account.data[0] || !payer.equals(s.refund) ||
          row.pubkey !== deriveEscrowPda(s.paymentHashHex, program).pda.toBase58()) throw new Error('Invalid payment account identity');
      if (s.recipient.toBase58() === terms.seller.solRecipient && s.mint.toBase58() === terms.mint &&
          s.refundAfter === BigInt(terms.refundAfter)) seen = true;
    }
    return seen;
  } });
  return { ok: true, seen: result.value, chainTime };
}
