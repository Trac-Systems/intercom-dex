import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../../../src/roles/store.js';
import { MarketView } from '../../../src/market-feed/view.js';
import { parseBody } from '../../../src/core/schemas.js';
import { sha256Hex, stableJSON } from '../../../src/core/canonical.js';
import { BookFeed, BookView } from '../../../src/market/book-feed.js';
import { setup, memoryStore } from './helpers.mjs';

const pair = s => s.view().pairs.find(p => p.pair === 'RESET/USDC');
const book = (s, remaining, ts = s.clock.t, seq = 1) => ({ pair: 'RESET/USDC', registryVersion: 1, ts, seq,
  levels: [{ side: 'sell', price: '0.43', baseAmount: '1', offers: 1 }, { side: 'sell', price: '0.42', baseAmount: '1', offers: 1 },
    { side: 'buy', price: '0.40', baseAmount: '1', offers: 1 }, { side: 'buy', price: '0.41', baseAmount: '1', offers: 1 }],
  ...(remaining === undefined ? {} : { remaining }) });

test('whole-unit view matches the game contract, with exact decimals and unknown fields', async () => {
  const s = setup(); await s.register();
  assert.deepEqual(s.view(), { v: 1, ts: s.clock.t, pairs: s.f.registry.pairs.map(p => ({ pair: p.pair, base: p.base.id,
    last: null, change24h: null, volume24h: null, bestBuy: null, bestSell: null, trades24h: null })), offers: [], trades: [] });
  const offer = s.offer();
  await s.send('offer', offer, s.f.seller, 'intercom-dex:offers');
  assert.equal(s.view().offers[0].left, null);
  await s.send('book', book(s, [{ offerId: offer.offerId, amount: '320000000000' }]));
  const trade = s.trade(); await s.send('tradeLog', trade);
  assert.deepEqual(s.view().offers[0], { offerId: offer.offerId, pair: offer.pair, side: 'sell', price: '0.42', amount: '5000', left: '3200',
    maker: { trac: offer.maker.tracAddr, sol: offer.maker.solAddr }, postedAt: s.clock.t });
  assert.deepEqual(s.view().trades[0], { id: trade.tradeId, pair: trade.pair, price: '0.42', amount: '1200', usdc: '504',
    seller: { trac: trade.seller.tracAddr, sol: trade.seller.solAddr }, buyer: { trac: trade.buyer.tracAddr, sol: trade.buyer.solAddr }, settledAt: s.clock.t });
  assert.deepEqual(pair(s), { pair: 'RESET/USDC', base: 'RESET', last: '0.42', change24h: '0', volume24h: '504', bestBuy: '0.41', bestSell: '0.42', trades24h: 1 });
  const tiny = s.offer({ pair: 'TNK/USDC', baseAmount: '1000000000000000001' });
  await s.send('offer', tiny, s.f.seller, 'intercom-dex:offers');
  assert.equal(s.view().offers.find(o => o.pair === 'TNK/USDC').amount, '1.000000000000000001');
  const cache = s.feed.view(); s.clock.t++;
  assert.equal(s.feed.view(), cache); assert.equal(s.view().ts, s.clock.t - 1);
});

test('postedAt survives disk restart and reannouncement; cancellation and expiry stay closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-view-')), key = randomBytes(32), store = openStore(dir, key), s = setup({ store });
  await s.register(); const offer = s.offer(); await s.send('offer', offer, s.f.seller, 'intercom-dex:offers');
  const postedAt = s.view().offers[0].postedAt; s.clock.t += 30;
  const restarted = setup({ store: openStore(dir, key), clock: s.clock, f: s.f });
  await restarted.send('offer', offer, s.f.seller, 'intercom-dex:offers');
  assert.equal(restarted.view().offers[0].postedAt, postedAt);
  assert.equal(await restarted.send('cancel', { offerId: offer.offerId }, s.f.buyer, 'intercom-dex:offers'), false);
  assert.equal(await restarted.send('cancel', { offerId: offer.offerId }, s.f.seller, 'intercom-dex:offers'), true);
  const again = setup({ store, clock: s.clock, f: s.f });
  assert.equal(await again.send('offer', offer, s.f.seller, 'intercom-dex:offers'), false);
  const fresh = again.offer({ expiresAt: s.clock.t + 5 });
  await again.send('offer', fresh, s.f.seller, 'intercom-dex:offers'); s.clock.t += 5;
  assert.deepEqual(again.view().offers, []);
});

test('view bounds, newest ordering, exact 24-hour window and persisted history exceed the 100-row view', async () => {
  const s = setup(); await s.register();
  for (let i = 0; i < 205; i++) { s.clock.t++; const o = s.offer(); s.feed.market.offer(o, o.maker.dexKey); }
  const offers = s.view().offers; assert.ok(offers.length > 0 && offers.length < 200);
  assert.ok(offers.every((o, i) => !i || o.postedAt <= offers[i - 1].postedAt));
  const now = s.clock.t;
  for (let i = 0; i < 120; i++) s.feed.market.trade(s.trade({ ts: now - 120 + i, price: i ? '1' : '2', quoteAmount: '1000001' }));
  s.feed.market.trade(s.trade({ ts: now - 86400, price: '100', quoteAmount: '999999999' }));
  assert.equal(s.view().trades.length, 100);
  assert.equal(pair(s).change24h, '-0.5'); assert.equal(pair(s).volume24h, '120.00012'); assert.equal(pair(s).trades24h, 120);
  const restarted = setup({ store: s.store, clock: s.clock, f: s.f });
  assert.deepEqual(restarted.view().trades, s.view().trades); assert.deepEqual(pair(restarted), pair(s));
  s.clock.t = now + 86400;
  assert.equal(pair(s).change24h, null); assert.equal(pair(s).trades24h, 0); assert.equal(pair(s).volume24h, '0');
  assert.equal(s.store.list('feed-trade-').length, 100);
});

test('history and first-seen storage are bounded; truncated change is unknown', async () => {
  const s = setup(); await s.register();
  const rows = Array.from({ length: 10001 }, (_, i) => s.trade({ ts: s.clock.t - 10001 + i }));
  const seen = Array.from({ length: 10000 }, (_, i) => [i.toString(16).padStart(64, '0'), { postedAt: 1, expiresAt: s.clock.t + 30, filled: '0', closed: false }]);
  const store = memoryStore(Object.fromEntries([...rows.map(t => ['feed-trade-' + t.tradeId, t]), ...seen.map(([id, row]) => ['feed-seen-' + id, row])]));
  const view = new MarketView({ store, now: () => s.clock.t });
  assert.equal(store.list('feed-trade-').length, 10000);
  assert.equal(JSON.parse(view.snapshot(s.f.registry).json).pairs[1].change24h, null);
  const offer = s.offer(); assert.equal(view.offer(offer, offer.maker.dexKey), false);
  assert.equal(store.list('feed-seen-').length, 10000);
});

test('venue ticker is preferred only when it agrees; missing first history leaves change unknown', async () => {
  const s = setup(); await s.register(); const t = s.trade(); await s.send('tradeLog', t);
  const tick = { pair: t.pair, registryVersion: 1, ts: s.clock.t, last: '0.42', high24h: '1', low24h: '0.1', volume24h: '1000000000', trades24h: 3 };
  await s.send('ticker', tick); assert.equal(pair(s).volume24h, '1000'); assert.equal(pair(s).trades24h, 3); assert.equal(pair(s).change24h, null);
  s.clock.t++; await s.send('ticker', { ...tick, ts: s.clock.t, last: '9' });
  assert.equal(pair(s).last, t.price); assert.equal(pair(s).volume24h, '504');
  s.clock.t += 300; assert.equal(pair(s).bestSell, null);
});

test('full books supply only remaining amounts; announcements supply bodies and deltas change only levels', async () => {
  const s = setup(); await s.register(); const offer = s.offer();
  const feed = new BookFeed(), view = new BookView(); let seq = 0;
  const next = remaining => feed.next(offer.pair, 1, [{ ...offer, baseAmount: remaining }], s.clock.t, () => ++seq);
  const full = next(offer.baseAmount); assert.ok(view.full(full.body));
  assert.ok(await s.send(full.kind, full.body)); assert.deepEqual(s.view().offers, []);
  await s.send('offer', offer, s.f.seller, 'intercom-dex:offers');
  assert.equal(s.view().offers[0].amount, '5000'); assert.equal(s.view().offers[0].left, '5000');
  s.clock.t++; const missed = next('400000000000'); assert.equal(missed.kind, 'bookDelta');
  s.clock.t++; const delta = next('320000000000');
  assert.ok(view.delta(delta.body, s.clock.t)); assert.ok(await s.send(delta.kind, delta.body));
  assert.equal(Object.hasOwn(view.books.get(offer.pair), 'remaining'), false);
  assert.equal(s.view().offers[0].left, '5000'); assert.equal(s.view().offers[0].amount, '5000');
  s.clock.t += 60; const repair = next('320000000000');
  assert.ok(await s.send(repair.kind, repair.body)); assert.equal(s.view().offers[0].left, '3200');
  s.clock.t++; const empty = feed.next(offer.pair, 1, [], s.clock.t, () => ++seq);
  await s.send(empty.kind, empty.body); assert.equal(s.view().offers.length, 1);
  s.clock.t += 60; const closed = feed.next(offer.pair, 1, [], s.clock.t, () => ++seq);
  await s.send(closed.kind, closed.body); assert.equal(s.view().offers.length, 0);
  assert.equal(await s.send('offer', offer, s.f.seller, 'intercom-dex:offers'), false);
});

test('tradeLog schema strictly requires price and both public parties', () => {
  const s = setup(), t = s.trade(); assert.deepEqual(parseBody('tradeLog', t), t);
  for (const field of ['price', 'seller', 'buyer']) { const bad = { ...t }; delete bad[field]; assert.throws(() => parseBody('tradeLog', bad)); }
  for (const bad of [{ ...t, price: 0.42 }, { ...t, price: '1e-3' }, { ...t, seller: { ...t.seller, dexKey: 'a'.repeat(64) } },
    { ...t, buyer: { tracAddr: 'bad', solAddr: t.buyer.solAddr } }, { ...t, extra: 1 }]) assert.throws(() => parseBody('tradeLog', bad));
});

test('logged terms associate chat identities without estimating remaining inventory', async () => {
  const s = setup(); await s.register(); const o = s.offer();
  s.feed.market.offer(o, o.maker.dexKey);
  const terms = { ...s.f.terms, offerId: o.offerId, baseAmount: '120000000000', quoteAmount: '504000000' };
  const t = s.trade({ termsHash: sha256Hex(stableJSON(terms)) });
  const report = { tradeId: t.tradeId, offerId: o.offerId, terms, hashHex: t.tracTxHash, txHash: t.tracTxHash };
  s.feed.market.settlement(report); assert.equal(s.feed.market.address(terms.buyer.dexKey), terms.buyer.dexKey);
  s.feed.market.trade(t); assert.equal(s.feed.market.address(terms.buyer.dexKey), terms.buyer.tracAddr);
  assert.equal(s.view().offers[0].left, null); assert.equal(s.feed.market.trade(t), false);
  assert.equal(s.feed.market.settlement(report), false); assert.equal(s.view().offers[0].left, null);
  const restored = setup({ store: s.store, clock: s.clock, f: s.f });
  assert.equal(restored.feed.market.address(terms.buyer.dexKey), terms.buyer.tracAddr);
  s.clock.t += 1; await restored.send('offer', o, s.f.seller, 'intercom-dex:offers');
  assert.equal(restored.view().offers[0].left, null);
  assert.throws(() => s.feed.market.offer({}, o.maker.dexKey));
  assert.throws(() => s.feed.market.book({})); assert.throws(() => s.feed.market.ticker({}));
  assert.throws(() => s.feed.market.trade({})); assert.throws(() => s.feed.market.settlement({})); assert.throws(() => s.feed.market.cancel({}, 'bad'));
});

test('latest full inventory survives restart; delayed books and reannouncements cannot replace it', async () => {
  const s = setup(); await s.register(); const o = s.offer();
  await s.send('offer', o, s.f.seller, 'intercom-dex:offers');
  const first = book(s, [{ offerId: o.offerId, amount: '500000000000' }]);
  await s.send('book', first);
  s.clock.t++;
  await s.send('book', book(s, [{ offerId: o.offerId, amount: '320000000000' }], s.clock.t, 2));
  assert.equal(await s.send('book', first), false);
  assert.equal(s.view().offers[0].left, '3200');
  const restored = setup({ store: s.store, clock: s.clock, f: s.f });
  assert.equal(await restored.send('book', first), false);
  await restored.send('offer', o, s.f.seller, 'intercom-dex:offers'); assert.equal(restored.view().offers[0].left, '3200');
});

test('terms arriving after a log map both parties and leave unknown inventory null', async () => {
  const s = setup(); await s.register(); const o = s.offer(); s.feed.market.offer(o, o.maker.dexKey);
  const terms = { ...s.f.terms, offerId: o.offerId, baseAmount: '120000000000', quoteAmount: '600000000' };
  const t = s.trade({ quoteAmount: terms.quoteAmount, termsHash: sha256Hex(stableJSON(terms)) });
  s.feed.market.trade(t);
  s.feed.market.settlement({ tradeId: t.tradeId, offerId: o.offerId, terms, hashHex: t.tracTxHash, txHash: t.tracTxHash });
  assert.equal(s.view().offers[0].left, null);
  assert.equal(s.feed.market.address(terms.buyer.dexKey), terms.buyer.tracAddr);
  const late = setup(); await late.register(); const lateOffer = late.offer();
  const matching = { ...late.f.terms, offerId: lateOffer.offerId, baseAmount: '120000000000', quoteAmount: '504000000' };
  const log = late.trade({ termsHash: sha256Hex(stableJSON(matching)) });
  late.feed.market.trade(log);
  late.feed.market.settlement({ tradeId: log.tradeId, offerId: lateOffer.offerId, terms: matching, hashHex: log.tracTxHash, txHash: log.tracTxHash });
  const restarted = setup({ store: late.store, clock: late.clock, f: late.f });
  restarted.feed.market.offer(lateOffer, lateOffer.maker.dexKey);
  assert.equal(restarted.view().offers[0].left, null);
});

test('settlements leave inventory at the latest full book until the next full snapshot', async () => {
  const s = setup(); await s.register(); const o = s.offer();
  await s.send('offer', o, s.f.seller, 'intercom-dex:offers');
  await s.send('book', book(s, [{ offerId: o.offerId, amount: '320000000000' }])); s.clock.t++;
  const terms = { ...s.f.terms, offerId: o.offerId, baseAmount: '120000000000', quoteAmount: '504000000' };
  const t = s.trade({ termsHash: sha256Hex(stableJSON(terms)) });
  s.feed.market.settlement({ tradeId: t.tradeId, offerId: o.offerId, terms, hashHex: t.tracTxHash, txHash: t.tracTxHash });
  s.feed.market.trade(t); assert.equal(s.view().offers[0].left, '3200');
  await s.send('book', book(s, [{ offerId: o.offerId, amount: '200000000000' }], s.clock.t, 2));
  assert.equal(s.view().offers[0].left, '2000');
});

test('pending settlement mappings survive a restart before the venue trade log', async () => {
  const s = setup(); await s.register(); const terms = s.f.terms;
  const t = s.trade({ pair: terms.pair, baseAmount: terms.baseAmount, quoteAmount: terms.quoteAmount, termsHash: sha256Hex(stableJSON(terms)) });
  s.feed.market.settlement({ tradeId: t.tradeId, offerId: terms.offerId, terms, hashHex: t.tracTxHash, txHash: t.tracTxHash });
  const restored = setup({ store: s.store, clock: s.clock, f: s.f }); restored.feed.market.trade(t);
  assert.equal(restored.feed.market.address(terms.buyer.dexKey), terms.buyer.tracAddr);
  assert.deepEqual(s.store.list('feed-terms-'), []);
});

test('optional inventory is pair-specific, does not age newer offers out, and removes absent offers across restart', async () => {
  const s = setup(); await s.register();
  const o = s.offer(), other = s.offer({ pair: 'TNK/USDC' });
  for (const offer of [o, other]) await s.send('offer', offer, s.f.seller, 'intercom-dex:offers');
  assert.ok(await s.send('book', book(s)));
  assert.ok(s.view().offers.every(o => o.left === null));
  s.clock.t++;
  const snapshotAt = s.clock.t;
  s.clock.t++;
  const later = s.offer(); await s.send('offer', later, s.f.seller, 'intercom-dex:offers');
  assert.ok(await s.send('book', book(s, [], snapshotAt, 2)));
  assert.deepEqual(new Set(s.view().offers.map(o => o.offerId)), new Set([other.offerId, later.offerId]));
  assert.ok(s.view().offers.every(o => o.left === null));
  const restarted = setup({ store: s.store, clock: s.clock, f: s.f });
  assert.equal(await restarted.send('offer', o, s.f.seller, 'intercom-dex:offers'), false);
  assert.ok(await restarted.send('offer', later, s.f.seller, 'intercom-dex:offers'));
  assert.equal(restarted.view().offers[0].left, null);
  s.clock.t++;
  assert.ok(await restarted.send('book', book(s, [{ offerId: later.offerId, amount: '0' }], s.clock.t, 3)));
  assert.deepEqual(restarted.view().offers, []);
});

test('a full book received before the announcement persists inventory but cannot supply offer bodies', async () => {
  const s = setup(); await s.register(); const o = s.offer();
  assert.ok(await s.send('book', book(s, [{ offerId: o.offerId, amount: '123456789012' }])));
  assert.deepEqual(s.view().offers, []);
  const restarted = setup({ store: s.store, clock: s.clock, f: s.f });
  assert.ok(await restarted.send('offer', o, s.f.seller, 'intercom-dex:offers'));
  assert.equal(restarted.view().offers[0].left, '1234.56789012');
  s.clock.t += 300;
  assert.deepEqual(restarted.view().offers, [], 'full books do not refresh maker announcements');
});

test('accepted messages write only their own records; reannouncements write nothing', async () => {
  const s = setup(); await s.register();
  const writes = [], put = s.store.put;
  s.store.put = (key, value) => { writes.push(key); return put(key, value); };
  const offer = s.offer();
  assert.ok(await s.send('offer', offer, s.f.seller, 'intercom-dex:offers'));
  assert.deepEqual(writes, [`feed-seen-${offer.offerId}`]);
  writes.length = 0; s.clock.t += 120;
  assert.ok(await s.send('offer', offer, s.f.seller, 'intercom-dex:offers'));
  assert.deepEqual(writes, []);
  const trade = s.trade(); await s.send('tradeLog', trade);
  assert.deepEqual(writes, [`feed-trade-${trade.tradeId}`]);
  writes.length = 0;
  assert.ok(await s.send('book', book(s, [{ offerId: offer.offerId, amount: '1' }])));
  assert.deepEqual(writes, [`feed-inventory-${Buffer.from('RESET/USDC').toString('hex')}`]);
  const restarted = setup({ store: s.store, clock: s.clock, f: s.f });
  assert.deepEqual(restarted.feed.market.inventory.get('RESET/USDC').remaining, [{ offerId: offer.offerId, amount: '1' }]);
  assert.equal(restarted.feed.market.trades.has(trade.tradeId), true);
});
