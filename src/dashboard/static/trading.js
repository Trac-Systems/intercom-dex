// The trader's screen, laid out like an exchange's spot view: pair bar, chart, order book, order entry and one
// bottom panel with the trader's lists. Built once; every poll only updates what changed.
import { h, api, amt, when, whenLong, fixed, percent, tone, empty } from './dom.js';
import { TIMEFRAMES, DEFAULT_INTERVAL, PAGE, DENSE_CAP, isInterval, denseCandles, mergeCandles, toPoint, precisionOf } from './candles.js';
import { priceChart } from './chart.js';
import { bookPanel } from './book.js';
import { serverList, cursorList } from './vlist.js';
import { review } from './dialogs.js';

const ROW = 32, LIVE_MS = 5000;
const q = params => new URLSearchParams(params).toString();
const plain = text => String(text).replaceAll(',', '');
const side = s => h('span', { class: s === 'sell' ? 'down' : s === 'buy' ? 'up' : 'muted' }, s === 'sell' ? 'Sell' : s === 'buy' ? 'Buy' : '—');
const cell = (cls, ...kids) => h('span', { class: cls }, kids);
const expander = (cls, open, toggle, kids, detail) => h('div', { class: `vl-row ${cls}${open ? ' open' : ''}`, role: 'listitem' },
  h('div', { class: 'cells', tabindex: '0', role: 'button', 'aria-expanded': String(open), onclick: toggle,
    onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } } }, kids, h('span', { class: 'chev', 'aria-hidden': 'true' }, open ? '▾' : '▸')),
  open ? h('div', { class: 'detail' }, detail) : null);
const table = (cls, heads, list) => h('div', { class: `table ${cls}` }, h('div', { class: 'thead' }, heads.map(([t, c]) => h('span', { class: c ?? null }, t))), list.el);

// ---- Chart: 16 timeframes, gap-filled candles, older pages on scroll left, the newest candle refreshed live.
function chartPanel() {
  let pair = null, interval = isInterval(localStorage.getItem('interval')) ? localStorage.getItem('interval') : DEFAULT_INTERVAL;
  let stored = [], dense = [], cap = DENSE_CAP, oldest = false, paging = false, loading = false, epoch = 0, places = 2, lastLive = 0, hover = null, failed = null;
  const buttons = TIMEFRAMES.map(tf => h('button', { type: 'button', class: 'tf', 'aria-pressed': String(tf.interval === interval), onclick: () => pick(tf.interval) }, tf.label));
  const readout = h('div', { class: 'readout' }), host = h('div', { class: 'chart-host', role: 'img', 'aria-label': 'Price chart' });
  const quiet = h('div', { class: 'chart-empty', hidden: true }, 'No trades yet');
  const el = h('section', { class: 'panel chart' },
    h('div', { class: 'chart-bar' }, h('div', { class: 'tfs', role: 'group', 'aria-label': 'Timeframe' }, buttons)),
    h('div', { class: 'chart-body' }, host, readout, quiet),
    h('p', { class: 'credit' }, 'Chart by ', h('a', { href: 'https://www.tradingview.com/', target: '_blank', rel: 'noopener noreferrer' }, 'TradingView'), ' Lightweight Charts™'));
  const chart = priceChart(host, { onOlder: older, onHover: t => { hover = t; showReadout(); } });
  chart.interval(interval);
  const url = extra => `/api/candles?${q({ pair, interval, ...extra })}`;

  function showReadout() {
    const c = (hover != null && dense.find(x => x.t === hover)) || dense.at(-1);
    if (!c) return readout.replaceChildren();
    const move = Number(c.o) ? (Number(c.c) - Number(c.o)) / Number(c.o) : 0, cls = move > 0 ? 'up' : move < 0 ? 'down' : '';
    const kv = (k, v) => [h('span', { class: 'muted' }, k), h('span', { class: cls }, v)];
    readout.replaceChildren(...kv('O', fixed(c.o, places)), ...kv('H', fixed(c.h, places)), ...kv('L', fixed(c.l, places)), ...kv('C', fixed(c.c, places)),
      h('span', { class: cls }, percent(move)), h('span', { class: 'muted' }, 'Vol'), h('span', null, c.v ? c.v.text : '0'));
  }
  function draw(mode) {
    dense = denseCandles(stored, interval, Date.now() / 1000, cap);
    quiet.hidden = loading || stored.length > 0;
    quiet.textContent = failed ? `Chart data unavailable: ${failed}` : 'No trades yet';
    chart.set(dense.map(toPoint), mode);
    showReadout();
  }
  async function load() {
    const e = ++epoch;
    stored = []; cap = DENSE_CAP; oldest = false; paging = false; loading = true; lastLive = Date.now();
    draw('fit');
    try {
      const page = await api(url({ limit: PAGE }));
      if (e !== epoch) return;
      stored = page.candles; failed = null;
    } catch (error) { if (e === epoch) failed = error.message; /* the live refresh reads it again */ }
    if (e === epoch) { loading = false; draw('fit'); }
  }
  async function older() {
    if (paging || oldest || !stored.length) return;
    if (dense.length && stored[0].t < dense[0].t) { cap += DENSE_CAP; return draw('keep'); }
    const e = epoch;
    paging = true;
    try {
      const page = await api(url({ limit: PAGE, before: stored[0].t }));
      if (e !== epoch) return;
      if (!page.candles.length) oldest = true;
      else { stored = mergeCandles(page.candles, stored); draw('keep'); }
    } catch { /* the next pan tries again */ } finally { if (e === epoch) paging = false; }
  }
  async function live() {
    const e = epoch;
    lastLive = Date.now();
    try {
      const page = await api(url({ limit: 3 }));
      if (e !== epoch) return;
      const had = stored.length;
      stored = mergeCandles(stored, page.candles); failed = null;
      draw(had ? 'live' : 'fit');
    } catch (error) { if (e === epoch && !stored.length) { failed = error.message; draw('live'); } }
  }
  function pick(next) {
    interval = next; localStorage.setItem('interval', next);
    buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(TIMEFRAMES[i].interval === next)));
    chart.interval(next);
    load();
  }
  return {
    el,
    pair(next) { pair = next; load(); },
    precision(p) { if (p !== places) { places = p; chart.precision(p); showReadout(); } },
    tick() { if (pair && !loading && Date.now() - lastLive >= LIVE_MS) live(); },
    theme: () => chart.theme(),
  };
}

// ---- Order entry: place an offer, or take one from the book. Both go through the preview -> confirm dialog.
function entryPanel() {
  let pair = null, book = null, balances = null, sideNow = 'buy', mode = 'offer', taking = null;
  const input = (name, attrs) => h('input', { name, inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false', ...attrs });
  const price = input('price', { placeholder: '0.00' }), amount = input('amount', { placeholder: '0' }), ttl = input('ttl', { type: 'number', min: 1, max: 1440, value: 60, inputmode: 'numeric' });
  const takeAmount = input('take', { placeholder: 'all' });
  const sideButtons = ['buy', 'sell'].map(s => h('button', { type: 'button', class: `side-btn ${s}`, onclick: () => { sideNow = s; taking = null; render(); } }, s === 'buy' ? 'Buy' : 'Sell'));
  const modeButtons = [['offer', 'Place offer'], ['take', 'Take offer']].map(([m, label]) => h('button', { type: 'button', role: 'tab', onclick: () => { mode = m; render(); } }, label));
  const baseUnit = h('span', { class: 'unit' }), takeUnit = h('span', { class: 'unit' });
  const available = h('div', { class: 'kv' }), estimate = h('div', { class: 'kv' }), minimum = h('div', { class: 'kv' });
  const takeInfo = h('div', { class: 'take-info' }), paused = h('p', { class: 'note', hidden: true }, 'Trading is paused on this pair.');
  const submit = h('button', { type: 'button', class: 'primary wide', onclick: () => send() });
  const offerFields = h('div', { class: 'fields' },
    h('label', null, 'Price', h('div', { class: 'affix' }, price, h('span', { class: 'unit' }, 'USDC'))),
    h('label', null, 'Amount', h('div', { class: 'affix' }, amount, baseUnit)),
    h('label', null, 'Open for', h('div', { class: 'affix' }, ttl, h('span', { class: 'unit' }, 'min'))));
  const maxNote = h('p', { class: 'note', hidden: true });
  const takeFields = h('div', { class: 'fields' }, takeInfo,
    h('label', null, 'Amount', h('div', { class: 'affix' }, takeAmount, h('button', { type: 'button', class: 'small link', onclick: () => fillMax() }, 'Max'), takeUnit)), maxNote);
  const el = h('section', { class: 'panel entry' }, h('div', { class: 'sides' }, sideButtons), h('div', { class: 'modes', role: 'tablist' }, modeButtons),
    offerFields, takeFields, h('div', { class: 'summary' }, available, estimate, minimum), paused, submit);
  for (const i of [price, amount, takeAmount]) i.addEventListener('input', () => { maxNote.hidden = true; render(); });

  // The offer to take: the level the reader clicked while it is still in the book, else the next offer at that
  // price (the clicked one was taken or called off), else the best one on the other side.
  function offer() {
    if (!book) return null;
    const levels = sideNow === 'buy' ? book.asks : book.bids;
    if (taking) {
      const l = levels.find(x => x.take?.offerId === taking.offerId) ?? levels.find(x => x.take && x.price === taking.price);
      if (l) return { ...l.take, price: l.price };
    }
    const best = levels.find(x => x.take);
    return best ? { ...best.take, price: best.price } : null;
  }
  const kv = (target, k, v) => target.replaceChildren(h('span', { class: 'muted' }, k), h('span', { class: 'num' }, v));
  function render() {
    if (!pair) return;
    const base = pair.base, open = pair.status === 'open';
    sideButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(['buy', 'sell'][i] === sideNow)));
    modeButtons.forEach((b, i) => b.setAttribute('aria-selected', String(['offer', 'take'][i] === mode)));
    offerFields.hidden = mode !== 'offer'; takeFields.hidden = mode !== 'take';
    baseUnit.textContent = base; takeUnit.textContent = base;
    const pay = sideNow === 'buy' ? 'USDC' : base, free = balances?.[pay]?.free;
    kv(available, 'Available', free ? amt(free) : '—');
    const o = mode === 'take' ? offer() : null;
    if (mode === 'take') {
      takeInfo.replaceChildren(...(o ? [h('span', { class: 'muted' }, taking && o.offerId === taking.offerId ? 'Chosen offer' : taking && o.price === taking.price ? 'Next offer at this price' : `Best ${sideNow === 'buy' ? 'sell' : 'buy'} offer`),
        h('span', { class: `num ${sideNow === 'buy' ? 'down' : 'up'}` }, o.price, h('span', { class: 'unit' }, 'USDC')), h('span', { class: 'num' }, 'up to ', amt(o.amount))]
        : [h('span', { class: 'muted' }, `No ${sideNow === 'buy' ? 'sell' : 'buy'} offer from another trader to take right now.`)]));
      takeAmount.placeholder = o ? `all (${o.amount.text})` : 'all';
    }
    const qty = Number(plain(mode === 'take' ? (takeAmount.value || (o ? o.amount.text : '')) : amount.value));
    const at = Number(mode === 'take' ? o?.price : price.value);
    kv(estimate, sideNow === 'buy' ? 'You pay about' : 'You receive about', qty > 0 && at > 0 ? `${(qty * at).toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC` : '—');
    kv(minimum, 'Smallest trade', amt(pair.minBase));
    paused.hidden = open;
    submit.disabled = !open || (mode === 'take' && !o);
    submit.className = `primary wide ${sideNow}`;
    submit.textContent = `${mode === 'take' ? '' : 'Review '}${sideNow === 'buy' ? 'Buy' : 'Sell'} ${base}${mode === 'take' ? ' now' : ''}`;
  }
  // Max: the most of the offer that the free balance pays for, fees included (worked out by the trader).
  async function fillMax() {
    const o = offer();
    if (!o) return;
    maxNote.hidden = true;
    try {
      const m = await api(`/api/max-take?${q({ offerId: o.offerId })}`);
      takeAmount.value = plain(m.amount.text);
      if (m.note) { maxNote.textContent = m.note; maxNote.hidden = false; }
    } catch (error) { maxNote.textContent = error.message; maxNote.hidden = false; }
    render();
  }
  function send() {
    if (mode === 'offer') return review('offer', { pair: pair.pair, side: sideNow, amount: plain(amount.value), price: price.value.trim(), ttlMin: Number(ttl.value) });
    const o = offer();
    if (o) review('take', { offerId: o.offerId, amount: plain(takeAmount.value) || undefined });
  }
  return {
    el,
    pair(p) { if (pair?.pair !== p.pair) { taking = null; takeAmount.value = ''; } pair = p; render(); },
    data(b, bal) { book = b; balances = bal; render(); },
    // A click on a book level: take that level's offer, and use its price for an offer too.
    take(level) {
      sideNow = level.side === 'sell' ? 'buy' : 'sell'; mode = 'take'; taking = { offerId: level.take.offerId, price: level.price }; maxNote.hidden = true;
      takeAmount.value = plain(level.take.amount.text); price.value = level.price;
      render(); takeAmount.focus();
    },
  };
}

// ---- Bottom panel: the trader's own lists and the market's trades, each a virtual list.
function bottomPanel(getPlaces) {
  const list = name => (offset, limit) => api(`/api/list?${q({ name, offset, limit })}`);
  const p = (pairName, price) => fixed(price, getPlaces(pairName));
  let tradesPair = null;
  const build = {
    offers: () => serverList({ fetchBlock: list('trader.offers'), rowHeight: ROW, key: o => o.offerId, label: 'Open offers', emptyText: 'Your open offers appear here.',
      row: o => h('div', { class: 'vl-row', role: 'listitem' }, h('div', { class: 'cells' }, cell('', o.pair), cell('', side(o.side)), cell('num', p(o.pair, o.price)),
        cell('num', amt(o.size)), cell('num hide-s', amt(o.filled)), cell('num hide-s', amt(o.reserved)), cell('num', amt(o.left)), cell('hide-s', when(o.expiresAt)),
        cell('end', h('button', { class: 'small danger', type: 'button', onclick: () => review('cancel', { offerId: o.offerId }) }, 'Cancel')))) }),
    running: () => serverList({ fetchBlock: list('trader.running'), rowHeight: ROW, key: x => x.key, label: 'Running trades',
      emptyText: 'Trades you start, or that take your offers, appear here with what happens next.',
      row: (x, { open, toggle }) => expander('', open, toggle, [cell('', x.pair), cell('', side(x.side)), cell('num', amt(x.base)), cell('num hide-s', amt(x.quote)),
        cell('clip', x.line.now), cell('hide-s', x.line.deadline ? when(x.line.deadline) : x.line.fallbackAt ? when(x.line.fallbackAt) : '—')],
      [h('p', null, h('strong', null, 'Now: '), x.line.now, '. ', h('span', { class: 'muted' }, `Waiting for ${x.line.waitingFor}.`)),
        x.line.ifMissed || x.line.fallback ? h('p', null, h('strong', null, 'If missed: '), x.line.ifMissed ? [x.line.ifMissed, x.line.deadline ? [' ', whenLong(x.line.deadline)] : null, ', '] : null,
          x.line.fallback, x.line.fallbackAt ? [' ', whenLong(x.line.fallbackAt)] : null, x.line.ifMissed ? '.' : null) : null,
        h('p', { class: 'muted' }, `${x.side === 'buy' ? 'Buying' : 'Selling'} ${x.base.text} ${x.base.unit} for ${x.quote.text} USDC at ${x.price} · with ${x.peer}`,
          x.tradeId ? ` · trade ${x.tradeId.slice(0, 12)}…` : null, ' · updated ', when(x.at))]) }),
    history: () => serverList({ fetchBlock: list('trader.history'), rowHeight: ROW, key: x => x.key, label: 'History', emptyText: 'Finished trades appear here.',
      row: (x, { open, toggle }) => expander('', open, toggle, [cell('', when(x.at)), cell('', x.pair), cell('', side(x.side)), cell('num', p(x.pair, x.price)),
        cell('num hide-s', amt(x.base)), cell('num hide-s', amt(x.quote)), cell(`clip tone-${x.outcome.tone}`, h('span', { class: 'icon' }, x.outcome.tone === 'good' ? '✓' : x.outcome.tone === 'bad' ? '✕' : '·'), ' ', x.outcome.text)],
      [h('p', null, x.outcome.text), h('p', { class: 'muted' }, `${x.side === 'buy' ? 'Bought' : 'Sold'} ${x.base.text} ${x.base.unit} for ${x.quote.text} USDC at ${x.price} · with ${x.peer}`,
        x.tradeId ? ` · trade ${x.tradeId}` : null, ' · ', whenLong(x.at))]) }),
    trades: () => cursorList({ key: t => t.id, rowHeight: ROW, label: 'Market trades', emptyText: 'No trades on this pair yet.',
      fetchPage: cursor => api(`/api/trades?${q({ pair: tradesPair, limit: 200, ...(cursor ? { before: cursor } : {}) })}`),
      row: t => h('div', { class: 'vl-row', role: 'listitem' }, h('div', { class: 'cells' }, cell('', when(t.t)), cell(`num ${t.side === 'sell' ? 'down' : t.side === 'buy' ? 'up' : ''}`, h('span', { title: t.price }, p(tradesPair, t.price))),
        cell('num', amt(t.amount)), cell('num', amt(t.usdc)), cell('hide-s', side(t.side)))) }),
    attention: () => serverList({ fetchBlock: list('trader.attention'), rowHeight: ROW, key: (a, i) => `${a.kind}:${a.at}:${a.text}` || i, label: 'Alerts', emptyText: 'Nothing needs your attention.',
      row: (a, { open, toggle }) => expander(['failed', 'key', 'paused'].includes(a.kind) ? 'alert bad' : 'alert', open, toggle,
        [cell('icon warn', '!'), cell('clip', a.text), cell('', a.at ? when(a.at) : '')], [h('p', null, a.text), a.at ? h('p', { class: 'muted' }, whenLong(a.at)) : null]) }),
  };
  const heads = {
    offers: ['cols-offers', [['Pair'], ['Side'], ['Price', 'num'], ['Size', 'num'], ['Filled', 'num hide-s'], ['Reserved', 'num hide-s'], ['Left', 'num'], ['Expires', 'hide-s'], ['']]],
    running: ['cols-running', [['Pair'], ['Side'], ['Amount', 'num'], ['Total', 'num hide-s'], ['What happens now'], ['Next deadline', 'hide-s'], ['']]],
    history: ['cols-history', [['Time'], ['Pair'], ['Side'], ['Price', 'num'], ['Amount', 'num hide-s'], ['Total', 'num hide-s'], ['Outcome'], ['']]],
    trades: ['cols-trades', [['Time'], ['Price', 'num'], ['Amount', 'num'], ['Total (USDC)', 'num'], ['Taker', 'hide-s']]],
    attention: ['cols-alerts', [[''], ['Needs attention'], ['When'], ['']]],
  };
  const tabs = [['offers', 'Open offers'], ['running', 'Running trades'], ['history', 'History'], ['trades', 'Market trades'], ['attention', 'Alerts']];
  const lists = {}, labels = {};
  let active = localStorage.getItem('bottom') in heads ? localStorage.getItem('bottom') : 'running';
  const body = h('div', { class: 'bottom-body' });
  const bar = h('div', { class: 'bottom-tabs', role: 'tablist' }, tabs.map(([id, label]) => {
    labels[id] = h('span', { class: 'count' });
    return h('button', { type: 'button', role: 'tab', 'data-id': id, onclick: () => pick(id) }, label, labels[id]);
  }));
  const el = h('section', { class: 'panel bottom' }, bar, body);
  function pick(id) {
    active = id; localStorage.setItem('bottom', id);
    for (const b of bar.children) b.setAttribute('aria-selected', String(b.dataset.id === id));
    if (!lists[id]) { lists[id] = build[id](); lists[id].table = table(heads[id][0], heads[id][1], lists[id]); }
    else lists[id].refresh();
    body.replaceChildren(lists[id].table);
    lists[id].list.refresh();
  }
  return {
    el,
    pair(name) { tradesPair = name; lists.trades?.reset(); },
    start() { pick(active); },
    counts(c) {
      for (const [id, n] of Object.entries({ offers: c.offers, running: c.running, history: c.history, attention: c.attention })) {
        labels[id].textContent = n ? String(n) : '';
        labels[id].className = `count${id === 'attention' && n ? ' hot' : ''}`;
      }
    },
    tick() { lists[active]?.refresh(); },
  };
}

// ---- Pair bar
function pairBar(onPick) {
  const el = h('section', { class: 'pairbar' });
  let sig = '';
  return {
    el,
    set(pairs, current, places, t) {
      const next = JSON.stringify([pairs, current, places, t.signersOnline, t.registryVersion]);
      if (next === sig) return;
      sig = next;
      const p = pairs.find(x => x.pair === current), cls = tone(p?.change24h);
      const stat = (k, v, c) => h('div', { class: 'stat' }, h('span', { class: 'k' }, k), h('span', { class: `v ${c ?? ''}` }, v));
      el.replaceChildren(
        h('div', { class: 'pairs', role: 'tablist', 'aria-label': 'Pair' }, pairs.map(x => h('button', { type: 'button', role: 'tab', 'aria-selected': String(x.pair === current), onclick: () => onPick(x.pair) },
          x.pair, x.status !== 'open' ? h('span', { class: 'badge' }, 'paused') : null))),
        h('div', { class: `last ${cls}` }, p?.last ? fixed(p.last, places) : '—', h('span', { class: 'unit' }, 'USDC')),
        stat('24h change', percent(p?.change24h), cls), stat('24h high', p?.high24h ? fixed(p.high24h, places) : '—'), stat('24h low', p?.low24h ? fixed(p.low24h, places) : '—'),
        stat('24h volume', p?.volume24h ? [p.volume24h.text, h('span', { class: 'unit' }, 'USDC')] : '—'),
        h('div', { class: 'signers', title: `${t.signersOnline} signer${t.signersOnline === 1 ? '' : 's'} online · ${t.registryVersion ? `signer list v${t.registryVersion}` : 'no signer list yet'}` },
          h('span', { class: `dot ${t.signersOnline > 0 ? 'on' : 'off'}`, 'aria-hidden': 'true' }), String(t.signersOnline), h('span', { class: 'muted hide-s' }, 'signers')));
    },
  };
}

export function tradingView() {
  let current = localStorage.getItem('pair'), shown = null, pairs = [], book = null, state = null, bookEpoch = 0;
  const places = new Map(), bookPlaces = new Map();
  const placesOf = name => places.get(name) ?? 2;
  const bar = pairBar(name => choose(name));
  const chart = chartPanel(), entry = entryPanel(), bottom = bottomPanel(placesOf);
  const books = bookPanel({ onTake: level => entry.take(level) });
  const waiting = h('div', { class: 'waiting', hidden: true }, empty('The pairs, book and chart appear once the venue’s signer list arrives.'));
  const el = h('div', { class: 'trading' }, bar.el, waiting, h('div', { class: 'market' }, chart.el, books.el, entry.el), bottom.el);

  function choose(name) {
    if (name === shown) return;
    const first = !shown;
    current = shown = name; localStorage.setItem('pair', name);
    book = null; books.clear(); bookEpoch++;
    chart.pair(name); bottom.pair(name);
    if (first) bottom.start();
    refreshBook();
    update(state);
  }
  async function refreshBook() {
    const e = bookEpoch, name = current;
    try {
      const b = await api(`/api/book?${q({ pair: name })}`);
      if (e !== bookEpoch) return;
      book = b;
      bookPlaces.set(name, precisionOf([...b.asks, ...b.bids].map(l => l.price)));
      const p = pricePlaces(pairs.find(x => x.pair === name));
      chart.precision(p);
      books.set(b, p);
      entry.data(b, state?.balances ?? null);
    } catch { /* kept until the next poll */ }
  }
  // Price decimals per pair: what its book's prices carry, or its best prices and last price before the book is read.
  function pricePlaces(p) {
    const n = Math.max(bookPlaces.get(p.pair) ?? 2, precisionOf([p.bestAsk, p.bestBid].filter(Boolean), p.last));
    places.set(p.pair, n);
    return n;
  }
  function update(t) {
    state = t;
    pairs = t.pairs;
    for (const p of pairs) pricePlaces(p);
    waiting.hidden = pairs.length > 0;
    el.classList.toggle('no-pairs', pairs.length === 0);
    if (!pairs.length) return;
    if (!pairs.some(p => p.pair === current)) current = pairs[0].pair;
    if (current !== shown) return choose(current);
    const p = pairs.find(x => x.pair === current);
    bar.set(pairs, current, placesOf(current), t);
    entry.pair(p);
    entry.data(book, t.balances);
    bottom.counts(t.counts);
  }
  return {
    el,
    update(data) {
      const first = !state;
      update(data.trader);
      if (!first && pairs.length) { refreshBook(); chart.tick(); bottom.tick(); }
    },
    theme: () => chart.theme(),
  };
}
