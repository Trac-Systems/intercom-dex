import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { cached, refreshing, createModel, describeTrade, outcome, plainReason, walletView, BALANCE_CACHE_MS } from '../../../src/dashboard/model.js';
import { formatUnits, shortKey } from '../../../src/dashboard/format.js';
import { seal } from '../../../src/core/envelope.js';
import { hex } from '../core/helpers.mjs';
import { traderFixture, signerFixture, serviceFixture, walletInfo, nowSec } from './fixtures.mjs';
import { RESET_PAUSED_MESSAGE } from '../../../src/market/gateway-status.js';

const model = (fx, clock) => createModel({ config: fx.config, role: fx.role, wallets: fx.wallets ?? null, bridge: fx.bridge, ...(clock ? { clock } : {}) });

test('a seller waiting for gateway recovery sees the pause and reservation-release deadline', () => {
  const fx = traderFixture(), trade = fx.role.host.trades.get('t-sell');
  trade.state.phase = 'transferring'; trade.state.gatewayPaused = true;
  const line = describeTrade(trade);
  assert.equal(line.now, RESET_PAUSED_MESSAGE); assert.equal(line.waitingFor, 'the RESET gateway');
  assert.equal(line.deadline, trade.state.terms.sendBy); assert.match(line.fallback, /reservation is released/);
  trade.state.phase = 'aborted'; trade.state.reason = 'Transfer not sent before the deadline: ' + RESET_PAUSED_MESSAGE;
  assert.match(outcome(trade).text, /was not sent.*reservation was released.*USDC stays locked until the refund time/);
  assert.doesNotMatch(outcome(trade).text, /Nothing was locked/);
});

test('claim failures appear on the trade row and in existing alerts, then disappear after success', async () => {
  const fx = traderFixture(), m = model(fx), trade = fx.role.host.trades.get('t-sell');
  trade.state.phase = 'claiming'; trade.state.claimFailure = { reason: 'insufficient SOL', at: fx.now };
  const row = (await m.list('trader.running')).rows.find(x => x.key === trade.key);
  assert.match(row.warning, /USDC claim failed: insufficient SOL/);
  assert.ok(row.warning.includes(trade.state.terms.seller.solRecipient));
  assert.match(row.warning, /SOL.*rent.*retries automatically/);
  const alerts = (await m.list('trader.attention')).rows.filter(x => x.kind === 'claim');
  assert.equal(alerts.length, 1); assert.ok(alerts[0].text.includes(row.warning));
  trade.state.phase = 'complete'; delete trade.state.claimFailure;
  assert.equal((await m.list('trader.attention')).rows.filter(x => x.kind === 'claim').length, 0);
  assert.equal((await m.list('trader.history')).rows.find(x => x.key === trade.key).warning, null);
});

test('amounts are formatted from base units without rounding up; keys are shortened', () => {
  assert.equal(formatUnits('1234567890123456789', 18), '1.234567');
  assert.equal(formatUnits('1000000', 6), '1');
  assert.equal(formatUnits('123456789000000', 6), '123,456,789');
  assert.equal(formatUnits('5', 6), '0.000005');
  assert.equal(formatUnits('123456', 18), '<0.000001');
  assert.equal(formatUnits('-123456', 18), '>-0.000001');
  assert.equal(formatUnits('0', 18), '0');
  assert.equal(formatUnits('-1500000', 6), '-1.5');
  assert.equal(shortKey('ab'.repeat(32)), 'ababab…abab');
  assert.equal(shortKey(null), '');
});

test('cached reads run at most once per window, share a running call and keep the last good value on failure', async () => {
  const clock = { t: 0 }, calls = { n: 0 }, fail = { now: false };
  const read = cached(async () => { calls.n++; if (fail.now) throw new Error('rpc down'); return calls.n; }, 30000, () => clock.t);
  const [a, b] = await Promise.all([read(), read()]);
  assert.equal(calls.n, 1); assert.equal(a, b); assert.deepEqual(a, { ok: true, value: 1, at: 0 });
  clock.t = 29999; assert.equal((await read()).value, 1); assert.equal(calls.n, 1);
  clock.t = 30000; fail.now = true;
  assert.deepEqual(await read(), { ok: false, error: 'rpc down', value: 1, at: 0 });
  clock.t = 40000; assert.equal(calls.n, 2, 'a failure also waits for the next window');
  await read(); assert.equal(calls.n, 2);
  clock.t = 60000; fail.now = false; assert.equal((await read()).value, 3);
});

test('the model reads balances at most once per 30 s however often the page polls', async () => {
  const fx = traderFixture(), clock = { t: Date.now() }, m = model(fx, () => clock.t);
  let reads = 0; const info = fx.wallets.info; fx.wallets.info = async () => { reads++; return info(); };
  for (let i = 0; i < 10; i++) { await m.state(); clock.t += 2000; }
  assert.equal(reads, 1);
  clock.t += BALANCE_CACHE_MS; await m.state(); assert.equal(reads, 2);
});

test('running trades read as one plain line: now, who we wait for, next deadline and the automatic fallback', () => {
  const fx = traderFixture(), trades = fx.role.host.trades;
  const locked = trades.get('t-locked'), t = locked.state.terms;
  assert.deepEqual(describeTrade(locked), { now: 'Your USDC is locked. Waiting for the seller to send the TNK', waitingFor: 'the seller',
    ifMissed: "If the seller doesn't send by", deadline: t.sendBy, fallback: 'your USDC comes back automatically on', fallbackAt: t.refundAfter });
  const sent = { ...locked, state: { ...locked.state, txHash: hex() } };
  assert.equal(describeTrade(sent).deadline, t.refundAfter); assert.equal(describeTrade(sent).waitingFor, 'signers and the seller');
  const acks = describeTrade(trades.get('t-acks'));
  assert.match(acks.now, /signers confirmed: 1 of 3/); assert.equal(acks.deadline, trades.get('t-acks').state.terms.sendBy - 120); assert.match(acks.fallback, /nothing is locked/);
  const shares = describeTrade(trades.get('t-sell'));
  assert.match(shares.now, /Your TNK was sent.*1 of 3 key pieces/); assert.equal(shares.deadline, trades.get('t-sell').state.terms.refundAfter);
  const phase = (role, p, extra = {}) => describeTrade({ role, state: { ...locked.state, role, phase: p, ...extra } });
  assert.equal(phase('buyer', 'awaitReveal').waitingFor, 'the other trader');
  assert.equal(phase('buyer', 'proving').waitingFor, 'this computer');
  assert.equal(phase('buyer', 'locking').fallbackAt, t.refundAfter);
  assert.equal(phase('buyer', 'refunding').ifMissed, null);
  assert.equal(phase('buyer', 'aborted', { locked: true }).fallbackAt, t.refundAfter);
  assert.equal(phase('seller', 'awaitReady').deadline, t.sendBy);
  assert.equal(phase('seller', 'transferring').deadline, t.sendBy);
  assert.equal(phase('seller', 'claiming').deadline, t.refundAfter);
  assert.equal(phase('seller', 'awaitDeal').waitingFor, 'the buyer');
  for (const p of ['awaitCertificate', 'preparingDeal', 'awaitAcks', 'locked', 'awaitTake', 'awaitTermsSig']) assert.doesNotMatch(JSON.stringify(phase('buyer', p)), /dealing|acks|Feldman|"H"/);
});

test('finished trades and reasons in plain words', () => {
  const state = { draft: { base: { id: 'TNK' } }, phase: 'complete' };
  assert.equal(outcome({ role: 'buyer', state }).text, 'Done: you received the TNK');
  assert.equal(outcome({ role: 'seller', state }).text, 'Done: you received the USDC');
  assert.match(outcome({ role: 'buyer', state: { ...state, phase: 'refunded' } }).text, /USDC came back/);
  assert.deepEqual(outcome({ role: 'seller', state: { ...state, phase: 'lost' } }),
    { tone: 'neutral', text: 'The buyer took the USDC back; your TNK was not sent' });
  assert.equal(outcome({ role: 'seller', state: { ...state, phase: 'aborted', reason: 'Invalid dealing' } }).text, "Called off: the buyer's lock details did not check out. Nothing was locked or sent.");
  assert.equal(plainReason('Timed out: deal'), 'the other side took too long to answer');
  assert.equal(plainReason(undefined), 'no reason given');
  assert.equal(plainReason('x'.repeat(500)).length, 160);
});

test('trader summaries and paged lists retain balances, attention, offers, running trades and history', async () => {
  const fx = traderFixture(), m = model(fx), s = (await m.state()).trader;
  assert.equal(s.signersOnline, 4);
  assert.equal(s.balances.USDC.free.unit, 'USDC'); assert.equal(s.balances.TNK.total.text, '12');
  assert.deepEqual(s.attention.map(a => a.kind).sort(), ['expired', 'failed', 'key']);
  assert.match(s.attention.find(a => a.kind === 'expired').text, /buy 4 TNK at 0\.30 USDC expired; 4 TNK were not traded/);
  assert.match(s.attention.find(a => a.kind === 'failed').text, /Called off: the other side took too long/);
  assert.deepEqual((await m.list('trader.offers')).rows.map(o => [o.left.text, o.reserved.text, o.size.text]), [['9', '1', '10']]);
  assert.deepEqual((await m.list('trader.running')).rows.map(r => r.key), ['t-sell', 't-locked', 't-acks']);
  assert.deepEqual((await m.list('trader.history')).rows.map(r => [r.key, r.outcome.tone]), [['t-off', 'neutral'], ['t-done', 'good']]);
  const pair = s.pairs.find(p => p.pair === 'TNK/USDC');
  assert.equal(pair.last, '0.41'); assert.equal(pair.volume24h.text, '123.45');
  assert.deepEqual([pair.bestAsk, pair.bestBid, pair.change24h, pair.high24h, pair.low24h], ['0.42', '0.39', null, null, null]);
  assert.deepEqual(s.pairs.map(p => p.pair), ['TNK/USDC', 'RESET/USDC']);
  assert.deepEqual(s.counts, { offers: 1, running: 3, history: 2, attention: 3 });
  for (const name of ['market', 'offers', 'running', 'history']) assert.equal(Object.hasOwn(s, name), false);
  assert.deepEqual(m.book('TNK/USDC').asks.map(l => l.price), ['0.42', '0.44', '0.45']);
  assert.equal(m.book('TNK/USDC').asks[1].take, null);

});

test('needs attention is empty when nothing needs the owner; a refund in progress shows up', async () => {
  const fx = traderFixture();
  fx.config.proof.zkey = fileURLToPath(import.meta.url);
  fx.role.host.trades.delete('t-off'); fx.role.store.map.clear();
  assert.deepEqual((await model(fx).state()).trader.attention, []);
  fx.role.host.trades.get('t-locked').state.phase = 'refunding';
  const items = (await model(fx).state()).trader.attention;
  assert.deepEqual(items.map(a => a.kind), ['refund']);
  fx.role.status = () => ({ ...traderFixture().role.status.call(fx.role), updateRequired: true, registryConflict: { version: 2 } });
  assert.deepEqual((await model(fx).state()).trader.attention.map(a => a.kind).sort(), ['paused', 'refund', 'update']);
});

test('wallets: deposit addresses, in use / free per asset, fee shortfall notes, payout locks and backup command; no secrets', () => {
  const fx = traderFixture(), w = walletView(fx.info, { network: 'local', role: 'trader' });
  assert.deepEqual(w.assets.map(a => a.asset), ['USDC', 'SOL', 'TNK', 'RESET']);
  const usdc = w.assets[0];
  assert.equal(usdc.address, fx.info.addresses.solana); assert.equal(w.assets[2].address, fx.info.addresses.trac);
  assert.equal(BigInt(usdc.inUse.units), BigInt(fx.info.balances.USDC.committed)); assert.equal(usdc.free.units, fx.info.balances.USDC.free);
  assert.deepEqual(w.notes, ['SOL is below what fees need: keep at least 0.04 SOL here (now 0.004).']);
  assert.match(w.backup.exportCommand, /dex\.mjs' export --config/);
  assert.equal(w.storage.passwordEnv, 'DEX_KEY_PASSWORD');
  const lock = walletInfo({ balances: { SOL: '1000000000', TNK: '1000000000000000000' }, payout: { trac: 'trac1xyz' } });
  const lw = walletView(lock, { network: 'local', role: 'trader' });
  assert.equal(lw.assets.find(a => a.asset === 'RESET').payoutLock, 'trac1xyz'); assert.equal(lw.assets.find(a => a.asset === 'USDC').payoutLock, null);
  assert.deepEqual(lw.notes, []);
  const venue = serviceFixture(), vw = walletView(venue.info, { network: 'local', role: 'service' });
  assert.deepEqual(vw.assets.map(a => [a.asset, a.canWithdraw]), [['USDC', true], ['SOL', true]]);
  const open = walletView({ ...venue.info, payout: {} }, { network: 'local', role: 'service' });
  assert.ok(open.assets.every(a => !a.canWithdraw)); assert.match(open.notes.at(-1), /payout\.solana/);
  const pending = walletView({ ...fx.info, withdrawals: [{ id: hex(), asset: 'USDC', amount: '2000000', to: 'x', status: 'unconfirmed', signature: 'S'.repeat(88) }] }, { network: 'mainnet', role: 'trader' });
  assert.equal(pending.withdrawals[0].amount.text, '2'); assert.equal(pending.withdrawals[0].link, `https://explorer.solana.com/tx/${'S'.repeat(88)}`);
  assert.equal(walletView(null, {}), null);
});

test('signer view: health checks, key pieces with the next change, earnings, venue warnings from verified requests only', async () => {
  const fx = signerFixture(), m = model(fx, () => fx.now * 1000), s = (await m.state()).signer;
  assert.equal(s.healthy, true);
  assert.deepEqual([s.health.peerConnected, s.health.trac, s.health.reset, s.health.heartbeatOk], [true, true, true, true]);
  assert.equal(s.pieces.held, 3); assert.equal(s.pieces.nextAt, fx.now);
  assert.deepEqual((await m.list('signer.pieces')).rows.map(p => p.until - fx.now), [0, 400, 700]);
  assert.equal(s.earnings.provisional.text, '0.0025'); assert.equal(s.earnings.final.text, '0.0025'); assert.equal(s.earnings.paid, null);
  assert.deepEqual((await m.list('signer.recent')).rows.map(r => r.text.split(' ')[0]), ['Key', 'No', 'Key']);
  assert.deepEqual(s.warnings, []);
  const published = [...fx.role.host.trades.values()].find(t => t.state.phase === 'published').state.tradeId;
  const ask = identity => seal({ kind: 'shareRequest', ch: 'intercom-dex:signers', body: { tradeId: published } }, identity.secretKey, { ts: nowSec(), nonce: hex() });
  m.note('intercom-dex:signers', ask(fx.f.buyer));
  m.note('intercom-dex:signers', { ...ask(fx.f.buyer), from: fx.role.serviceKey });
  m.note('intercom-dex:offers', ask(fx.f.service));
  assert.deepEqual((await m.state()).signer.warnings, [], 'only the venue’s own signed request counts');
  m.note('intercom-dex:signers', ask(fx.f.service));
  assert.match((await m.state()).signer.warnings[0], /venue has not confirmed it received your released key piece/);
  const down = signerFixture(); down.bridge.readers.dex_reset_context = false; down.bridge.ws.readyState = 3; down.role.lastHeartbeatAt = down.now - 200;
  const d = (await model(down).state()).signer;
  assert.equal(d.healthy, false); assert.deepEqual([d.health.peerConnected, d.health.trac, d.health.reset, d.health.heartbeatOk], [false, true, false, false]);
  down.role.registry.usable = null;
  assert.match((await model(down).state()).signer.warnings[0], /No signer list/);
});

test('venue view: signers with earned / owed / paid, today and 7-day trades, fees, reports waiting, book and health', async () => {
  const noon = new Date(); noon.setHours(12, 0, 0, 0);
  const now = Math.floor(noon.getTime() / 1000), fx = serviceFixture({ now }), [a, b, c] = fx.f.registry.signers;
  const m = model(fx, () => now * 1000), v = (await m.state()).service, signers = (await m.list('service.signers')).rows;
  const row = k => signers.find(s => s.dexKey === k);
  assert.deepEqual([row(a.dexKey).earned.text, row(a.dexKey).owed.text, row(a.dexKey).owedTrades, row(a.dexKey).paid.text, row(a.dexKey).online], ['0.012498', '0.008332', 2, '0', true]);
  assert.deepEqual([row(b.dexKey).owed.text, row(b.dexKey).paid.text], ['0.004166', '0.004166']);
  assert.deepEqual([row(c.dexKey).provisional.text, row(c.dexKey).owed.text, row(c.dexKey).online], ['0.004166', '0', false]);
  assert.equal(row(a.dexKey).limit.text, '1,000');
  assert.deepEqual([v.today.trades, v.week.trades, v.all.trades], [1, 1, 4]);
  assert.deepEqual([v.today.volume.text, v.today.fees.text, v.all.fees.text], ['5', '0.025', '0.1']);
  assert.deepEqual(v.reports, { waiting: 1, oldestAt: now - 900 });
  assert.deepEqual(v.book, { 'TNK/USDC': 3, 'RESET/USDC': 1 });
  assert.deepEqual([v.health.channels, v.health.connections, v.health.lastRegistryAt, v.health.registryVersion], [3, 6, now - 15, 1]);
  fx.role.registry = { ...fx.role.registry, signers: fx.role.registry.signers.slice(1), removed: [{ dexKey: a.dexKey, removedAt: now, reason: 'test' }] };
  assert.equal((await m.list('service.signers')).rows.find(s => s.dexKey === a.dexKey).label, 'removed signer');
});

test('refreshing returns the last result at once while the next read runs, and waits at most briefly for the first', async () => {
  const clock = { t: 0 }, gate = {};
  let n = 0;
  const read = refreshing(() => new Promise(resolve => { n++; gate.open = () => resolve(n); }), 30000, () => clock.t, 20);
  assert.deepEqual(await read(), { ok: false, error: 'still being read', value: null, at: null });
  gate.open(); await new Promise(r => setTimeout(r, 0));
  assert.equal((await read()).value, 1);
  clock.t = 30000;
  const started = Date.now(), stale = await read();
  assert.equal(stale.value, 1); assert.ok(Date.now() - started < 15, 'a due refresh does not hold the caller');
  assert.equal(stale.ok, false); assert.match(stale.error, /being refreshed/); assert.equal(stale.at, 0);
  assert.equal(n, 2); gate.open(); await new Promise(r => setTimeout(r, 0));
  assert.equal((await read()).value, 2);
});

test('a slow or failed wallet refresh retains values with their successful read time and an explicit warning', async () => {
  const fx = traderFixture(), clock = { t: Date.now() }, m = model(fx, () => clock.t);
  const first = await m.state(), info = await fx.wallets.info();
  let finish;
  fx.wallets.info = () => new Promise(resolve => { finish = resolve; });
  clock.t += BALANCE_CACHE_MS;
  const pending = await m.state();
  assert.deepEqual(pending.wallets.assets, first.wallets.assets);
  assert.equal(pending.wallets.readAt, first.wallets.readAt);
  assert.match(pending.wallets.error, /being refreshed/);
  assert.equal(pending.trader.balances, null, 'the trade ticket does not present stale balances as spendable');
  finish({ ...info, balances: null, balanceError: 'RESET balance unavailable: read timed out' });
  await new Promise(resolve => setImmediate(resolve));
  const failed = await m.state();
  assert.deepEqual(failed.wallets.assets, first.wallets.assets);
  assert.equal(failed.wallets.readAt, first.wallets.readAt);
  assert.match(failed.wallets.error, /RESET.*timed out/);
  assert.equal(failed.trader.balances, null);
  clock.t += BALANCE_CACHE_MS;
  fx.wallets.info = async () => info;
  await m.state(); await new Promise(resolve => setImmediate(resolve));
  const recovered = await m.state();
  assert.equal(recovered.wallets.error, null);
  assert.ok(recovered.wallets.readAt > first.wallets.readAt);
});

test('state stays available when the chains cannot be read: balances null, the read error shown, nothing throws', async () => {
  const fx = traderFixture(), info = fx.wallets.info;
  fx.wallets.info = async () => ({ ...(await info()), balances: null, balanceError: 'Balances unavailable right now: rpc down' });
  const s = await model(fx).state();
  assert.equal(s.trader.balances, null);
  assert.deepEqual(s.wallets.assets, []);
  assert.equal(s.wallets.error, 'Balances unavailable right now: rpc down');
});

test('alerts: a take of ours that ended without a trade is an alert unless the next offer took over; strangers dropping a take are not', async () => {
  const fx = traderFixture(), now = nowSec();
  fx.config.proof.zkey = fileURLToPath(import.meta.url);
  fx.role.host.trades.delete('t-off'); fx.role.store.map.clear();
  const base = fx.role.host.trades.get('t-acks').state;
  const add = (key, extra) => fx.role.host.trades.set(key, { key, role: 'buyer', state: { ...base, tradeId: undefined, phase: 'aborted', now: now - 30, ...extra } });
  add('take-last', { mode: 'taker', reason: 'Accept slot outside the freshness window' });
  add('take-moved', { mode: 'taker', reason: 'Timed out: take/accept' });
  add('stranger', { mode: 'maker', reason: 'Timed out: deciding block' });
  const notes = { 'take-moved': { moved: true, text: 'The next offer at this price was taken instead.' },
    'take-last': { moved: false, text: 'No other offer at this price could take over.' } };
  const m = createModel({ config: fx.config, role: fx.role, wallets: fx.wallets, bridge: fx.bridge, nextOffer: { note: k => notes[k] ?? null } });
  const items = (await m.state()).trader.attention;
  assert.equal(items.length, 1);
  assert.match(items[0].text, /Called off: the other side's view of the Solana chain did not match ours\. Nothing was locked or sent\. No other offer at this price could take over\./);
});

test('seller wording distinguishes an unconfirmed transfer from final coins sent, including after refund', () => {
  const fx = traderFixture(), trade = fx.role.host.trades.get('t-sell');
  for (const base of ['RESET', 'TNK']) {
    const state = { ...trade.state, terms: { ...trade.state.terms, base: { ...trade.state.terms.base, id: base } }, phase: 'transferring', transferUnknown: true };
    assert.equal(describeTrade({ ...trade, state }).now, `Sending your ${base}…`);
    assert.match(describeTrade({ ...trade, state: { ...state, phase: 'awaitShares', transferUnknown: false, transferFinal: true } }).now, /was sent/);
    const lost = outcome({ ...trade, state: { ...state, phase: 'lost' } });
    assert.match(lost.text, /still unconfirmed/); assert.doesNotMatch(lost.text, /had been sent/);
    const unsent = outcome({ ...trade, state: { ...state, phase: 'lost', transferUnknown: false } });
    assert.equal(unsent.tone, 'neutral'); assert.match(unsent.text, /was not sent/);
    for (const evidence of [{ txHash: hex() }, { transferFinal: true }]) {
      const sent = outcome({ ...trade, state: { ...state, phase: 'lost', transferUnknown: false, ...evidence } });
      assert.equal(sent.tone, 'bad'); assert.match(sent.text, /had been sent/);
    }
  }
});

test('expired offer sizes and history distinguish unsent losses from recorded or uncertain transfers', async () => {
  for (const [evidence, left] of [[{}, '4'], [{ transferUnknown: false, transferFinal: false }, '4'],
    [{ txHash: hex() }, '2.5'], [{ transferUnknown: true }, '2.5'], [{ transferFinal: true }, '2.5']]) {
    const fx = traderFixture(), old = fx.role.host.trades.get('t-sell');
    const expired = fx.role.store.list('offer-').map(k => fx.role.store.get(k).offer).find(o => o.expiresAt < fx.now);
    const trade = { ...old, state: { ...old.state, offerId: expired.offerId, phase: 'lost', ...evidence } };
    fx.role.host.trades.set(old.key, trade);
    const m = model(fx), attention = (await m.state()).trader.attention;
    assert.ok(attention.find(a => a.kind === 'expired').text.includes(`; ${left} TNK were not traded.`));
    const history = (await m.list('trader.history')).rows.find(t => t.key === old.key);
    assert.deepEqual(history.outcome, outcome(trade));
    if (left === '4') {
      assert.match(history.outcome.text, /was not sent/);
      assert.match(attention.find(a => a.kind === 'failed' && a.text.includes('USDC back')).text, /was not sent/);
    }
  }
});
