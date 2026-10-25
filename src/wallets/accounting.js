import { PublicKey } from '@solana/web3.js';
import { isSolanaAddress, isTracAddress } from '../core/addresses.js';
import { quoteAmount, registryPair } from '../market/assets.js';
import { calculateFees } from '../solana/escrow.js';
import { releasesOfferAmount } from '../core/offer-inventory.js';

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
      if (s.mode !== 'maker' || s.offerId !== offer.offerId || releasesOfferAmount(t)) continue;
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

// Lock funding is outside the wallet after finality; pending transactions reserve wallet funds.
// Callers combine this with accountBalances while holding the same wallet admission lock.
export function lockCommitments(positions, lockKey) {
  const rows = Object.fromEntries(Object.keys(DECIMALS).map(asset => [asset, { pending: 0n, locked: 0n }]));
  for (const p of positions) {
    if (p.state === 'released') continue;
    const maker = p.post.maker.lockKey === lockKey, taker = p.taker?.lockKey === lockKey;
    if (!maker && !taker) continue;
    const t = p.post.terms, product = p.post.product, ops = p.operations ?? {}, asset = t.asset ?? 'RESET';
    const reserve = BigInt(p.registry.params.tnkReserve);
    const funding = asset === 'TNK' ? [['TNK', (BigInt(t.collateral ?? t.amount) + reserve).toString()]]
      : [['RESET', t.collateral ?? t.amount], ['TNK', reserve.toString()]];
    const hold = (items, prefix, own, funded, winner) => {
      for (const [currency, amount] of items) {
        const op = ops[prefix + currency], final = funded || op?.status === 'confirmed';
        if (final) { if (winner ? winner === (maker ? 'maker' : 'taker') : own) rows[currency].locked += BigInt(amount); }
        else if (own && (p.state !== 'ended:unfunded' || op)) rows[currency].pending += BigInt(amount);
      }
    };
    if (product === 'put') {
      if (ops.sweep?.status !== 'confirmed' && p.escrowStatus !== 'refunded') hold([['USDC', t.strikeTotal]], 'fund:', maker, p.funded, p.winner);
      if (maker && !p.funded && ops['fund:USDC']?.status !== 'confirmed') rows.USDC.pending += BigInt(p.escrowCost ?? t.strikeTotal) - BigInt(t.strikeTotal);
      if (p.taker && ops[`sweep:H:${p.takeId}`]?.status !== 'confirmed') hold(funding, `fund:H:${p.takeId}:`, taker, p.holderFunded, p.holderDecision?.winner);
    } else hold(funding, 'fund:', maker, p.funded, p.winner);
    const opening = `open:${p.takeId}`;
    if (taker && p.state === 'taking' && ops[opening]?.status !== 'confirmed') rows.USDC.pending += BigInt(t.principal ?? t.premium);
    for (const [step, op] of Object.entries(ops)) {
      if (op.status === 'confirmed' || step.startsWith('fund:') || step.startsWith('sweep') || step === opening && taker && p.state === 'taking') continue;
      const input = op.input;
      rows[input.asset ?? 'USDC'].pending += BigInt(input.amount ?? '0') + BigInt(input.fee ?? '0');
    }
  }
  return Object.fromEntries(Object.entries(rows).map(([asset, row]) => [asset, { pending: row.pending.toString(), locked: row.locked.toString() }]));
}

export function lockNetworkFees(positions, lockKey, feeTnk = MSB_FEE) {
  let sol = 0n, tnk = 0n;
  for (const p of positions) {
    const maker = p.post.maker.lockKey === lockKey, taker = p.taker?.lockKey === lockKey;
    if ((!maker && !taker) || p.state === 'released' || p.state === 'ended:unfunded' && !p.holderLock) continue;
    sol += BigInt(MIN_SOL);
    const holder = p.post.product === 'put';
    if (holder ? !taker || p.holderFunded : !maker || p.funded) continue;
    const prefix = holder ? `fund:H:${p.takeId}:` : 'fund:';
    const assets = p.post.terms.asset === 'TNK' ? ['TNK'] : ['RESET', ...(BigInt(p.registry.params.tnkReserve) > 0n ? ['TNK'] : [])];
    for (const asset of assets) if (p.operations?.[prefix + asset]?.status !== 'confirmed') tnk += BigInt(feeTnk);
  }
  return { SOL: sol.toString(), TNK: tnk.toString() };
}

export function accountLockBalances(balances, positions, lockKey, feeTnk = MSB_FEE) {
  const locks = lockCommitments(positions, lockKey), result = structuredClone(balances);
  const fees = lockNetworkFees(positions, lockKey, feeTnk);
  for (const [asset, row] of Object.entries(result)) {
    const pending = BigInt(locks[asset].pending), locked = BigInt(locks[asset].locked), fee = BigInt(fees[asset] ?? '0');
    row.balance = (BigInt(row.balance) + locked).toString();
    row.committed = (BigInt(row.committed) + pending + locked + fee).toString();
    row.free = max(0n, BigInt(row.free) - pending - fee).toString();
    row.breakdown.fees = (BigInt(row.breakdown.fees) + fee).toString();
    row.breakdown.locks = pending.toString(); row.breakdown.locked = locked.toString();
  }
  return result;
}
