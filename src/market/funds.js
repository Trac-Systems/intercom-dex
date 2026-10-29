import { quoteAmount, priceUnits } from './assets.js';
import { MIN_SOL } from '../wallets/accounting.js';
import { validAddressProof } from '../core/address-proof.js';

// Maker funds: the venue reads each maker's wallet and leaves an offer out of its published book while the maker cannot
// fill even the pair's smallest trade. Bids share one wallet budget across pairs, after pending purchases, including
// USDC fees and one MIN_SOL reserve per lock. Unknown/malformed balances preserve the unsized offer; repeated isolated
// read failures retain the existing #failing policy. A chain-wide outage never hides or sizes offers from failed reads.
export const FUNDS_TTL_SEC = 300, FUNDS_READS_AT_ONCE = 4, FAILED_READS = 3;

export class MakerFunds {
  constructor({ solana, trac, now, addressProof = () => ({ required: false }), log = () => {}, ttlSec = FUNDS_TTL_SEC, readsAtOnce = FUNDS_READS_AT_ONCE }) {
    Object.assign(this, { solana, trac, now, addressProof, log, ttlSec, readsAtOnce });
    this.wallets = new Map();   // `${chain}:${address}` -> { balances, at, failures } (balances null after a failed read)
    this.lastGood = new Map();  // chain -> time of the latest successful read on it
    this.reading = new Set();
  }

  // Proof admission fails closed. Once admitted, an unknown balance or read error keeps the offer.
  funded(offer, pair) {
    if (!this.#proven(offer)) return false;
    try { return this.#funded(offer, pair); } catch { return true; }
  }

  // Entries carry the offer's original fee terms and venue first-seen time. Allocate globally before publishing any
  // pair: highest price, then oldest, then id. All integer floors match the quote and escrow fee formulas.
  allocate(entries, pending = new Map(), purchases = []) {
    const budgets = new Map(), sizes = new Map();
    const cost = (quote, fees = {}) => quote + quote * BigInt(fees.platformFeeBps ?? 0) / 10000n +
      quote * BigInt(fees.tradeFeeBps ?? 0) / 10000n;
    const ordered = [...entries].sort((a, b) => {
      const d = priceUnits(b.offer.price) - priceUnits(a.offer.price);
      return (d > 0n ? 1 : d < 0n ? -1 : 0) || a.firstSeen - b.firstSeen || a.offer.offerId.localeCompare(b.offer.offerId);
    });
    for (const { offer: o, pair, fees } of ordered) {
      let free = BigInt(o.baseAmount) - (pending.get(o.offerId) ?? 0n);
      if (!this.funded(o, pair) || free < BigInt(pair.minBaseAmount)) { sizes.set(o.offerId, '0'); continue; }
      if (o.side === 'buy') {
        const address = o.maker.solAddr;
        if (!budgets.has(address)) {
          let budget = null;
          try {
            const b = this.balances(o);
            if (b && [b.USDC, b.SOL].every(v => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v))) {
              budget = { usdc: BigInt(b.USDC), sol: BigInt(b.SOL) };
              for (const t of purchases) if (t.buyer.solPayer === address) {
                // A logged trade may have spent a balance cached before settlement. Keep that debit until a newer
                // wallet read observes it; otherwise logging a fill briefly creates spendable money again.
                const read = this.wallets.get(`solana:${address}`);
                if (t.settledAt != null && t.settledAt < (read.readAt ?? read.at)) continue;
                budget.usdc -= cost(BigInt(t.quoteAmount), t.fees);
                budget.sol -= BigInt(MIN_SOL);
              }
            }
          } catch { budget = null; }
          budgets.set(address, budget);
        }
        const budget = budgets.get(address);
        if (budget) {
          const quote = amount => amount * priceUnits(o.price) * 1000000n / 10n ** BigInt(pair.base.decimals + 12);
          let lo = 0n, hi = free;
          if (budget.sol < BigInt(MIN_SOL)) hi = 0n;
          while (lo < hi) {
            const mid = (lo + hi + 1n) / 2n;
            if (cost(quote(mid), fees) <= budget.usdc) lo = mid; else hi = mid - 1n;
          }
          free = lo;
          if (free >= BigInt(pair.minBaseAmount) && quote(free) > 0n) {
            budget.usdc -= cost(quote(free), fees); budget.sol -= BigInt(MIN_SOL);
          } else free = 0n;
        }
      }
      sizes.set(o.offerId, free.toString());
    }
    return sizes;
  }

  #proven(offer) {
    try { return validAddressProof(offer.maker, { ...this.addressProof(), now: this.now(), validUntil: offer.expiresAt }); }
    catch { return false; }
  }

  // A wallet that failed FAILED_READS reads in a row while other wallets on the same chain read fine is treated as
  // unfunded; while the chain's reads fail for everyone (an RPC or peer outage), failed wallets hide nothing.
  #failing(chain, address) {
    const w = this.wallets.get(`${chain}:${address}`);
    return !!w && w.balances === null && w.failures >= FAILED_READS && (this.lastGood.get(chain) ?? -Infinity) > this.now() - this.ttlSec;
  }

  #funded(offer, pair) {
    const min = BigInt(pair.minBaseAmount);
    if (this.#failing(...(offer.side === 'sell' ? ['trac', offer.maker.tracAddr] : ['solana', offer.maker.solAddr]))) return false;
    if (offer.side === 'sell') {
      const b = this.#cached('trac', offer.maker.tracAddr);
      if (!b) return true;
      const base = pair.base.id, fee = BigInt(b.feeTnk);
      if (base === 'TNK') return BigInt(b.TNK) >= min + fee;
      return BigInt(b[base] ?? '0') >= min && BigInt(b.TNK) >= fee;
    }
    const b = this.#cached('solana', offer.maker.solAddr);
    if (!b) return true;
    return BigInt(b.USDC) >= BigInt(quoteAmount(pair, min.toString(), offer.price)) && BigInt(b.SOL) >= BigInt(MIN_SOL);
  }

  // Start reads for makers whose reading is missing or older than the TTL, a few at a time; never waits for them.
  refresh(offers) {
    const due = [];
    for (const o of offers) {
      if (!this.#proven(o)) continue;
      const [chain, address] = o.side === 'sell' ? ['trac', o.maker.tracAddr] : ['solana', o.maker.solAddr];
      const key = `${chain}:${address}`, w = this.wallets.get(key);
      if (this.reading.has(key) || due.some(d => d.key === key) || (w && this.now() - w.at < this.ttlSec)) continue;
      due.push({ key, chain, address });
    }
    for (const d of due.slice(0, Math.max(0, this.readsAtOnce - this.reading.size))) this.#read(d);
  }

  // The last balances read for this offer's maker (null when unread or unreadable).
  balances(offer) {
    if (!this.#proven(offer)) return null;
    return offer.side === 'sell' ? this.#cached('trac', offer.maker.tracAddr) : this.#cached('solana', offer.maker.solAddr);
  }

  forget(keep) {
    for (const key of this.wallets.keys()) if (!keep.has(key)) this.wallets.delete(key);
  }

  #cached(chain, address) {
    const w = this.wallets.get(`${chain}:${address}`);
    // A slow successful response does not make the snapshot newer than the request that obtained it.
    return w && this.now() - (w.readAt ?? w.at) < 2 * this.ttlSec ? w.balances : null;
  }

  async #read({ key, chain, address }) {
    this.reading.add(key);
    const readAt = this.now();
    try {
      const balances = chain === 'trac' ? await this.trac.balances(address) : await this.solana.walletBalances(address);
      this.wallets.set(key, { balances, at: this.now(), readAt, failures: 0 });
      this.lastGood.set(chain, this.now());
    } catch (e) {
      this.wallets.set(key, { balances: null, at: this.now(), failures: (this.wallets.get(key)?.failures ?? 0) + 1 });
      this.log('funds read', chain, address.slice(0, 12), e.message);
    } finally {
      this.reading.delete(key);
    }
  }
}
