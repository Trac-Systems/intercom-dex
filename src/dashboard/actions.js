import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { stableJSON } from '../core/canonical.js';
import { registryPair, quoteAmount } from '../market/assets.js';
import { calculateFees } from '../solana/escrow.js';
import { amountUnits, withdrawalDestination } from '../wallets/accounting.js';
import { amount, shortKey } from './format.js';
import { withdrawalView } from './model.js';
import { STALE_OFFER_MESSAGE } from '../market/book.js';
import { lockError } from '../locks/position.js';

export const CONFIRM_TTL_MS = 120000;
const HEX64 = /^[0-9a-f]{64}$/, PRICE = /^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$/;
const text = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Every action runs in two steps: preview returns the normalized input, a plain summary and a confirmation that is
// bound to exactly that input; run accepts only that confirmation, once, within two minutes.
export function createConfirmations({ secret = randomBytes(32), clock = () => Date.now(), ttlMs = CONFIRM_TTL_MS } = {}) {
  const used = new Map();
  const mac = (action, input, exp) => createHmac('sha256', secret).update(stableJSON({ action, input, exp })).digest('hex');
  return {
    issue(action, input) { const exp = clock() + ttlMs; return `${exp}.${mac(action, input, exp)}`; },
    consume(action, input, token) {
      const [exp, sig] = String(token ?? '').split('.'), at = Number(exp);
      for (const [t, e] of used) if (e < clock()) used.delete(t);
      if (!Number.isSafeInteger(at) || at < clock() || !/^[0-9a-f]{64}$/.test(sig ?? '')) throw Object.assign(new Error('Confirmation expired or missing; review the action again'), { reason: 'confirmation_expired' });
      if (!timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(mac(action, input, at), 'hex'))) throw Object.assign(new Error('Confirmation does not match this action'), { reason: 'confirmation_expired' });
      if (used.has(token)) throw Object.assign(new Error('This confirmation was already used'), { reason: 'confirmation_expired' });
      used.set(token, at);
    },
  };
}

// The dashboard's actions call the same role and wallet functions as the control API, the CLI and the MCP tools.
export function createActions({ config, role, wallets = null, balances = null, nextOffer = null }) {
  const kind = config.role, registry = () => ('usable' in role.registry ? role.registry.usable : role.registry);
  const freeOf = async asset => { const r = balances ? await balances() : null; return r?.value?.balances ? BigInt(r.value.balances[asset].free) : null; };
  const shortfall = async (asset, units) => {
    const free = await freeOf(asset);
    return free !== null && units > free ? `You have ${amount(free, asset).text} ${asset} free; this needs ${amount(units, asset).text} ${asset}.` : null;
  };

  const trader = {
    async offer(input) {
      const reg = registry();
      if (!reg) throw new Error('No signer list from the venue yet');
      const pair = registryPair(reg, text(input.pair, 32)), base = pair.base.id;
      const side = input.side === 'buy' ? 'buy' : input.side === 'sell' ? 'sell' : null;
      if (!side) throw new Error('Choose buy or sell');
      const price = text(input.price, 40);
      if (!PRICE.test(price)) throw new Error('Price must be a decimal number of USDC per ' + base);
      const baseAmount = amountUnits(base, text(input.amount, 100)).toString();
      if (BigInt(baseAmount) < BigInt(pair.minBaseAmount)) throw new Error(`The smallest offer is ${amount(pair.minBaseAmount, base).text} ${base}`);
      const ttlMin = Number(input.ttlMin ?? 60);
      if (!Number.isSafeInteger(ttlMin) || ttlMin < 1 || ttlMin > 1440) throw new Error('Offer time must be 1 to 1440 minutes');
      const quote = quoteAmount(pair, baseAmount, price);
      const lock = side === 'buy' ? calculateFees(BigInt(quote), reg.fee.platformFeeBps, reg.fee.tradeFeeBps).totalAmount : BigInt(baseAmount);
      const lockAsset = side === 'buy' ? 'USDC' : base;
      return { input: { pair: pair.pair, side, baseAmount, price, ttlSec: ttlMin * 60 }, title: `${side === 'buy' ? 'Buy' : 'Sell'} ${amount(baseAmount, base).text} ${base}`,
        lines: [
          ['Price', `${price} USDC per ${base}`],
          [side === 'buy' ? 'You pay' : 'You receive', `${amount(quote, 'USDC').text} USDC`],
          ['Set aside while the offer is open', `${amount(lock, lockAsset).text} ${lockAsset}${side === 'buy' ? ' (includes fees)' : ''}`],
          ['Offer open for', `${ttlMin} min`],
        ],
        note: side === 'buy' ? 'USDC is locked only when someone takes the offer and signers confirm; until then it stays in your wallet, set aside.'
          : `Your ${base} is sent only after the buyer's USDC is locked and signers confirmed.`,
        warning: await shortfall(lockAsset, lock) };
    },
    run: { offer: input => role.makeOffer(input) },

    async take(input) {
      const offerId = text(input.offerId, 64), o = HEX64.test(offerId) ? role.availableOffer(offerId) : null;
      if (!o) throw new Error(STALE_OFFER_MESSAGE);
      nextOffer?.check(o);
      const reg = role.registry.snapshot(o.registryVersion);
      if (!reg) throw new Error('No signer list for this offer');
      const pair = registryPair(reg, o.pair), base = pair.base.id;
      const baseAmount = input.amount ? amountUnits(base, text(input.amount, 100)).toString() : o.baseAmount;
      if (BigInt(baseAmount) > BigInt(o.baseAmount)) throw new Error(`This offer has only ${amount(o.baseAmount, base).text} ${base}`);
      // The smallest trade is the one of the signer list the offer was made under; signers check terms against it.
      if (BigInt(baseAmount) < BigInt(pair.minBaseAmount)) {
        throw new Error(`The smallest trade for this offer is ${amount(pair.minBaseAmount, base).text} ${base}` + (BigInt(o.baseAmount) < BigInt(pair.minBaseAmount)
          ? `; only ${amount(o.baseAmount, base).text} ${base} is left, so this rest cannot be traded. Offers placed now can go down to the current smallest trade.` : '.'));
      }
      const quote = quoteAmount(pair, baseAmount, o.price), buying = o.side === 'sell';
      const cost = calculateFees(BigInt(quote), reg.fee.platformFeeBps, reg.fee.tradeFeeBps).totalAmount;
      return { input: { offerId, baseAmount, price: o.price }, title: `${buying ? 'Buy' : 'Sell'} ${amount(baseAmount, base).text} ${base} at ${o.price} USDC`,
        lines: buying ? [['You lock', `${amount(cost, 'USDC').text} USDC (includes fees)`], ['You receive', `${amount(baseAmount, base).text} ${base}`]]
          : [['You send', `${amount(baseAmount, base).text} ${base}`], ['You receive', `${amount(quote, 'USDC').text} USDC`]],
        note: (buying ? 'Your USDC is locked on Solana. If the seller does not deliver in time, it comes back to you automatically.'
          : "You send only after the buyer's USDC is locked and signers confirmed.") + (nextOffer ? ' If this offer\'s maker does not answer, the next offer at this price is taken instead.' : ''),
        warning: await shortfall(buying ? 'USDC' : base, buying ? cost : BigInt(baseAmount)) };
    },

    // The most of an offer the free balance pays for: all of a buy offer up to the free base, and of a sell offer the
    // largest amount whose USDC cost with fees still fits (the cost only grows with the amount, so a search finds it).
    async maxTake(input) {
      const offerId = text(input.offerId, 64), o = HEX64.test(offerId) ? role.availableOffer(offerId) : null;
      if (!o) throw new Error(STALE_OFFER_MESSAGE);
      const reg = role.registry.snapshot(o.registryVersion);
      if (!reg) throw new Error('No signer list for this offer');
      const pair = registryPair(reg, o.pair), base = pair.base.id, buying = o.side === 'sell', offered = BigInt(o.baseAmount);
      const free = await freeOf(buying ? 'USDC' : base);
      if (free === null) throw new Error('Balances unavailable right now');
      const cost = units => calculateFees(BigInt(quoteAmount(pair, units.toString(), o.price)), reg.fee.platformFeeBps, reg.fee.tradeFeeBps).totalAmount;
      let most = buying ? 0n : (free < offered ? free : offered);
      if (buying) {
        for (let lo = 0n, hi = offered; lo <= hi;) {
          const mid = (lo + hi) / 2n;
          if (cost(mid) <= free) { most = mid; lo = mid + 1n; } else hi = mid - 1n;
        }
      }
      const short = most < BigInt(pair.minBaseAmount);
      return { baseAmount: most.toString(), amount: amount(most, base), all: most === offered,
        note: short ? `Your free ${buying ? 'USDC' : base} covers less than the smallest trade (${amount(pair.minBaseAmount, base).text} ${base}).` : null };
    },

    async cancel(input) {
      const offerId = text(input.offerId, 64), o = role.mine.get(offerId);
      if (!HEX64.test(offerId) || !o) throw new Error('Not one of your open offers');
      const base = o.pair.split('/')[0];
      return { input: { offerId }, title: 'Cancel offer',
        lines: [['Offer', `${o.side} ${amount(o.baseAmount, base).text} ${base} at ${o.price} USDC`]],
        note: 'Trades already running on this offer continue.' };
    },
  };
  trader.run.take = input => nextOffer ? nextOffer.take(input.offerId, input.baseAmount, input.price) : role.takeOffer(input.offerId, input.baseAmount, input.price);
  trader.run.cancel = input => role.cancelOffer(input.offerId);

  const withdraw = async input => {
    if (!wallets) throw new Error('This role has no wallets');
    const asset = text(input.asset, 8), chain = ['SOL', 'USDC'].includes(asset) ? 'solana' : 'trac';
    if (kind === 'service' && chain !== 'solana') throw new Error('The venue withdraws only USDC and SOL');
    if (kind === 'service' && !config.payout?.solana) throw new Error('Withdrawals need payout.solana in the config');
    const lock = config.payout?.[chain];
    const to = withdrawalDestination(asset, lock ?? (text(input.to, 120) || undefined), config.payout);
    const all = input.amount === 'all', value = all ? 'all' : text(input.amount, 100);
    const units = all ? await freeOf(asset) : amountUnits(asset, value);
    return { input: { asset, amount: value, to }, title: `Withdraw ${all ? 'all free' : amount(units, asset).text} ${asset}`,
      lines: [['Amount', units === null ? `all free ${asset}` : `${amount(units, asset).text} ${asset}`],
        ['To', to + (lock ? ' (fixed payout address)' : '')], ['Network fee', `paid in ${chain === 'solana' ? 'SOL' : 'TNK'}`]],
      note: 'This sends funds out of this wallet. It cannot be undone.', warning: all ? null : await shortfall(asset, units) };
  };
  const runWithdraw = async input => withdrawalView(await wallets.withdraw(input), config.network);

  const service = {
    async markPaid(input) {
      const dexKey = text(input.dexKey, 64), owed = (role.payouts[dexKey] ?? []).filter(p => p.final && !p.paid && !p.forfeited);
      if (!owed.length) throw new Error('Nothing is owed to this signer');
      const label = role.registry.signers.find(s => s.dexKey === dexKey)?.label ?? shortKey(dexKey);
      const total = owed.reduce((a, p) => a + BigInt(p.amount), 0n);
      return { input: { dexKey, tradeIds: owed.map(p => p.tradeId).sort() }, title: `Mark ${amount(total, 'USDC').text} USDC as paid to ${label}`,
        lines: [['Signer', `${label} (${shortKey(dexKey)})`], ['Trades', String(owed.length)], ['Amount', `${amount(total, 'USDC').text} USDC`]],
        note: 'Pay the signer yourself first. This only records the payment in the venue\'s books and cannot be undone here.' };
    },
  };

  const previews = kind === 'trader' ? { offer: trader.offer, take: trader.take, cancel: trader.cancel, withdraw }
    : kind === 'service' ? { markPaid: service.markPaid, withdraw } : {};
  const runs = kind === 'trader' ? { ...trader.run, withdraw: runWithdraw }
    : kind === 'service' ? { markPaid: input => role.markPaid(input.dexKey, input.tradeIds), withdraw: runWithdraw } : {};
  return { names: Object.keys(previews), preview: (name, input) => previews[name](input ?? {}), run: (name, input) => runs[name](input),
    ...(kind === 'trader' && role.locks ? { locks: createLockActions(role.locks) } : {}),
    maxTake: kind === 'trader' ? input => trader.maxTake(input ?? {}) : null };
}

export function createLockActions(client) {
  const names = ['post', 'take', 'repay', 'exercise', 'cancel', 'refund'];
  const normalize = (action, input = {}) => {
    if (!client) throw lockError('locks_disabled');
    if (!names.includes(action) || !input || typeof input !== 'object' || Array.isArray(input)) throw lockError('invalid_input');
    const { action: ignored, confirm, ...value } = input;
    if (value.asset !== undefined && !['RESET', 'TNK'].includes(value.asset)) throw lockError('invalid_input');
    if (action !== 'post') {
      if (Object.keys(value).some(k => !['positionId', 'product', 'asset'].includes(k))) throw lockError('invalid_input');
      const p = client.positions?.get(value.positionId) ?? client.book?.get(value.positionId);
      if (p && (value.asset && value.asset !== (p.post.terms.asset ?? 'RESET') || value.product && value.product !== p.post.product)) throw lockError('invalid_input');
      return value;
    }
    const asset = value.asset ?? value.terms?.asset ?? 'RESET', product = value.product;
    if (!['loan', 'call', 'put'].includes(product) || value.asset && value.terms?.asset && value.asset !== value.terms.asset) throw lockError('invalid_input');
    if (value.terms) {
      if (Object.keys(value).some(k => !['product', 'terms', 'asset'].includes(k))) throw lockError('invalid_input');
      return { product, terms: { ...value.terms, asset } };
    }
    const fields = product === 'loan' ? ['principal', 'repay', 'collateral', 'fee', 'termBlocks'] : ['amount', 'premium', 'strikeTotal', 'expiryBlock'];
    if (Object.keys(value).some(k => !['product', 'asset', 'offerUntilBlock', ...fields].includes(k))) throw lockError('invalid_input');
    const terms = { asset };
    for (const k of fields.filter(k => !['fee', 'termBlocks', 'expiryBlock'].includes(k))) terms[k] = amountUnits(['amount', 'collateral'].includes(k) ? asset : 'USDC', value[k]).toString();
    if (product === 'loan') {
      terms.termBlocks = value.termBlocks;
      if (value.fee !== undefined) {
        const fee = value.fee === '0' ? 0n : amountUnits('USDC', value.fee);
        if (BigInt(terms.repay) !== BigInt(terms.principal) + fee) throw lockError('invalid_input');
      }
    } else terms.expiryBlock = value.expiryBlock;
    if (!Number.isSafeInteger(client.counted)) throw lockError('clock_unavailable');
    const max = client.registry?.usable?.params.offerMaxBlocks ?? 144;
    terms.offerUntilBlock = value.offerUntilBlock ?? Math.min(client.counted + Math.min(144, max), terms.expiryBlock === undefined ? Number.MAX_SAFE_INTEGER : terms.expiryBlock - 1);
    return { product, terms };
  };
  return {
    names, normalize,
    async preview(action, input = {}) {
      const normalized = normalize(action, input), preview = client.preview({ ...normalized, action });
      if (action === 'post' && preview.product === 'put' && client.adapters.escrowCosts) {
        const cost = await client.adapters.escrowCosts({ registry: client.registry.usable, amount: preview.terms.strikeTotal });
        preview.amounts.escrowTotal = cost.total; preview.amounts.escrowPlatformFee = (BigInt(cost.total) - BigInt(preview.terms.strikeTotal)).toString();
      }
      const a = preview.amounts, t = preview.terms, asset = preview.asset ?? t?.asset ?? 'RESET';
      let sentence = preview.now;
      if (a && t) {
        const usd = n => `${amount(n, 'USDC').text} USDC`, base = `${amount(t.collateral ?? t.amount, asset).text} ${asset}`;
        if (action === 'post' && preview.product === 'loan') sentence = `You get ${usd(a.makerReceives)} once a lender takes this. Pay back ${usd(t.repay)} in ${t.termBlocks} counted Bitcoin blocks, or the lender keeps your ${base}.`;
        else if (action === 'post') sentence = `You lock ${preview.product === 'put' ? usd(t.strikeTotal) : base} until block ${t.expiryBlock}. You receive ${usd(a.makerReceives)} when someone takes this.`;
        else if (action === 'take') sentence = preview.product === 'put'
          ? `Protect against a drop: lock your ${base} for the term and pay ${usd(a.openingTotal)}. A small Solana message before block ${t.expiryBlock} sells it for ${usd(t.strikeTotal)}.`
          : `Pay ${usd(a.openingTotal)} to take this offer. ${preview.now}`;
        else if (action === 'exercise' && preview.product === 'put') sentence = `Send a small Solana message to sell your locked ${base} for ${usd(t.strikeTotal)}. Release follows about an hour after the message is finalized.`;
        else if (action === 'repay') sentence = `Pay back ${usd(t.repay)}. Your ${base} returns about an hour after payment, once the verified Bitcoin median time covers it.`;
        else if (action === 'refund') sentence = `Refund your unclaimed escrow after its on-chain refund deadline. The holder keeps their asset if it is refunded.`;
        else if (action === 'cancel') sentence = `Cancel this offer and collect the locked funds after enough signers accept.`;
        if (a.escrowTotal) sentence += ` Escrow funding ${usd(a.escrowTotal)}, including ${usd(a.escrowPlatformFee)} platform fee.`;
        if (['post', 'take'].includes(action)) sentence += ` Opening total ${usd(a.openingTotal)}: maker receives ${usd(a.makerReceives)}; service fee ${usd(a.openingFee)}.`;
      }
      return { ...preview, sentence, input: { action, ...normalized } };
    },
    run(action, input = {}) {
      const value = normalize(action, input);
      if (action === 'post') return client.post(value);
      if (action === 'take') return client.take(value.positionId);
      if (action === 'cancel') return client.cancel(value.positionId);
      if (action === 'refund') return client.refund(value.positionId);
      return client.pay(value.positionId, action);
    },
  };
}
