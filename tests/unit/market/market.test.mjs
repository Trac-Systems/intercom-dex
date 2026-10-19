import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteAmount, tradePrice, priceUnits, formatPrice } from '../../../src/market/assets.js';
import { OfferBook } from '../../../src/market/book.js';
import { PAIRS } from '../core/helpers.mjs';
import { ticker } from '../../../src/market/ticker.js';

test('quote amounts round down across decimals', () => {
  assert.equal(quoteAmount(PAIRS[1], '100000000', '0.5'), '500000');            // 1 RESET at 0.5 USDC
  assert.equal(quoteAmount(PAIRS[0], (10n ** 18n).toString(), '0.123456'), '123456');
  assert.equal(quoteAmount(PAIRS[1], '100', '1'), '1');                        // 1e-6 RESET at 1 USDC
  assert.throws(() => quoteAmount(PAIRS[1], '99', '1'), /too small/);
  assert.throws(() => quoteAmount(PAIRS[1], '1', '0.000001'), /too small/);
  assert.throws(() => priceUnits('1.0000000000001'), /Invalid price/);
  assert.equal(formatPrice(priceUnits('12.5000')), '12.5');
  assert.equal(tradePrice(PAIRS[1], '200000000', '1000000'), '0.5');
});

test('book orders, fills, cancels and expires', () => {
  const b = new OfferBook(), maker = { dexKey: 'a'.repeat(64) };
  const o = (id, side, price, exp = 1000) => ({ offerId: id.repeat(64), pair: 'RESET/USDC', side, baseAmount: '100', price, maker, expiresAt: exp });
  assert.ok(b.add(o('1', 'sell', '0.6'), 0)); assert.ok(b.add(o('2', 'sell', '0.5'), 0));
  assert.ok(b.add(o('3', 'buy', '0.4'), 0)); assert.ok(b.add(o('4', 'buy', '0.45', 10), 0));
  assert.ok(!b.add(o('5', 'buy', '0.4', 5), 6));
  assert.deepEqual(b.snapshot('RESET/USDC', 0).map(x => x.price), ['0.5', '0.6', '0.45', '0.4']);
  b.fill('2'.repeat(64), '40');
  assert.equal(b.snapshot('RESET/USDC', 0)[0].baseAmount, '60');
  b.fill('2'.repeat(64), '60');
  assert.ok(!b.cancel('1'.repeat(64), 'b'.repeat(64)));
  assert.ok(b.cancel('1'.repeat(64), maker.dexKey));
  assert.deepEqual(b.snapshot('RESET/USDC', 20).map(x => x.price), ['0.4']);
});

test('ticker over 24 hours', () => {
  const day = 24 * 3600 * 1000, t = (ts, base, quote) => ({ pair: 'RESET/USDC', ts, baseAmount: base, quoteAmount: quote });
  const trades = [t(0, '100000000', '400000'), t(day + 10, '100000000', '500000'), t(day + 20, '200000000', '1200000')];
  assert.deepEqual(ticker(PAIRS[1], trades, day + 30), { pair: 'RESET/USDC', ts: day + 30, last: '0.6',
    volume24h: '1700000', high24h: '0.6', low24h: '0.5', trades24h: 2 });
  assert.equal(ticker(PAIRS[0], trades, day).trades24h, 0);
});
