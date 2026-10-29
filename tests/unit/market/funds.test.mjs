import test from 'node:test';
import assert from 'node:assert/strict';
import { MakerFunds } from '../../../src/market/funds.js';

const TNK = { pair: 'TNK/USDC', base: { kind: 'trac-native', id: 'TNK', decimals: 18 }, minBaseAmount: '10000000000000000', status: 'open' };
const RESET = { pair: 'RESET/USDC', base: { kind: 'trac-contract-token', id: 'RESET', decimals: 8 }, minBaseAmount: '10000', status: 'open' };
const FEE = '30000000000000000';
const offer = (side, n) => ({ side, price: '5', maker: { tracAddr: `trac${n}`, solAddr: `sol${n}` } });

function setup() {
  const clock = { t: 1000 }, wallets = new Map(), reads = [];
  const solana = { walletBalances: async a => { reads.push(a); if (!wallets.has(a)) throw new Error('rpc down'); return wallets.get(a); } };
  const trac = { balances: async a => { reads.push(a); if (!wallets.has(a)) throw new Error('peer busy'); return wallets.get(a); } };
  const funds = new MakerFunds({ solana, trac, now: () => clock.t, readsAtOnce: 2 });
  const settle = () => new Promise(r => setImmediate(r));
  return { clock, wallets, reads, funds, settle };
}

test('a maker without the smallest trade is left out once read; unread or unreadable wallets keep the offer', async () => {
  const { wallets, funds, settle } = setup();
  const empty = offer('sell', 1), funded = offer('sell', 2), buyer = offer('buy', 3), poor = offer('buy', 4), unknown = offer('sell', 5);
  wallets.set('trac1', { TNK: '0', RESET: '0', feeTnk: FEE });
  wallets.set('trac2', { TNK: '40000000000000000', RESET: '0', feeTnk: FEE });
  wallets.set('sol3', { SOL: '10000000', USDC: '50000' });
  wallets.set('sol4', { SOL: '2600000', USDC: '50000000' });
  assert.equal(funds.funded(empty, TNK), true, 'not read yet');
  funds.refresh([empty, funded]); funds.refresh([buyer, poor, unknown]); await settle();
  funds.refresh([buyer, poor, unknown]); await settle();
  assert.equal(funds.funded(empty, TNK), false);
  assert.equal(funds.funded(funded, TNK), true, 'min 0.01 TNK plus the 0.03 TNK fee');
  assert.equal(funds.funded(buyer, TNK), true, '0.01 TNK at 5 USDC = 0.05 USDC, and the 0.01 SOL reserve');
  assert.equal(funds.funded(poor, TNK), false, 'USDC but less than 0.01 SOL');
  assert.equal(funds.funded(unknown, TNK), true, 'a failed read hides nothing');
});

test('RESET sellers need the RESET and the TNK fee; funds that arrive bring the offer back after the TTL', async () => {
  const { clock, wallets, funds, settle, reads } = setup();
  const seller = offer('sell', 1);
  wallets.set('trac1', { TNK: '0', RESET: '20000', feeTnk: FEE });
  funds.refresh([seller]); await settle();
  assert.equal(funds.funded(seller, RESET), false, 'RESET but no TNK for the transfer fee');
  wallets.set('trac1', { TNK: FEE, RESET: '20000', feeTnk: FEE });
  funds.refresh([seller]); await settle(); assert.equal(reads.length, 1, 'no re-read inside the TTL');
  clock.t += 300; funds.refresh([seller]); await settle();
  assert.equal(funds.funded(seller, RESET), true);
  funds.forget(new Set()); assert.equal(funds.funded(seller, RESET), true);
});

test('reads run a few at a time and a broken balance or price never throws', async () => {
  const { wallets, funds, reads, settle } = setup();
  for (let i = 0; i < 5; i++) wallets.set(`sol${i}`, { SOL: '0', USDC: '0' });
  funds.refresh([0, 1, 2, 3, 4].map(i => offer('buy', i)));
  assert.equal(reads.length, 2); await settle();
  wallets.set('trac9', { TNK: 'x', RESET: '0', feeTnk: FEE });
  funds.refresh([offer('sell', 9)]); await settle();
  assert.equal(funds.funded(offer('sell', 9), TNK), true);
  assert.equal(funds.funded({ ...offer('buy', 0), price: 'bad' }, TNK), true);
});

test('a wallet failing three reads in a row is hidden while other wallets read fine, never during an outage', async () => {
  const { clock, wallets, funds, settle } = setup();
  const broken = offer('buy', 1), fine = offer('buy', 2);
  wallets.set('sol2', { SOL: '10000000', USDC: '50000000' });
  for (let i = 0; i < 2; i++) { funds.refresh([broken, fine]); await settle(); assert.equal(funds.funded(broken, TNK), true, `after ${i + 1} failures`); clock.t += 300; }
  funds.refresh([broken, fine]); await settle();
  assert.equal(funds.funded(broken, TNK), false, 'three failures while another wallet reads fine');
  wallets.delete('sol2'); clock.t += 600; funds.refresh([broken, fine]); await settle();
  assert.equal(funds.funded(broken, TNK), true, 'every read on the chain fails: an outage hides nothing');
});

const bid = (id, pair = TNK, extra = {}) => ({ offer: { ...offer('buy', 1), offerId: id, pair: pair.pair,
  baseAmount: pair === TNK ? '2000000000000000000' : '200000000', ...extra }, pair, firstSeen: 1,
  fees: { platformFeeBps: 10, tradeFeeBps: 50 } });
const quoteCost = (p, n, price, fees) => {
  const q = BigInt(n) * BigInt(price) * 1000000n / 10n ** BigInt(p.base.decimals);
  return q + q * BigInt(fees.platformFeeBps) / 10000n + q * BigInt(fees.tradeFeeBps) / 10000n;
};

test('bids across pairs and identities share one fee-inclusive USDC budget, ordered by price then age then id', async () => {
  const { funds, wallets, settle } = setup();
  const a = bid('a'), b = bid('b', RESET, { price: '6', maker: { ...offer('buy', 1).maker, dexKey: 'another' } });
  wallets.set('sol1', { USDC: '15000000', SOL: '100000000' });
  funds.refresh([a.offer]); await settle();
  const sizes = funds.allocate([a, b]);
  assert.equal(sizes.get('b'), b.offer.baseAmount);
  const spent = quoteCost(RESET, sizes.get('b'), '6', b.fees) + quoteCost(TNK, sizes.get('a'), '5', a.fees);
  assert.ok(spent <= 15000000n);
  assert.ok(quoteCost(TNK, BigInt(sizes.get('a')) + 1n, '5', a.fees) + quoteCost(RESET, sizes.get('b'), '6', b.fees) > 15000000n);
  const older = { ...a, firstSeen: 0, offer: { ...a.offer, offerId: 'z' } };
  assert.deepEqual(funds.allocate([a, older]), funds.allocate([older, a]));
  assert.equal(funds.allocate([a, older]).get('z'), older.offer.baseAmount);
  const tie = { ...a, offer: { ...a.offer, offerId: 'b' } };
  assert.equal(funds.allocate([tie, a]).get('a'), a.offer.baseAmount);
});

test('pending purchases reserve USDC and SOL across pairs even with no remaining offer; pending base counted once', async () => {
  const { funds, wallets, settle } = setup(), a = bid('a');
  wallets.set('sol1', { USDC: '12000000', SOL: '30000000' });
  funds.refresh([a.offer]); await settle();
  const purchase = { buyer: { solPayer: 'sol1' }, quoteAmount: '5000000', fees: a.fees };
  const sizes = funds.allocate([a], new Map([['a', 1000000000000000000n]]), [purchase]);
  assert.equal(sizes.get('a'), '1000000000000000000');
  const twice = funds.allocate([a], new Map(), [purchase, purchase]);
  assert.ok(BigInt(twice.get('a')) < 1000000000000000000n);
  assert.equal(funds.allocate([a], new Map(), [purchase, purchase, purchase]).get('a'), '0');
});

test('below-minimum allocations are hidden without consuming the budget; SOL reserves bound simultaneous locks', async () => {
  const { funds, wallets, settle } = setup(), a = bid('a'), b = bid('b', RESET);
  a.pair = { ...TNK, minBaseAmount: '2000000000000000000' };
  wallets.set('sol1', { USDC: '1000000', SOL: '10000000' });
  funds.refresh([a.offer]); await settle();
  const sizes = funds.allocate([a, b]);
  assert.equal(sizes.get('a'), '0'); assert.ok(BigInt(sizes.get('b')) >= BigInt(RESET.minBaseAmount));
  const smaller = bid('c', RESET, { baseAmount: '10000' });
  assert.equal(funds.allocate([smaller, { ...smaller, offer: { ...smaller.offer, offerId: 'd' } }]).get('d'), '0');
});

test('unreadable, malformed and expired balance caches keep unsized bids with the existing pending-size deduction', async () => {
  for (const balance of [undefined, { USDC: 'broken', SOL: '10000000' }, { USDC: '1000000', SOL: '10000000' }]) {
    const { funds, wallets, settle, clock } = setup(), a = bid('a');
    if (balance) wallets.set('sol1', balance);
    funds.refresh([a.offer]); await settle();
    if (balance?.USDC === '1000000') clock.t += 600;
    assert.equal(funds.allocate([a], new Map([['a', 1n]])).get('a'), (BigInt(a.offer.baseAmount) - 1n).toString());
  }
});

test('a bid allocation change at an unchanged price level publishes fresh per-offer sizes for old traders', async () => {
  const { BookFeed, BookView } = await import('../../../src/market/book-feed.js');
  const { availableOffer } = await import('../../../src/market/book.js');
  const feed = new BookFeed(), view = new BookView(); let seq = 0;
  const a = { ...bid('aa'.repeat(32)).offer, expiresAt: 10000, software: '0.1.32', registryVersion: 1 };
  const b = { ...a, offerId: 'bb'.repeat(32) };
  const publish = (offers, now) => { const m = feed.next(TNK.pair, 1, offers, now, () => ++seq); view.full(m.body, now); return m; };
  publish([a, b], 1000);
  const m = publish([{ ...a, baseAmount: '1000000000000000000' }, { ...b, baseAmount: '3000000000000000000' }], 1005);
  assert.equal(m.kind, 'book');
  const sized = availableOffer({ offer: a, lastSeen: 1000, firstSeen: 1000 }, view.books.get(a.pair), view.inventory.get(a.pair), 1005, 1005);
  assert.equal(sized.baseAmount, '1000000000000000000');
});

test('deep bid books keep a complete legacy inventory so an omitted bid cannot fall back to full maker size', async () => {
  const { BookFeed } = await import('../../../src/market/book-feed.js');
  const { availableOffer } = await import('../../../src/market/book.js');
  const offers = Array.from({ length: 210 }, (_, i) => ({ ...bid(i.toString(16).padStart(64, '0')).offer, expiresAt: 2000, software: '0.1.32' }));
  const { body } = new BookFeed().next(TNK.pair, 1, offers, 1000, () => 1);
  assert.equal(body.remaining.length, 199);
  assert.equal(body.levels[0].offers, 199);
  assert.equal(availableOffer({ offer: offers[209], firstSeen: 999, lastSeen: 999 }, body, body, 1000, 1000), null);
});

test('a logged purchase stays debited from an older balance cache until a newer wallet read', async () => {
  const { funds, wallets, settle, clock } = setup(), a = bid('a');
  wallets.set('sol1', { USDC: '11000000', SOL: '100000000' }); funds.refresh([a.offer]); await settle();
  const purchase = { buyer: { solPayer: 'sol1' }, quoteAmount: '10000000', fees: a.fees, settledAt: clock.t };
  assert.ok(BigInt(funds.allocate([a], new Map(), [purchase]).get('a')) < 200000000000000000n);
  clock.t += 300; funds.refresh([a.offer]); await settle();
  assert.equal(funds.allocate([a], new Map(), [purchase]).get('a'), a.offer.baseAmount);
});

test('a read begun before settlement cannot release its debit just because the old balance arrives afterward', async () => {
  const { funds, clock, settle } = setup(), a = bid('a'); let release;
  funds.solana.walletBalances = () => new Promise(resolve => { release = resolve; });
  funds.refresh([a.offer]);
  clock.t++;
  const purchase = { buyer: { solPayer: 'sol1' }, quoteAmount: '10000000', fees: a.fees, settledAt: clock.t };
  clock.t++; release({ USDC: '11000000', SOL: '100000000' }); await settle();
  assert.ok(BigInt(funds.allocate([a], new Map(), [purchase]).get('a')) < 200000000000000000n);
});

test('an excessively delayed wallet response remains unknown rather than becoming a fresh empty balance', async () => {
  const { funds, clock, settle } = setup(), a = bid('a'); let release;
  funds.solana.walletBalances = () => new Promise(resolve => { release = resolve; });
  funds.refresh([a.offer]); clock.t += 600;
  release({ USDC: '0', SOL: '0' }); await settle();
  assert.equal(funds.balances(a.offer), null);
  assert.equal(funds.allocate([a]).get('a'), a.offer.baseAmount, 'documented unknown-balance behavior');
});
