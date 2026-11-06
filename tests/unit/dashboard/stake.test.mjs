// SB4 stake, rewards, offer pauses and delivery states: the read model (src/dashboard/stake.js and the trader view)
// and every sentence people read (src/dashboard/static/stake-text.js), for every state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stakeView, rewardsView, deliveryView, saleBond, buyerNeedsUpdate, bannerWorthy, DELIVERY_STATES, BOND_REFUSALS } from '../../../src/dashboard/stake.js';
import { createModel, outcome } from '../../../src/dashboard/model.js';
import { Trader } from '../../../src/roles/trader.js';
import { deliveryStatus as coreDelivery } from '../../../src/stake/status.js';
import { traderFixture } from './fixtures.mjs';
import { stakeStatus, rewardsStatus, deliveryStatus, piece, armBonds, bondedVenue, penaltyResult, PAUSE_CODES } from './stake-fixtures.mjs';
const STATIC = new URL('../../../src/dashboard/static', import.meta.url).href;
const { pauseText, deliveryText, toNotify, saleBondText, buyBondText, paymentsLabel, saleBondKey, tradeBondText, stakeNotes, coverageText, weightText, earningNow, poolText, duration, dollars, usd, ALARM, DECIDED } = await import(`${STATIC}/stake-text.js`);

const NOW = 1_800_000_000;
const T = unix => `<${unix}>`;
const text = parts => parts.join('');
const model = fx => createModel({ config: fx.config, role: fx.role, wallets: fx.wallets, bridge: fx.bridge });
// No fixed code ("stake_short", "delivery_failed", …) or long hex id ever reaches a sentence.
const plainOnly = s => { assert.doesNotMatch(s, /\b[a-z]+_[a-z_]+\b/); assert.doesNotMatch(s, /[0-9a-f]{16}/); };

test('stake: the core status as amounts; coverage unknown until the venue reports it; no venue policy; no stake at all', () => {
  const s = stakeView(stakeStatus(), { selling: true });
  assert.deepEqual([s.locked.text, s.reserved.text, s.free.text, s.withdrawing.text, s.pending.text], ['1.2', '0.002', '1.198', '0', '0']);
  assert.deepEqual([s.coverage, s.openOffers.text, s.suggested.text, s.cap.text, s.minPenalty.text, s.freeUsd.text], [null, '4.4', '0.198', '400', '0.5', '299.5']);
  assert.deepEqual([s.offered, s.short, s.selling, s.state, s.reason, s.busy], [true, null, true, 'active', null, false]);
  assert.deepEqual([s.withdrawDelaySec, s.withdrawingUntil, s.penaltyBps, s.price], [86400, null, 300, '250']);
  const short = stakeView(stakeStatus({ coverageUsd: '3000000' }), { selling: true });
  assert.equal(short.short.text, '1.4'); assert.equal(short.short.unit, 'USDC'); assert.equal(short.coverage.text, '3');
  assert.equal(stakeView(stakeStatus({ pieces: [piece('free', '120000000')] }), { selling: false }).selling, false, 'a buyer');
  assert.equal(stakeView(stakeStatus(), { selling: false }).selling, true, 'reserved stake means a sale is running');
  const none = stakeView(stakeStatus({ pieces: [], price: null }), { selling: true });
  assert.deepEqual([none.state, none.reason, none.price, none.freeUsd, none.short], ['none', 'price_unavailable', null, null, null]);
  const bare = stakeView(stakeStatus({ settings: null }), { selling: true });
  assert.deepEqual([bare.offered, bare.cap, bare.suggested, bare.minPenalty, bare.withdrawDelaySec, bare.penaltyBps], [false, null, null, null, null, null]);
  const cheap = stakeView(stakeStatus({ price: { numerator: '1234567', denominator: '1000' } }), { selling: true });
  assert.deepEqual([cheap.price, cheap.freeUsd.text], ['0.001234567', '0.001479'], 'a price with 12 decimals, rounded down');
  assert.equal(stakeView({ ...stakeStatus(), operationId: 'a1'.repeat(32), operationPending: true }, { selling: true }).busy, true);
});
test('rewards: amounts, last payout time and link, weight, pool and forfeits; unknown pool and no venue settings', () => {
  const r = rewardsView(rewardsStatus(NOW));
  assert.deepEqual([r.unpaid.text, r.paidTotal.text, r.ratePerDay.text, r.poolBalance.text, r.dailyBudget.text], ['0.0312', '0.415', '0.0125', '1,800', '5']);
  assert.deepEqual(r.lastPayout, { amount: { units: '10000000', text: '0.1', unit: 'RESET' }, tx: 'c4'.repeat(32), link: `https://explorer.trac.network/tx/${'c4'.repeat(32)}`, at: NOW - 2 * 86400 });
  assert.deepEqual([r.weight, r.activeWeightBps, r.poolState, r.forfeited], ['active', 20000, 'active', null]);
  assert.equal(rewardsView(rewardsStatus(NOW, { forfeited: '3120000' })).forfeited.text, '0.0312');
  assert.equal(rewardsView(rewardsStatus(NOW, { forfeited: '0' })).forfeited, null, 'the payout role reports 0 forfeited: nothing to tell');
  const good = rewardsStatus(NOW);
  assert.equal(rewardsView({ ...good, lastPayout: { ...good.lastPayout, link: 'http://explorer.example/tx' } }).lastPayout.link, null, 'only https links');
  assert.equal(rewardsView(rewardsStatus(NOW, { lastPayout: undefined })).lastPayout, null);
  const unknown = rewardsView(rewardsStatus(NOW, { poolState: 'unknown', poolBalance: null, dailyBudget: null, activeWeightBps: null }));
  assert.deepEqual([unknown.poolBalance, unknown.dailyBudget, unknown.activeWeightBps], [null, null, null]);
});
test('delivery: every state keeps its code, deadline, amounts at risk and reason; unknown states are dropped', () => {
  for (const state of DELIVERY_STATES) {
    const d = deliveryView(deliveryStatus(state, NOW));
    assert.equal(d.state, state); assert.equal(d.deadline, state === 'delivery_overdue' ? NOW - 60 : NOW + 1200);
    assert.equal(d.atRisk.usd.text, '0.5'); assert.equal(d.atRisk.reset.text, '0.002');
  }
  assert.equal(deliveryView(deliveryStatus('delivery_failed', NOW)).reason, 'tnk_short');
  assert.equal(deliveryView(deliveryStatus('delivery_confirming', NOW)).reason, 'confirmation_pending');
  assert.match(deliveryView(deliveryStatus('penalty_paid', NOW)).link, /^https:\/\//);
  assert.equal(deliveryView(deliveryStatus('penalty_paid', NOW, { deliveryLink: 'http://explorer.example/tx' })).link, null);
  assert.equal(deliveryView({ ...deliveryStatus('delivered', NOW), state: 'exploded' }), null);
  assert.equal(deliveryView(undefined), null);
  const row = state => ({ at: NOW - 100, delivery: deliveryView(deliveryStatus(state, NOW)) });
  assert.deepEqual(DELIVERY_STATES.filter(s => bannerWorthy(row(s), NOW - 86400)), ['delivery_failed', 'delivery_overdue', 'delivery_confirming', 'penalty_paid']);
  assert.equal(bannerWorthy({ ...row('penalty_paid'), at: NOW - 90000 }, NOW - 86400), false, 'an old penalty is history only');
  assert.equal(bannerWorthy({ ...row('delivery_failed'), at: NOW - 90000 }, NOW - 86400), true, 'a failing sale stays pinned');
  assert.equal(bannerWorthy({ at: NOW, delivery: null }, NOW), false);
});
test('trader view: sales carry their delivery, buys never; banners list only what needs the seller; stake and rewards included', async () => {
  const fx = traderFixture();
  fx.role.deliveries.set('t-sell', deliveryStatus('delivery_overdue', fx.now));
  fx.role.deliveries.set('t-locked', deliveryStatus('delivery_failed', fx.now));
  fx.role.deliveries.set('t-off', deliveryStatus('penalty_paid', fx.now));
  const m = model(fx), s = (await m.state()).trader;
  const running = (await m.list('trader.running')).rows;
  assert.equal(running.find(r => r.key === 't-sell').delivery.state, 'delivery_overdue');
  assert.equal(running.find(r => r.key === 't-locked').delivery, null, 'a buy has no delivery to make');
  assert.equal((await m.list('trader.history')).rows.find(r => r.key === 't-off').delivery.state, 'penalty_paid');
  assert.deepEqual(s.deliveries.map(d => [d.key, d.delivery.state]), [['t-sell', 'delivery_overdue'], ['t-off', 'penalty_paid']]);
  assert.deepEqual(Object.keys(s.deliveries[0]).sort(), ['base', 'delivery', 'key', 'pair', 'quote']);
  assert.equal(s.stake.selling, true); assert.equal(s.stake.locked.text, '1.2'); assert.equal(s.rewards.weight, 'active');
  fx.role.deliveries.set('t-sell', deliveryStatus('delivery_sending', fx.now));
  assert.deepEqual((await model(fx).state()).trader.deliveries.map(d => d.key), ['t-off']);
  fx.role.mine.clear(); fx.role.stake = stakeStatus({ pieces: [piece('free', '120000000')] });
  assert.equal((await model(fx).state()).trader.stake.selling, false, 'no sell offer and nothing reserved: a buyer');
  fx.role.stake = stakeStatus({ settings: null });
  assert.equal((await model(fx).state()).trader.stake.offered, false, 'stake left over while the venue takes none: still shown');
  fx.role.stake = stakeStatus({ settings: null, pieces: [] }); fx.role.rewards = rewardsStatus(fx.now, { unpaid: '0', paidTotal: '0', lastPayout: undefined, dailyBudget: null });
  const bare = (await model(fx).state()).trader;
  assert.equal(bare.stake, null, 'a venue without stakes: no stake row'); assert.equal(bare.rewards, null);
  fx.role.rewards = rewardsStatus(fx.now, { unpaid: '1', dailyBudget: null });
  assert.equal((await model(fx).state()).trader.rewards.unpaid.text, '0.00000001', 'rewards still owed are shown');
});

test('a bonded sale being sent says when it must be confirmed (the core delivery deadline), not the send-by time (found live)', async () => {
  const fx = traderFixture(), sale = fx.role.host.trades.get('t-sell');
  sale.state = { ...sale.state, phase: 'transferring' };
  const line = async () => (await model(fx).list('trader.running')).rows.find(r => r.key === 't-sell').line;
  const unbonded = await line();
  assert.deepEqual([unbonded.ifMissed, unbonded.deadline, unbonded.fallback], ['Transfers are retried until', sale.state.terms.sendBy,
    'the same transaction is retried; confirmation may arrive later']);
  const d = deliveryStatus('delivery_failed', fx.now);
  fx.role.deliveries.set('t-sell', d);
  const bonded = await line();
  assert.deepEqual([bonded.now, bonded.ifMissed, bonded.deadline, bonded.fallback],
    ['Sending your TNK…', 'If it is not confirmed by', d.deadlineUnix, 'the bond reserved from your stake goes to the buyer']);
  assert.notEqual(d.deadlineUnix, sale.state.terms.sendBy);
  const v = armBonds(fx, { now: fx.now }), terms = v.bonded(sale.state.terms);
  sale.state = { ...sale.state, terms, draft: terms, H: 'cd'.repeat(32), acks: terms.committee.slice(0, 3).map(m => m.dexKey) };
  fx.role.store.put(`stake-trade-penalty-${sale.state.tradeId}`, penaltyResult(v, sale, { decided: true }));
  const decided = await line();
  assert.deepEqual([decided.ifMissed, decided.deadline], ['Transfers are retried until', sale.state.terms.sendBy], 'decided: no "or the bond goes to the buyer"');
});

test('trader view: offer pauses ride on the offer row; venue warnings without a trade become alerts with their severity', async () => {
  const fx = traderFixture(), [offerId] = fx.role.mine.keys();
  fx.role.pauses.set(offerId, { code: 'stake_short', message: 'Stake does not cover this offer' });
  fx.role.warnings = [{ code: 'pool_empty', severity: 'yellow', message: 'Rewards paused, pool empty' },
    { code: 'delivery_overdue', severity: 'red', tradeId: 'ab'.repeat(32), message: 'overdue', deadline: '2026-11-03T12:00:00Z', atRiskUsd: '500000', atRiskReset: '200000' }];
  const m = model(fx);
  assert.deepEqual((await m.list('trader.offers')).rows[0].pause, { code: 'stake_short', message: 'Stake does not cover this offer' });
  const alerts = (await m.list('trader.attention')).rows.filter(a => a.kind === 'stake');
  assert.deepEqual(alerts, [{ kind: 'stake', severity: 'yellow', text: 'Rewards paused, pool empty' }], 'trade warnings show as banners, not twice');
  fx.role.pauses.clear();
  assert.equal((await model(fx).list('trader.offers')).rows[0].pause, null);
});

test('offer pauses: a plain reason and what to do for every code; an unknown code shows the core message', () => {
  for (const code of PAUSE_CODES) {
    const p = pauseText({ code, message: 'x' }, 'TNK');
    assert.ok(p.reason.length > 20 && p.todo.length > 20, code); plainOnly(p.reason + p.todo);
  }
  assert.match(pauseText({ code: 'stake_short' }, 'TNK').todo, /Deposit RESET under Wallets → Stake, or offer less TNK/);
  assert.match(pauseText({ code: 'coin_short' }, 'RESET').reason, /no longer holds the RESET/);
  assert.match(pauseText({ code: 'offline' }, 'TNK').todo, /resumes by itself/);
  assert.deepEqual(pauseText({ code: 'stake_stale', message: 'The stake check is out of date; this offer is paused until it refreshes.' }, 'TNK'),
    { reason: 'Stake check is being refreshed.', todo: 'Nothing to do; the offer resumes by itself within a minute.' });
  assert.deepEqual(pauseText({ code: 'new_code', message: 'Paused by the venue' }, 'TNK'), { reason: 'Paused by the venue', todo: '' });
});

test('delivery sentences: what is wrong, $ and RESET at risk and the time to act by; retry only when failing or overdue', () => {
  const d = state => deliveryView(deliveryStatus(state, NOW));
  const tones = Object.fromEntries(DELIVERY_STATES.map(s => [s, deliveryText(d(s), '1.5 TNK', T)]));
  assert.deepEqual(Object.fromEntries(Object.entries(tones).map(([s, t]) => [s, [t.tone, t.retry]])), {
    delivery_sending: ['info', false], delivery_failed: ['red', true], delivery_overdue: ['red', true],
    delivery_confirming: ['yellow', false], delivered: ['good', false], penalty_paid: ['info', false] });
  for (const [state, t] of Object.entries(tones)) {
    const all = t.head + text(t.parts);
    assert.match(all, /\$0\.50 \(0\.002 RESET\)/, state); assert.match(t.head, /1\.5 TNK/, state); plainOnly(all);
    if (!['delivered', 'penalty_paid'].includes(state)) assert.ok(t.parts.includes(`<${d(state).deadline}>`), `${state} names the deadline`);
  }
  assert.equal(tones.delivery_failed.head, 'Sending your 1.5 TNK failed: not enough TNK for the transfer fee');
  assert.equal(text(tones.delivery_failed.parts), `Add TNK to your Trac wallet and retry by <${NOW + 1200}>, or $0.50 (0.002 RESET) of your stake goes to the buyer.`);
  assert.match(text(tones.delivery_overdue.parts), /Retry now and keep this app online/);
  assert.equal(text(tones.penalty_paid.parts), '$0.50 (0.002 RESET) of your stake went to the buyer.', 'forfeited rewards show in the Rewards panel only when there are any');
  const reason = r => deliveryText(deliveryView(deliveryStatus('delivery_failed', NOW, { deliveryFailure: r })), '2 RESET', T).head;
  assert.match(reason('coin_short'), /not enough RESET in your wallet/);
  assert.match(reason('gateway_paused'), /paused at the gateway/); assert.match(reason('gateway_unavailable'), /paused at the gateway/);
  assert.match(reason('offline'), /this app was offline/);
  assert.match(reason('send_failed'), /the transfer did not go through/); assert.match(reason('something_new'), /the transfer did not go through/);
  assert.equal(deliveryText({ ...d('delivered'), state: 'odd' }, '1 TNK', T), null);
  assert.equal(deliveryText(d('delivery_overdue'), '1 TNK').parts[1], String(NOW - 60), 'plain text by default');
});

test('browser notifications: once per sale and alarming state, with the deadline in the body; others never', () => {
  const seen = new Set(), item = (key, state) => ({ key, base: { text: '1.5', unit: 'TNK' }, delivery: deliveryView(deliveryStatus(state, NOW)) });
  const first = toNotify([item('a', 'delivery_failed'), item('b', 'delivery_confirming'), item('c', 'penalty_paid'), item('d', 'delivery_overdue')], seen, T);
  assert.deepEqual(first.map(n => n.tag), ['a:delivery_failed', 'd:delivery_overdue']);
  assert.equal(first[0].title, 'Sending your 1.5 TNK failed: not enough TNK for the transfer fee');
  assert.ok(first[1].body.includes(`<${NOW - 60}>`) && first[1].body.includes('$0.50 (0.002 RESET)'));
  assert.deepEqual(toNotify([item('a', 'delivery_failed'), item('d', 'delivery_overdue')], seen, T), [], 'never twice');
  assert.deepEqual(toNotify([item('a', 'delivery_overdue')], seen, T).map(n => n.tag), ['a:delivery_overdue'], 'a new state notifies again');
  assert.deepEqual(ALARM, ['delivery_failed', 'delivery_overdue']);
});

test('sale bond: the exact bond the core would sign (role.bondPreview), its refusals in words, none while sales are not bonded', () => {
  const fx = traderFixture(), sale = { pair: 'TNK/USDC', side: 'sell', amount: '1500000000000000000', price: '0.5' };
  assert.equal(saleBond(fx.role, sale, fx.now), null); assert.equal(saleBondText(null), null);
  assert.equal(buyerNeedsUpdate(fx.role, fx.now), false);
  armBonds(fx, { now: fx.now, pieces: ['25000', '25000'] });
  assert.equal(fx.role.me.boxKey, undefined, 'like Trader.me: the receiving key is the stake runtime\'s');
  const b = saleBond(fx.role, sale, fx.now);
  assert.deepEqual([b.reset.text, b.usd.text, b.refused], ['0.00025', '0.5', null], 'the $0.50 minimum, one whole piece');
  assert.deepEqual(saleBondText(b), { ok: true, label: 'Bond', value: '$0.50 · 0.00025 RESET', status: 'covered', what: '$0.50 (0.00025 RESET)',
    text: 'Bond reserved for this sale: $0.50 (0.00025 RESET) of your stake, paid to the buyer only if you do not deliver in time.' });
  assert.equal(saleBond(fx.role, { ...sale, price: '20' }, fx.now).reset.text, '0.0005', '3% of $30 plus fees needs both pieces');
  assert.equal(saleBond(fx.role, { ...sale, price: '1000' }, fx.now).refused, 'bond_not_reserved');
  const cached = fx.role.stakeRuntime.admission.cache.get(fx.role.me.dexKey);
  fx.role.stakeRuntime.admission.cache.set(fx.role.me.dexKey, { ...cached, priceReference: { ...cached.priceReference, cutoffAt: fx.now - 61 } });
  assert.deepEqual([saleBond(fx.role, sale, fx.now).refused, saleBond(fx.role, sale, fx.now).retrySec], ['bond_price_unavailable', 60], 'a price older than a minute');
  // Everything a minute old: the price is the first to go stale, so the core says so.
  armBonds(fx, { now: fx.now - 61, pieces: ['25000', '25000'] });
  assert.deepEqual([saleBond(fx.role, sale, fx.now).refused, saleBond(fx.role, sale, fx.now).retrySec], ['bond_price_unavailable', 60]);
  // The core's own refusal for a stale stake check: not "not covered", but "being refreshed".
  const stale = { reset: null, usd: null, refused: 'bond_stale', retrySec: 60 };
  assert.deepEqual(saleBondText(stale), { ok: false, label: 'Bond', value: '—', status: 'refreshing', text: 'Stake check is being refreshed, try again in 60 s.' });
  const refused = code => saleBondText({ reset: null, usd: null, refused: code, retrySec: 30 });
  for (const code of BOND_REFUSALS) { const t = refused(code); assert.equal(t.ok, false); assert.equal(t.status, code === 'bond_stale' ? 'refreshing' : 'not covered'); plainOnly(t.text); }
  assert.equal(refused('bond_stale').text, 'Stake check is being refreshed, try again in 30 s.');
  assert.match(refused('bond_price_unavailable').text, /no fresh RESET price/);
  assert.match(refused('bond_setup_unavailable').text, /signers have not confirmed your stake yet/);
  assert.match(refused('bond_required').text, /no stake yet/);
  const runtime = fx.role.stakeRuntime;
  fx.role.stakeRuntime = null;
  assert.equal(saleBond(fx.role, sale, fx.now).refused, 'bond_setup_unavailable');
  assert.equal(buyerNeedsUpdate(fx.role, fx.now), true, 'without the stake capability the core refuses this buyer');
  fx.role.stakeRuntime = runtime;
  assert.equal(buyerNeedsUpdate(fx.role, fx.now), false);
});

test("a buyer's take shows the seller's bond when the core can tell it, and nothing otherwise", () => {
  const fx = traderFixture(), v = armBonds(fx, { now: fx.now }), offer = fx.theirs[0];
  const buy = { pair: offer.pair, side: 'buy', amount: '1500000000000000000', offerId: offer.offerId };
  const none = saleBond(fx.role, buy, fx.now);
  assert.equal(none.refused, 'bond_setup_unavailable', 'no certified stake of this seller cached yet');
  assert.equal(buyBondText(none), null);
  assert.equal(buyBondText(null), null, 'a venue without bonds');
  // The seller's stake as the core caches it, certified by the signers for the receiving key in the offer.
  const seller = bondedVenue({ me: offer.maker, registry: fx.f.registry, now: fx.now, boxKey: 'b2'.repeat(32) });
  fx.role.stakeRuntime.admission.cache.set(offer.maker.dexKey, seller.runtime.admission.cache.get(offer.maker.dexKey));
  const b = saleBond(fx.role, buy, fx.now);
  assert.deepEqual([b.refused, b.reset.text], [null, '0.00025']);
  assert.equal(buyBondText(b), "$0.50 (0.00025 RESET) from the seller's stake, paid to you if the seller does not deliver in time");
  assert.equal(v.registry.sellerBond.epoch.id, seller.registry.sellerBond.epoch.id);
});

// A trade with bonded terms as the seller's trader signs them, H set and `acks` signers confirmed, plus the venue's
// penalty result and the closure records the core's runtime keeps (src/stake/runtime.js).
function bondedTrade(fx, v, key, { acks = 3, sendBy = fx.now + 600 } = {}) {
  const t = fx.role.host.trades.get(key), terms = v.bonded({ ...t.state.terms, sendBy });
  t.state = { ...t.state, terms, draft: terms, H: 'cd'.repeat(32), acks: terms.committee.slice(0, acks).map(m => m.dexKey) };
  return t;
}

test('trade bond: amount from the signed terms and the reservation from reserving to paid, for seller and buyer (core trades[].bond)', async () => {
  const fx = traderFixture(), v = armBonds(fx, { now: fx.now }), store = fx.role.store;
  const sale = bondedTrade(fx, v, 't-sell', { acks: 1 }), buy = bondedTrade(fx, v, 't-locked');
  const bondOf = async key => (await model(fx).list('trader.running')).rows.find(r => r.key === key).bond;
  assert.equal(await bondOf('t-acks'), null, 'a trade without a bond');
  const states = [];
  const check = async key => { const b = await bondOf(key); states.push(b.state); return [tradeBondText(b, false), tradeBondText(b, true)]; };
  assert.deepEqual(await check('t-sell'), ['$0.50 (0.00025 RESET) of your stake, being reserved by the signers.',
    "$0.50 (0.00025 RESET) from the seller's stake, being reserved by the signers."]);
  sale.state.acks.push(sale.state.acks[0], 'ee'.repeat(32));
  assert.equal((await bondOf('t-sell')).state, 'reserving', 'the same signer twice, or one outside the committee, does not count');
  sale.state.acks = sale.state.terms.committee.slice(0, 3).map(m => m.dexKey);
  assert.deepEqual(await check('t-sell'), ['$0.50 (0.00025 RESET) of your stake is reserved until the signers confirm the buyer has your coins.',
    "$0.50 (0.00025 RESET) from the seller's stake is reserved: you receive it if the seller does not deliver in time."]);
  store.put(`stake-trade-penalty-${sale.state.tradeId}`, penaltyResult(v, sale, { resolved: 'delivered' }));
  assert.deepEqual(await check('t-sell'), ['$0.50 (0.00025 RESET) of your stake is free again.', "$0.50 (0.00025 RESET) from the seller's stake was released."]);
  store.put(`stake-trade-penalty-${buy.state.tradeId}`, penaltyResult(v, buy, { decided: true }));
  assert.deepEqual(await check('t-locked'), ['$0.50 (0.00025 RESET) of your stake is being paid to the buyer.', "$0.50 (0.00025 RESET) from the seller's stake is being collected for you."]);
  store.put(`stake-trade-penalty-${buy.state.tradeId}`, penaltyResult(v, buy, { decided: true, collected: 1 }));
  assert.deepEqual(await check('t-locked'), ['$0.50 (0.00025 RESET) of your stake went to the buyer.', "You received $0.50 (0.00025 RESET) from the seller's stake."]);
  assert.deepEqual((await bondOf('t-locked')).payments, ['d7'.repeat(32)], 'the verified RESET transfer to the buyer');
  assert.deepEqual(states, ['reserving', 'reserved', 'released', 'decided-being-collected', 'paid']);
  for (const s of states) for (const buyer of [false, true]) plainOnly(tradeBondText({ ...(await bondOf('t-locked')), state: s }, buyer));
  // An uncertified or foreign closure is not a release; the dashboard reads no store record itself.
  store.put(`stake-trade-penalty-${sale.state.tradeId}`, { resolved: penaltyResult(v, sale, { resolved: 'delivered' }).resolved.slice(0, 2) });
  assert.equal((await bondOf('t-sell')).state, 'reserved');
});

test('penalty states through the core: overdue, decided but still being collected, paid only after collection; the buyer side', async () => {
  const fx = traderFixture(), v = armBonds(fx, { now: fx.now }), store = fx.role.store;
  const sale = bondedTrade(fx, v, 't-sell', { sendBy: fx.now - 3600 }), buy = bondedTrade(fx, v, 't-locked', { sendBy: fx.now - 3600 });
  // What Trader.status() reports for each trade: the core's own projection and delivery status.
  const project = () => { for (const t of [sale, buy]) fx.role.deliveries.set(t.key, coreDelivery(Trader.prototype.deliveryProjection.call(fx.role, t), fx.now)); };
  const rows = async () => { const m = model(fx); return { s: (await m.state()).trader, running: (await m.list('trader.running')).rows }; };
  project();
  let { s, running } = await rows();
  const row = key => running.find(r => r.key === key);
  assert.equal(row('t-sell').delivery.state, 'delivery_overdue');
  assert.equal(row('t-locked').delivery.state, 'delivery_overdue'); assert.equal(row('t-locked').delivery.buyer, true);
  assert.equal(text(deliveryText(row('t-locked').delivery, '1.5 TNK', T).parts), `If it is not confirmed by <${fx.now - 3600 + 1800}>, you receive $0.50 (0.00025 RESET) from the seller's stake.`);
  assert.deepEqual(s.deliveries.map(d => d.key), ['t-sell'], "a buyer's late seller is not a banner");
  for (const t of [sale, buy]) store.put(`stake-trade-penalty-${t.state.tradeId}`, penaltyResult(v, t, { decided: true }));
  project(); ({ s, running } = await rows());
  assert.equal(fx.role.deliveries.get('t-sell').state, 'delivery_overdue', 'the core still says overdue: not paid before collection');
  assert.deepEqual([row('t-sell').delivery.state, row('t-locked').delivery.state, row('t-sell').bond.state], ['penalty_collecting', 'penalty_collecting', 'decided-being-collected']);
  const seller = deliveryText(row('t-sell').delivery, '1.5 TNK', T), buyer = deliveryText(row('t-locked').delivery, '1.5 TNK', T);
  assert.deepEqual([seller.tone, seller.retry, seller.head, text(seller.parts)], ['red', false, 'Your 1.5 TNK was not delivered in time', '$0.50 (0.00025 RESET) of your stake is being paid to the buyer.']);
  assert.deepEqual([buyer.tone, buyer.head, text(buyer.parts)], ['info', 'The seller did not deliver your 1.5 TNK in time', "$0.50 (0.00025 RESET) from the seller's stake is being collected for you."]);
  assert.deepEqual(s.deliveries.map(d => d.key), ['t-sell', 't-locked']);
  for (const t of [sale, buy]) store.put(`stake-trade-penalty-${t.state.tradeId}`, penaltyResult(v, t, { decided: true, collected: 1 }));
  project(); ({ s, running } = await rows());
  assert.deepEqual([row('t-sell').delivery.state, row('t-locked').delivery.state], ['penalty_paid', 'penalty_paid']);
  const paid = deliveryText(row('t-locked').delivery, '1.5 TNK', T);
  assert.deepEqual([paid.tone, paid.head, text(paid.parts)], ['good', 'You received 0.00025 RESET because the seller did not deliver your 1.5 TNK in time',
    "It came from the seller's stake and was worth $0.50 when the trade was agreed."]);
  assert.equal(text(deliveryText(row('t-sell').delivery, '1.5 TNK', T).parts), '$0.50 (0.00025 RESET) of your stake went to the buyer.');
  for (const t of [seller, buyer, paid]) plainOnly(t.head + text(t.parts));
  fx.role.deliveries.set('t-locked', deliveryStatus('delivery_sending', fx.now));
  assert.equal(deliveryView(fx.role.deliveries.get('t-locked'), { buyer: true }), null, "a buyer is not shown the seller's sending");
  assert.equal(deliveryText({ ...deliveryView(deliveryStatus('penalty_paid', fx.now)), buyer: true, state: 'delivered' }, '1 TNK'), null);
  const unbonded = fx.role.host.trades.get('t-off');
  unbonded.state = { ...unbonded.state, phase: 'complete', transferFinal: true };
  assert.equal(coreDelivery(unbonded, fx.now).atRiskReset, '0', 'the core reports every sale');
  assert.equal(deliveryView(coreDelivery(unbonded, fx.now)), null, 'a sale without a bond has nothing at risk to tell of');
});

test('a decided award is "being collected" whatever delivery state the core still reports (found live: failed, before the deadline)', async () => {
  const fx = traderFixture(), v = armBonds(fx, { now: fx.now }), store = fx.role.store;
  const sale = bondedTrade(fx, v, 't-sell'), buy = bondedTrade(fx, v, 't-locked');
  sale.state = { ...sale.state, escrowOk: true, phase: 'transferring', deliveryFailure: 'tnk_short' };
  const project = () => { for (const t of [sale, buy]) fx.role.deliveries.set(t.key, coreDelivery(Trader.prototype.deliveryProjection.call(fx.role, t), fx.now)); };
  const row = async key => (await model(fx).list('trader.running')).rows.find(r => r.key === key);
  project();
  assert.deepEqual([fx.role.deliveries.get('t-sell').state, fx.role.deliveries.get('t-locked').state], ['delivery_failed', 'delivery_sending']);
  assert.equal((await row('t-locked')).delivery, null);
  for (const t of [sale, buy]) store.put(`stake-trade-penalty-${t.state.tradeId}`, penaltyResult(v, t, { decided: true }));
  project();
  assert.equal(fx.role.deliveries.get('t-sell').state, 'delivery_failed', 'the core still reports the failed send');
  const seller = (await row('t-sell')).delivery, buyer = (await row('t-locked')).delivery;
  assert.deepEqual([seller.state, buyer.state], ['penalty_collecting', 'penalty_collecting']);
  assert.deepEqual([deliveryText(seller, '1.5 TNK', T).retry, deliveryText(seller, '1.5 TNK', T).head], [false, 'Your 1.5 TNK was not delivered in time']);
  assert.equal(text(deliveryText(buyer, '1.5 TNK', T).parts), "$0.50 (0.00025 RESET) from the seller's stake is being collected for you.");
  sale.state = { ...sale.state, deliveryFailure: undefined, transferFinal: true };
  project();
  assert.equal(fx.role.deliveries.get('t-sell').state, 'delivered', 'delivered late, after the decision');
  assert.equal((await row('t-sell')).delivery.state, 'penalty_collecting', 'the stake still goes to the buyer: not "free again"');
});

test('a delivered sale frees its stake only once the signers close the reservation (found live: free again, but still reserved)', async () => {
  const fx = traderFixture(), v = armBonds(fx, { now: fx.now }), store = fx.role.store, sale = bondedTrade(fx, v, 't-sell');
  sale.state = { ...sale.state, escrowOk: true, phase: 'claiming', transferFinal: true };
  const delivered = async () => { fx.role.deliveries.set('t-sell', coreDelivery(sale, fx.now)); const r = (await model(fx).list('trader.running')).rows.find(x => x.key === 't-sell');
    return [r.bond.state, r.delivery.state, text(deliveryText(r.delivery, '1.5 TNK', T).parts), tradeBondText(r.bond, false)]; };
  assert.deepEqual(await delivered(), ['reserved', 'delivered', 'The $0.50 (0.00025 RESET) reserved from your stake is free again once the signers confirm the delivery.',
    '$0.50 (0.00025 RESET) of your stake is reserved until the signers confirm the buyer has your coins.']);
  store.put(`stake-trade-penalty-${sale.state.tradeId}`, penaltyResult(v, sale, { resolved: 'delivered' }));
  assert.deepEqual(await delivered(), ['released', 'delivered', 'The $0.50 (0.00025 RESET) reserved from your stake is free again.', '$0.50 (0.00025 RESET) of your stake is free again.']);
});

test('the sell ticket asks for its bond again when the stake row changes and every 15 s (found live: the core admission lags)', () => {
  const sale = { pair: 'RESET/USDC', amount: '0.0005', price: '2000' }, stake = stakeView(stakeStatus(), { selling: true }), t0 = 1_800_000_000_000;
  assert.equal(saleBondKey(null, stake, t0), '', 'no sale, no question');
  assert.equal(saleBondKey(sale, stake, t0), saleBondKey({ ...sale }, stake, t0 + 14_999));
  assert.notEqual(saleBondKey(sale, stake, t0), saleBondKey(sale, stake, t0 + 15_000), 'free 0 but still "covered" is asked again');
  assert.notEqual(saleBondKey(sale, stake, t0), saleBondKey(sale, stakeView(stakeStatus({ pieces: [piece('reserved', '120000000')] }), { selling: true }), t0));
  assert.notEqual(saleBondKey(sale, stake, t0), saleBondKey({ ...sale, amount: '0.001' }, stake, t0));
  // A decided delivery has no deadline left to act by: the row shows the trade's own next deadline instead.
  assert.deepEqual(DECIDED, ['delivered', 'penalty_collecting', 'penalty_paid']);
  assert.ok(ALARM.every(s => !DECIDED.includes(s)));
});

test('a draining venue (moving stakes to new signers): no new stakes or sales, the stake stays and can be withdrawn', async () => {
  const fx = traderFixture(), v = armBonds(fx, { now: fx.now }), sale = { pair: 'TNK/USDC', side: 'sell', amount: '1500000000000000000', price: '0.5' };
  assert.equal(saleBond(fx.role, sale, fx.now).refused, null);
  fx.role.registry = { ...fx.role.registry, usable: { ...v.registry, sellerBond: { ...v.registry.sellerBond, acceptNew: false } } };
  assert.equal(saleBond(fx.role, sale, fx.now).refused, 'venue_draining');
  const t = saleBondText(saleBond(fx.role, sale, fx.now));
  assert.deepEqual([t.ok, t.status, t.text], [false, 'no new sales', 'No new sales for now: the venue is moving stakes to new signers. Your stake stays as it is.']);
  const s = (await model(fx).state()).trader.stake;
  assert.deepEqual([s.draining, s.offered, s.locked.text], [true, false, '1.2']);
  const notes = stakeNotes(s, T).map(n => text(n.parts));
  assert.ok(notes.includes('The venue is moving stakes to new signers: no new stakes and no new sales for now. Your stake stays as it is, and you can still withdraw it.'));
  assert.ok(!notes.includes('The venue does not take new stakes right now.'), 'said once');
  assert.ok(!notes.some(n => n.startsWith('Required to sell')), 'no "listed as far as your stake covers" while no sale can start');
  // Seen live after the withdrawal under the new signers: nothing left to keep or withdraw.
  assert.equal(text(stakeNotes(stakeView(stakeStatus({ pieces: [] }), { selling: false, draining: true }), T).at(-1).parts),
    'The venue is moving stakes to new signers: no new stakes and no new sales for now.');
  for (const n of notes) plainOnly(n);
  // Seen live while draining: the price is blocked by the handoff (not a missing trade), and no reward accrues.
  const noPrice = stakeView(stakeStatus({ price: null }), { selling: true, draining: true });
  assert.ok(!stakeNotes(noPrice, T).map(n => text(n.parts)).some(n => n.startsWith('There is no RESET price')));
  const r = rewardsView(rewardsStatus(fx.now));
  assert.deepEqual([earningNow(r, s), weightText(r, s)], ['0', 'Paused while the venue moves stakes to new signers']);
  const offerId = [...fx.role.mine.keys()][0];
  fx.role.pauses.set(offerId, { code: 'stake_short', message: 'Stake coverage is unavailable; this offer is paused.' });
  const pause = (await model(fx).list('trader.offers')).rows[0].pause;
  assert.equal(pause.code, 'venue_draining');
  assert.deepEqual(pauseText(pause, 'TNK'), { reason: 'The venue is moving stakes to new signers and starts no new sales for now.', todo: 'Nothing to do; keep the offer or cancel it.' });
});

test('a take refused with "update the app" reads plainly in the trade outcome and alerts', async () => {
  const fx = traderFixture(), t = fx.role.host.trades.get('t-off');
  t.state = { ...t.state, mode: 'taker', reason: 'update the app' };
  assert.equal(outcome(t).text, 'Called off: sellers here post a bond, and only a newer version of this app can receive it. Update the app. Nothing was locked or sent.');
  assert.ok((await model(fx).list('trader.attention')).rows.some(a => a.kind === 'failed' && a.text.includes('Update the app.')));
});

test('stake notes: required for sellers, optional for buyers, coverage shortfall, deposits and withdrawals on their way, reasons', () => {
  const seller = stakeView(stakeStatus(), { selling: true });
  assert.deepEqual(stakeNotes(seller, T).map(n => [n.tone, text(n.parts)]), [['note', 'Required to sell: your offers are listed only as far as your free stake covers them.']]);
  assert.equal(coverageText(seller), 'Free stake worth $299.50 · your open sales $4.40');
  assert.equal(coverageText(stakeView(stakeStatus({ coverageUsd: '9983333333' }), { selling: true })), 'Covers up to $9,983.33 of open sales (yours: $4.40)');
  assert.equal(coverageText(stakeView(stakeStatus({ price: null }), { selling: true })), null);
  assert.equal(coverageText(stakeView(stakeStatus({ pieces: [], pending: '25000' }), { selling: false })), null, 'nothing staked yet: no value line');
  const buyer = stakeView(stakeStatus({ pieces: [piece('free', '120000000')] }), { selling: false });
  assert.equal(text(stakeNotes(buyer, T)[0].parts), 'Optional for buyers: stake RESET to earn a share of the daily rewards. Stake is reserved only when you sell, so while you only buy it is never at risk.');
  assert.equal(text(stakeNotes(stakeView(stakeStatus(), { selling: true, bonded: false }), T)[0].parts), 'Stake RESET to earn a share of the daily rewards. Sales here do not reserve a bond yet.');
  assert.equal(coverageText(buyer), 'Free stake worth $300.00');
  const busy = stakeView(stakeStatus({ coverageUsd: '3000000', pending: '50000000', reason: 'over_cap',
    pieces: [piece('free', '119800000'), piece('reserved', '200000'), piece('withdrawing', '20000000', { availableAt: NOW + 86400 })] }), { selling: true });
  const notes = stakeNotes(busy, T).map(n => [n.tone, text(n.parts)]);
  assert.deepEqual(notes.map(n => n[0]), ['note', 'warn', 'warn', 'note', 'note']);
  assert.equal(notes[1][1], 'Stake above the limit per address covers no sales and earns no rewards.');
  assert.equal(notes[2][1], 'Your open sales ($4.40) are $1.40 more than your stake covers ($3.00); the venue hides the rest. Suggested stake for your open offers: $0.20.');
  assert.equal(notes[3][1], 'Deposit of 0.5 RESET is being confirmed.');
  assert.equal(notes[4][1], `0.2 RESET is being withdrawn and earns no rewards; it is free to send on <${NOW + 86400}>.`);
  for (const [, t] of notes) plainOnly(t);
  const unknownWait = stakeView(stakeStatus({ pieces: [piece('withdrawing', '20000000')] }), { selling: false });
  assert.equal(text(stakeNotes(unknownWait, T).at(-1).parts), '0.2 RESET is being withdrawn and earns no rewards; it comes back to your wallet after the wait.');
  assert.equal(text(stakeNotes(stakeView(stakeStatus({ price: null }), { selling: false }), T)[1].parts),
    'There is no RESET price for today yet: it comes from a RESET trade completed today. Deposits and the stake’s dollar value wait for it.');
  const closed = stakeNotes(stakeView(stakeStatus({ settings: null }), { selling: true }), T).map(n => text(n.parts));
  assert.ok(closed.includes('The venue does not take new stakes right now.'));
});
test('a withdrawal that includes stake backing a running sale: returned after the sale closes; a forfeited part said plainly', () => {
  const w = extra => ({ operationId: 'b2'.repeat(32), requested: 'all', pending: true, deferred: '200000', withdrawing: '119800000', returned: '0', forfeited: '0', ...extra });
  const s = extra => stakeView({ ...stakeStatus(), withdrawal: w(extra) }, { selling: true });
  assert.deepEqual([s().withdrawal.deferred.text, s().withdrawal.forfeited.text], ['0.002', '0']);
  const notes = stakeNotes(s(), T).map(n => [n.tone, text(n.parts)]);
  assert.deepEqual(notes.at(-1), ['note', '0.002 RESET you asked to withdraw still backs a running sale: it is returned after the sale it backs closes and a 24 h wait.']);
  const lost = stakeNotes(s({ deferred: '0', forfeited: '200000' }), T).map(n => [n.tone, text(n.parts)]);
  assert.deepEqual(lost.at(-1), ['warn', '0.002 RESET of your withdrawal went to a buyer instead: a sale it backed was not delivered in time.']);
  assert.equal(stakeView({ ...stakeStatus(), withdrawal: w({ pending: false }) }, { selling: true }).withdrawal, null, 'a finished withdrawal says nothing more');
  assert.equal(stakeView(stakeStatus(), { selling: true }).withdrawal, null);
  for (const [, t] of [...notes, ...lost]) plainOnly(t);
});

test('a decided bond shows its verified RESET transfers to the buyer, not the sale delivery link', () => {
  const tx = ['d7'.repeat(32), 'd8'.repeat(32)];
  const bond = { state: 'paid', payments: tx.slice(0, 1) }, d = deliveryView(deliveryStatus('penalty_paid', NOW), { bond });
  assert.deepEqual(d.payments, tx.slice(0, 1));
  assert.deepEqual(deliveryView(deliveryStatus('delivery_sending', NOW)).payments, [], 'nothing decided, nothing paid');
  assert.deepEqual([paymentsLabel(tx.slice(0, 1)), paymentsLabel(tx)], ['Transaction:', 'Paid in 2 transactions:']);
});

test('rewards in words: weight with the venue multiplier, pool state with "Rewards paused, pool empty"', () => {
  const r = extra => rewardsView(rewardsStatus(NOW, extra));
  assert.equal(weightText(r()), 'Active (2×): your stake backs live sell offers');
  assert.equal(weightText(r({ activeWeightBps: 15000 })), 'Active (1.5×): your stake backs live sell offers');
  assert.equal(weightText(r({ activeWeightBps: null })), 'Active: your stake backs live sell offers');
  assert.equal(weightText(r({ weight: 'idle' })), 'Idle (1×): stake not backing a live sell offer');
  assert.equal(weightText(r({ weight: 'none' })), 'None: stake RESET to earn rewards');
  // Seen live: a stake certified after the last reward round is not counted yet; over the cap it earns nothing.
  const staked = extra => stakeView(stakeStatus(extra), { selling: false });
  assert.equal(weightText(r({ weight: 'none' }), staked()), 'Not counted yet: your stake counts from the next reward round');
  assert.equal(weightText(r({ weight: 'none' }), { ...staked(), reason: 'over_cap' }), 'None: stake RESET to earn rewards');
  assert.equal(weightText(r({ weight: 'none' }), staked({ pieces: [] })), 'None: stake RESET to earn rewards');
  assert.equal(weightText(r({ weight: 'idle' }), staked()), 'Idle (1×): stake not backing a live sell offer');
  // Seen live: the whole stake went to a buyer after the last reward round; it earns nothing more.
  assert.deepEqual([earningNow(r(), staked({ pieces: [] })), weightText(r(), staked({ pieces: [] }))], ['0', 'None: stake RESET to earn rewards']);
  assert.deepEqual([earningNow(r(), staked()), weightText(r(), staked())], ['0.0125', 'Active (2×): your stake backs live sell offers']);
  assert.equal(poolText(r()), 'Paying 5 RESET a day');
  assert.equal(poolText(r({ dailyBudget: null })), 'Paying rewards');
  assert.equal(poolText(r({ poolState: 'empty' })), 'Rewards paused, pool empty');
  assert.equal(poolText(r({ poolState: 'unknown' })), 'Pool balance unknown right now');
});

test('money and waits as text', () => {
  assert.equal(dollars(1250), '$1,250.00'); assert.equal(dollars(0.5), '$0.50'); assert.equal(dollars(3.456), '$3.46');
  assert.equal(usd({ text: '9,983.333333' }), '$9,983.33');
  assert.deepEqual([duration(1800), duration(86400), duration(3 * 86400), duration(20)], ['30 min', '24 h', '3 days', '1 min']);
});
