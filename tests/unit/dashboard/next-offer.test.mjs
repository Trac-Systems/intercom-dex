import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNextOffer, MAX_NEXT_TAKES } from '../../../src/dashboard/next-offer.js';
import { PAIRS } from '../core/helpers.mjs';

const pair = PAIRS[1], now = 1000;
const seen = (n, price, units, firstSeen, side = 'sell') => ({ firstSeen, lastSeen: now,
  offer: { offerId: n.toString(16).padStart(64, '0'), pair: pair.pair, side, price, baseAmount: units, registryVersion: 1, maker: { dexKey: 'b'.repeat(64) } } });

function fakeRole(offers) {
  const trades = new Map(), hooks = { afterStep: [] };
  const role = { offers: new Map(offers.map(s => [s.offer.offerId, s])), host: { trades, hooks }, calls: [], failNext: null,
    registry: { snapshot: () => ({ pairs: [pair] }) },
    availableOffer(id) { const s = this.offers.get(id); return s ? { ...s.offer } : null; },
    async takeOffer(offerId, baseAmount, price) {
      if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
      const o = this.offers.get(offerId).offer, key = `k${this.calls.length}`, amount = String(baseAmount ?? o.baseAmount);
      this.calls.push([offerId, amount, price]);
      trades.set(key, { key, state: { mode: 'taker', offerId, phase: 'awaitAccept', draft: { baseAmount: amount } } });
      return { key, offerId, baseAmount: amount };
    } };
  return role;
}
// One trade step as the host runs it: the state changes, then the hooks see the trade and the state before.
const run = async (role, key, state, beforePhase = 'awaitAccept') => {
  const trade = role.host.trades.get(key), before = { ...trade.state, phase: beforePhase };
  trade.state = { ...trade.state, ...state };
  for (const h of role.host.hooks.afterStep) h(trade, before);
};
const flush = () => new Promise(r => setImmediate(r));

test('a take the maker leaves unanswered moves on to the next offer at that price, oldest first, until one works', async () => {
  const a = seen(1, '1', '100000000', 900), b = seen(2, '1.00', '300000000', 950), c = seen(3, '1', '50000000', 920),
    other = seen(4, '1.1', '900000000', 800), buy = seen(5, '1', '900000000', 800, 'buy');
  const role = fakeRole([a, b, c, other, buy]), next = createNextOffer({ role, defer: fn => fn() });
  const first = await next.take(a.offer.offerId, '100000000', '1');
  await run(role, first.key, { phase: 'aborted', reason: 'Timed out: take/accept' }); await flush();
  // c is older than b; it holds only 0.5 of the 1 wanted, so the take is capped to it.
  assert.deepEqual(role.calls[1], [c.offer.offerId, '50000000', '1']);
  assert.equal(next.note(first.key).moved, true);
  await run(role, 'k1', { phase: 'aborted', reason: 'busy' }); await flush();
  // b's price is written differently but is the same price; the offer's own text is sent.
  assert.deepEqual(role.calls[2], [b.offer.offerId, '100000000', '1.00']);
  await run(role, 'k2', { phase: 'aborted', reason: 'Peer aborted: gone' }); await flush();
  assert.equal(role.calls.length, 3);
  assert.deepEqual(next.note('k2'), { moved: false, text: 'No other offer at this price could take over.' });
});

test('only a call-off while agreeing terms moves on: never signer trouble, a lock, a transfer or a later step', async () => {
  const cases = [
    [{ phase: 'aborted', reason: 'Signers did not confirm' }, 'awaitAcks'],
    [{ phase: 'aborted', reason: 'not enough signers' }, 'awaitAccept'],
    [{ phase: 'aborted', reason: 'Escrow lock failed', lockAttempted: true }, 'locking'],
    [{ phase: 'aborted', reason: 'Peer aborted: x' }, 'awaitCertificate'],
    [{ phase: 'aborted', reason: 'Timed out: deal' }, 'awaitDeal'],
    [{ phase: 'aborted', reason: 'Transfer not sent before the deadline: x' }, 'transferring'],
    [{ phase: 'aborted', reason: 'Timed out: take/accept', locked: true }, 'awaitAccept'],
    [{ phase: 'complete' }, 'claiming'],
  ];
  for (const [state, beforePhase] of cases) {
    const role = fakeRole([seen(1, '1', '100000000', 900), seen(2, '1', '100000000', 950)]), next = createNextOffer({ role, defer: fn => fn() });
    const r = await next.take(seen(1, '1', '1', 0).offer.offerId, '100000000', '1');
    await run(role, r.key, state, beforePhase); await flush();
    assert.equal(role.calls.length, 1, JSON.stringify(state));
    assert.equal(next.note(r.key), null);
  }
});

test('no second order: while a chain agrees terms or moves on, another take on that market is refused', async () => {
  const offers = [seen(1, '1', '100000000', 900), seen(2, '1', '100000000', 950), seen(3, '2', '100000000', 950)];
  const role = fakeRole(offers), next = createNextOffer({ role, defer: fn => fn() });
  // Two requests at the same moment: the second is refused before it starts anything.
  let release; const gate = new Promise(r => { release = r; }), take = role.takeOffer.bind(role);
  role.takeOffer = async (...a) => { await gate; return take(...a); };
  const first = next.take(offers[0].offer.offerId, '100000000', '1');
  await assert.rejects(next.take(offers[1].offer.offerId, '100000000', '1'), /still being agreed/);
  await assert.rejects(next.take(offers[2].offer.offerId, '100000000', '2'), /still being agreed/);
  release(); const r = await first; role.takeOffer = take;
  assert.equal(role.calls.length, 1);
  assert.throws(() => next.check(offers[1].offer), /still being agreed/);
  // A maker no-show moves on to exactly one next take, even if the hook fires twice for the same call-off.
  const trade = role.host.trades.get(r.key), before = { ...trade.state };
  trade.state = { ...trade.state, phase: 'aborted', reason: 'Timed out: take/accept' };
  for (const h of role.host.hooks.afterStep) { h(trade, before); h(trade, before); }
  await flush();
  assert.equal(role.calls.length, 2);
  assert.throws(() => next.check(offers[1].offer), /still being agreed/);
  // Once terms are agreed the chain is over; the trade runs on as a normal trade and new takes are allowed.
  await run(role, 'k1', { phase: 'awaitCertificate' }, 'awaitTermsSig');
  next.check(offers[1].offer);
  // The other side of the market is never blocked.
  next.check({ ...offers[1].offer, side: 'buy' });
});

test('a refused next take is reported, and the chain stops after the cap', async () => {
  const offers = Array.from({ length: MAX_NEXT_TAKES + 3 }, (_, i) => seen(i + 1, '1', '100000000', 900 + i));
  const role = fakeRole(offers), next = createNextOffer({ role, defer: fn => fn() });
  let r = await next.take(offers[0].offer.offerId, '100000000', '1');
  role.failNext = new Error('Not enough signers online');
  await run(role, r.key, { phase: 'aborted', reason: 'Timed out: take/accept' }); await flush();
  assert.deepEqual(next.note(r.key), { moved: false, text: 'The next offer at this price could not be taken: Not enough signers online' });
  r = await next.take(offers[0].offer.offerId, '100000000', '1');
  for (let i = 0; i < MAX_NEXT_TAKES + 1; i++) {
    const key = `k${role.calls.length - 1}`;
    await run(role, key, { phase: 'aborted', reason: 'Timed out: take/accept' }); await flush();
  }
  assert.equal(role.calls.length, 2 + MAX_NEXT_TAKES);
});
