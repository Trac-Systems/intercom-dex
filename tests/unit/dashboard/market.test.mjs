import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBook, ownTakes } from '../../../src/dashboard/market.js';
import { availableOffer, OFFER_FRESH_SEC, VENUE_SILENT_SEC, LIVE_SEC, LIVE_SEC_FAST } from '../../../src/market/book.js';
import { amount, decimalAmount } from '../../../src/dashboard/format.js';
import { PAIRS } from '../core/helpers.mjs';

const pair = PAIRS[1], now = 1000, dexKey = 'a'.repeat(64);
const offer = (id, price, side = 'sell', units = '100000000', firstSeen = 900) => ({ firstSeen, lastSeen: 950,
  offer: { pair: pair.pair, offerId: id.toString(16).padStart(64, '0'), maker: { dexKey: 'b'.repeat(64) },
    registryVersion: 1, price, side, baseAmount: units, expiresAt: 5000 } });
const build = (offers, extra = {}) => buildBook({ pair, offers, dexKey, now, ...extra });
const snapshot = (levels, remaining, ts = now) => ({ pair: pair.pair, registryVersion: 1, ts, levels, ...(remaining ? { remaining } : {}) });

test('equal numeric prices merge, sides sort best first, exact cumulative totals and oldest take', () => {
  const rows = [offer(1, '2'), offer(2, '1.00', 'sell', '200000000', 890), offer(3, '1', 'sell', '300000000'),
    offer(4, '0.5', 'buy'), offer(5, '0.8', 'buy', '200000000')];
  const book = build(rows);
  assert.deepEqual(book.asks.map(l => [l.price, l.amount.text, l.total.text, l.count]), [['1', '5', '5', 2], ['2', '1', '6', 1]]);
  assert.deepEqual(book.bids.map(l => [l.price, l.amount.text, l.total.text]), [['0.8', '2', '2'], ['0.5', '1', '3']]);
  assert.deepEqual(book.asks[0].take, { offerId: rows[1].offer.offerId, amount: amount('200000000', 'RESET') });
  assert.deepEqual(book.spread, { price: '0.2', pct: '25' });
  assert.equal(book.base, 'RESET'); assert.equal(book.at, now);
  assert.deepEqual(build([offer(8, '1', 'buy'), offer(9, '0.9')]).spread, { price: '-0.1', pct: '-10' });
});

test('mine uses unreserved remainder, is included once, and is never a take candidate', () => {
  const mine = { ...offer(1, '1').offer, maker: { dexKey }, available: '200000000' };
  const theirs = offer(2, '1');
  const book = build([{ ...offer(1, '1'), offer: mine }, theirs], { mine: [mine] });
  assert.deepEqual([book.asks[0].amount.text, book.asks[0].mine.text, book.asks[0].count], ['3', '2', 2]);
  assert.equal(book.asks[0].take.offerId, theirs.offer.offerId);
  const onlyMine = build([], { mine: [mine] });
  assert.equal(onlyMine.asks[0].take, null); assert.equal(onlyMine.spread, null);
  assert.deepEqual(build([], { mine: [{ ...mine, available: '0' }] }).asks, []);
  assert.deepEqual(build([], { mine: [{ ...mine, expiresAt: now }] }).asks, []);
});

test('quiet, expired and zero remainder offers are excluded at the same boundary as the venue', () => {
  assert.equal(OFFER_FRESH_SEC, 300);
  const stale = { ...offer(1, '1'), lastSeen: now - LIVE_SEC - 1 };
  const expired = offer(2, '2'); expired.offer.expiresAt = now;
  const fresh = { ...offer(3, '3'), lastSeen: now - LIVE_SEC };
  assert.deepEqual(build([stale, expired, fresh]).asks.map(l => l.price), ['3']);
  assert.deepEqual(build([{ ...fresh, lastSeen: undefined }]).asks, []);
  const book = snapshot([], [{ offerId: fresh.offer.offerId, amount: '0' }]);
  assert.deepEqual(build([fresh], { book }).asks, []);
  assert.deepEqual(build([]), { pair: pair.pair, base: 'RESET', at: now, asks: [], bids: [], spread: null });
});

test('full inventory supplies remaining size, removes missing offers, and predates a new announcement', () => {
  const a = offer(1, '1'), b = offer(2, '2'), c = offer(3, '3', 'sell', '100000000', now + 1);
  const book = snapshot([{ side: 'sell', price: '1', baseAmount: '40000000', offers: 1 }], [{ offerId: a.offer.offerId, amount: '40000000' }]);
  const out = build([a, b, c], { book });
  assert.deepEqual(out.asks.map(l => [l.price, l.amount.units]), [['1', '40000000'], ['3', '100000000']]);
  assert.equal(out.asks[0].take.amount.units, '40000000');
  assert.equal(a.offer.baseAmount, '100000000', 'signed input is never rewritten');
});

test('deltas retain last full inventory, cap an offer and its level, and remove disappeared levels', () => {
  const a = offer(1, '1'), b = offer(2, '1');
  const inventory = snapshot([], [a, b].map(s => ({ offerId: s.offer.offerId, amount: '80000000' })), 950);
  const book = snapshot([{ side: 'sell', price: '1.00', baseAmount: '50000000', offers: 1 }]);
  const out = build([a, b], { book, inventory });
  assert.equal(out.asks[0].amount.units, '50000000'); assert.equal(out.asks[0].take.amount.units, '50000000');
  assert.equal(availableOffer(a, book, inventory, now).baseAmount, '50000000');
  assert.deepEqual(build([a, b], { book: snapshot([]), inventory }).asks, []);
});

test('current books size old and new registry offers by id and remove missing or expired offers', () => {
  const old = offer(1, '1'), fresh = offer(2, '2'), removed = offer(3, '3'), expired = offer(4, '4');
  for (const s of [old, removed, expired]) s.offer.registryVersion = 10;
  fresh.offer.registryVersion = 11; expired.offer.expiresAt = now;
  const inventory = { ...snapshot([
    { side: 'sell', price: '1', baseAmount: '40000000', offers: 1 },
    { side: 'sell', price: '2', baseAmount: '60000000', offers: 1 },
  ], [{ offerId: old.offer.offerId, amount: '40000000' }, { offerId: fresh.offer.offerId, amount: '60000000' }]), registryVersion: 11 };
  const rows = [old, fresh, removed, expired], out = build(rows, { book: inventory });
  assert.deepEqual(out.asks.map(l => [l.price, l.amount.units, l.take.offerId]), [
    ['1', '40000000', old.offer.offerId], ['2', '60000000', fresh.offer.offerId],
  ]);
  assert.equal(availableOffer(old, inventory, inventory, now).registryVersion, 10);
  const delta = { ...inventory, ts: now + 1, levels: [{ side: 'sell', price: '1', baseAmount: '20000000', offers: 1 }] };
  delete delta.remaining;
  assert.equal(build(rows, { book: delta, inventory }).asks[0].take.amount.units, '20000000');
  assert.deepEqual(build(rows, { book: { ...delta, levels: [] }, inventory }).asks, []);
  assert.deepEqual(build(rows, { book: { ...inventory, remaining: [] } }).asks, []);
  assert.deepEqual(build(rows, { pair: { ...pair, status: 'paused' }, book: inventory, mine: [{ ...old.offer, available: '100000000' }] }).asks, []);
  assert.equal(old.offer.baseAmount, '100000000', 'signed offer remains unchanged');
});

test("another maker's offer shows only after a venue book heard after it, unless the venue went silent", () => {
  // Seen at 990; the venue's last book arrived at 980 and does not list it yet (an unfunded maker's offer never gets listed).
  const fresh = offer(1, '1', 'buy', '100000000', 990);
  assert.deepEqual(build([fresh], { heardAt: 980 }).bids, []);
  assert.equal(availableOffer(fresh, null, null, now, 980), null);
  // A venue book heard at or after the offer decides as before; without any venue book the offer shows.
  assert.equal(build([fresh], { heardAt: 995 }).bids[0].price, '1');
  assert.equal(build([fresh]).bids[0].price, '1');
  // A venue silent for VENUE_SILENT_SEC no longer holds offers back.
  assert.equal(build([fresh], { heardAt: now - VENUE_SILENT_SEC }).bids[0].price, '1');
});

test('wire depth caps do not erase deep offers or truncate the dashboard at 50 levels', () => {
  const offers = Array.from({ length: 240 }, (_, i) => offer(i + 1, String(i + 1)));
  const levels = offers.slice(0, 50).map(s => ({ side: 'sell', price: s.offer.price, baseAmount: s.offer.baseAmount, offers: 1 }));
  const book = snapshot(levels, offers.slice(0, 200).map(s => ({ offerId: s.offer.offerId, amount: s.offer.baseAmount })));
  assert.equal(build(offers, { book }).asks.length, 240);
  assert.equal(build(offers, { book }).asks.at(-1).total.text, '240');
  const gone = offer(999, '1.5');
  assert.equal(availableOffer(gone, book, book, now), null, 'absence within the published best 50 is conclusive');
});

test('decimal feed amounts convert exactly to base units and reject malformed and overprecision values', () => {
  assert.deepEqual(decimalAmount('1.000001', 'USDC'), amount('1000001', 'USDC'));
  assert.deepEqual(decimalAmount('0.000000000000000001', 'TNK'), amount('1', 'TNK'));
  assert.deepEqual(decimalAmount('0', 'RESET'), amount('0', 'RESET'));
  for (const v of [1, null, '', '01', '-1', '1e3', '1.', '.1', '1\n', '1\r', '0.0000001', '1 '.repeat(200)]) assert.throws(() => decimalAmount(v, 'USDC'), /Invalid decimal/);
  assert.throws(() => decimalAmount('1', 'UNKNOWN'), /Invalid decimal/);
});

test('own takes: a called-off take skips that offer at once, running takes count against it', () => {
  const a = offer(1, '1', 'sell', '100000000', 880), b = offer(2, '1', 'sell', '300000000', 890), c = offer(3, '1', 'sell', '200000000', 900);
  const take = (o, phase, extra = {}) => ({ state: { mode: 'taker', offerId: o.offer.offerId, phase, draft: { baseAmount: '50000000' }, ...extra } });
  assert.equal(build([a, b, c]).asks[0].take.offerId, a.offer.offerId);
  // The maker did not answer: the next offer at the same price is the take, the level shrinks by the skipped offer.
  let taken = ownTakes([take(a, 'aborted', { reason: 'Timed out: take/accept' })]);
  let level = build([a, b, c], { taken }).asks[0];
  assert.deepEqual([level.take.offerId, level.amount.text, level.count], [b.offer.offerId, '5', 2]);
  // Declines are skipped too; signer trouble is not the maker's and keeps the offer.
  taken = ownTakes([take(a, 'aborted', { reason: 'busy' }), take(b, 'aborted', { reason: 'Signers did not confirm' })]);
  assert.equal(build([a, b, c], { taken }).asks[0].take.offerId, b.offer.offerId);
  // Called off after the lock started: not a maker no-show, nothing skipped.
  taken = ownTakes([take(a, 'aborted', { reason: 'Escrow lock failed', lockAttempted: true })]);
  assert.equal(build([a, b, c], { taken }).asks[0].take.offerId, a.offer.offerId);
  // A running own take holds part of its offer; a fully held offer passes the take to the next one.
  taken = ownTakes([take(b, 'awaitAccept'), take(a, 'locked', { terms: { baseAmount: '100000000' } }), take(c, 'complete')]);
  level = build([a, b, c], { taken }).asks[0];
  assert.deepEqual([level.take.offerId, level.take.amount.text, level.amount.text, level.count], [b.offer.offerId, '2.5', '4.5', 2]);
  // Maker-side trades and other modes are ignored.
  assert.deepEqual(ownTakes([{ state: { mode: 'maker', offerId: a.offer.offerId, phase: 'aborted', reason: 'busy' } }]).skip.size, 0);
});

test('an offer whose maker went quiet is not shown: 70 s for makers on 0.1.14+, 150 s for older ones', () => {
  const old = { ...offer(21, '1', 'sell', '100000000', 600), lastSeen: now - 100 };
  old.offer.software = '0.1.13';
  const fast = { ...offer(22, '2', 'sell', '100000000', 500), lastSeen: now - 100 };
  fast.offer.software = '0.1.14';
  assert.deepEqual(build([fast, old]).asks.map(l => l.price), ['1']);
  assert.deepEqual(build([{ ...fast, lastSeen: now - LIVE_SEC_FAST }, old]).asks.map(l => l.price), ['1', '2']);
  assert.deepEqual(build([fast, { ...old, lastSeen: now - LIVE_SEC - 1 }]).asks, []);
});

test("another maker's rest below the pair's smallest trade is not shown", () => {
  const dust = offer(1, '1', 'sell', '1'), real = offer(2, '2', 'sell', '100000000');
  const strict = { ...pair, minBaseAmount: '100' };
  assert.deepEqual(buildBook({ pair: strict, offers: [dust, real], dexKey, now }).asks.map(l => l.price), ['2']);
});
