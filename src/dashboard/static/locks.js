// The Borrow & Lend and Options tabs, laid out like the Trading tab: a market bar, the book of other traders' requests
// or offers next to an order ticket, and one bottom panel with the reader's positions and activity. Data from
// /api/locks/*; with ?locksDemo=1 in the address every locks call is answered by locks-demo.js instead.
import { h, fill, relative, amt } from './dom.js';
import { show } from './dialogs.js';
import { virtualList, serverList } from './vlist.js';
import { demoApi, demoState } from './locks-demo.js';
import { TERMS, ASSETS, blockNo, short, money, plain, positive, addDecimal, mulDecimal, isDone, isLoan, isPaid, assetOf, actionOf, TAKE,
  needsAction, stateLabel, toneOf, groupOf, productLabel, sideLabel, sizeOf, flowOf, deadlineOf, actionShort, actionHeading, priceText, loanRate,
  loanToValue, releaseWait, steps, feeRows, shortError, hhmm } from './locks-text.js';

const DEMO = new URLSearchParams(location.search).get('locksDemo') === '1';
const PAGE = 50, ROW = 32, RETRY_MS = 30000, REFRESH_MS = 90000;
const RACE = 'Someone else just took this.';
const q = params => new URLSearchParams(params).toString();
const raced = e => e?.reason === 'already_taken';
// People see the plain explanation, never the internal reason code.
const errorText = e => e.hint || e.message;
const fee = s => /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(s);
const usd = n => Number(n.toFixed(2)).toLocaleString('en-US', { maximumFractionDigits: 2 });
const nowSec = () => Date.now() / 1000;

// Like dom.js api(), but keeps the reason and what to do from a refusal ({ error, reason, whatToDo }).
async function call(path, payload) {
  if (DEMO) return demoApi(path, payload);
  const res = await fetch(path, payload === undefined ? { credentials: 'same-origin' }
    : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const v = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok || v?.ok === false) throw Object.assign(new Error(v.error ?? v.reason ?? `HTTP ${res.status}`), { reason: v.reason, hint: v.whatToDo ?? v.what, status: res.status });
  return v;
}

// ---- Shared by both tabs: the reader's positions, recent events, the settings. Read on every dashboard poll.
const store = { available: DEMO, loaded: false, checkedAt: 0, counted: null, prices: {}, balances: null, rows: [], settings: null, events: [], cursor: null, listeners: new Set() };
const badges = { lend: h('span', { class: 'lk-tab-dot', hidden: true }), options: h('span', { class: 'lk-tab-dot', hidden: true }) };

// Unread marks: an action counts until its tab has been opened, and again when its deadline is near (36 blocks,
// about six hours). Seen actions are remembered in this browser only.
const SEEN_KEY = 'locks.seen', URGENT_BLOCKS = 36;
const seen = new Set((() => { try { return JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]'); } catch { return []; } })());
const seenKey = p => `${p.positionId}:${actionOf(p)?.action ?? ''}`;
const urgent = p => Number.isFinite(p.blocksLeft) && p.blocksLeft <= URGENT_BLOCKS;
const alerting = p => needsAction(p) && (urgent(p) || !seen.has(seenKey(p)));
function markSeen(rows) {
  let changed = false;
  for (const p of rows) if (needsAction(p) && !seen.has(seenKey(p))) { seen.add(seenKey(p)); changed = true; }
  if (!changed) return;
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-500))); } catch { /* kept for this page only */ }
  paint();
}

function paint() {
  for (const [id, mine] of [['lend', isLoan], ['options', p => !isLoan(p)]]) {
    const n = store.rows.filter(p => mine(p) && alerting(p)).length;
    badges[id].hidden = !n;
    badges[id].title = n ? `${n} need${n === 1 ? 's' : ''} you` : '';
    badges[id].setAttribute('aria-label', badges[id].title);
  }
  for (const fn of store.listeners) fn();
}

export const locks = {
  demo: DEMO, demoState,
  get available() { return store.available; },
  badge: id => badges[id] ?? null,
  // True when the tabs appeared (the trader answered /api/locks/* for the first time).
  async poll() {
    if (!store.available && Date.now() - store.checkedAt < RETRY_MS) return false;
    store.checkedAt = Date.now();
    const was = store.available;
    try {
      const [mine, events] = await Promise.all([call('/api/locks/mine'), call(`/api/locks/events?${q(store.cursor ? { since: store.cursor } : {})}`)]);
      store.available = store.loaded = true;
      store.rows = mine.rows ?? []; store.counted = mine.counted ?? store.counted;
      for (const [asset, v] of Object.entries(mine.prices ?? (mine.price ? { RESET: mine.price } : {}))) if (v?.text ?? typeof v === 'string') store.prices[asset] = Number(plain(v.text ?? v));
      const known = new Set(store.events.map(e => e.id ?? `${e.at}:${e.text}`));
      const fresh = (events.rows ?? []).filter(e => !known.has(e.id ?? `${e.at}:${e.text}`));
      store.events = [...fresh, ...store.events].sort((a, b) => b.at - a.at).slice(0, 200);
      store.cursor = events.next ?? events.cursor ?? store.cursor;
      store.settings ??= await call('/api/locks/settings').catch(() => null);
      paint();
    } catch { /* tried again on the next poll; the tabs stay as they are */ }
    return store.available !== was;
  },
};
const refreshNow = () => { store.checkedAt = 0; locks.poll(); };

// ---- "?" tips: one small popover per concept, on hover, focus or click. One floating box for the whole page; inside
// the dialog it moves into the dialog so it stays on top.
const tipBox = h('div', { class: 'lk-tip', role: 'tooltip', hidden: true });
let tipAnchor = null, pinned = false;
const lines = content => [typeof content === 'function' ? content() : content].flat().filter(Boolean);
function openTip(anchor, content) {
  tipAnchor = anchor;
  const host = anchor.closest('dialog') ?? document.body;
  if (tipBox.parentNode !== host) host.append(tipBox);
  fill(tipBox, lines(content).map(t => h('p', null, t)));
  tipBox.hidden = false;
  const r = anchor.getBoundingClientRect(), w = tipBox.offsetWidth, ht = tipBox.offsetHeight;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
  const top = r.bottom + 6 + ht > innerHeight - 8 ? Math.max(8, r.top - ht - 6) : r.bottom + 6;
  tipBox.style.left = `${left}px`; tipBox.style.top = `${top}px`;
}
function closeTip() { tipBox.hidden = true; tipAnchor = null; pinned = false; }
document.addEventListener('click', e => { if (tipAnchor && !tipAnchor.contains(e.target) && !tipBox.contains(e.target)) closeTip(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && tipAnchor) closeTip(); });
addEventListener('scroll', () => { if (tipAnchor) closeTip(); }, { capture: true, passive: true });
function hint(el, content) {
  el.addEventListener('mouseenter', () => { if (!pinned) openTip(el, content); });
  el.addEventListener('mouseleave', () => { if (!pinned && tipAnchor === el) closeTip(); });
  el.addEventListener('focus', () => { if (!pinned) openTip(el, content); });
  el.addEventListener('blur', () => { if (!pinned && tipAnchor === el) closeTip(); });
  return el;
}
const tip = (content, label = 'More') => {
  const b = h('button', { type: 'button', class: 'lk-q', 'aria-label': label, onclick: e => {
    e.stopPropagation();
    if (pinned && tipAnchor === b) return closeTip();
    openTip(b, content); pinned = true;
  } }, '?');
  return hint(b, content);
};
// A short line with the rest of a long text behind "?".
const line = (cls, text) => { const [s, full] = shortError(text); return h('p', { class: cls }, s, full ? tip(full) : null); };

// ---- Explanations (one per concept, behind "?" and in How it works).
const BLOCKS = 'Deadlines are Bitcoin block heights as counted by the RESET network. A block takes about 10 minutes, so times are estimates. Once a payment counts, what it releases follows when Bitcoin\'s clock (the middle time of the last 11 blocks) has passed the payment, usually 1–2 hours later, without waiting for the deadline.';
const SIGNERS = 'Nobody holds what is locked: it sits on an address whose key exists only in pieces, spread over the signer committee. A majority of them releases it to exactly one side, decided only by what happened on chain before the deadline.';
// Fee terms come from the service's current settings; without them the text stays general.
const FEES = () => {
  const f = store.settings?.service;
  const rates = f ? `The service fee is ${f.loanPct} % of the USDC amount for a loan, and ${f.optionPct} % of the fee for an option, at least ${f.optionMin} USDC but never more than the fee itself. Of it, ${f.venuePct} % goes to the service and ${f.signerPct} % is shared by the signers who guard the lock.`
    : 'The service fee is a small share of the loan amount or of the option fee, split between the service and the signers who guard the lock.';
  return `${rates} It is taken once, from the payment that opens the loan or option, and comes out of what the side that posted it receives. Whoever takes pays exactly the amount shown. Paying back, using a right, cancelling and collecting cost no service fee.`;
};
const NETWORK = () => `Network costs come on top and go to the networks, not to the service: a little SOL for each Solana payment and a small TNK fee for each Trac transfer. Locked RESET or TNK carries ${store.settings?.service?.tnkReserve ?? 'a little'} TNK extra that pays for sending it out at the end.`;
const ONLINE = what => `Automatic ${what} only works while this app is running and online. It acts a few blocks (about an hour) before the deadline. If the app is off then, nothing is paid for you. Closing the browser is fine; the app itself has to keep running.`;
const LOAN_RISK = 'A partial payment counts as nothing and is not returned automatically, and neither is overpaying. A lender gets the collateral even if it is worth less than the loan by then. There is no refund window for locked RESET or TNK: if most signers lost their keys it would stay locked for good, and a majority of signers working together could take it. The service caps the total that can be locked.';
const OPTION_RISK = 'A right used after its end does not count. USDC in a put\'s Solana escrow has a refund window: its writer can take it back after the refund time shown, even if every signer disappears. Locked RESET or TNK has no refund window: if most signers lost their keys it would stay locked for good, and a majority of signers working together could take it. The service caps the total that can be locked.';
const RELEASE = 'Released when Bitcoin\'s clock passes the payment, usually 1–2 hours later.';

// ---- Small pieces
const close = () => h('button', { type: 'button', onclick: () => document.querySelector('#dialog').close() }, 'Close');
const cell = (cls, ...kids) => h('span', { class: cls || null }, kids);
const units = a => (a ? amt(a) : '—');
const head = (cols, heads) => h('div', { class: `thead ${cols}` }, heads.map(([t, c, more]) => h('span', { class: c ?? null }, t, more ? tip(more) : null)));
// A key-value table: [label, value, extra], extra being 'sub' or 'total' (a row style) or what its "?" explains.
const ROW_STYLES = new Set(['sub', 'total']);
const kvTable = rows => h('div', { class: 'lk-kv' }, rows.filter(Boolean).map(([k, v, x]) => h('div', { class: `kv${ROW_STYLES.has(x) ? ` ${x}` : ''}` },
  h('span', { class: 'muted' }, k, x && !ROW_STYLES.has(x) ? tip(x) : null), h('span', { class: 'num' }, v))));
const NETWORK_ROW = ['Network', 'Small SOL / TNK', NETWORK];
const feeTable = fees => [...feeRows(fees, store.settings?.service).map(([k, v, x]) => [k, v, k === 'Service fee' ? FEES : x]), NETWORK_ROW];
const pill = p => {
  const w = releaseWait(p, nowSec());
  const el = h('span', { class: `lk-pill ${toneOf(p)}` }, stateLabel(p));
  if (!w) return el;
  const bar = h('i');
  if (w.progress != null) bar.style.width = `${Math.round(Math.min(1, w.progress) * 100)}%`;
  return hint(h('span', { class: 'lk-release', tabindex: '0' }, el, w.progress != null ? h('span', { class: 'lk-bar', 'aria-hidden': 'true' }, bar) : null,
    w.text ? h('span', { class: 'muted' }, w.text) : null), w.tip);
};
const signed = f => (f ? h('span', { class: f.sign === '+' ? 'up' : 'down' }, f.sign === '+' ? '+' : '−', f.amount.text, h('span', { class: 'unit' }, f.amount.unit)) : '—');
// Block and time left; on a phone the time only (the block when the height is not known).
const until = (block, left) => (block == null ? '—' : left == null ? blockNo(block)
  : [h('span', { class: 'hide-s' }, blockNo(block)), h('span', { class: 'muted' }, h('span', { class: 'hide-s' }, ' · '), left > 0 ? short(left) : 'reached')]);
const per = (total, amount) => { const v = priceText(total, amount); return v ? [v, h('span', { class: 'unit' }, 'USDC')] : '—'; };

// One button of a choice, remembered in this browser.
function choice(cls, items, key, fallback, onPick, aria) {
  let current = items.some(([k]) => k === localStorage.getItem(key)) ? localStorage.getItem(key) : fallback;
  const buttons = items.map(([k]) => h('button', { type: 'button', role: 'tab', 'data-k': k, onclick: () => pick(k) }));
  const mark = () => buttons.forEach(b => b.setAttribute('aria-selected', String(b.dataset.k === current)));
  const relabel = asset => buttons.forEach((b, i) => { const l = items[i][1]; b.textContent = typeof l === 'function' ? l(asset) : l; });
  function pick(k) { current = k; localStorage.setItem(key, k); mark(); onPick(k); }
  mark(); relabel('RESET');
  return { el: h('div', { class: cls, role: 'tablist', 'aria-label': aria ?? null }, buttons), relabel, pick, get value() { return current; } };
}

// ---- Dialog step: the numbers from /api/locks/preview, the fee table, one risk line, then Confirm. The confirmation
// lasts two minutes; an open dialog reads it again quietly, and an expired one is refreshed on Confirm.
const race = onRace => { onRace?.(); show(h('h3', null, 'Already taken'), h('p', null, RACE), h('div', { class: 'actions' }, close())); };
const failed = (heading, e) => show(h('h3', null, heading), line('error', errorText(e)), h('div', { class: 'actions' }, close()));
async function step({ heading, input, rows = [], risk, more, done, onRace, onDone }) {
  show(h('h3', null, heading), h('p', { class: 'muted' }, 'Checking…'));
  const preview = () => call('/api/locks/preview', input);
  let p, timer = 0;
  try { p = await preview(); } catch (e) { return raced(e) ? race(onRace) : failed(heading, e); }
  draw();
  function draw(note) {
    clearTimeout(timer);
    const confirm = h('button', { class: 'primary', type: 'button', onclick: async () => {
      clearTimeout(timer); confirm.disabled = true; confirm.textContent = 'Working…';
      try {
        const r = await call('/api/locks/act', { ...(p.input ?? input), confirm: p.confirm });
        show(h('h3', null, 'Done'), h('p', null, r.result?.text ?? done), h('div', { class: 'actions' }, close()));
        onDone?.(); refreshNow();
      } catch (e) {
        if (e.reason === 'confirmation_expired') { try { p = await preview(); return draw('Refreshed. Check and confirm again.'); } catch (e2) { e = e2; } }
        raced(e) ? race(onRace) : failed('It did not go through', e);
      }
    } }, 'Confirm');
    show(h('h3', null, heading), kvTable([...rows, ...feeTable(p.fees)]),
      h('p', { class: 'lk-risk' }, risk, tip([p.sentence, more].filter(Boolean), 'In full')),
      note ? h('p', { class: 'lk-msg' }, note) : null,
      h('div', { class: 'actions' }, confirm, h('button', { type: 'button', onclick: () => document.querySelector('#dialog').close() }, 'Back')));
    timer = setTimeout(async () => { if (!confirm.isConnected || confirm.disabled) return; try { p = await preview(); if (confirm.isConnected) draw(); } catch { /* Confirm refreshes it */ } }, REFRESH_MS);
  }
}

// ---- Book: other traders' open requests or offers as an exchange table, paged by the trader, with term chips.
const TERM_FILTERS = [['all', 'All', {}], ['1d', '≤ 1 day', { maxTerm: 144 }], ['1w', '≤ 1 week', { maxTerm: 1008 }], ['long', '> 1 week', { minTerm: 1009 }]];
function bookPanel({ product, asset, title, cols, heads, cells, emptyLine, emptyAction, onPick, onFirst }) {
  const gone = new Set(), count = h('span', { class: 'count' });
  let term = 'all', picked = null;
  const lost = o => {
    gone.add(o.positionId);
    list.el.querySelector(`.vl-row[data-id="${o.positionId}"] .end`)?.replaceChildren(hint(h('span', { class: 'lk-pill off', tabindex: '0' }, 'Taken'), RACE));
  };
  const take = (o, cleared) => takeStep(product, asset, o, () => { lost(o); cleared?.(); }, () => { gone.add(o.positionId); cleared?.(); });
  const row = o => {
    const lost = gone.has(o.positionId);
    return h('div', { class: `vl-row${picked === o.positionId ? ' picked' : ''}`, role: 'listitem', 'data-id': o.positionId },
      h('div', { class: `cells ${cols}`, role: 'button', tabindex: '0', onclick: () => pick(o), onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(o); } } },
        cells(o), cell('end', lost ? hint(h('span', { class: 'lk-pill off', tabindex: '0' }, 'Taken'), RACE)
          : h('button', { type: 'button', class: 'small primary', onclick: e => { e.stopPropagation(); take(o); } }, TAKE[product]))));
  };
  function pick(o) {
    picked = o.positionId;
    for (const r of list.el.querySelectorAll('.vl-row[data-id]')) r.classList.toggle('picked', r.dataset.id === picked);
    onPick?.(o);
  }
  const empty = h('div', { class: 'lk-empty', hidden: true }, h('span', null, emptyLine), emptyAction ? h('button', { type: 'button', class: 'small', onclick: emptyAction[1] }, emptyAction[0]) : null);
  const list = serverList({ size: PAGE, rowHeight: ROW, key: o => o.positionId, label: title, emptyText: '', row,
    fetchBlock: offset => call(`/api/locks?${q({ product, asset, page: offset / PAGE, ...TERM_FILTERS.find(([k]) => k === term)[2] })}`),
    onPage: p => { count.textContent = p.total ? String(p.total) : ''; empty.hidden = p.total > 0; if (p.page === 0) onFirst?.(p.rows?.find(o => !gone.has(o.positionId)) ?? null); } });
  const chips = h('div', { class: 'lk-chips', role: 'group', 'aria-label': 'Term' }, TERM_FILTERS.map(([k, l]) =>
    h('button', { type: 'button', 'data-k': k, 'aria-pressed': String(k === term), onclick: () => {
      term = k; for (const b of chips.children) b.setAttribute('aria-pressed', String(b.dataset.k === k)); list.reset();
    } }, l)));
  const el = h('section', { class: 'panel lk-book' }, h('header', { class: 'panel-head' }, h('h2', null, title), count, chips),
    h('div', { class: 'table' }, head(cols, heads), list.el, empty));
  return { el, refresh: () => list.refresh(), take, gone };
}

// Taking one offer: the dialog with its numbers. Loans are lent in full; calls and puts are bought for their fee.
const TAKE_DONE = { loan: 'Payment sent. Follow it under My loans.', call: 'Fee sent. Follow it under My options.', put: 'Locking and fee sent. Follow it under My options.' };
const TAKE_RISK = { loan: 'Not paid back in time? The security is yours.', call: 'Unused, the fee is not returned.', put: 'Unused, the fee is not returned.' };
function offerRows(o) {
  if (o.product === 'loan') {
    const r = loanRate(o.principal, o.repay, o.termBlocks);
    return [['You lend', money(o.principal)], ['You get back', money(o.repay)], ['Rate', r ? `${r.rate} · ${r.apr} a year` : '—'], ['Term', `${blockNo(o.termBlocks)} blocks · ${short(o.termBlocks)}`],
      ['Security', `${money(o.collateral)}${o.collateralNow ? ` · ~${o.collateralNow.text} USDC` : ''}`, BLOCKS]];
  }
  return [['Size', money(o.amount)], ['Price / coin', `${priceText(o.strikeTotal, o.amount) ?? '—'} USDC`], ['Total', money(o.strikeTotal)], ['Fee', money(o.premium)],
    ['Until', `${blockNo(o.expiryBlock)}${o.blocksLeft == null ? '' : ` · ${short(o.blocksLeft)}`}`, BLOCKS], o.priceNow ? ['Value now', `~${money(o.priceNow)}`] : null];
}
function takeStep(product, asset, o, onRace, onDone) {
  return step({ heading: `${TAKE[product]} ${product === 'loan' ? money(o.principal) : money(o.amount)}`, input: { action: 'take', product, asset, positionId: o.positionId },
    rows: offerRows(o), risk: TAKE_RISK[product], more: product === 'loan' ? LOAN_RISK : OPTION_RISK, done: TAKE_DONE[product], onRace, onDone });
}

// ---- Order ticket: post a request or an offer. Fields, a summary that fills in from /api/locks/preview (fee table
// and one risk line), one button. The preview's confirmation is read again before it lapses.
const strikeTotal = (price, amount) => {
  if (!positive(price ?? '') || !positive(amount ?? '')) return null;
  const total = mulDecimal(price, amount, 6);
  return positive(total) ? total : null;
};
const free = asset => store.balances?.[asset]?.free ?? null;
const POST_RISK = { loan: () => 'Miss the due block: the lender keeps it.', call: a => `Your ${a} stays locked until the end.`, put: () => 'Your USDC stays in escrow until the end.' };
function postForm({ product, asset, button, done }) {
  const loan = product === 'loan';
  const inputs = {};
  const input = (name, label, unit, extra) => {
    inputs[name] = h('input', { name, inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false', placeholder: '0', oninput: edited });
    return h('label', null, h('span', null, label, extra ? tip(extra) : null), h('div', { class: 'affix' }, inputs[name], h('span', { class: 'unit' }, unit)));
  };
  let blocks = loan ? 2016 : 1008, ready = null, seq = 0, timer = 0, message = null;
  const presets = TERMS.map(([b, label]) => h('button', { type: 'button', 'data-b': b, title: `${blockNo(b)} blocks`, onclick: () => { blocks = b; mark(); edited(); } }, label));
  const mark = () => presets.forEach(p => p.setAttribute('aria-pressed', String(Number(p.dataset.b) === blocks)));
  const fields = loan
    ? [input('principal', 'Borrow amount', 'USDC'), input('collateral', 'Security', asset), h('div', { class: 'lk-field' }, h('span', null, 'Pay back within', tip(BLOCKS)), h('div', { class: 'lk-terms', role: 'group' }, presets)), input('fee', 'Fee you offer', 'USDC')]
    : [input('amount', product === 'call' ? 'Size' : 'Size to buy', asset), input('strikePrice', 'Price / coin', 'USDC'), h('div', { class: 'lk-field' }, h('span', null, 'Until', tip(BLOCKS)), h('div', { class: 'lk-terms', role: 'group' }, presets)), input('premium', 'Fee you ask', 'USDC')];
  const summary = h('div', { class: 'summary' }), risk = h('p', { class: 'lk-risk', hidden: true }), msg = h('p', { class: 'lk-msg', hidden: true });
  const submit = h('button', { type: 'button', class: 'primary wide', onclick: send }, button);
  const el = h('div', { class: 'lk-post' }, h('div', { class: 'fields' }, fields), summary, risk, msg, submit);
  const values = () => Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, plain(i.value)]));
  const say = (text, bad) => { message = text ? { text, bad } : null; draw(); };
  mark(); submit.disabled = true; draw();

  function payload() {
    const v = values();
    if (!Object.entries(v).every(([k, x]) => (['fee', 'premium'].includes(k) ? fee(x) : positive(x)))) return null;
    if (loan) return { action: 'post', product, asset, principal: v.principal, collateral: v.collateral, fee: v.fee, repay: addDecimal(v.principal, v.fee, 6), termBlocks: blocks };
    const total = strikeTotal(v.strikePrice, v.amount);
    return store.counted == null || !total ? null : { action: 'post', product, asset, amount: v.amount, strikeTotal: total, premium: v.premium, expiryBlock: store.counted + blocks };
  }
  // The numbers the reader can check before the preview answers, then the fee table and the risk line from it.
  function draw() {
    const v = values(), price = store.prices[asset], rows = [];
    const lock = loan || product === 'call' ? asset : 'USDC';
    rows.push(['Available', free(lock) ? money(free(lock)) : '—']);
    if (loan) {
      const back = positive(v.principal) && fee(v.fee) ? `${addDecimal(v.principal, v.fee, 6)} USDC` : '—';
      const value = positive(v.collateral) && price ? Number(v.collateral) * price : null;
      const rate = positive(v.principal) && fee(v.fee) ? loanRate({ text: v.principal }, { text: addDecimal(v.principal, v.fee, 6) }, blocks) : null;
      const ltv = value && positive(v.principal) ? loanToValue({ text: v.principal }, { text: String(value) }) : null;
      rows.push(['Pay back', back], ['Rate', rate ? `${rate.rate} · ${rate.apr} a year` : '—'], ['Security value', value ? `~${usd(value)} USDC${ltv ? ` · LTV ${ltv}` : ''}` : '—'],
        ['Due', store.counted == null ? `in ${blockNo(blocks)} blocks` : `${blockNo(store.counted + blocks)} · ${short(blocks)}`]);
    } else {
      const total = strikeTotal(v.strikePrice, v.amount), value = positive(v.amount) && price ? Number(v.amount) * price : null;
      rows.push(['Total', total ? `${total} USDC` : '—'], ['Value now', value ? `~${usd(value)} USDC` : '—'],
        ['Until', store.counted == null ? 'Waiting for block height' : `${blockNo(store.counted + blocks)} · ${short(blocks)}`]);
    }
    if (ready) rows.push(...feeTable(ready.fees));
    fill(summary, kvTable(rows));
    risk.hidden = !ready;
    if (ready) fill(risk, POST_RISK[product](asset), tip([ready.sentence, loan ? LOAN_RISK : OPTION_RISK], 'In full'));
    msg.hidden = !message; msg.className = `lk-msg${message?.bad ? ' bad' : ''}`;
    if (message) fill(msg, shortError(message.text)[0], shortError(message.text)[1] ? tip(message.text) : null);
  }
  function edited() { if (!message?.bad) message = null; changed(); }
  function changed() {
    const i = payload(), k = i && JSON.stringify(i);
    if (ready?.key === k && k) return draw();
    clearTimeout(timer); ready = null; submit.disabled = true; seq++;
    if (message?.bad) message = null;
    draw();
    if (i) timer = setTimeout(() => preview(i, k), 250);
  }
  async function preview(i, k) {
    const s = ++seq;
    try {
      const p = await call('/api/locks/preview', i);
      if (s !== seq) return;
      ready = { key: k, input: p.input ?? i, confirm: p.confirm, fees: p.fees, sentence: p.sentence };
      submit.disabled = false; draw();
      clearTimeout(timer); timer = setTimeout(() => { if (ready?.key === k) preview(i, k); }, REFRESH_MS);
    } catch (e) { if (s === seq) say(errorText(e), true); }
  }
  async function send() {
    if (!ready) return;
    const go = ready;
    submit.disabled = true; submit.textContent = 'Working…';
    try {
      await call('/api/locks/act', { ...go.input, confirm: go.confirm });
      for (const i of Object.values(inputs)) i.value = '';
      ready = null; message = { text: done }; changed();
      refreshNow();
    } catch (e) {
      const i = e.reason === 'confirmation_expired' && payload();
      if (i) { ready = null; await preview(i, JSON.stringify(i)); if (ready) say('Refreshed. Check and press again.', true); }
      else { say(errorText(e), true); submit.disabled = false; }
    }
    submit.textContent = button;
  }
  // A new counted block moves an options deadline: read the preview again.
  return { el, sync: () => { if (ready && ready.key !== JSON.stringify(payload())) changed(); else draw(); }, focus: () => Object.values(inputs)[0].focus() };
}

// The ticket's take side: the offer picked in the book (or the newest one), its numbers, one button.
function takePanel({ product, asset, book, emptyLine }) {
  let offer = null;
  const body = h('div', { class: 'summary' }), risk = h('p', { class: 'lk-risk' }, TAKE_RISK[product], tip(product === 'loan' ? LOAN_RISK : OPTION_RISK));
  const button = h('button', { type: 'button', class: 'primary wide', onclick: () => offer && book().take(offer, () => set(null)) });
  const el = h('div', { class: 'lk-post' }, body, risk, button);
  function set(o) {
    offer = o && !book().gone.has(o.positionId) ? o : null;
    const lock = product === 'loan' ? 'USDC' : product === 'put' ? asset : 'USDC';
    fill(body, offer ? [h('div', { class: 'take-info' }, h('span', { class: 'muted' }, 'Picked'), h('span', null, product === 'loan' ? money(offer.principal) : `${money(offer.amount)} @ ${priceText(offer.strikeTotal, offer.amount)}`)),
      kvTable([...offerRows(offer), ['Available', free(lock) ? money(free(lock)) : '—']])] : h('div', { class: 'take-info' }, h('span', { class: 'muted' }, emptyLine)));
    risk.hidden = !offer;
    button.disabled = !offer;
    button.textContent = offer ? `${TAKE[product]} ${product === 'loan' ? money(offer.principal) : money(offer.amount)}` : TAKE[product];
  }
  set(null);
  return { el, set, get offer() { return offer; } };
}

// ---- The reader's positions: one table, newest first, filters with counts, one button per row; a row opens a detail
// panel (key-value grid and the step tracker).
const FILTERS = [['all', 'All'], ['active', 'Running'], ['open', 'Open'], ['done', 'Completed'], ['failed', 'Failed or cancelled']];
const ACT_DONE = {
  repay: p => `Payment sent. ${money(p.collateral)} releases in ~1–2h.`,
  exercise: p => (p.product === 'put' ? `Message sent. ${money(p.strikeTotal)} releases in ~1–2h.` : `Payment sent. ${money(p.amount)} releases in ~1–2h.`),
  cancel: () => 'Cancelled. What you locked comes back.',
  refund: p => `Refund sent. ${money(p.strikeTotal)} comes back.`,
};
function actRows(p, action) {
  if (action === 'repay') return [['You pay', money(p.repay)], ['You get back', money(p.collateral)]];
  if (action === 'exercise') return p.product === 'put' ? [['You sell', money(p.amount)], ['You get', money(p.strikeTotal)]] : [['You pay', money(p.strikeTotal)], ['You get', money(p.amount)]];
  if (action === 'refund') return [['You get back', money(p.strikeTotal)]];
  return [['Comes back', p.product === 'put' ? money(p.strikeTotal) : money(p.collateral ?? p.amount)]];
}
const ACT_RISK = { repay: 'Pay the full amount; a partial payment counts as nothing.', exercise: 'Counts only before the end block.', cancel: 'The offer leaves the book.', refund: 'Only after the refund time.' };
function act(p) {
  const a = actionOf(p).action;
  step({ heading: actionHeading(p), input: { action: a, product: p.product, asset: assetOf(p), positionId: p.positionId }, rows: actRows(p, a),
    risk: ACT_RISK[a] ?? '', more: ['repay', 'exercise'].includes(a) ? RELEASE : null, done: ACT_DONE[a]?.(p) ?? 'Done.' });
}

function detail(p) {
  const loan = isLoan(p), d = deadlineOf(p), w = releaseWait(p, nowSec());
  const kv = (k, v, more) => (v == null || v === '' ? null : h('div', { class: 'stat' }, h('span', { class: 'k' }, k, more ? tip(more) : null), h('span', { class: 'v' }, v)));
  const rate = loan ? loanRate(p.principal, p.repay, p.termBlocks) : null;
  const items = loan ? [
    kv(p.role === 'maker' ? 'Borrowed' : 'Lent', units(p.principal)), kv(p.role === 'maker' ? 'Pay back' : 'Get back', units(p.repay)),
    kv('Rate', rate ? `${rate.rate} · ${rate.apr}/yr` : null), kv('Security', units(p.collateral)), kv('Security now', p.collateralNow ? ['~', units(p.collateralNow)] : null),
    kv('Term', p.termBlocks ? `${blockNo(p.termBlocks)} blocks · ${short(p.termBlocks)}` : null),
  ] : [
    kv('Size', units(p.amount)), kv('Price / coin', per(p.strikeTotal, p.amount)), kv('Total', units(p.strikeTotal)), kv('Fee', units(p.premium)),
    kv('Value now', p.priceNow ? ['~', units(p.priceNow)] : null),
    p.product === 'put' && p.role === 'maker' && (p.refundAfter || p.recovery) && !isDone(p)
      ? kv('Refund after', p.refundAfter ? new Date(p.refundAfter * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—', p.recovery) : null,
  ];
  const facts = [
    kv(loan ? 'Due' : 'Until', d ? [d.block, d.left ? h('span', { class: 'muted' }, ` · ${d.left}`) : null] : null, BLOCKS),
    kv('Paid', w && Number.isFinite(p.paidAt) ? hhmm(p.paidAt) : null), kv('Bitcoin clock', w && Number.isFinite(p.bitcoinTime) ? hhmm(p.bitcoinTime) : null, RELEASE),
    kv('With', p.counterparty ?? null), kv('Created', p.createdAt ? relative(p.createdAt) : null),
    !isDone(p) && !isPaid(p) && p.ifMissed ? kv('At deadline', shortError(p.ifMissed, 40)[0], shortError(p.ifMissed, 40)[1]) : null,
    kv('Status', [h('span', { class: `lk-pill ${toneOf(p)}` }, stateLabel(p))], p.now),
  ];
  return h('div', { class: 'detail lk-detail' },
    h('ol', { class: 'lk-steps', 'aria-label': 'Progress' }, steps(p).map(s => h('li', { class: `lk-step s-${s.at}` }, s.label))),
    h('div', { class: 'lk-facts' }, items, facts),
    p.whatToDo || p.reason ? line('error', p.whatToDo ?? p.reason) : null);
}

const POS_HEADS = [['Product'], ['Coin & size', 'num'], ['Price / coin', 'num hide-s'], ['You pay / get', 'num hide-s'], ['Deadline', 'hide-s lk-dl', BLOCKS], ['Status'], [''], ['']];
function posRow(p, { open, toggle }) {
  const a = actionShort(p), must = needsAction(p), d = deadlineOf(p), size = sizeOf(p), side = sideLabel(p);
  const button = a ? h('button', { type: 'button', class: `small${must ? ' primary' : ''}`, onclick: e => { e.stopPropagation(); act(p); } }, a) : null;
  return h('div', { class: `vl-row${open ? ' open' : ''}${isDone(p) ? ' done' : ''}`, role: 'listitem' },
    h('div', { class: 'cells cols-lk-pos', tabindex: '0', role: 'button', 'aria-expanded': String(open), onclick: toggle,
      onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } } },
    cell('lk-prod', p.lit ? h('span', { class: 'lk-dot', title: 'New', 'aria-label': 'New' }) : null, productLabel(p), side ? h('span', { class: `lk-side ${side === 'bought' ? 'up' : 'down'}` }, side) : null),
    cell('num', units(size)), cell('num hide-s', isLoan(p) ? per(p.principal, p.collateral) : per(p.strikeTotal, p.amount)), cell('num hide-s', signed(flowOf(p))),
    cell('hide-s lk-dl', d ? [d.block, d.left ? h('span', { class: 'muted' }, ` · ${d.left}`) : null] : h('span', { class: 'muted' }, '—')),
    cell('lk-status', pill(p)), cell('end', button), h('span', { class: 'chev', 'aria-hidden': 'true' }, open ? '▾' : '▸')),
    open ? detail(p) : null);
}

function positions({ heading, filter, emptyLine, emptyAction, setting: [name, label, tipText] }) {
  const list = virtualList({ rowHeight: ROW, key: p => p.positionId, label: heading, emptyText: '', className: 'lk-pos', row: posRow });
  const feed = virtualList({ rowHeight: ROW, key: e => e.id ?? `${e.at}:${e.text}`, label: 'Activity', emptyText: 'Nothing has happened yet.',
    row: e => h('div', { class: 'vl-row', role: 'listitem' }, h('div', { class: 'cells cols-lk-feed' }, cell('muted', h('span', { title: new Date(e.at).toLocaleString() }, e.rel)), cell('clip', e.text))) });
  const lit = new Set();
  let shown = 'all', tab = 'mine';
  const box = h('input', { type: 'checkbox', onchange: async () => {
    box.disabled = true;
    try { const r = await call('/api/locks/settings', { [name]: box.checked }); store.settings = r && name in r ? r : { ...store.settings, [name]: box.checked }; } catch { /* shown as it was */ }
    box.disabled = false; api.render();
  } });
  const auto = h('label', { class: 'inline lk-auto', hidden: true }, box, label, h('span', { class: 'muted hide-s' }, 'while app runs'), tip(() => [tipText(store.settings ?? {}), ONLINE(name === 'autoRepay' ? 'paying back' : 'use')]));
  const need = h('span', { class: 'lk-need', hidden: true });
  const tabs = { mine: h('span', { class: 'count' }), feed: h('span', { class: 'count' }) };
  const bar = h('div', { class: 'bottom-tabs', role: 'tablist' }, [['mine', heading], ['feed', 'Activity']].map(([k, l]) =>
    h('button', { type: 'button', role: 'tab', 'data-k': k, onclick: () => { tab = k; api.render(); } }, l, tabs[k])), h('span', { class: 'lk-bar-end' }, need, auto));
  const chips = h('div', { class: 'lk-chips filters', role: 'group', 'aria-label': 'Show' }, FILTERS.map(([k]) =>
    h('button', { type: 'button', 'data-k': k, onclick: () => { shown = k; api.render(); } })));
  const empty = h('div', { class: 'lk-empty', hidden: true }, h('span'), h('button', { type: 'button', class: 'small' }));
  const mineTable = h('div', { class: 'table lk-pos-table' }, head('cols-lk-pos', POS_HEADS), list.el, empty);
  const feedTable = h('div', { class: 'table', hidden: true }, head('cols-lk-feed', [['When'], ['Event']]), feed.el);
  const el = h('section', { class: 'panel bottom lk-positions' }, bar, chips, h('div', { class: 'bottom-body' }, mineTable, feedTable));
  const api = {
    el,
    render() {
      for (const b of bar.querySelectorAll('[data-k]')) b.setAttribute('aria-selected', String(b.dataset.k === tab));
      chips.hidden = tab !== 'mine'; mineTable.hidden = tab !== 'mine'; feedTable.hidden = tab !== 'feed';
      auto.hidden = !store.settings;
      if (store.settings) box.checked = !!store.settings[name];
      if (!store.loaded) return;
      const mine = store.rows.filter(filter), n = mine.filter(needsAction).length, hot = mine.some(p => needsAction(p) && urgent(p));
      // Rows that were unread when this tab came on screen keep their dot until the reader leaves the tab.
      if (el.isConnected) { for (const p of mine) if (alerting(p)) lit.add(seenKey(p)); markSeen(mine); } else lit.clear();
      const rows = mine.filter(p => shown === 'all' || groupOf(p) === shown).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
        .map(p => ({ ...p, lit: lit.has(seenKey(p)) && needsAction(p), tick: Math.floor(Date.now() / 60000) }));
      for (const b of chips.children) {
        const c = b.dataset.k === 'all' ? mine.length : mine.filter(p => groupOf(p) === b.dataset.k).length;
        fill(b, FILTERS.find(([k]) => k === b.dataset.k)[1], c ? h('span', { class: 'count' }, String(c)) : null);
        b.setAttribute('aria-pressed', String(b.dataset.k === shown));
      }
      tabs.mine.textContent = mine.length ? String(mine.length) : '';
      tabs.feed.textContent = '';
      list.set(rows.length, i => rows[i]);
      const filtered = shown !== 'all' && mine.length > 0;
      empty.hidden = rows.length > 0;
      empty.firstChild.textContent = filtered ? `Nothing ${FILTERS.find(([k]) => k === shown)[1].toLowerCase()}.` : emptyLine;
      fill(empty.lastChild, filtered ? 'Show all' : emptyAction[0]);
      empty.lastChild.onclick = filtered ? () => { shown = 'all'; api.render(); } : emptyAction[1];
      need.hidden = !n;
      fill(need, 'Needs action', h('span', { class: `count${hot ? ' hot' : ''}` }, String(n)));
      // Events of this tab's positions, and the general ones (settings).
      const ids = new Set(mine.map(p => p.positionId));
      const events = store.events.filter(e => (e.product ? filter({ product: e.product }) : !e.positionId || ids.has(e.positionId)))
        .map(e => ({ ...e, rel: relative(e.at / 1000) }));
      feed.set(events.length, i => events[i]);
    },
  };
  return api;
}

// ---- One tab: the market bar, book + ticket per asset, the positions panel.
function marketBar({ asset, stats, help }) {
  const values = h('div', { class: 'lk-stats' }), last = h('span', { class: 'lk-last clip' });
  const el = h('section', { class: 'pairbar lk-bar' }, asset.el, values, h('div', { class: 'lk-bar-right' }, last,
    h('button', { type: 'button', class: 'link small', onclick: help }, 'How it works'), DEMO ? h('span', { class: 'badge' }, 'Demo') : null));
  const stat = (k, v, c) => h('div', { class: 'stat' }, h('span', { class: 'k' }, k), h('span', { class: `v ${c ?? ''}` }, v));
  return {
    el,
    set() {
      fill(values, stats().map(([k, v, c]) => stat(k, v, c)));
      const e = store.events[0];
      last.textContent = e ? `${e.text} · ${relative(e.at / 1000)}` : '';
      last.title = last.textContent;
    },
  };
}
function helpDialog(title, sections) {
  show(h('h3', null, title), h('div', { class: 'lk-explain' }, sections.map(([k, t]) => [h('h4', null, k), h('p', null, typeof t === 'function' ? t() : t)])), h('div', { class: 'actions' }, close()));
}

function tabView({ asset, bar, build, mine }) {
  const market = h('div', { class: 'lk-market' }), built = {};
  const el = h('div', { class: 'lk' }, bar.el, market, mine.el);
  const current = () => (built[asset.value] ??= build(asset.value));
  const open = () => { const c = current(); c.mount?.(); fill(market, c.book.el, c.ticket.el); c.book.refresh(); };
  store.listeners.add(() => { bar.set(); mine.render(); built[asset.value]?.sync?.(); });
  open();
  return {
    el, current,
    switched() { open(); bar.set(); },
    update(data) {
      for (const a of ASSETS) {
        const lastPrice = data.trader?.pairs?.find(p => p.pair === `${a}/USDC`)?.last;
        if (lastPrice && store.prices[a] == null) store.prices[a] = Number(lastPrice);
      }
      store.balances = data.trader?.balances ?? store.balances;
      built[asset.value]?.book.refresh(); bar.set(); mine.render();
    },
  };
}
const assetSwitch = (key, onPick) => choice('pairs', ASSETS.map(a => [a, a]), key, 'RESET', onPick, 'Asset');
const priceStat = a => ['Price', store.prices[a] ? [usd(store.prices[a]), h('span', { class: 'unit' }, 'USDC')] : '—'];
const mineStats = filter => {
  const mine = store.rows.filter(filter), n = mine.filter(needsAction).length;
  return [['Block', store.counted == null ? '—' : blockNo(store.counted)], ['Running', String(mine.filter(p => groupOf(p) === 'active').length)], ['Needs action', String(n), n ? 'down' : '']];
};

export function lendView() {
  let view;
  const asset = assetSwitch('locks.asset.lend', () => view.switched());
  const mine = positions({ heading: 'My loans', filter: isLoan, emptyLine: 'No loans yet.', emptyAction: ['Borrow USDC', () => view.current().start()],
    setting: ['autoRepay', 'Pay back automatically', s => `Pays back ${s.autoRepayBlocks ?? 'a few'} blocks before the deadline from your free USDC.`] });
  const help = () => helpDialog('Borrow & Lend', [
    ['Loans', 'These are loans backed by RESET or TNK (collateralized loans). The borrower locks RESET or TNK as collateral and sets the amount, the fee (the interest) and the term. A lender takes the whole request and pays the USDC straight to the borrower. If the borrower pays back the full amount before the due block, the collateral goes back to them; if not, it goes to the lender.'],
    ['Fees', FEES], ['Network', NETWORK], ['Pay back automatically', ONLINE('paying back')], ['What can go wrong', LOAN_RISK], ['Signers', SIGNERS], ['Blocks and release', BLOCKS]]);
  const bar = marketBar({ asset, help, stats: () => [priceStat(asset.value), ...mineStats(isLoan)] });
  view = tabView({ asset, bar, mine, build: a => {
    let take;
    const post = postForm({ product: 'loan', asset: a, button: 'Ask to borrow', done: 'Request posted. It shows under My loans.' });
    const book = bookPanel({ product: 'loan', asset: a, title: `Loan requests · ${a} security`, cols: 'cols-lk-loans',
      heads: [['Amount', 'num'], ['Get back', 'num hide-s'], ['Rate', 'num'], ['Term', 'num'], ['Security', 'num'], ['LTV', 'num hide-s'], ['']],
      cells: o => { const r = loanRate(o.principal, o.repay, o.termBlocks); return [cell('num', units(o.principal)), cell('num hide-s', units(o.repay)),
        cell('num', r ? h('span', { title: `about ${r.apr} a year` }, r.rate) : '—'), cell('num', short(o.termBlocks)), cell('num', units(o.collateral)),
        cell('num hide-s muted', loanToValue(o.principal, o.collateralNow) ?? '—')]; },
      emptyLine: `No requests against ${a} yet.`, emptyAction: ['Borrow instead', () => ticket.pick('borrow')],
      onPick: o => { ticket.pick('lend'); take.set(o); }, onFirst: o => { if (!take.offer) take.set(o); } });
    take = takePanel({ product: 'loan', asset: a, book: () => book, emptyLine: 'Pick a request in the book.' });
    const body = h('div');
    const ticket = choice('modes', [['borrow', 'Borrow USDC'], ['lend', 'Lend USDC']], 'locks.lend', 'borrow', k => fill(body, k === 'borrow' ? post.el : take.el));
    fill(body, ticket.value === 'borrow' ? post.el : take.el);
    return { book, ticket: { el: h('section', { class: 'panel entry lk-ticket' }, ticket.el, body) }, sync: () => post.sync(), start: () => { ticket.pick('borrow'); post.focus(); } };
  } });
  return view;
}

export function optionsView() {
  let view;
  const asset = assetSwitch('locks.asset.options', () => view.switched());
  const mine = positions({ heading: 'My options', filter: p => !isLoan(p), emptyLine: 'No options yet.', emptyAction: ['Offer one', () => view.current().start()],
    setting: ['autoExercise', 'Use automatically', () => 'Uses a right shortly before it ends when the DEX price makes it worth it.'] });
  const help = () => helpDialog('Options', [
    ['Calls', 'Earn on your RESET or TNK is selling a covered call: you lock it and set a strike (the fixed price) and an expiry (until). Whoever pays your premium (the fee) may buy it at the strike until expiry, in one full payment. If they do not, it comes back to you and you keep the fee. Reserve is buying such a call.'],
    ['Puts', 'Protect is buying a put: you lock your RESET or TNK for the term and pay the premium. Until expiry you may sell it at the strike with one click (a small Solana message; no coins move at that moment). If you do not, it comes back to you and the fee is not returned. Earn on your USDC is the other side (a cash-secured put): your strike in USDC waits in the Solana escrow.'],
    ['Use automatically', 'With the automatic setting on, your app uses a right shortly before the end when the DEX price makes it worth it. ' + ONLINE('use') + ' An option that is not used in time ends, and its fee is not returned.'],
    ['Fees', FEES], ['Network', NETWORK], ['What can go wrong', OPTION_RISK], ['Signers', SIGNERS], ['Blocks and release', BLOCKS]]);
  const side = choice('sides lk-sides', [['call', 'Calls'], ['put', 'Puts']], 'locks.side.options', 'call', () => view.switched());
  const bar = marketBar({ asset, help, stats: () => [priceStat(asset.value), ...mineStats(p => !isLoan(p))] });
  view = tabView({ asset: { get value() { return `${asset.value}/${side.value}`; } }, bar, mine, build: key => {
    const [a, product] = key.split('/'), call = product === 'call';
    let take;
    const post = postForm({ product, asset: a, button: call ? `Offer ${a} call` : 'Offer put', done: 'Offer posted. It shows under My options.' });
    const book = bookPanel({ product, asset: a, title: call ? `Calls · reserve ${a}` : `Puts · protect ${a}`, cols: 'cols-lk-chain',
      heads: [['Coin', 'hide-s'], ['Size', 'num'], ['Price / coin', 'num'], ['Total', 'num hide-s'], ['Fee', 'num'], ['Until', 'num', BLOCKS], ['']],
      cells: o => [cell('hide-s muted', assetOf(o)), cell('num', o.amount.text), cell('num', per(o.strikeTotal, o.amount)), cell('num hide-s', units(o.strikeTotal)),
        cell('num', units(o.premium)), cell('num', until(o.expiryBlock, o.blocksLeft))],
      emptyLine: call ? `No ${a} calls yet.` : `No ${a} puts yet.`, emptyAction: ['Offer one', () => modes.pick('post')],
      onPick: o => { modes.pick('take'); take.set(o); }, onFirst: o => { if (!take.offer) take.set(o); } });
    take = takePanel({ product, asset: a, book: () => book, emptyLine: 'Pick an offer in the book.' });
    const body = h('div');
    const modes = choice('modes', [['post', call ? `Earn on ${a}` : 'Earn on USDC'], ['take', call ? `Reserve ${a}` : `Protect ${a}`]], `locks.mode.${product}`, 'post', k => fill(body, k === 'post' ? post.el : take.el));
    fill(body, modes.value === 'post' ? post.el : take.el);
    const el = h('section', { class: 'panel entry lk-ticket' }, side.el, modes.el, body);
    // The Calls / Puts switch is one element shared by every ticket of the tab.
    return { book, ticket: { el }, mount: () => el.prepend(side.el), sync: () => post.sync(), start: () => { modes.pick('post'); post.focus(); } };
  } });
  return view;
}
