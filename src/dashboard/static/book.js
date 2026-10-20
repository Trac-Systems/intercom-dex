// The order book as exchanges draw it: sells on top (highest price first, best ask just above the spread), the
// spread in the middle, buys below (best bid first). Both halves are virtual lists anchored at the spread.
import { h, fixed } from './dom.js';
import { virtualList } from './vlist.js';

export const LEVEL_HEIGHT = 22;

// Rows ready to draw: asks reversed, and each level's depth bar (cumulative amount) as a share of the deeper side's
// depth DEPTH_LEVELS away from the spread, so the levels near the spread stay readable; deeper ones show full.
export const DEPTH_LEVELS = 30;
export function bookRows(book, places = 2) {
  const depth = side => (side.length ? Number(side[Math.min(side.length, DEPTH_LEVELS) - 1].total.units) : 0);
  const max = Math.max(depth(book.asks), depth(book.bids), 1);
  const row = side => l => ({ ...l, side, places, depth: Math.min(1, Number(l.total.units) / max) });
  return { asks: book.asks.map(row('sell')).reverse(), bids: book.bids.map(row('buy')) };
}

export function bookPanel({ onTake }) {
  const level = l => {
    const bar = h('div', { class: 'depth', 'aria-hidden': 'true' });
    bar.style.width = `${(l.depth * 100).toFixed(1)}%`;
    const take = l.take ? () => onTake(l) : null;
    return h('div', { class: `vl-row lvl ${l.side}${take ? ' takeable' : ''}${l.mine ? ' mine' : ''}`, role: 'listitem',
      tabindex: take ? '0' : null, title: [l.take ? `${l.side === 'sell' ? 'Buy' : 'Sell'} up to ${l.take.amount.text} ${l.take.amount.unit} at ${l.price}` : 'Only your own offers at this price',
        l.mine ? `yours: ${l.mine.text} ${l.mine.unit}` : null, `${l.count} offer${l.count === 1 ? '' : 's'}`].filter(Boolean).join(' · '),
      onclick: take, onkeydown: take ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); take(); } } : null },
    bar, h('span', { class: 'price' }, fixed(l.price, l.places)), h('span', { class: 'num' }, l.mine ? h('i', { class: 'own', 'aria-label': 'includes yours' }) : null, l.amount.text),
    h('span', { class: 'num muted' }, l.total.text));
  };
  const key = l => `${l.side}:${l.price}`;
  const asks = virtualList({ rowHeight: LEVEL_HEIGHT, row: level, key, anchor: 'end', className: 'book-side', label: 'Sell offers', emptyText: 'No sell offers' });
  const bids = virtualList({ rowHeight: LEVEL_HEIGHT, row: level, key, className: 'book-side', label: 'Buy offers', emptyText: 'No buy offers' });
  const spreadPrice = h('span', { class: 'mid' }), spreadPct = h('span', { class: 'muted' });
  const unitBase = h('span'), headPrice = h('span', null, 'Price (USDC)'), headAmount = h('span', { class: 'num' }, 'Amount'), headTotal = h('span', { class: 'num' }, 'Total');
  const el = h('section', { class: 'panel book' },
    h('header', { class: 'panel-head' }, h('h2', null, 'Order book'), unitBase),
    h('div', { class: 'lvl head' }, headPrice, headAmount, headTotal),
    asks.el, h('div', { class: 'spread' }, h('span', { class: 'muted' }, 'Spread'), spreadPrice, spreadPct), bids.el);

  return {
    el,
    set(book, pricePlaces) {
      unitBase.className = 'muted small'; unitBase.textContent = `amounts in ${book.base}`;
      const rows = bookRows(book, pricePlaces);
      asks.set(rows.asks.length, i => rows.asks[i]);
      bids.set(rows.bids.length, i => rows.bids[i]);
      spreadPrice.textContent = book.spread ? fixed(book.spread.price, pricePlaces) : '—';
      spreadPct.textContent = book.spread?.pct != null ? `${Number(book.spread.pct).toFixed(2)}%` : '';
    },
    clear() { asks.clear(); bids.clear(); spreadPrice.textContent = '—'; spreadPct.textContent = ''; },
  };
}
