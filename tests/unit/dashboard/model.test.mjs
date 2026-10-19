import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { cached, createModel, describeTrade, outcome, plainReason, walletView, BALANCE_CACHE_MS } from '../../../src/dashboard/model.js';
import { formatUnits, shortKey } from '../../../src/dashboard/format.js';
import { seal } from '../../../src/core/envelope.js';
import { hex } from '../core/helpers.mjs';
import { traderFixture, signerFixture, serviceFixture, walletInfo, nowSec } from './fixtures.mjs';

const model = (fx, clock) => createModel({ config: fx.config, role: fx.role, wallets: fx.wallets ?? null, bridge: fx.bridge, ...(clock ? { clock } : {}) });

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
  assert.deepEqual(await read(), { ok: false, error: 'rpc down', value: 1, at: 30000 });
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
  assert.equal(outcome({ role: 'seller', state: { ...state, phase: 'lost' } }).tone, 'bad');
  assert.equal(outcome({ role: 'seller', state: { ...state, phase: 'aborted', reason: 'Invalid dealing' } }).text, "Called off: the buyer's lock details did not check out. Nothing was locked or sent.");
  assert.equal(plainReason('Timed out: deal'), 'the other side took too long to answer');
  assert.equal(plainReason(undefined), 'no reason given');
  assert.equal(plainReason('x'.repeat(500)).length, 160);
});

test('trader view: balances, signers online, attention, offers, trades, history and best-10 market with takeable offers', async () => {
  const fx = traderFixture(), s = (await model(fx).state()).trader;
  assert.equal(s.signersOnline, 4);
  assert.equal(s.balances.USDC.free.unit, 'USDC'); assert.equal(s.balances.TNK.total.text, '12');
  assert.deepEqual(s.attention.map(a => a.kind).sort(), ['expired', 'failed', 'key']);
  assert.match(s.attention.find(a => a.kind === 'expired').text, /buy 4 TNK at 0\.30 USDC expired; 4 TNK were not traded/);
  assert.match(s.attention.find(a => a.kind === 'failed').text, /Called off: the other side took too long/);
  assert.deepEqual(s.offers.map(o => [o.left.text, o.reserved.text, o.size.text]), [['9', '1', '10']]);
  assert.deepEqual(s.running.map(r => r.key), ['t-sell', 't-locked', 't-acks']);
  assert.deepEqual(s.history.map(r => [r.key, r.outcome.tone]), [['t-off', 'neutral'], ['t-done', 'good']]);
  const m = s.market.find(p => p.pair === 'TNK/USDC');
  assert.equal(m.last, '0.41'); assert.equal(m.volume24h.text, '123.45');
  assert.deepEqual(m.levels.sell.map(l => l.price), ['0.42', '0.44', '0.45']);
  assert.deepEqual(m.offers.sell.map(o => o.price), ['0.42', '0.45'], 'own offers are not offered for taking');
  assert.deepEqual(m.offers.buy.map(o => o.price), ['0.39']);
  for (let i = 0; i < 30; i++) fx.role.book.get('TNK/USDC').levels.push({ side: 'buy', price: `0.${10 + i}`, baseAmount: '1', offers: 1 });
  assert.equal((await model(fx).state()).trader.market[0].levels.buy.length, 10);
  assert.deepEqual(s.market.map(p => p.pair), ['TNK/USDC', 'RESET/USDC']);
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
  const fx = signerFixture(), m = model(fx), s = (await m.state()).signer;
  assert.equal(s.healthy, true);
  assert.deepEqual([s.health.peerConnected, s.health.trac, s.health.reset, s.health.heartbeatOk], [true, true, true, true]);
  assert.equal(s.pieces.held, 3); assert.equal(s.pieces.nextAt, fx.now);
  assert.deepEqual(s.pieces.list.map(p => p.until - fx.now), [0, 400, 700]);
  assert.equal(s.earnings.provisional.text, '0.0025'); assert.equal(s.earnings.final.text, '0.0025'); assert.equal(s.earnings.paid, null);
  assert.deepEqual(s.recent.map(r => r.text.split(' ')[0]), ['Key', 'No', 'Key']);
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
  const v = (await model(fx, () => now * 1000).state()).service;
  const row = k => v.signers.find(s => s.dexKey === k);
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
  assert.equal((await model(fx, () => now * 1000).state()).service.signers.find(s => s.dexKey === a.dexKey).label, 'removed signer');
});
