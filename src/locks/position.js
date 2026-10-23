import { z } from 'zod';
import { meetsVersion } from '../core/software.js';
import { randomBytes } from 'node:crypto';
import { sha256Hex, stableJSON } from '../core/canonical.js';
import { isTracAddress, isSolanaAddress } from '../core/addresses.js';
import { products, deadlineOf, termsOf, assetOf } from './products/index.js';

export const OUTCOMES = Object.freeze(['repaid', 'defaulted', 'exercised', 'expired', 'cancelled', 'unfunded']);
export const STATES = Object.freeze(['creating', 'funding', 'posted', 'taking', 'running', ...OUTCOMES.map(x => `ended:${x}`), 'released']);
export const REASONS = Object.freeze({
  locks_disabled: 'Loans and options are switched off in this app.',
  invalid_input: 'Something in the form is not valid. Check the amounts and the time.',
  registry_unavailable: 'The loans and options service has not sent its settings yet. Try again in a minute.',
  venue_unavailable: 'The loans and options service is not answering right now. Try again in a minute.',
  registry_conflict: 'The loans and options service sent conflicting settings, so new offers are paused for safety.',
  product_paused: 'This kind of offer is paused right now.',
  update_required: 'This app is too old for loans and options. Update it first.',
  limit_exceeded: 'This amount is outside the allowed range.',
  term_out_of_range: 'The time you picked is too short or too long.',
  unknown_position: 'This offer no longer exists. Refresh the list.',
  not_your_position: 'This is not your offer, so you cannot do that.',
  own_offer: 'This is your own offer. You cannot take it yourself.',
  already_taken: 'Someone else took this offer first. Nothing was paid.',
  offer_expired: 'This offer has run out of time.',
  wrong_state: 'That is not possible at this point. Refresh to see where this offer stands.',
  signers_unavailable: 'Not enough signers are online right now. Do not send any payment by hand; try again shortly.',
  dkg_failed: 'Setting up the safe for this offer failed. Nothing was paid. Create the offer again.',
  lock_mismatch: 'The safe for this offer did not check out. Do not pay into it; create the offer again.',
  reservation_expired: 'Your hold on this offer ran out before the payment. Take it again to get a new hold.',
  reservation_active: 'Someone is taking this offer right now. Wait a few minutes before cancelling.',
  insufficient_funds: 'Not enough funds. You need the amount itself plus a little SOL and TNK for network fees.',
  fee_changed: 'The network fee for this just changed. Wait a moment and try again.',
  refund_not_ready: 'The refund is not open yet. It opens after the deadline shown on the offer.',
  payment_pending: 'Your payment is still being confirmed. Do not pay again.',
  collect_pending: 'Collecting your coins from the lock. This takes a minute.',
  payment_failed: 'The payment did not go through. Check your balance and try again.',
  deadline_passed: 'The deadline has passed, so paying is no longer possible. The outcome is being settled.',
  clock_unavailable: 'Waiting for the latest Bitcoin block. Try again in a minute.',
  invalid_message: 'A message from the network could not be verified and was ignored.',
  invalid_share: 'One signer sent a bad piece. The app collects the pieces from the other signers instead.',
  adapter_unavailable: 'Loans and options are not fully set up in this app.',
  protocol_unavailable: 'The loans and options service runs a newer version than this app. Update the app.',
  sweep_pending: 'Your funds are being collected. Keep the app running until it finishes.',
  settings_invalid: 'One of these settings is not valid.',
  confirmation_expired: 'This preview is out of date. Check the numbers and press the button again.',
  unexpected: 'Something unexpected went wrong. Try again; if it repeats, the app log has the details.',
});
const DECIMALS = { RESET: 8, TNK: 18, USDC: 6, SOL: 9 };
const LABELS = { collateral: 'collateral', amount: 'amount', principal: 'loan amount', repay: 'amount to pay back', premium: 'fee', strikeTotal: 'fixed price' };
export function formatUnits(value, asset) {
  const d = DECIMALS[asset] ?? 0, s = BigInt(value).toString().padStart(d + 1, '0');
  const whole = s.slice(0, s.length - d), frac = s.slice(s.length - d).replace(/0+$/, '');
  return `${whole}${frac ? '.' + frac : ''} ${asset}`;
}
const blocksText = n => `${n} blocks (about ${n >= 288 ? Math.round(n / 144) + ' days' : Math.round(n / 6) + ' hours'})`;

export function lockError(reason, detail) { return Object.assign(new Error(reason), { reason, whatToDo: detail ?? REASONS[reason] ?? REASONS.invalid_input }); }
export function errorResult(error) {
  // An error without a known reason is never passed off as a form problem: people see what actually happened.
  if (!Object.hasOwn(REASONS, error?.reason)) {
    const message = String(error?.message ?? '').trim().slice(0, 200);
    return { ok: false, reason: 'unexpected', whatToDo: message ? `Something went wrong: ${message}` : REASONS.unexpected };
  }
  return { ok: false, reason: error.reason, whatToDo: typeof error.whatToDo === 'string' ? error.whatToDo : REASONS[error.reason] };
}
export const hex32 = z.string().regex(/^[0-9a-f]{64}$/);
export const units = z.string().max(39).regex(/^[1-9][0-9]*$/);
export const height = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const usdc = units.refine(s => BigInt(s) <= (1n << 64n) - 1n);
const reset = units.refine(s => BigInt(s) <= (1n << 128n) - 1n);
export const partySchema = z.object({ lockKey: hex32, boxKey: hex32,
  trac: z.string().refine(s => s === s.toLowerCase() && isTracAddress(s)), sol: z.string().refine(isSolanaAddress) }).strict();
export const assetSchema = z.enum(['RESET', 'TNK']);
export const termsSchemas = {
  loan: z.object({ asset: assetSchema.optional(), collateral: reset, principal: usdc, repay: usdc, termBlocks: height, offerUntilBlock: height }).strict(),
  call: z.object({ asset: assetSchema.optional(), amount: reset, premium: usdc, strikeTotal: usdc, expiryBlock: height, offerUntilBlock: height }).strict(),
  put: z.object({ asset: assetSchema.optional(), amount: reset, premium: usdc, strikeTotal: usdc, expiryBlock: height, offerUntilBlock: height }).strict(),
};
const postSchema = z.object({ v: z.literal(1), product: z.enum(['loan', 'call', 'put']), maker: partySchema,
  terms: z.record(z.string(), z.unknown()), registryVersion: height.refine(n => n > 0), createdAt: height, nonce: hex32, escrowPreimage: hex32.optional(), drawSlot: height.optional() }).strict();

export function validatePost(input, registry = null, { counted, totalLocked = null, openPositions = 0, makerPositions = 0 } = {}) {
  let post;
  try { post = postSchema.parse(input); post.terms = termsSchemas[post.product].parse(post.terms); }
  catch { throw lockError('invalid_input'); }
  const t = post.terms;
  if (post.product === 'put' && !post.escrowPreimage) throw lockError('invalid_input');
  if (post.product === 'loan' ? t.termBlocks < 6 : t.offerUntilBlock >= t.expiryBlock) throw lockError('term_out_of_range',
    post.product === 'loan' ? 'The loan time is too short.' : 'The offer must stop being takeable before the option ends.');
  if (!registry) return post;
  if (post.registryVersion !== registry.version) throw lockError('registry_unavailable');
  const { n, k } = registry.params;
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(k) || k <= n / 2 || k > n || n > 16) throw lockError('registry_unavailable');
  if (registry.products[post.product] !== 'open' || registry.assets && registry.assets[assetOf(post)] !== 'open') throw lockError('product_paused');
  const p = registry.params;
  if (openPositions >= Math.min(p.maxPositions ?? p.maxOpenPositions ?? 2000, 2000)) throw lockError('limit_exceeded', 'The service holds as many loans and options as it can right now. Try again later.');
  const perMaker = Math.min(p.maxPerMaker ?? 50, 50);
  if (makerPositions >= perMaker) throw lockError('limit_exceeded', `You already have ${perMaker} open loans and options, the most allowed. Wait until some have ended.`);
  if (post.product === 'loan' && (t.termBlocks < p.termBlocks.min || t.termBlocks > p.termBlocks.max)) throw lockError('term_out_of_range', `The loan time must be between ${blocksText(p.termBlocks.min)} and ${blocksText(p.termBlocks.max)}.`);
  if (counted !== undefined && post.product !== 'loan' && t.expiryBlock > counted + p.offerMaxBlocks) throw lockError('term_out_of_range', `The end can be at most ${blocksText(p.offerMaxBlocks)} from now.`);
  if (counted !== undefined && (!Number.isSafeInteger(counted) || counted < 0 || t.offerUntilBlock <= counted || t.offerUntilBlock - counted > p.offerMaxBlocks ||
      post.product === 'loan' && !Number.isSafeInteger(counted + t.termBlocks))) throw lockError('term_out_of_range', `The offer must stay open for some time, at most ${blocksText(p.offerMaxBlocks)}.`);
  const within = (asset, key) => {
    const bounds = registry.limits[asset], v = BigInt(t[key]), label = LABELS[key] ?? key;
    if (!bounds) throw lockError('product_paused');
    if (v < BigInt(bounds.min)) throw lockError('limit_exceeded', `The ${label} is too small. The smallest allowed is ${formatUnits(bounds.min, asset)}.`);
    if (v > BigInt(bounds.max)) throw lockError('limit_exceeded', `The ${label} is too large. The most allowed is ${formatUnits(bounds.max, asset)}.`);
  };
  within(assetOf(post), t.collateral !== undefined ? 'collateral' : 'amount');
  for (const key of post.product === 'loan' ? ['principal', 'repay'] : ['premium', 'strikeTotal']) within('USDC', key);
  if (totalLocked) {
    const asset = post.product === 'put' ? 'USDC' : assetOf(post), value = t.strikeTotal && post.product === 'put' ? t.strikeTotal : t.collateral ?? t.amount;
    const used = BigInt(totalLocked[asset] ?? '0'), cap = BigInt(registry.limits.totalLocked[asset]);
    if (used + BigInt(value) > cap) throw lockError('limit_exceeded', `The service is close to its total limit for ${asset}: ${formatUnits(used, asset)} of ${formatUnits(cap, asset)} are in use. Try a smaller amount or later.`);
  }
  return post;
}

export const positionId = post => sha256Hex(stableJSON(validatePost(post)));
export const positionIdOf = positionId;
export function selectCommittee(registry, id, drawSeed = null) {
  hex32.parse(id);
  const eligible = registry.signers.filter(s => s.status === 'active' && meetsVersion(s.software, registry.minSoftware) && !(registry.removed ?? []).some(r => (r.lockKey ?? r) === s.lockKey))
    .sort((a, b) => a.lockKey.localeCompare(b.lockKey));
  const { n, k } = registry.params, modern = !!registry.assets, minimum = modern ? registry.params.minOperatorSigners ?? k : 0;
  if (eligible.length < n || n > 16 || k <= n / 2 || k > n || k < 1 || new Set(eligible.map(s => s.lockKey)).size !== eligible.length ||
      eligible.filter(s => s.group === 'operator').length < minimum) throw lockError('signers_unavailable');
  if (modern && eligible.length === n) return eligible;
  if (eligible.length > n && !drawSeed) throw lockError('protocol_unavailable');
  const seed = drawSeed ?? id; hex32.parse(seed);
  let c = 0;
  while (c < 1000000) {
    const pool = [...eligible], chosen = [];
    while (chosen.length < n) {
      const counter = Buffer.alloc(4); counter.writeUInt32BE(c++);
      const x = BigInt('0x' + sha256Hex(Buffer.concat([Buffer.from(seed, 'hex'), counter]))), size = BigInt(pool.length);
      if (x >= (2n ** 256n / size) * size) continue;
      chosen.push(pool.splice(Number(x % size), 1)[0]);
    }
    if (chosen.filter(s => s.group === 'operator').length >= minimum) return chosen;
  }
  throw lockError('signers_unavailable');
}
export function createPost({ product, maker, terms, registryVersion, createdAt = Math.floor(Date.now() / 1000), nonce = randomBytes(32).toString('hex'), escrowPreimage, drawSlot }, registry, context) {
  return validatePost({ v: 1, product, maker, terms, registryVersion, createdAt, nonce,
    ...(product === 'put' ? { escrowPreimage: escrowPreimage ?? randomBytes(32).toString('hex') } : {}), ...(drawSlot === undefined ? {} : { drawSlot }) }, registry, context);
}

export function majority(votes, committee, k, select = v => v) {
  if (!Number.isSafeInteger(k) || k <= committee.length / 2 || k > committee.length || committee.length > 16) throw lockError('registry_unavailable');
  const allowed = new Set(committee.map(s => s.lockKey)), seen = new Map(), groups = new Map();
  for (const vote of votes) {
    if (!allowed.has(vote.from)) continue;
    const value = select(vote), key = stableJSON(value);
    if (seen.has(vote.from)) {
      if (seen.get(vote.from) !== key) throw lockError('invalid_message');
      continue;
    }
    seen.set(vote.from, key);
    const group = groups.get(key) ?? { value, count: 0 }; group.count++; groups.set(key, group);
  }
  return [...groups.values()].find(g => g.count >= k)?.value ?? null;
}

const decimal = (value, places) => {
  const s = String(value).padStart(places + 1, '0'), fraction = s.slice(-places).replace(/0+$/, '');
  return s.slice(0, -places) + (fraction ? '.' + fraction : '');
};
export function approximateTime(blocks) {
  const hours = Math.max(0, blocks) / 6;
  const n = hours >= 24 ? Math.round(hours / 24) : Math.max(1, Math.round(hours)), unit = hours >= 24 ? 'day' : 'hour';
  return `~${n} ${unit}${n === 1 ? '' : 's'}`;
}

export function describePosition(position, { lockKey, counted = null, facts = {} } = {}) {
  const post = position.post ?? position, t = termsOf(position), product = post.product;
  const maker = lockKey === post.maker.lockKey, state = position.state ?? 'posted';
  // Without a known height (clock not read yet) the deadline is shown as a block number only.
  const deadline = deadlineOf(position), blocksLeft = deadline == null || counted == null ? null : Math.max(0, deadline - counted);
  const decision = products[product].decide(position, { ...facts, counted: counted ?? 0 });
  const missed = products[product].decide({ ...position, state: 'running', opened: true }, {
    counted: deadline, T: 0, payments: [], scanned: true,
  });
  const asset = assetOf(position), reset = decimal(t.collateral ?? t.amount, asset === 'TNK' ? 18 : 8), usd = value => decimal(value, 6);
  const by = deadline == null ? '' : `block ${deadline.toLocaleString('en-US')}${blocksLeft == null ? '' : ` (${approximateTime(blocksLeft)})`}`;
  let now, ifMissed, nextAction = null;
  if (product === 'loan') {
    ifMissed = maker && missed.winner === 'taker' ? `The lender keeps your ${reset} ${asset}.` : `You keep the ${reset} ${asset}.`;
    now = maker ? `Pay back ${usd(t.repay)} USDC by ${by}.` : `You get ${usd(t.repay)} USDC by ${by.replace(/ \(.+\)$/, '')}, or the ${reset} ${asset}. Nothing to do.`;
    if (maker) nextAction = 'repay';
  } else {
    ifMissed = maker ? `You keep your ${product === 'call' ? reset + ' ' + asset : usd(t.strikeTotal) + ' USDC'} and the fee.` : 'The right expires, the fee is not returned.';
    now = maker ? `The holder may ${product === 'call' ? 'buy' : 'sell'} ${reset} ${asset} for ${usd(t.strikeTotal)} USDC until ${by}. Nothing to do.`
      : `You may ${product === 'call' ? 'buy' : 'sell'} ${reset} ${asset} for ${usd(t.strikeTotal)} USDC until ${by}.`;
    if (!maker) { nextAction = 'exercise'; if (product === 'put') {
      now = `Your ${reset} ${asset} is locked for the term. Send a small Solana message to sell it for ${usd(t.strikeTotal)} USDC until ${by}.`;
      ifMissed = `Your ${reset} ${asset} returns to you; the fee is not returned.`;
    } }
  }
  if (['creating', 'funding'].includes(state)) { now = state === 'creating' ? 'Waiting for the signers to prepare the lock.' : 'Waiting for the lock funding to finish.'; nextAction = null; }
  if (['posted', 'taking'].includes(state)) {
    nextAction = maker ? 'cancel' : 'take';
    if (product === 'loan') now = `Offer: ${usd(t.principal)} USDC now, ${usd(t.repay)} USDC back in ${t.termBlocks} blocks (${approximateTime(t.termBlocks)}), with ${reset} ${asset} locked.`;
    else now = `Anyone may ${product === 'call' ? 'buy your' : 'sell you'} ${reset} ${asset} for ${usd(t.strikeTotal)} USDC until ${by} for a ${usd(t.premium)} USDC fee. Your ${product === 'call' ? asset : 'USDC'} is locked.`;
    if (product === 'put' && !maker) now = `Protect against a drop: lock your ${reset} ${asset} for the term and pay ${usd(t.premium)} USDC. A small Solana message lets you sell it for ${usd(t.strikeTotal)} USDC until ${by}.`;
    ifMissed = 'If nobody takes the offer, the lock returns to the maker.';
    if (state === 'taking') { now = 'Waiting for a reservation and the opening payment.'; nextAction = null; }
  }
  if (state.startsWith('ended:') || state === 'released' || decision.winner) {
    const winner = position.winner ?? decision.winner, won = winner === (maker ? 'maker' : 'taker');
    now = state === 'released' ? 'Finished. The winner collected the locked funds.' : won ? 'The position ended. Collecting your locked funds.' : 'The position ended. The other party receives the locked funds.';
    if (product === 'put' && position.opened) {
      const exercised = (position.outcome ?? decision.outcome) === 'exercised';
      const holderWinner = position.holderDecision?.winner ?? decision.winners?.H;
      if (exercised && !holderWinner) now = maker ? `Waiting for the escrow to settle before releasing ${reset} ${asset}.`
        : `Collecting your ${usd(t.strikeTotal)} USDC. The ${asset} lock waits for finalized escrow settlement.`;
      else {
        const refunded = exercised && holderWinner === 'taker';
        const funds = (holderWinner ?? 'taker') === (maker ? 'maker' : 'taker') ? `${reset} ${asset}` : `${usd(t.strikeTotal)} USDC`;
        now = refunded && maker ? `The escrow refunded your ${usd(t.strikeTotal)} USDC. The ${reset} ${asset} returns to the holder.`
          : state === 'released' ? `Finished. You collected ${funds}.` : `The position ended. Collecting your ${funds}.`;
      }
    }
    ifMissed = product === 'put' ? 'The writer can refund through the escrow after refundAfter if it has not been claimed.' : 'Collection needs enough surviving signer shares.';
    nextAction = null;
  }
  if (state === 'ended:unfunded') { now = position.holderLock ? `The reservation expired. Collecting your locked ${reset} ${asset}.` : 'The attempt ended before funding. No payment is needed.'; ifMissed = 'Create a new position if you want to try again.'; }
  return { positionId: position.positionId ?? positionId(post), product, asset, role: maker ? 'maker' : 'taker', state, createdAt: post.createdAt, maker: post.maker, taker: position.taker ?? null,
    terms: t, registryVersion: post.registryVersion, counterparty: (maker ? position.taker?.lockKey : post.maker.lockKey)?.slice(0, 12) ?? null,
    dueBlock: product === 'loan' ? deadline : null, expiryBlock: product === 'loan' ? null : deadline, blocksLeft,
    ...(product === 'put' ? { recovery: `The writer can refund unclaimed USDC after refundAfter${position.refundAfter ? ' (' + position.refundAfter + ')' : ''}. The holder’s ${asset} needs enough surviving signers.` } : {}),
    ...(product === 'put' ? { holderWinner: position.holderDecision?.winner ?? null, escrowStatus: position.escrowStatus ?? null } : {}),
    paid: position.operations?.[product === 'loan' ? 'repay' : 'exercise']?.status === 'confirmed',
    refundAfter: position.refundAfter ?? null, nextAction, now, ifMissed: state.startsWith('ended:') || state === 'released' ? null : ifMissed, outcome: position.outcome ?? decision.outcome };
}
