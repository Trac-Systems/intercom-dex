import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseWait, short, wait, priceText, loanRate, loanToValue, deadlineOf, actionShort, actionHeading, flowOf, groupOf, toneOf, steps, feeRows, shortError, stateLabel }
  from '../../../src/dashboard/static/locks-text.js';

const at = (h, m) => Date.UTC(2026, 9, 23, h, m) / 1000;
const hhmm = s => new Date(s * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
const A = (text, unit) => ({ text, unit });
const loan = extra => ({ product: 'loan', role: 'maker', state: 'running', principal: A('100', 'USDC'), repay: A('103', 'USDC'), collateral: A('0.01', 'RESET'), ...extra });

test('a paid row shows a short wait and its facts in two lines; without the clock only that it is releasing', () => {
  const w = releaseWait(loan({ paid: true, paidAt: at(14, 44), bitcoinTime: at(13, 58) }), at(15, 0));
  assert.equal(stateLabel(loan({ paid: true })), 'Releasing');
  assert.equal(w.text, '~46m'); assert.equal(w.left, 46 * 60);
  assert.deepEqual(w.tip, [`Paid ${hhmm(at(14, 44))}`, `Bitcoin clock ${hhmm(at(13, 58))}`]);
  assert.ok(w.progress > 0.2 && w.progress < 0.3, 'about 16 of 62 minutes done');
  assert.equal(releaseWait(loan({ paid: true, paidAt: at(14, 44), bitcoinTime: at(14, 50) }), at(15, 0)).text, 'now');
  const blind = releaseWait(loan({ paid: true }), at(15, 0));
  assert.equal(blind.text, null); assert.equal(blind.progress, null); assert.equal(blind.tip.length, 2);
  assert.equal(releaseWait(loan({}), at(15, 0)), null, 'not paid: no release wait');
  assert.ok(blind.tip.every(l => l.length <= 24) && w.tip.every(l => l.length <= 24), 'tips stay two short lines');
});

test('table cells: short times, price per coin, rate, loan to value, deadline with and without a known height', () => {
  assert.deepEqual([short(1), short(4), short(138), short(144), short(1008), short(2016)], ['10m', '40m', '23h', '24h', '7d', '14d']);
  assert.deepEqual([wait(45 * 60), wait(2 * 3600)], ['45m', '2h']);
  assert.equal(priceText(A('480', 'USDC'), A('5,000', 'TNK')), '0.096');
  assert.equal(priceText(A('300', 'USDC'), A('1', 'RESET')), '300');
  assert.equal(priceText(null, A('1', 'RESET')), null);
  assert.deepEqual(loanRate(A('100', 'USDC'), A('103', 'USDC'), 2016), { rate: '3.00%', apr: '78%' });
  assert.equal(loanToValue(A('100', 'USDC'), A('250', 'USDC')), '40%');
  assert.deepEqual(deadlineOf(loan({ dueBlock: 917174, blocksLeft: 30 })), { block: '917,174', left: '5h' });
  assert.deepEqual(deadlineOf(loan({ dueBlock: 917174, blocksLeft: null })), { block: '917,174', left: null }, 'no height: block number only');
  assert.equal(deadlineOf(loan({ dueBlock: 917174, blocksLeft: 30, paid: true })), null);
  assert.deepEqual(flowOf(loan({})), { sign: '-', amount: A('103', 'USDC') });
  assert.equal(flowOf({ product: 'call', role: 'maker', premium: A('5', 'USDC') }).sign, '+');
});

test('one short button per row, the amounts in the dialog heading; filters and pill colours by state', () => {
  assert.equal(actionShort(loan({ nextAction: 'repay' })), 'Pay back');
  assert.equal(actionHeading(loan({ nextAction: 'repay' })), 'Pay back 103 USDC');
  assert.equal(actionShort({ product: 'put', nextAction: 'exercise', state: 'running' }), 'Sell now');
  assert.equal(actionShort({ product: 'put', nextAction: 'refund', state: 'running' }), 'Refund');
  assert.equal(actionShort(loan({ nextAction: 'repay', paid: true })), null, 'paid: nothing more to press');
  assert.ok(['Pay back', 'Buy now', 'Sell now', 'Cancel', 'Refund'].every(l => l.split(' ').length <= 3));
  assert.deepEqual(['posted', 'running', 'released'].map(state => groupOf({ state })), ['open', 'active', 'done']);
  assert.equal(groupOf({ state: 'ended', outcome: 'cancelled' }), 'failed');
  assert.deepEqual([toneOf(loan({})), toneOf(loan({ paid: true })), toneOf(loan({ state: 'posted' })), toneOf(loan({ state: 'ended:defaulted' }))], ['run', 'up', 'open', 'off']);
});

test('the step tracker: four steps, or the steps up to how it ended', () => {
  const at = p => steps(p).map(s => `${s.label}:${s.at}`).join(' ');
  assert.equal(at(loan({ state: 'posted' })), 'Created:now Running:next Paid back:next Released:next');
  assert.equal(at(loan({})), 'Created:done Running:now Paid back:next Released:next');
  assert.equal(at(loan({ paid: true })), 'Created:done Running:done Paid back:done Released:now');
  assert.equal(at({ product: 'call', state: 'released' }), 'Created:done Running:done Used:done Released:done');
  assert.equal(at(loan({ state: 'ended', outcome: 'defaulted' })), 'Created:done Running:done Not paid back:end Released:now');
  assert.equal(at(loan({ state: 'ended:cancelled' })), 'Created:done Cancelled:end');
});

test('fee rows: the taker pays the amount shown; the maker sees the service fee split into venue and signers', () => {
  assert.deepEqual(feeRows({ pay: A('50', 'USDC') }), [['You pay', '50 USDC'], ['Service fee', 'Paid by maker']]);
  assert.deepEqual(feeRows({ receive: A('4.5', 'USDC'), fee: A('0.5', 'USDC'), gross: A('5', 'USDC') }, { venuePct: 60, signerPct: 40 }), [
    ['Fee asked', '5 USDC'], ['Service fee', '0.5 USDC'], ['Venue 60%', '0.3 USDC', 'sub'], ['Signers 40%', '0.2 USDC', 'sub'], ['You receive', '4.5 USDC', 'total']]);
  assert.deepEqual(feeRows(undefined), [['Service fee', 'None']]);
});

test('errors fit one line; the whole text goes behind "?"', () => {
  assert.deepEqual(shortError('Fill in every amount above 0.'), ['Fill in every amount above 0.', null]);
  const long = 'The signers did not answer in time. Try again in a minute; nothing was locked and nothing was paid, so your funds are where they were.';
  assert.deepEqual(shortError(long), ['The signers did not answer in time.', long]);
  const [cut, full] = shortError('x'.repeat(120));
  assert.equal(cut.length, 80); assert.ok(cut.endsWith('…')); assert.equal(full.length, 120);
});
