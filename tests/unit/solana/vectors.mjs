import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PROGRAM_ID } from '../../../src/solana/constants.js';
import { escrowAddresses } from '../../../src/solana/escrow.js';

export const key = n => new PublicKey(Buffer.alloc(32, n));
export const hashHex = '11'.repeat(32);
export const options = {
  payer: key(1), payerTokenAccount: key(2), recipient: key(3), refund: key(1), mint: key(4),
  paymentHashHex: hashHex, refundAfter: 1700000000n, amount: 1234567n,
  expectedPlatformFeeBps: 10, expectedTradeFeeBps: 50, tradeFeeCollector: key(5),
};
export const addresses = escrowAddresses(options);
export const terms = {
  seller: { solRecipient: key(3).toBase58() }, buyer: { solPayer: key(1).toBase58() },
  mint: key(4).toBase58(), quoteAmount: '1234567', refundAfter: 1700000000,
  fees: { platformFeeBps: 10, tradeFeeBps: 50, platformCollector: key(6).toBase58(), collector: key(5).toBase58() },
};

// Fixed offsets from the Rust structs; independent of the production decoders.
export function escrowBytes() {
  const b = Buffer.alloc(263);
  b[0] = 3; b[1] = 0;
  Buffer.from(hashHex, 'hex').copy(b, 2);
  key(3).toBuffer().copy(b, 34); key(1).toBuffer().copy(b, 66);
  b.writeBigInt64LE(1700000000n, 98); key(4).toBuffer().copy(b, 106);
  b.writeBigUInt64LE(1234567n, 138); b.writeBigUInt64LE(1234n, 146); b.writeUInt16LE(10, 154);
  key(6).toBuffer().copy(b, 156); b.writeBigUInt64LE(6172n, 188); b.writeUInt16LE(50, 196);
  key(5).toBuffer().copy(b, 198); addresses.vault.toBuffer().copy(b, 230); b[262] = addresses.bump;
  return b;
}

export function configBytes() {
  const b = Buffer.alloc(68);
  b[0] = 1; key(6).toBuffer().copy(b, 1); key(6).toBuffer().copy(b, 33);
  b.writeUInt16LE(10, 65); b[67] = 254;
  return b;
}

export function tokenBytes() {
  const b = Buffer.alloc(165);
  key(4).toBuffer().copy(b, 0); addresses.escrowPda.toBuffer().copy(b, 32);
  b.writeBigUInt64LE(1241973n, 64); b[108] = 1;
  return b;
}

export function wireAccount(data = escrowBytes(), owner = PROGRAM_ID.toBase58()) {
  return { data: [data.toString('base64'), 'base64'], owner, lamports: 2000000, executable: false };
}

export function wireVault() { return wireAccount(tokenBytes(), TOKEN_PROGRAM_ID.toBase58()); }
