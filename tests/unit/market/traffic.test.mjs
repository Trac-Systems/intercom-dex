import test from 'node:test';
import assert from 'node:assert/strict';
import { OfferBook } from '../../../src/market/book.js';
import { BookFeed, BookView, priceLevels } from '../../../src/market/book-feed.js';

const offer = (i, patch = {}) => ({ offerId: i.toString(16).padStart(64, '0'), maker: { dexKey: 'a'.repeat(64) },
  pair: 'TNK/USDC', registryVersion: 1, software: '0.1.0', side: 'sell', baseAmount: '100', price: '1', expiresAt: 10000, ...patch });

test('book freshness, reannouncement, cancellation and fills preserve remaining inventory', () => {
  const b = new OfferBook(), o = offer(1);
  b.add(o, 0); b.fill(o.offerId, '40'); b.add(o, 120);
  assert.equal(b.get(o.offerId, 419).remaining, 60n);
  assert.equal(b.get(o.offerId, 420), null); assert.deepEqual(b.snapshot(o.pair, 420), []);
  b.add(o, 421); assert.equal(b.get(o.offerId, 421).remaining, 100n); // service reapplies its durable fill
  assert.equal(b.cancel(o.offerId, 'stranger'), false);
  assert.equal(b.cancel(o.offerId, o.maker.dexKey), true);
  assert.equal(b.add(o, 422), false, 'cancelled offers cannot be resurrected by a late copy');
  assert.equal(b.add({ ...o, expiresAt: 422 }, 422), false);
});

test('book shows the oldest twenty offers per maker across pairs; overflow becomes visible when a slot opens', () => {
  const b = new OfferBook();
  for (let i = 1; i <= 25; i++) b.add(offer(i, { pair: i % 2 ? 'TNK/USDC' : 'RESET/USDC' }), i);
  const both = () => ['TNK/USDC', 'RESET/USDC'].flatMap(p => b.snapshot(p, 30));
  assert.equal(both().length, 20); assert.ok(!both().some(o => o.offerId === offer(21).offerId));
  b.cancel(offer(1).offerId, offer(1).maker.dexKey);
  assert.ok(both().some(o => o.offerId === offer(21).offerId));
});

test('levels aggregate equal numeric prices and cap each side at the best fifty', () => {
  const offers = Array.from({ length: 120 }, (_, i) => offer(i, { price: String(i + 1), side: i % 2 ? 'buy' : 'sell' }));
  offers.push(offer(121, { price: '1.000' }));
  const levels = priceLevels(offers);
  assert.equal(levels.length, 100); assert.equal(levels[0].baseAmount, '200'); assert.equal(levels[0].offers, 2);
  assert.equal(levels[49].price, '99'); assert.equal(levels[50].price, '120'); assert.equal(levels[99].price, '22');
});

test('full snapshots every sixty seconds, changed-only cumulative deltas, gaps and stale messages', () => {
  const feed = new BookFeed(), view = new BookView(); let seq = 0;
  const next = (offers, now) => feed.next('TNK/USDC', 1, offers, now, () => ++seq);
  const a = offer(1), b = offer(2, { price: '2' });
  const full = next([a], 100); view.full(full.body);
  assert.equal(next([a], 105), null);
  const missed = next([a, b], 110); assert.equal(missed.kind, 'bookDelta');
  const later = next([b], 115); assert.equal(view.delta(later.body, 115), true);
  assert.deepEqual(view.books.get(a.pair).levels, priceLevels([b]));
  assert.equal(view.delta(missed.body, 110), false);
  assert.equal(view.delta({ ...later.body, seq: 2 }, 120), false);
  const empty = new BookView(); assert.equal(empty.delta(later.body, 115), false);
  assert.equal(next([b], 159), null);
  const repair = next([b], 160); assert.equal(repair.kind, 'book'); view.full(repair.body);
  assert.equal(view.full(full.body), false); assert.equal(view.delta(later.body, 165), false);
  assert.throws(() => view.full({ ...full.body, unexpected: 1 }));
  assert.throws(() => view.delta({ ...later.body, upserts: [{ side: 'sell', price: 'bad', baseAmount: '1', offers: 1 }] }, 170));
  assert.equal(feed.next(a.pair, 2, [a], 161, () => ++seq).kind, 'book');
});

test('full books carry at most 200 remaining amounts; inventory-only changes wait for a full snapshot', () => {
  const feed = new BookFeed(); let seq = 0;
  const offers = Array.from({ length: 500 }, (_, i) => offer(i));
  const full = feed.next('TNK/USDC', 1, offers, 100, () => ++seq);
  assert.deepEqual(full.body.remaining, offers.slice(0, 200).map(o => ({ offerId: o.offerId, amount: '100' })));
  assert.equal(Object.hasOwn(full.body, 'offers'), false);
  const changed = offers.map((o, i) => ({ ...o, baseAmount: i === 0 ? '90' : i === 1 ? '110' : '100' }));
  assert.equal(feed.next('TNK/USDC', 1, changed, 105, () => ++seq), null);
  const repair = feed.next('TNK/USDC', 1, changed, 160, () => ++seq);
  assert.deepEqual(repair.body.remaining.slice(0, 2), [{ offerId: offers[0].offerId, amount: '90' }, { offerId: offers[1].offerId, amount: '110' }]);
  const delta = feed.next('TNK/USDC', 1, [], 165, () => ++seq);
  assert.deepEqual(Object.keys(delta.body).sort(), ['pair', 'removes', 'seq', 'upserts']);
});
