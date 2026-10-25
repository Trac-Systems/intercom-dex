import { MIN_SOL } from '../wallets/accounting.js';
import { calculateFees } from '../solana/escrow.js';

export const TAKER_FUNDS_TIMEOUT_MS = 2000;
const units = value => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('Unreadable taker balance');
  return BigInt(value);
};

// This early check is advisory. Failed or slow reads preserve admission; signers independently check the seller.
export async function takerFunded({ terms, role, trac, solana, timeoutMs = TAKER_FUNDS_TIMEOUT_MS }) {
  let timer;
  try {
    const read = Promise.resolve().then(async () => {
      if (role === 'seller') {
        const b = await trac.balances(terms.seller.tracAddr), base = terms.base.id;
        const amount = units(terms.baseAmount), fee = units(b.feeTnk), tnk = units(b.TNK);
        return base === 'TNK' ? tnk >= amount + fee : units(b[base]) >= amount && tnk >= fee;
      }
      const b = await solana.walletBalances(terms.buyer.solPayer);
      const total = calculateFees(terms.quoteAmount, terms.fees.platformFeeBps, terms.fees.tradeFeeBps).totalAmount;
      return units(b.USDC) >= total && units(b.SOL) >= BigInt(MIN_SOL);
    });
    return await Promise.race([read, new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })]);
  } catch { return null; }
  finally { clearTimeout(timer); }
}
