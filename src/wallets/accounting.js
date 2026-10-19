import { PublicKey } from '@solana/web3.js';
import { isSolanaAddress, isTracAddress } from '../core/addresses.js';
import { quoteAmount, registryPair } from '../market/assets.js';
import { calculateFees } from '../solana/escrow.js';

export const DECIMALS = Object.freeze({ USDC: 6, SOL: 9, TNK: 18, RESET: 8 });
// Keep enough for transaction fees and ATA/escrow rent, and two MSB transfers.
export const MIN_SOL = '10000000';
export const MIN_TNK = '60000000000000000';
export const MSB_FEE = '30000000000000000';
const max = (a, b) => a > b ? a : b;

export function amountUnits(asset, amount) {
  if (!Object.hasOwn(DECIMALS, asset) || typeof amount !== 'string' || amount.length > 100 || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(amount)) throw new Error('Invalid asset or decimal amount');
  const [whole, fraction = ''] = amount.split('.');
  if (fraction.length > DECIMALS[asset]) throw new Error('Too many decimal places');
  const value = BigInt(whole + fraction.padEnd(DECIMALS[asset], '0'));
  if (value <= 0n || value > (['SOL', 'USDC'].includes(asset) ? (1n << 64n) - 1n : (1n << 128n) - 1n)) throw new Error('Amount out of range');
  return value;
}

export function validatePayout(payout = {}) {
  if (!payout || typeof payout !== 'object' || Array.isArray(payout) || Object.keys(payout).some(k => !['solana', 'trac'].includes(k))) throw new Error('Invalid payout settings');
  for (const [chain, address] of Object.entries(payout)) {
    if (!(chain === 'solana' ? isSolanaAddress(address) : isTracAddress(address) && address === address.toLowerCase())) throw new Error('Invalid payout address');
    // Off-curve addresses (token accounts, program addresses) have no key that could ever move what they receive.
    if (chain === 'solana' && !PublicKey.isOnCurve(new PublicKey(address).toBytes())) throw new Error('This is not a wallet address (no one can sign for it, for example a token account); give the wallet address');
  }
  return payout;
}

export function withdrawalDestination(asset, to, payout) {
  if (!Object.hasOwn(DECIMALS, asset)) throw new Error('Invalid asset');
  const chain = ['SOL', 'USDC'].includes(asset) ? 'solana' : 'trac';
  const lock = validatePayout(payout)[chain];
  if (lock && to !== undefined && to !== lock) throw new Error('Destination differs from payout lock');
  const destination = to ?? lock;
  validatePayout({ [chain]: destination });
  return destination;
}

// Balances are base-unit strings. Escrow funds are shown separately from the spendable wallet.
// Pending chain actions remain reserved until their state machine records settlement.
export function accountBalances({ balances, offers = [], trades = [], registry, now = Math.floor(Date.now() / 1000),
  trader = true, feeTnk = MSB_FEE, withdrawals = [] }) {
  const rows = Object.fromEntries(Object.entries(DECIMALS).map(([asset, decimals]) => [asset,
    { decimals, wallet: BigInt(balances[asset] ?? '0'), offers: 0n, trades: 0n, escrow: 0n, fees: 0n, withdrawals: 0n }]));
  const fee = BigInt(feeTnk), active = t => !['complete', 'refunded', 'lost'].includes(t.state.phase) &&
    (t.state.phase !== 'aborted' || t.state.locked || t.state.lockAttempted);
  let solActions = 0n, tracActions = 0n;
  for (const t of trades) {
    if (!active(t) || !['buyer', 'seller'].includes(t.role)) continue;
    const s = t.state, terms = s.terms ?? s.draft;
    if (t.role === 'buyer') {
      const cost = calculateFees(BigInt(terms.quoteAmount), terms.fees.platformFeeBps, terms.fees.tradeFeeBps).totalAmount;
      if (s.locked && !s.lockUnknown) rows.USDC.escrow += cost;
      else rows.USDC.trades += cost;
      solActions++;
    } else {
      rows[terms.base.id].trades += BigInt(terms.baseAmount);
      tracActions++; solActions++;
    }
  }
  for (const offer of offers) {
    if (offer.expiresAt <= now) continue;
    let consumed = 0n;
    for (const t of trades) {
      const s = t.state;
      if (s.mode !== 'maker' || s.offerId !== offer.offerId || ['aborted', 'refunded'].includes(s.phase)) continue;
      consumed += BigInt((s.terms ?? s.draft).baseAmount);
    }
    const remaining = max(0n, BigInt(offer.baseAmount) - consumed);
    if (!remaining) continue;
    const snapshot = registry(offer.registryVersion), pair = registryPair(snapshot, offer.pair, { open: false });
    if (offer.side === 'sell') { rows[pair.base.id].offers += remaining; tracActions++; }
    else {
      const quote = BigInt(quoteAmount(pair, remaining.toString(), offer.price));
      rows.USDC.offers += calculateFees(quote, snapshot.fee.platformFeeBps, snapshot.fee.tradeFeeBps).totalAmount;
    }
    solActions++;
  }
  rows.SOL.fees = BigInt(MIN_SOL) * max(1n, solActions);
  if (trader) rows.TNK.fees = max(BigInt(MIN_TNK), fee * (tracActions + 2n));
  for (const w of withdrawals) if (!['confirmed', 'failed'].includes(w.status)) {
    rows[w.asset].withdrawals += BigInt(w.amount);
  }
  return Object.fromEntries(Object.entries(rows).map(([asset, r]) => {
    const held = r.offers + r.trades + r.fees + r.withdrawals;
    const total = r.wallet + r.escrow, committed = held + r.escrow;
    return [asset, { decimals: r.decimals, balance: total.toString(), wallet: r.wallet.toString(),
      committed: committed.toString(), free: max(0n, r.wallet - held).toString(),
      breakdown: Object.fromEntries(['offers', 'trades', 'escrow', 'fees', 'withdrawals'].map(k => [k, r[k].toString()])) }];
  }));
}
