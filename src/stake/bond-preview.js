import { z } from 'zod';
import { registryPair, quoteAmount } from '../market/assets.js';
import { stakeError, errorDetails } from './errors.js';
import { formatAmount } from './status.js';

const requestSchema = z.object({ pair: z.string(), side: z.enum(['buy', 'sell']),
  amount: z.string().regex(/^[1-9][0-9]{0,30}$/), price: z.string().optional(),
  offerId: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict();

export function previewBond(role, input, now) {
  const args = requestSchema.parse(input), registry = role.registry.usable;
  try {
    if (!registry?.sellerBond || !role.stakeRuntime?.admission) throw stakeError('bond_setup_unavailable', { retrySec: 60 });
    // Trader.me carries no receiving key; the stake runtime holds it (as in the trader's own offers and takes).
    const me = { ...role.me, boxKey: role.stakeRuntime.boxKey }, pair = registryPair(registry, args.pair);
    const offer = args.offerId ? role.availableOffer(args.offerId) : null;
    if (args.offerId && (!offer || offer.pair !== args.pair || offer.side === args.side || BigInt(args.amount) > BigInt(offer.baseAmount)))
      throw stakeError('bond_setup_unavailable', { retrySec: 60 });
    // A buy ticket needs a real seller; its own optional buyer stake cannot cover the counterparty.
    if (args.side === 'buy' && !offer) throw stakeError('bond_setup_unavailable', { retrySec: 60 });
    const price = offer?.price ?? args.price;
    if (!price || args.price && offer && args.price !== offer.price) throw stakeError('bond_price_unavailable', { retrySec: 60 });
    const terms = { seller: args.side === 'sell' ? me : offer.maker,
      buyer: args.side === 'buy' ? me : offer?.maker ?? { boxKey: '0'.repeat(64) },
      base: pair.base, baseAmount: args.amount, quoteAmount: quoteAmount(pair, args.amount, price), fees: registry.fee,
      sendBy: now + registry.params.sendWindowSec, refundAfter: now + registry.params.refundSec };
    const bond = role.stakeRuntime.admission.propose(terms, now);
    return { ok: true, pair: args.pair, side: args.side, amount: args.amount, price, bond,
      formatted: { targetReset: formatAmount(bond.targetReset, 8), payoutReset: formatAmount(bond.payoutReset, 8), payoutUsd: formatAmount(bond.payoutUsd, 6) } };
  } catch (error) {
    if (error.result) return error.result;
    const code = Object.hasOwn(errorDetails, error.message) && ['bond_not_reserved', 'bond_required', 'bond_price_unavailable', 'bond_setup_unavailable'].includes(error.message)
      ? error.message : 'bond_setup_unavailable';
    return stakeError(code, ['bond_price_unavailable', 'bond_setup_unavailable'].includes(code) ? { retrySec: 60 } : {}).result;
  }
}
