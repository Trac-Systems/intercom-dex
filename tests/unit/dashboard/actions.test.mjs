import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Keypair } from '@solana/web3.js';
import { createConfirmations, CONFIRM_TTL_MS } from '../../../src/dashboard/actions.js';
import { Service } from '../../../src/roles/service.js';
import { openStore } from '../../../src/roles/store.js';
import { encodeKey } from '../../../src/core/keys.js';
import { fixture, hex } from '../core/helpers.mjs';
import { traderFixture, serviceFixture, signerFixture, startFor, httpCall, nowSec } from './fixtures.mjs';
import { stakeStatus, deliveryStatus, piece, armBonds, bondedVenue } from './stake-fixtures.mjs';

test('a confirmation is bound to one action and its exact input, expires, and works once', () => {
  const clock = { t: 1000 }, c = createConfirmations({ clock: () => clock.t }), input = { offerId: 'ab'.repeat(32) };
  const token = c.issue('cancel', input);
  assert.throws(() => c.consume('cancel', { offerId: 'cd'.repeat(32) }, token), /does not match/);
  assert.throws(() => c.consume('take', input, token), /does not match/);
  assert.throws(() => c.consume('cancel', input, undefined), /expired or missing/);
  assert.throws(() => c.consume('cancel', input, 'garbage'), /expired or missing/);
  assert.throws(() => c.consume('cancel', input, token.replace(/.$/, ch => (ch === '0' ? '1' : '0'))), /does not match/);
  c.consume('cancel', structuredClone(input), token);
  assert.throws(() => c.consume('cancel', input, token), /already used/);
  assert.throws(() => createConfirmations({ clock: () => clock.t }).consume('cancel', input, c.issue('cancel', input)), /does not match/, 'another process start has another key');
  const late = c.issue('cancel', input);
  clock.t += CONFIRM_TTL_MS + 1;
  assert.throws(() => c.consume('cancel', input, late), /expired/);
});

// Preview, then act: refused without the preview's confirmation, with a changed input, and on replay.
async function confirmPath(t, fx, action, input, expectCall) {
  const s = await startFor(t, fx), post = (path, body) => httpCall(s.port, { path, method: 'POST', cookie: s.cookie, body });
  const calls = () => [...(fx.role.calls ?? []), ...(fx.wallets?.calls ?? [])].length;
  assert.equal((await post('/api/act', { action, input })).status, 400);
  const preview = await post('/api/preview', { action, input });
  assert.equal(preview.status, 200, preview.body);
  const p = preview.json();
  assert.equal(calls(), 0, 'nothing happens before the confirmation');
  const changed = { ...p.input, [Object.keys(p.input)[0]]: 'x' };
  assert.equal((await post('/api/act', { action, input: changed, confirm: p.confirm })).status, 400);
  const done = await post('/api/act', { action, input: p.input, confirm: p.confirm });
  assert.equal(done.status, 200, done.body);
  assert.equal(calls(), 1);
  expectCall(p);
  const replay = await post('/api/act', { action, input: p.input, confirm: p.confirm });
  assert.equal(replay.status, 400); assert.match(replay.json().error, /already used/);
  assert.equal(calls(), 1);
  return { p, result: done.json().result, post };
}

test('make offer: shows what is set aside (USDC with fees for buys), then calls the trader’s makeOffer', async t => {
  const fx = traderFixture();
  const { p } = await confirmPath(t, fx, 'offer', { pair: 'TNK/USDC', side: 'buy', amount: '10', price: '0.5', ttlMin: 30 }, () => {});
  assert.deepEqual(fx.role.calls[0], ['offer', { pair: 'TNK/USDC', side: 'buy', baseAmount: '10000000000000000000', price: '0.5', ttlSec: 1800 }]);
  assert.deepEqual(p.lines[1], ['You pay', '5 USDC']);
  assert.deepEqual(p.lines[2], ['Set aside while the offer is open', '5.03 USDC (includes fees)']);
  assert.equal(p.warning, null);
  const s = await startFor(t, traderFixture()), post = body => httpCall(s.port, { path: '/api/preview', method: 'POST', cookie: s.cookie, body: { action: 'offer', input: body } });
  const sell = (await post({ pair: 'TNK/USDC', side: 'sell', amount: '50', price: '0.5' })).json();
  assert.match(sell.warning, /You have 1\.88 TNK free; this needs 50 TNK/);
  assert.match((await post({ pair: 'TNK/USDC', side: 'sell', amount: '1', price: 'abc' })).json().error, /Price/);
  assert.match((await post({ pair: 'TNK/USDC', side: 'hold', amount: '1', price: '1' })).json().error, /buy or sell/);
  assert.match((await post({ pair: 'BTC/USDC', side: 'sell', amount: '1', price: '1' })).json().error, /Unknown registry pair/);
  assert.match((await post({ pair: 'TNK/USDC', side: 'sell', amount: '1', price: '1', ttlMin: 0 })).json().error, /1 to 1440/);
});

test('offer and take previews use the registry platform fee, not a fixed one', async t => {
  const fx = traderFixture(); fx.f.registry.fee.platformFeeBps = 25;
  const s = await startFor(t, fx), preview = (action, input) => httpCall(s.port, { path: '/api/preview', method: 'POST', cookie: s.cookie, body: { action, input } });
  const offer = (await preview('offer', { pair: 'TNK/USDC', side: 'buy', amount: '10', price: '0.5' })).json();
  assert.deepEqual(offer.lines[2], ['Set aside while the offer is open', '5.0375 USDC (includes fees)']);
  const take = (await preview('take', { offerId: fx.theirs[0].offerId, amount: '2' })).json();
  assert.deepEqual(take.lines[0], ['You lock', '0.8463 USDC (includes fees)']);
});

test('take: shows the USDC locked (with fees) or the tokens sent, then calls takeOffer with the offer’s own price', async t => {
  const fx = traderFixture(), sell = fx.theirs[0];
  const { p } = await confirmPath(t, fx, 'take', { offerId: sell.offerId, amount: '2' }, () => {});
  assert.deepEqual(fx.role.calls[0], ['take', [sell.offerId, '2000000000000000000', '0.42']]);
  assert.deepEqual(p.lines, [['You lock', '0.84504 USDC (includes fees)'], ['You receive', '2 TNK']]);
  const s = await startFor(t, traderFixture()), post = input => httpCall(s.port, { path: '/api/preview', method: 'POST', cookie: s.cookie, body: { action: 'take', input } });
  assert.match((await post({ offerId: hex() })).json().error, /no longer announced by its maker/);
  const fx2 = traderFixture(), s2 = await startFor(t, fx2);
  const buy = (await httpCall(s2.port, { path: '/api/preview', method: 'POST', cookie: s2.cookie, body: { action: 'take', input: { offerId: fx2.theirs[2].offerId } } })).json();
  assert.deepEqual(buy.lines, [['You send', '8 TNK'], ['You receive', '3.12 USDC']], 'a venue that does not bond sales: no bond line');
  assert.match(buy.warning, /1\.88 TNK free/);
  const tooMuch = await httpCall(s2.port, { path: '/api/preview', method: 'POST', cookie: s2.cookie, body: { action: 'take', input: { offerId: fx2.theirs[2].offerId, amount: '9' } } });
  assert.match(tooMuch.json().error, /only 8 TNK/);
  // Below the smallest trade of the offer's signer list: a clear answer, and a rest below it is named as such.
  const tnk = fx2.f.registry.pairs.find(p => p.pair === 'TNK/USDC'), before = tnk.minBaseAmount;
  tnk.minBaseAmount = '1000000000000000000';
  const small = await httpCall(s2.port, { path: '/api/preview', method: 'POST', cookie: s2.cookie, body: { action: 'take', input: { offerId: fx2.theirs[2].offerId, amount: '0.5' } } });
  assert.equal(small.json().error, 'The smallest trade for this offer is 1 TNK.');
  tnk.minBaseAmount = '9000000000000000000';
  const rest = await httpCall(s2.port, { path: '/api/preview', method: 'POST', cookie: s2.cookie, body: { action: 'take', input: { offerId: fx2.theirs[2].offerId } } });
  assert.match(rest.json().error, /^The smallest trade for this offer is 9 TNK; only 8 TNK is left, so this rest cannot be traded\./);
  tnk.minBaseAmount = before;
});

test('cancel: only own open offers, then calls cancelOffer', async t => {
  const fx = traderFixture();
  const { p } = await confirmPath(t, fx, 'cancel', { offerId: fx.mine.offerId }, () => {});
  assert.deepEqual(fx.role.calls[0], ['cancel', fx.mine.offerId]);
  assert.match(p.lines[0][1], /sell 10 TNK at 0\.44 USDC/);
  const s = await startFor(t, traderFixture());
  const r = await httpCall(s.port, { path: '/api/preview', method: 'POST', cookie: s.cookie, body: { action: 'cancel', input: { offerId: fx.theirs[0].offerId } } });
  assert.match(r.json().error, /Not one of your open offers/);
});

test('withdraw: free amount or all, typed destination or the fixed payout address, via the wallet’s withdraw', async t => {
  const fx = traderFixture(), to = Keypair.generate().publicKey.toBase58();
  const { p, result } = await confirmPath(t, fx, 'withdraw', { asset: 'USDC', amount: '1.25', to }, () => {});
  assert.deepEqual(fx.wallets.calls[0], { asset: 'USDC', amount: '1.25', to });
  assert.deepEqual(p.lines[1], ['To', to]);
  assert.equal(result.status, 'confirmed'); assert.equal(result.amount.text, '1.25'); assert.equal(result.link, null, 'no explorer link off mainnet');
  const locked = traderFixture(), lock = Keypair.generate().publicKey.toBase58();
  locked.config = { ...locked.config, payout: { solana: lock }, network: 'mainnet' };
  const { p: lp, result: lr } = await confirmPath(t, locked, 'withdraw', { asset: 'SOL', amount: 'all', to }, () => {});
  assert.deepEqual(locked.wallets.calls[0], { asset: 'SOL', amount: 'all', to: lock }, 'a payout lock replaces any typed destination');
  assert.deepEqual(lp.lines[1], ['To', `${lock} (fixed payout address)`]);
  assert.equal(lr.link, `https://explorer.solana.com/tx/${'5'.repeat(88)}`);
  const s = await startFor(t, traderFixture()), post = input => httpCall(s.port, { path: '/api/preview', method: 'POST', cookie: s.cookie, body: { action: 'withdraw', input } });
  assert.match((await post({ asset: 'USDC', amount: '1', to: 'nope' })).json().error, /payout address/i);
  assert.match((await post({ asset: 'USDC', amount: '1.1234567', to })).json().error, /decimal places/);
  assert.match((await post({ asset: 'USDC', amount: '100', to })).json().warning, /USDC free; this needs 100 USDC/);
});

test('venue: mark paid names exactly the owed trades and calls the service; withdrawals only to payout.solana', async t => {
  const fx = serviceFixture(), signer = fx.f.registry.signers[0].dexKey;
  const { p } = await confirmPath(t, fx, 'markPaid', { dexKey: signer }, () => {});
  assert.deepEqual(fx.role.calls[0], ['markPaid', signer, [...fx.owedA].sort()]);
  assert.equal(p.title, 'Mark 0.008332 USDC as paid to signer-0');
  const s = await startFor(t, serviceFixture()), post = (action, input) => httpCall(s.port, { path: '/api/preview', method: 'POST', cookie: s.cookie, body: { action, input } });
  assert.match((await post('markPaid', { dexKey: fx.f.registry.signers[2].dexKey })).json().error, /Nothing is owed/);
  assert.match((await post('withdraw', { asset: 'TNK', amount: '1' })).json().error, /only USDC and SOL/);
  assert.match((await post('offer', {})).json().error, /Unknown action/);
  const w = serviceFixture();
  await confirmPath(t, w, 'withdraw', { asset: 'USDC', amount: 'all' }, () => {});
  assert.deepEqual(w.wallets.calls[0], { asset: 'USDC', amount: 'all', to: w.config.payout.solana });
  const none = serviceFixture(); none.config = { ...none.config, payout: {} };
  const s3 = await startFor(t, none);
  assert.match((await httpCall(s3.port, { path: '/api/preview', method: 'POST', cookie: s3.cookie, body: { action: 'withdraw', input: { asset: 'USDC', amount: '1' } } })).json().error, /payout\.solana/);
});

test('signers have no dashboard actions', async t => {
  const s = await startFor(t, signerFixture());
  for (const action of ['offer', 'take', 'cancel', 'withdraw', 'markPaid']) {
    const r = await httpCall(s.port, { path: '/api/preview', method: 'POST', cookie: s.cookie, body: { action, input: {} } });
    assert.equal(r.status, 400); assert.equal(r.json().error, 'Unknown action');
  }
});

test('Service.markPaid records only final, unpaid credits for that signer, all or nothing, durably', async () => {
  const f = fixture(), dir = mkdtempSync(join(tmpdir(), 'dash-paid-')), key = randomBytes(32), store = openStore(dir, key);
  const [a, b] = f.registry.signers.map(s => s.dexKey), now = 2_000_000;
  const put = (id, credits, extra) => store.put(`settle-${id}`, { tradeId: id, status: 'logged', loggedAt: now - 8 * 86400, credits, creditsFinal: true, fill: null,
    entry: { tradeId: id, escrowAddress: hex(), ts: now - 8 * 86400 }, report: { terms: f.terms }, ...extra });
  const [t1, t2, t3, t4] = [hex(), hex(), hex(), hex()];
  put(t1, { [a]: '100', [b]: '100' }); put(t2, { [a]: '50' }); put(t3, { [a]: '70' }, { creditsFinal: false }); put(t4, { [b]: '9' });
  const { version: _v, issuedAt: _i, ...input } = f.registry;
  const make = () => new Service({ firstLaunch: true, bridge: new EventEmitter(), identity: { secretKey: encodeKey(f.service.secretKey), publicKey: encodeKey(f.service.publicKey) },
    store: openStore(dir, key), solana: null, trac: null, log: () => {}, now: () => now, registryInput: input });
  const service = make();
  await assert.rejects(service.markPaid(a, [t1, t3]), /Not every trade is owed/);
  await assert.rejects(service.markPaid(a, [t4]), /Not every trade is owed/);
  await assert.rejects(service.markPaid(a, []), /Name the trades/);
  await assert.rejects(service.markPaid(a, [t1, t1]), /Name the trades/);
  assert.ok(service.payouts[a].every(p => !p.paid), 'a refused list changes nothing');
  assert.deepEqual(await service.markPaid(a, [t1, t2]), { dexKey: a, trades: 2, amount: '150' });
  await assert.rejects(service.markPaid(a, [t1]), /Not every trade is owed/, 'paid once only');
  const again = make();
  assert.deepEqual(again.payouts[a].map(p => [p.tradeId, p.paid]).sort(), [[t1, true], [t2, true], [t3, false]].sort());
  assert.ok(again.payouts[b].every(p => !p.paid), 'another signer’s credit on the same trade stays unpaid');
});

test('take previews reject stale, expired, own and removed offers and default to the remaining amount', async t => {
  const fx = traderFixture(), s = await startFor(t, fx), offer = fx.theirs[0];
  const preview = (id, amount) => httpCall(s.port, { path: '/api/preview', method: 'POST', cookie: s.cookie,
    body: { action: 'take', input: { offerId: id, ...(amount ? { amount } : {}) } } });
  const seen = fx.role.offers.get(offer.offerId);
  seen.lastSeen -= 300;
  assert.deepEqual((await preview(offer.offerId)).json(), { error: 'This offer is no longer announced by its maker.' });
  seen.lastSeen += 300;
  const expiry = offer.expiresAt; offer.expiresAt = fx.now - 1;
  assert.equal((await preview(offer.offerId)).status, 400); offer.expiresAt = expiry;
  assert.equal((await preview(fx.mine.offerId)).status, 400);
  const book = fx.role.book.get(offer.pair); book.ts = fx.now;
  book.remaining = [{ offerId: offer.offerId, amount: '1000000000000000000' }];
  const p = (await preview(offer.offerId)).json();
  assert.equal(p.input.baseAmount, '1000000000000000000');
  assert.match((await preview(offer.offerId, '2')).json().error, /only 1 TNK/);
  book.remaining = [];
  assert.equal((await preview(offer.offerId)).status, 400);
  assert.deepEqual(fx.role.calls, []);
});

test('max-take: the most of an offer the free balance pays for, fees included', async t => {
  const fx = traderFixture(), [sell, , buy] = fx.theirs;
  fx.info.balances.USDC.free = '1000000';
  const s = await startFor(t, fx), get = offerId => httpCall(s.port, { path: `/api/max-take?offerId=${offerId}`, cookie: s.cookie });
  const preview = amount => httpCall(s.port, { path: '/api/preview', method: 'POST', cookie: s.cookie, body: { action: 'take', input: { offerId: sell.offerId, amount } } });
  const most = (await get(sell.offerId)).json();
  assert.equal(most.all, false);
  assert.equal((await preview(most.amount.text)).json().warning, null, 'the maximum fits the free USDC with fees');
  const over = (BigInt(most.baseAmount) + 1n).toString().padStart(19, '0');
  assert.match((await preview(`${over.slice(0, -18)}.${over.slice(-18)}`)).json().warning, /1 USDC free/, 'one unit more does not');
  // Selling into a buy offer: the free base, at most the offer.
  const sale = (await get(buy.offerId)).json();
  assert.equal(sale.baseAmount, fx.info.balances.TNK.free);
  assert.equal(sale.all, false);
  fx.role.book.get(buy.pair).remaining = [{ offerId: buy.offerId, amount: '100000000000000000' }];
  assert.equal((await get(buy.offerId)).json().baseAmount, '100000000000000000', 'max-take uses the venue-sized bid');
  delete fx.role.book.get(buy.pair).remaining;
  fx.info.balances.USDC.free = '25000000';
  assert.deepEqual((await get(sell.offerId)).json(), { baseAmount: sell.baseAmount, amount: { units: sell.baseAmount, text: '5', unit: 'TNK' }, all: true, note: null });
  assert.match((await get(hex())).json().error, /no longer announced by its maker/);
});

test('stake deposit: the stake afterwards against the cap, the core’s TNK fees and wait, then calls the trader’s stakeDeposit', async t => {
  const fx = traderFixture();
  const { p, result } = await confirmPath(t, fx, 'stakeDeposit', { amount: '0.3' }, () => {});
  assert.deepEqual(fx.role.calls, [['stakeDeposit', '30000000']]);
  assert.deepEqual(p.lines, [['Deposit', '0.3 RESET (about $75.00)'], ['Stake afterwards', '1.5 RESET (about $375.00)'], ['Limit per address', '$400.00'],
    ['TNK paid now', '0.3 TNK: 0.12 TNK network fees and 0.18 TNK held for the return transfers'], ['Withdrawing later', 'waits 24 h'],
    ['Returned by itself', 'after 30 days unless withdrawn first']]);
  assert.equal(p.warning, null); assert.match(p.note, /paid to the buyer only if the sale is not delivered in time\. It counts once the signers confirm it\./);
  assert.deepEqual(result, { ok: true, operationId: 'a1'.repeat(32), funded: '30000000' });
  const s = await startFor(t, fx), preview = input => httpCall(s.port, { path: '/api/preview', method: 'POST', cookie: s.cookie, body: { action: 'stakeDeposit', input } });
  assert.equal((await preview({ amount: '0.5' })).json().error, 'This would bring your stake to $425.00; the limit is $400.00 per address. Deposit at most 0.4 RESET.');
  assert.match((await preview({ amount: '3' })).json().error, /Deposit at most 0\.4 RESET/);
  assert.match((await preview({ amount: '0' })).json().error, /out of range/);
  assert.match((await preview({ amount: 'abc' })).json().error, /Invalid/);
  fx.role.stake = { ...fx.role.stake, priceUsd: null };
  assert.equal((await preview({ amount: '0.5' })).json().lines[1][1], '1.7 RESET', 'no price: no dollar value and no cap check here; the core still refuses');
  fx.role.stakePreview = async () => { throw new Error('Add TNK to cover stake funding fees and collection reserves.'); };
  assert.equal((await preview({ amount: '0.1' })).json().error, 'Add TNK to cover stake funding fees and collection reserves.', 'the core’s refusal as it is');
  fx.role.stake = stakeStatus({ settings: null });
  assert.equal((await preview({ amount: '0.5' })).json().error, 'This venue does not take stakes yet.');
});

test('stake withdraw: free stake waits now, stake backing a running sale is returned after it closes; "all" is all of it', async t => {
  const fx = traderFixture();
  const { p, result } = await confirmPath(t, fx, 'stakeWithdraw', { amount: '0.5' }, () => {});
  assert.deepEqual(fx.role.calls[0], ['stakeWithdraw', '50000000']);
  assert.equal(result.pending, true); assert.equal(typeof result.availableAt, 'number'); assert.equal(result.deferred, undefined);
  assert.deepEqual(p.lines, [['Amount', '0.5 RESET'], ['Wait', '24 h'], ['Then', 'back to your Trac wallet']]);
  assert.equal(p.note, 'The RESET earns no rewards and covers no sales while it waits. Offers beyond what the rest of your stake covers are hidden.',
    'the core withdraws exact amounts now: no "fixed pieces" refusal');
  const s = await startFor(t, fx), preview = input => httpCall(s.port, { path: '/api/preview', method: 'POST', cookie: s.cookie, body: { action: 'stakeWithdraw', input } }).then(r => r.json());
  const all = await preview({ amount: 'all' });
  assert.deepEqual(all.input, { amount: 'all' }, 'all of it, also the part backing a running sale');
  assert.equal(all.title, 'Withdraw 1.2 RESET from your stake');
  assert.deepEqual(all.lines, [['Amount', '1.2 RESET'], ['Free now', '1.198 RESET: waits 24 h'],
    ['Backing running sales', '0.002 RESET: returned after the sale it backs closes, then waits 24 h'], ['Then', 'back to your Trac wallet']]);
  assert.match(all.note, /If a sale it backs is not delivered in time, that part goes to the buyer instead\.$/);
  const more = await preview({ amount: '1.199' });
  assert.deepEqual([more.input, more.lines[2]], [{ amount: '119900000' }, ['Backing running sales', 'at least 0.001 RESET: returned after the sale it backs closes, then waits 24 h']]);
  assert.equal((await preview({ amount: '2' })).error, 'You can withdraw at most 1.2 RESET; the rest is already on its way.');
  fx.role.stake = { ...stakeStatus(), operationId: 'a1'.repeat(32), operationPending: true };
  assert.match((await preview({ amount: '0.5' })).error, /still running/);
  fx.role.stake = stakeStatus({ pieces: [piece('reserved', '200000')], openOffersUsd: '0' });
  const reserved = await preview({ amount: 'all' });
  assert.deepEqual([reserved.input, reserved.lines[1]], [{ amount: 'all' }, ['Free now', '0 RESET: waits 24 h']]);
  fx.role.stake = stakeStatus({ pieces: [piece('withdrawing', '200000')] });
  assert.match((await preview({ amount: 'all' })).error, /^No stake to withdraw; what is left is already on its way\./);
  // Done: the core's stake.withdrawal says how much of it waits for a running sale.
  fx.role.stake = stakeStatus();
  fx.role.stakeWithdraw = async () => { fx.role.stake = { ...stakeStatus(), operationId: 'b2'.repeat(32), operationPending: true,
    withdrawal: { operationId: 'b2'.repeat(32), requested: 'all', pending: true, deferred: '200000', withdrawing: '119800000', returned: '0', forfeited: '0' } };
  return { ok: true, operationId: 'b2'.repeat(32), pending: true }; };
  const done = await httpCall(s.port, { path: '/api/act', method: 'POST', cookie: s.cookie, body: { action: 'stakeWithdraw', input: all.input, confirm: (await preview({ amount: 'all' })).confirm } }).then(r => r.json());
  assert.equal(done.result.deferred.text, '0.002');
});

test('retry delivery: only a failing or overdue sale, shows what is at risk, calls retryDelivery with the full trade key', async t => {
  const fx = traderFixture();
  fx.role.deliveries.set('t-sell', deliveryStatus('delivery_overdue', fx.now));
  const { p } = await confirmPath(t, fx, 'retryDelivery', { key: 't-sell' }, () => {});
  assert.deepEqual(fx.role.calls[0], ['retryDelivery', 't-sell']);
  assert.equal(p.title, 'Send your 1.5 TNK again');
  assert.deepEqual(p.lines, [['Sale', '1.5 TNK for 0.63 USDC'], ['At risk', '$0.50 (0.002 RESET)']]);
  assert.match(p.note, /never starts a new one/);
  const s = await startFor(t, fx), preview = key => httpCall(s.port, { path: '/api/preview', method: 'POST', cookie: s.cookie, body: { action: 'retryDelivery', input: { key } } });
  fx.role.deliveries.set('t-sell', { ...fx.role.deliveries.get('t-sell'), state: 'delivery_confirming' });
  assert.equal((await preview('t-sell')).json().error, 'This sale has nothing to retry right now');
  fx.role.deliveries.set('t-locked', { ...fx.role.deliveries.get('t-sell'), state: 'delivery_failed' });
  assert.equal((await preview('t-locked')).json().error, 'This sale has nothing to retry right now', 'a buy is never retried from here');
  assert.equal((await preview('nope')).json().error, 'This sale has nothing to retry right now');
});

test('sell previews and the sell ticket show the bond the trader would sign, or why the sale cannot start', async t => {
  // Both venues price at the same second: their price references must match exactly.
  const fx = traderFixture(), s = await startFor(t, fx), now = nowSec();
  const preview = (action, input) => httpCall(s.port, { path: '/api/preview', method: 'POST', cookie: s.cookie, body: { action, input } }).then(r => r.json());
  const ticket = input => httpCall(s.port, { path: `/api/sale-bond?${new URLSearchParams(input)}`, cookie: s.cookie }).then(r => r.json());
  const sale = { pair: 'TNK/USDC', side: 'sell', amount: '1.5', price: '0.5', ttlMin: 30 };
  assert.ok(!(await preview('offer', sale)).lines.some(([k]) => k.startsWith('Bond')), 'the venue does not bond sales yet');
  assert.deepEqual(await ticket({ pair: 'TNK/USDC', amount: '1.5', price: '0.5' }), { bond: null });
  armBonds(fx, { now });
  const sell = await preview('offer', sale);
  assert.deepEqual(sell.lines[3], ['Bond reserved for this sale', '$0.50 (0.00025 RESET)']);
  assert.equal(sell.warning, null);
  const t1 = await ticket({ pair: 'TNK/USDC', amount: '1.5', price: '0.5' });
  assert.deepEqual([t1.bond.reset.text, t1.bond.usd.text, t1.bond.refused], ['0.00025', '0.5', null]);
  const big = await preview('offer', { ...sale, price: '1000' });
  assert.ok(!big.lines.some(([k]) => k.startsWith('Bond')));
  assert.equal(big.warning, 'Not covered: your free stake has no pieces that cover this bond. Deposit RESET under Wallets → Stake, or sell less.');
  assert.equal((await ticket({ pair: 'TNK/USDC', amount: '1.5', price: '1000' })).bond.refused, 'bond_not_reserved');
  assert.match((await ticket({ pair: 'TNK/USDC', amount: '1.5', price: 'x' })).error, /Price must be a decimal number/);
  const buy = await preview('offer', { ...sale, side: 'buy', amount: '10' });
  assert.ok(!buy.lines.some(([k]) => k.startsWith('Bond')), 'buyers reserve no bond');
  const take = await preview('take', { offerId: fx.theirs.find(o => o.side === 'buy').offerId, amount: '1' });
  assert.deepEqual(take.lines.at(-1), ['Bond reserved for this sale', '$0.50 (0.00025 RESET)']);
  const takeBuy = await preview('take', { offerId: fx.theirs[0].offerId });
  assert.ok(!takeBuy.lines.some(([k]) => /bond/i.test(k)), "no seller's bond while the core cannot tell it");
  assert.doesNotMatch(takeBuy.warning ?? '', /Update the app/, 'this app can receive a bond');
  const seller = bondedVenue({ me: fx.theirs[0].maker, registry: fx.f.registry, now, boxKey: 'b2'.repeat(32) });
  fx.role.stakeRuntime.admission.cache.set(fx.theirs[0].maker.dexKey, seller.runtime.admission.cache.get(fx.theirs[0].maker.dexKey));
  assert.deepEqual((await preview('take', { offerId: fx.theirs[0].offerId, amount: '1.5' })).lines.at(-1),
    ['Seller’s bond', "$0.50 (0.00025 RESET) from the seller's stake, paid to you if the seller does not deliver in time"]);
  fx.role.stakeRuntime = null;
  assert.equal((await ticket({ pair: 'TNK/USDC', amount: '1.5', price: '0.5' })).bond.refused, 'bond_setup_unavailable');
  assert.match((await preview('take', { offerId: fx.theirs[0].offerId })).warning,
    /^Sellers here post a bond, and only a newer version of this app can receive it\. Update the app to buy\./);
});

test('a review the core already refuses has no Confirm: no confirmation is issued, so it cannot run', async t => {
  const fx = traderFixture(), s = await startFor(t, fx);
  const post = (path, body) => httpCall(s.port, { path, method: 'POST', cookie: s.cookie, body }).then(r => r.json());
  const sale = { pair: 'TNK/USDC', side: 'sell', amount: '1.5', price: '0.5', ttlMin: 30 };
  armBonds(fx);
  const covered = await post('/api/preview', { action: 'offer', input: sale });
  assert.equal(covered.blocked, false); assert.match(covered.confirm, /^\d+\.[0-9a-f]{64}$/);
  const refused = await post('/api/preview', { action: 'offer', input: { ...sale, price: '1000' } });
  assert.equal(refused.blocked, true); assert.equal(refused.confirm, null); assert.match(refused.warning, /^Not covered:/);
  let made = 0; fx.role.makeOffer = async () => { made++; return {}; };
  const reg = fx.role.registry.usable;
  fx.role.registry = { ...fx.role.registry, usable: { ...reg, sellerBond: { ...reg.sellerBond, acceptNew: false } } };
  const drained = await post('/api/preview', { action: 'offer', input: sale });
  assert.deepEqual([drained.blocked, drained.confirm, drained.warning], [true, null, 'No new sales for now: the venue is moving stakes to new signers. Your stake stays as it is.']);
  assert.equal((await post('/api/preview', { action: 'stakeDeposit', input: { amount: '0.1' } })).error,
    'The venue is moving stakes to new signers and takes no new stakes for now. Your stake stays as it is.');
  fx.role.registry = { ...fx.role.registry, usable: reg };
  assert.match((await post('/api/act', { action: 'offer', input: refused.input, confirm: refused.confirm })).error, /Confirmation expired or missing/);
  const sellTake = await post('/api/preview', { action: 'take', input: { offerId: fx.theirs.find(o => o.side === 'buy').offerId, amount: '1' } });
  assert.equal(sellTake.blocked, false); assert.ok(sellTake.confirm);
  const buy = await post('/api/preview', { action: 'take', input: { offerId: fx.theirs[0].offerId } });
  assert.equal(buy.blocked, false); assert.ok(buy.confirm, 'an ordinary buy can be confirmed');
  fx.role.stakeRuntime = null;
  const update = await post('/api/preview', { action: 'take', input: { offerId: fx.theirs[0].offerId } });
  assert.match(update.warning, /Update the app to buy\./); assert.equal(update.blocked, true); assert.equal(update.confirm, null);
  let took = 0; fx.role.takeOffer = async () => { took++; return {}; };
  assert.match((await post('/api/act', { action: 'take', input: update.input, confirm: update.confirm })).error, /Confirmation expired or missing/);
  assert.deepEqual([made, took], [0, 0]);
  // The core's price is older than a minute: refused for now, with when to try again.
  armBonds(fx, { now: nowSec() - 61 });
  const stale = await post('/api/preview', { action: 'offer', input: sale });
  assert.deepEqual([stale.blocked, stale.confirm, stale.warning], [true, null, 'No bond right now: there is no fresh RESET price. Try again in a minute.']);
  // While the venue drains the core starts no new trade at all, buys included.
  fx.role.registry = { ...fx.role.registry, usable: { ...reg, sellerBond: { ...reg.sellerBond, acceptNew: false } } };
  for (const p of [await post('/api/preview', { action: 'take', input: { offerId: fx.theirs[0].offerId } }), await post('/api/preview', { action: 'offer', input: { ...sale, side: 'buy' } })])
    assert.deepEqual([p.blocked, p.confirm, p.warning], [true, null, 'No new trades for now: the venue is moving stakes to new signers.']);
});

test('a take the core refuses with "update the app" says so plainly', async t => {
  const fx = traderFixture();
  fx.role.takeOffer = async () => { throw new Error('update the app'); };
  const s = await startFor(t, fx), post = (path, body) => httpCall(s.port, { path, method: 'POST', cookie: s.cookie, body }).then(r => r.json());
  const p = await post('/api/preview', { action: 'take', input: { offerId: fx.theirs[0].offerId, amount: '2' } });
  const r = await post('/api/act', { action: 'take', input: p.input, confirm: p.confirm });
  assert.equal(r.error, 'Sellers here post a bond, and only a newer version of this app can receive it. Update the app to buy.');
});
