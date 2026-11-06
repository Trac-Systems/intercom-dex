// Plain words for the RESET stake, rewards, paused offers and trade deliveries. No DOM, so it runs anywhere.
// Sentences with a deadline come back as parts; `time(unix)` turns the deadline into text or a page element.
const num = a => Number(String(a.text).replaceAll(',', ''));
const join = parts => parts.map(p => (typeof p === 'string' ? p : String(p))).join('');

// Dollars with cents ("$1,250.00").
export const dollars = n => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const usd = a => dollars(num(a));
export const atRisk = r => `${usd(r.usd)} (${r.reset.text} RESET)`;

// Seconds as a wait people read: "30 min", "24 h", "3 days".
export function duration(sec) {
  if (sec < 5400) return `${Math.max(1, Math.round(sec / 60))} min`;
  if (sec < 172800) return `${Math.round(sec / 3600)} h`;
  return `${Math.round(sec / 86400)} days`;
}

// Why an own offer is paused and what to do about it, by the fixed pause code.
const PAUSES = {
  stake_short: base => ['Your free stake does not cover the bond for this offer.', `Deposit RESET under Wallets → Stake, or offer less ${base}.`],
  stake_stale: () => ['Stake check is being refreshed.', 'Nothing to do; the offer resumes by itself within a minute.'],
  coin_short: base => [`Your wallet no longer holds the ${base} this offer sells.`, `Add ${base} to your Trac wallet, or cancel the offer.`],
  tnk_short: () => ['Your wallet does not hold enough TNK for the transfer fee.', 'Add TNK to your Trac wallet; the offer resumes by itself.'],
  offline: () => ['This app was offline, so the offer was taken out of the book.', 'Keep the app running; the offer resumes by itself once it is back online.'],
  price_unavailable: () => ['There is no current RESET price to size the bond.', 'Nothing to do; the offer resumes once the venue publishes a price.'],
  venue_draining: () => ['The venue is moving stakes to new signers and starts no new sales for now.', 'Nothing to do; keep the offer or cancel it.'],
};
export function pauseText(pause, base) {
  const [reason, todo] = PAUSES[pause.code]?.(base) ?? [pause.message, ''];
  return { reason, todo };
}

// Why a delivery failed (by its reason code) and what to do before retrying.
const FAILURES = {
  tnk_short: () => ['not enough TNK for the transfer fee', 'Add TNK to your Trac wallet'],
  coin_short: base => [`not enough ${base} in your wallet`, `Add ${base} to your Trac wallet`],
  gateway_paused: () => ['RESET transfers are paused at the gateway', 'Wait for the gateway to resume'],
  offline: () => ['this app was offline', 'Keep this app online'],
};
const failure = (reason, base) => FAILURES[reason]?.(base) ?? ['the transfer did not go through', 'Check your Trac wallet'];

// One trade's delivery as the seller reads it: tone, a short head, a sentence with the amount at risk and the time to
// act by, and whether "Retry now" applies. `coin` is the amount sold ("1.5 TNK"). A buyer reads only the seller's
// stake: late, being collected for them, received.
export function deliveryText(d, coin, time = String) {
  const risk = atRisk(d.atRisk), base = coin.split(' ').at(-1);
  if (d.buyer) {
    switch (d.state) {
      case 'delivery_overdue':
        return { tone: 'info', head: `The seller has not delivered your ${coin} yet`, retry: false,
          parts: ['If it is not confirmed by ', time(d.deadline), `, you receive ${risk} from the seller's stake.`] };
      case 'penalty_collecting':
        return { tone: 'info', head: `The seller did not deliver your ${coin} in time`, retry: false,
          parts: [`${risk} from the seller's stake is being collected for you.`] };
      case 'penalty_paid':
        return { tone: 'good', head: `You received ${d.atRisk.reset.text} RESET because the seller did not deliver your ${coin} in time`, retry: false,
          parts: [`It came from the seller's stake and was worth ${usd(d.atRisk.usd)} when the trade was agreed.`] };
    }
    return null;
  }
  switch (d.state) {
    case 'delivery_sending':
      return { tone: 'info', head: `Sending your ${coin}`, retry: false,
        parts: ['It must be confirmed by ', time(d.deadline), `, or ${risk} of your stake goes to the buyer.`] };
    case 'delivery_failed': {
      const [why, todo] = failure(d.reason, base);
      return { tone: 'red', head: `Sending your ${coin} failed: ${why}`, retry: true,
        parts: [`${todo} and retry by `, time(d.deadline), `, or ${risk} of your stake goes to the buyer.`] };
    }
    case 'delivery_overdue':
      return { tone: 'red', head: `Your ${coin} has not reached the buyer in time`, retry: true,
        parts: ['It must be confirmed by ', time(d.deadline), `, or ${risk} of your stake goes to the buyer. Retry now and keep this app online.`] };
    case 'delivery_confirming':
      return { tone: 'yellow', head: `Your ${coin} was sent; waiting for the Trac network to confirm it`, retry: false,
        parts: [`${risk} of your stake stays reserved until then. It must be final by `, time(d.deadline), '.'] };
    case 'delivered':
      return { tone: 'good', head: `Your ${coin} was delivered`, retry: false, parts: [d.released ? `The ${risk} reserved from your stake is free again.`
        : `The ${risk} reserved from your stake is free again once the signers confirm the delivery.`] };
    case 'penalty_collecting':
      return { tone: 'red', head: `Your ${coin} was not delivered in time`, retry: false,
        parts: [`${risk} of your stake is being paid to the buyer.`] };
    case 'penalty_paid':
      return { tone: 'info', head: `Your ${coin} was not delivered in time`, retry: false,
        parts: [`${risk} of your stake went to the buyer.`] };
  }
  return null;
}
// The RESET transfers of a decided bond to the buyer, in front of their hashes.
export const paymentsLabel = txs => (txs.length > 1 ? `Paid in ${txs.length} transactions:` : 'Transaction:');
export const ALARM = ['delivery_failed', 'delivery_overdue'];
// Deliveries with nothing left to do by their deadline: done, or the stake is already decided.
export const DECIDED = ['delivered', 'penalty_collecting', 'penalty_paid'];

// Browser notifications still to send: one per trade and alarming state, never twice. `seen` is updated.
export function toNotify(items, seen, time) {
  const out = [];
  for (const x of items) {
    const tag = `${x.key}:${x.delivery.state}`;
    if (!ALARM.includes(x.delivery.state) || seen.has(tag)) continue;
    seen.add(tag);
    const t = deliveryText(x.delivery, `${x.base.text} ${x.base.unit}`, time);
    out.push({ tag, title: t.head, body: join(t.parts) });
  }
  return out;
}

// A trade's bond in one sentence for its row: the amount from the signed terms and where its reservation stands.
export function tradeBondText(b, buyer) {
  const what = `${usd(b.usd)} (${b.reset.text} RESET)`;
  if (buyer) return {
    reserving: `${what} from the seller's stake, being reserved by the signers.`,
    reserved: `${what} from the seller's stake is reserved: you receive it if the seller does not deliver in time.`,
    released: `${what} from the seller's stake was released.`,
    'decided-being-collected': `${what} from the seller's stake is being collected for you.`,
    paid: `You received ${what} from the seller's stake.`,
  }[b.state];
  return {
    reserving: `${what} of your stake, being reserved by the signers.`,
    reserved: `${what} of your stake is reserved until the signers confirm the buyer has your coins.`,
    released: `${what} of your stake is free again.`,
    'decided-being-collected': `${what} of your stake is being paid to the buyer.`,
    paid: `${what} of your stake went to the buyer.`,
  }[b.state];
}

// The exact bond the core sets for a sale (the dashboard's saleBond), for the ticket and the review: null while the
// venue does not bond sales. A refused bond tells why the sale cannot start.
const REFUSED = {
  bond_not_reserved: () => 'Not covered: your free stake has no pieces that cover this bond. Deposit RESET under Wallets → Stake, or sell less.',
  bond_required: () => 'Not covered: you have no stake yet. Deposit RESET under Wallets → Stake.',
  bond_stale: sec => `Stake check is being refreshed, try again in ${sec ?? 60} s.`,
  bond_price_unavailable: () => 'No bond right now: there is no fresh RESET price. Try again in a minute.',
  bond_setup_unavailable: () => 'No bond right now: the signers have not confirmed your stake yet. Try again in a minute.',
  venue_draining: () => 'No new sales for now: the venue is moving stakes to new signers. Your stake stays as it is.',
};
const REFUSED_STATUS = { venue_draining: 'no new sales', bond_stale: 'refreshing' };
export function saleBondText(b) {
  if (!b) return null;
  if (b.refused) return { ok: false, label: 'Bond', value: '—', status: REFUSED_STATUS[b.refused] ?? 'not covered', text: REFUSED[b.refused](b.retrySec) };
  const what = `${usd(b.usd)} (${b.reset.text} RESET)`;
  return { ok: true, label: 'Bond', value: `${usd(b.usd)} · ${b.reset.text} RESET`, status: 'covered', what,
    text: `Bond reserved for this sale: ${what} of your stake, paid to the buyer only if you do not deliver in time.` };
}
// The seller's bond as a buyer reads it before taking a sell offer; null when the core cannot tell it right now.
export const buyBondText = b => (b && !b.refused ? `${usd(b.usd)} (${b.reset.text} RESET) from the seller's stake, paid to you if the seller does not deliver in time` : null);

// When the sell ticket asks for its bond again: other inputs, a changed stake row, and at least every 15 s, because the
// core's admission view can lag the stake row by some seconds (seen live: free 0 but still "covered").
export const saleBondKey = (sale, stake, now = Date.now()) => (sale ? JSON.stringify([sale, stake?.free, stake?.reserved, Math.floor(now / 15000)]) : '');

// Notes under the stake row: what it is for, coverage, the suggested amount, the cap and what is on its way.
const STAKE_REASONS = {
  price_unavailable: 'There is no RESET price for today yet: it comes from a RESET trade completed today. Deposits and the stake’s dollar value wait for it.',
  over_cap: 'Stake above the limit per address covers no sales and earns no rewards.',
  tnk_short: 'Your wallet does not hold enough TNK for the stake transfers.',
};
// While the venue drains, its note replaces what stake is for, and the missing price is the handoff's, not a missing trade.
export function stakeNotes(s, time = String) {
  const notes = s.draining ? [] : [{ tone: 'note', parts: [!s.bonded ? 'Stake RESET to earn a share of the daily rewards. Sales here do not reserve a bond yet.'
    : s.selling ? 'Required to sell: your offers are listed only as far as your free stake covers them.'
    : 'Optional for buyers: stake RESET to earn a share of the daily rewards. Stake is reserved only when you sell, so while you only buy it is never at risk.'] }];
  if (STAKE_REASONS[s.reason] && !(s.draining && s.reason === 'price_unavailable')) notes.push({ tone: 'warn', parts: [STAKE_REASONS[s.reason]] });
  if (s.draining) notes.push({ tone: 'warn', parts: ['The venue is moving stakes to new signers: no new stakes and no new sales for now.',
    num(s.locked) > 0 ? ' Your stake stays as it is, and you can still withdraw it.' : ''] });
  else if (!s.offered) notes.push({ tone: 'warn', parts: ['The venue does not take new stakes right now.'] });
  if (s.short) {
    notes.push({ tone: 'warn', parts: [`Your open sales (${usd(s.openOffers)}) are ${usd(s.short)} more than your stake covers (${usd(s.coverage)}); the venue hides the rest. Suggested stake for your open offers: ${usd(s.suggested)}.`] });
  }
  if (num(s.pending) > 0) notes.push({ tone: 'note', parts: [`Deposit of ${s.pending.text} RESET is being confirmed.`] });
  if (s.withdrawal && num(s.withdrawal.deferred) > 0) notes.push({ tone: 'note', parts: [`${s.withdrawal.deferred.text} RESET you asked to withdraw still backs a running sale: it is returned after the sale it backs closes${s.withdrawDelaySec === null ? ' and the wait' : ` and a ${duration(s.withdrawDelaySec)} wait`}.`] });
  if (s.withdrawal && num(s.withdrawal.forfeited) > 0) notes.push({ tone: 'warn', parts: [`${s.withdrawal.forfeited.text} RESET of your withdrawal went to a buyer instead: a sale it backed was not delivered in time.`] });
  if (num(s.withdrawing) > 0) notes.push({ tone: 'note', parts: [`${s.withdrawing.text} RESET is being withdrawn and earns no rewards; `,
    ...(s.withdrawingUntil === null ? ['it comes back to your wallet after the wait.'] : ['it is free to send on ', time(s.withdrawingUntil), '.'])] });
  return notes;
}
export const coverageText = s => (s.coverage ? `Covers up to ${usd(s.coverage)} of open sales${s.selling ? ` (yours: ${usd(s.openOffers)})` : ''}`
  : s.freeUsd && (s.free.units !== '0' || s.selling) ? `Free stake worth ${usd(s.freeUsd)}${s.selling ? ` · your open sales ${usd(s.openOffers)}` : ''}` : null);

// Rewards in words: the weight of this address and the pool. The weight and rate are from the last reward round, so
// against the stake row now (`stake`): a stake that became active after it is not counted yet, one that is gone since
// (withdrawn, or paid to a buyer) earns nothing more, and none accrues while the venue drains.
export const earningNow = (r, stake = null) => (stake?.draining || r.weight !== 'none' && stake?.state === 'none' ? '0' : r.ratePerDay.text);
export function weightText(r, stake = null) {
  if (stake?.draining && stake.state !== 'none') return 'Paused while the venue moves stakes to new signers';
  if (r.weight !== 'none' && stake?.state === 'none') return 'None: stake RESET to earn rewards';
  if (r.weight === 'active') return `Active${r.activeWeightBps ? ` (${r.activeWeightBps / 10000}×)` : ''}: your stake backs live sell offers`;
  if (r.weight === 'idle') return 'Idle (1×): stake not backing a live sell offer';
  if (stake?.state === 'active' && stake.reason !== 'over_cap') return 'Not counted yet: your stake counts from the next reward round';
  return 'None: stake RESET to earn rewards';
}
export function poolText(r) {
  if (r.poolState === 'empty') return 'Rewards paused, pool empty';
  if (r.poolState === 'unknown') return 'Pool balance unknown right now';
  return r.dailyBudget ? `Paying ${r.dailyBudget.text} RESET a day` : 'Paying rewards';
}
