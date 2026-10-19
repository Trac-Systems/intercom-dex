// The dashboard page. Everything shown comes from /api/state and /api/traffic; all text is inserted as text nodes.
const $ = s => document.querySelector(s);
const main = $('#main'), dialog = $('#dialog'), body = $('#dialog-body');
body.addEventListener('submit', e => e.preventDefault());
const pages = {}, expanded = new Set();
const filters = { channel: '', kind: '', trade: '', page: 0 };
let data = null, tab = null, trafficView = null;

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;   // CSSOM, allowed by the page's style policy (attributes are not)
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

// Times: local clock time (weekday when not today) with a relative hint.
function clock(ts) {
  const d = new Date(ts * 1000), now = new Date(), t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return t;
  if (Math.abs(d - now) < 6 * 86400000) return `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${t}`;
}
function relative(ts) {
  const s = ts - Date.now() / 1000, a = Math.abs(s);
  const v = a < 60 ? `${Math.round(a)} s` : a < 3600 ? `${Math.round(a / 60)} min` : a < 172800 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86400)} days`;
  return s >= 0 ? `in ${v}` : `${v} ago`;
}
const when = ts => (ts ? h('span', { title: new Date(ts * 1000).toLocaleString() }, clock(ts), h('span', { class: 'muted small' }, ` (${relative(ts)})`)) : h('span', { class: 'muted' }, '—'));
const amt = a => (a ? [a.text, h('span', { class: 'unit-s' }, a.unit)] : '—');
const num = a => h('td', { class: 'num' }, amt(a));
const bytes = n => (n < 1000 ? `${n} B` : n < 1e6 ? `${(n / 1000).toFixed(1)} KB` : `${(n / 1e6).toFixed(2)} MB`);
const empty = text => h('p', { class: 'empty' }, text);
const section = (title, extra, ...content) => h('section', null, h('h2', null, title, extra), content);
const tile = (label, value, unit, sub) => h('div', { class: 'tile' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value, unit ? h('span', { class: 'unit' }, unit) : null), sub ? h('div', { class: 'sub' }, sub) : null);
const table = (heads, rows) => h('div', { class: 'scroll' }, h('table', null, h('thead', null, h('tr', null, heads.map(([t, c]) => h('th', { class: c }, t)))), h('tbody', null, rows)));
const check = (ok, text, extra) => h('li', { class: ok ? 'ok' : '' }, h('span', { class: `icon ${ok ? 'ok' : 'bad'}`, 'aria-hidden': 'true' }, ok ? '✓' : '✕'), h('span', null, text, extra ? [' ', extra] : null));

function paged(key, items, size, draw) {
  const count = Math.max(1, Math.ceil(items.length / size)), p = Math.min(pages[key] ?? 0, count - 1);
  const go = n => () => { pages[key] = n; render(); };
  return [draw(items.slice(p * size, (p + 1) * size)), count > 1 ? h('div', { class: 'pager' },
    h('button', { class: 'small', type: 'button', disabled: p === 0, onclick: go(p - 1) }, '‹ Previous'), `Page ${p + 1} of ${count}`,
    h('button', { class: 'small', type: 'button', disabled: p >= count - 1, onclick: go(p + 1) }, 'Next ›')) : null];
}

function copyButton(text) {
  const b = h('button', { class: 'small', type: 'button', onclick: async () => {
    try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; }
    setTimeout(() => { b.textContent = 'Copy'; }, 1500);
  } }, 'Copy');
  return b;
}

async function api(path, payload) {
  const res = await fetch(path, payload === undefined ? { credentials: 'same-origin' }
    : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const value = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(value.error ?? `HTTP ${res.status}`);
  return value;
}

// ---- Dialogs: a form, then a review of exactly what happens, then the result.
function show(...content) { body.replaceChildren(...content.flat(Infinity).filter(x => x != null && x !== false)); if (!dialog.open) dialog.showModal(); }
const close = () => h('button', { type: 'button', onclick: () => dialog.close() }, 'Close');

async function review(action, input) {
  show(h('p', { class: 'muted' }, 'Checking…'));
  let p;
  try { p = await api('/api/preview', { action, input }); }
  catch (e) { return show(h('h3', null, 'Cannot do this'), h('p', { class: 'error' }, e.message), h('div', { class: 'actions' }, close())); }
  const confirm = h('button', { class: 'primary', type: 'button', onclick: async () => {
    confirm.disabled = true; confirm.textContent = 'Working…';
    try { result(action, (await api('/api/act', { action, input: p.input, confirm: p.confirm })).result); poll(); }
    catch (e) { show(h('h3', null, 'It did not go through'), h('p', { class: 'error' }, e.message), h('div', { class: 'actions' }, close())); }
  } }, 'Confirm');
  show(h('h3', null, p.title), h('dl', null, p.lines.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
    p.warning ? h('p', { class: 'warning' }, p.warning) : null, p.note ? h('p', { class: 'note' }, p.note) : null,
    h('div', { class: 'actions' }, confirm, h('button', { type: 'button', onclick: () => dialog.close() }, 'Back')));
}

function result(action, r) {
  const lines = {
    offer: () => ['Your offer is posted. It appears under My offers.'],
    take: () => ['The trade has started. Follow it under Running trades.'],
    cancel: () => ['The offer is cancelled.'],
    markPaid: () => [`Recorded: ${r.trades} trade(s) marked paid.`],
    withdraw: () => [`Status: ${r.status}`, `${r.amount.text} ${r.asset} to ${r.to}`, r.reason, r.tx ? ['Transaction: ', r.link ? h('a', { href: r.link, target: '_blank', rel: 'noopener noreferrer' }, r.tx) : h('code', null, r.tx)] : null],
  }[action]();
  show(h('h3', null, 'Done'), lines.filter(Boolean).map(l => h('p', null, l)), h('div', { class: 'actions' }, close()));
}

function form(title, fields, submit) {
  const el = h('div', { style: 'display:grid;gap:12px' }, fields);
  show(h('h3', null, title), el, h('div', { class: 'actions' },
    h('button', { class: 'primary', type: 'button', onclick: () => submit(Object.fromEntries([...el.querySelectorAll('[name]')].map(i => [i.name, i.type === 'checkbox' ? i.checked : i.value]))) }, 'Review'),
    h('button', { type: 'button', onclick: () => dialog.close() }, 'Cancel')));
}
const field = (label, input) => h('label', null, label, input);

function offerForm() {
  const pairs = data.trader.market.filter(p => p.status === 'open');
  if (!pairs.length) return show(h('h3', null, 'Make an offer'), h('p', null, 'No open pairs yet. They appear once the venue’s signer list arrives.'), close());
  form('Make an offer', [
    h('div', { class: 'row' }, field('Pair', h('select', { name: 'pair' }, pairs.map(p => h('option', { value: p.pair }, p.pair)))),
      field('I want to', h('select', { name: 'side' }, h('option', { value: 'sell' }, 'Sell'), h('option', { value: 'buy' }, 'Buy')))),
    h('div', { class: 'row' }, field('Amount', h('input', { name: 'amount', inputmode: 'decimal', placeholder: 'e.g. 10', required: true })),
      field('Price (USDC each)', h('input', { name: 'price', inputmode: 'decimal', placeholder: 'e.g. 0.25', required: true }))),
    field('Open for (minutes)', h('input', { name: 'ttlMin', type: 'number', min: 1, max: 1440, value: 60 })),
  ], v => review('offer', { ...v, ttlMin: Number(v.ttlMin) }));
}

function takeForm(o, p) {
  form(`${o.side === 'sell' ? 'Buy' : 'Sell'} ${p.base} at ${o.price} USDC`, [
    h('p', { class: 'note' }, `This offer has ${o.amount.text} ${p.base}. Leave the amount empty to take all of it.`),
    field('Amount', h('input', { name: 'amount', inputmode: 'decimal', placeholder: o.amount.text })),
  ], v => review('take', { offerId: o.offerId, amount: v.amount || undefined }));
}

function withdrawForm(a) {
  form(`Withdraw ${a.asset}`, [
    h('p', { class: 'note' }, `Free to withdraw: ${a.free.text} ${a.asset}`),
    field('Amount', h('input', { name: 'amount', inputmode: 'decimal', placeholder: 'e.g. 1.5' })),
    h('label', { style: 'display:flex;gap:8px;align-items:center' }, h('input', { type: 'checkbox', name: 'all' }), 'All free funds'),
    a.payoutLock ? h('p', null, 'Destination (fixed payout address): ', h('code', null, a.payoutLock))
      : field(`Destination (${a.chain === 'solana' ? 'Solana address' : 'trac1 address'})`, h('input', { name: 'to', autocomplete: 'off', spellcheck: 'false' })),
  ], v => review('withdraw', { asset: a.asset, amount: v.all ? 'all' : v.amount, to: v.to || undefined }));
}

// ---- Sections
function wallets(w) {
  if (!w) return null;
  const addresses = [...new Map(w.assets.map(a => [a.chain, a])).values()];
  return section('Wallets', w.readAt ? h('span', { class: 'muted' }, 'balances read ', when(w.readAt)) : null,
    w.error ? h('p', { class: 'error' }, `Balances could not be read just now (${w.error}). Showing the last known values.`) : null,
    w.notes.length ? h('ul', { class: 'attention' }, w.notes.map(n => h('li', null, h('span', { class: 'icon warn' }, '!'), n))) : null,
    h('div', { class: 'card', style: 'margin:10px 0' }, h('div', { class: 'small muted' }, 'Deposit addresses'),
      addresses.map(a => h('div', { class: 'copy', style: 'margin-top:6px' }, h('strong', null, a.chain === 'solana' ? 'Solana (USDC, SOL)' : 'Trac (TNK, RESET)'),
        h('code', null, a.address), copyButton(a.address)))),
    table([['Asset'], ['Total', 'num'], ['In use', 'num'], ['Free', 'num'], ['']], w.assets.map(a => h('tr', null,
      h('td', null, a.asset), num(a.total), h('td', { class: 'num', title: `offers ${a.parts.offers.text}, trades ${a.parts.trades.text}, locked ${a.parts.escrow.text}, fee reserve ${a.parts.fees.text}, withdrawals ${a.parts.withdrawals.text}` }, amt(a.inUse)),
      num(a.free), h('td', null, a.canWithdraw ? h('button', { class: 'small', type: 'button', onclick: () => withdrawForm(a) }, 'Withdraw') : null)))),
    w.withdrawals.length ? h('div', { style: 'margin-top:10px' }, h('div', { class: 'small muted' }, 'Withdrawals still being confirmed'),
      w.withdrawals.map(x => h('p', null, `${x.amount.text} ${x.asset} to `, h('code', null, x.to), ` — ${x.status}`, x.reason ? ` (${x.reason})` : '',
        x.link ? [' · ', h('a', { href: x.link, target: '_blank', rel: 'noopener noreferrer' }, 'transaction')] : null))) : null,
    w.storage ? h('details', { style: 'margin-top:10px', open: expanded.has('keys'), ontoggle: e => (e.target.open ? expanded.add('keys') : expanded.delete('keys')) },
      h('summary', null, 'Where your keys are and how to back them up'),
      h('div', { class: 'card', style: 'margin-top:8px;display:grid;gap:6px' },
        h('div', null, 'Encrypted key file: ', h('code', null, w.storage.keyringFile)),
        w.storage.tracWalletFile ? h('div', null, 'Encrypted Trac wallet: ', h('code', null, w.storage.tracWalletFile)) : null,
        h('div', null, 'Data folder: ', h('code', null, w.storage.dataDir)),
        h('div', null, 'Password comes from the environment setting ', h('code', null, w.storage.passwordEnv),
          w.storage.tracPasswordEnv && w.storage.tracPasswordEnv !== w.storage.passwordEnv ? [' (Trac wallet: ', h('code', null, w.storage.tracPasswordEnv), ')'] : null, '.'),
        w.backup ? [h('div', null, w.backup.instruction), h('div', { class: 'copy' }, h('code', null, w.backup.exportCommand), copyButton(w.backup.exportCommand)),
          h('div', { class: 'small muted' }, w.backup.exportInstruction)] : null)) : null);
}

function trader(t) {
  const b = t.balances;
  const tiles = h('div', { class: 'tiles' }, ['TNK', 'RESET', 'USDC'].map(a => (b ? tile(a, b[a].total.text, a, `free ${b[a].free.text}`) : tile(a, '—', null, 'reading…'))),
    b ? tile('SOL for fees', b.SOL.total.text, 'SOL', `free ${b.SOL.free.text}`) : tile('SOL for fees', '—'),
    tile('Signers online', String(t.signersOnline), null, t.registryVersion ? `signer list v${t.registryVersion}` : 'no signer list yet'));
  const attention = t.attention.length ? section('Needs attention', null, h('ul', { class: 'attention' }, t.attention.map(a =>
    h('li', { class: ['failed', 'key', 'paused'].includes(a.kind) ? 'bad' : '' }, h('span', { class: 'icon warn' }, '!'), h('span', null, a.text, a.at ? h('span', { class: 'muted small' }, ' · ', when(a.at)) : null))))) : null;
  const what = x => `${x.side === 'buy' ? 'Buying' : 'Selling'} ${x.base.text} ${x.base.unit} for ${x.quote.text} USDC`;
  const tradeItem = x => h('li', null,
    h('div', { class: 'what' }, what(x), h('span', { class: 'muted small' }, ` · ${x.pair} · with ${x.peer}`)),
    h('div', { class: 'now' }, x.line.now, '.', h('span', { class: 'muted' }, ` Waiting for ${x.line.waitingFor}.`)),
    h('div', { class: 'if' }, x.line.ifMissed ? [x.line.ifMissed, x.line.deadline ? [' ', when(x.line.deadline)] : null, ', '] : null,
      x.line.fallback, x.line.fallbackAt ? [' ', when(x.line.fallbackAt)] : null, x.line.ifMissed ? '.' : null));
  const running = section('Running trades', h('span', { class: 'muted' }, String(t.running.length)), t.running.length
    ? paged('running', t.running, 10, list => h('ul', { class: 'trades' }, list.map(tradeItem)))
    : empty('Trades you start, or that take your offers, appear here with what happens next.'));
  const offers = section('My offers', h('button', { class: 'primary small', type: 'button', onclick: offerForm }, 'Make an offer'),
    t.offers.length ? paged('offers', t.offers, 10, list => table([['Pair'], ['Side'], ['Price', 'num'], ['Size', 'num'], ['Filled', 'num'], ['Reserved', 'num'], ['Left', 'num'], ['Expires'], ['']],
      list.map(o => h('tr', null, h('td', null, o.pair), h('td', { class: o.side }, o.side), h('td', { class: 'num' }, o.price, h('span', { class: 'unit-s' }, 'USDC')),
        num(o.size), num(o.filled), num(o.reserved), num(o.left), h('td', null, when(o.expiresAt)),
        h('td', null, h('button', { class: 'small danger', type: 'button', onclick: () => review('cancel', { offerId: o.offerId }) }, 'Cancel'))))))
      : empty('Your open offers appear here. Use “Make an offer” to post one.'));
  const market = section('Market', null, t.market.length ? t.market.map(p => h('div', { class: 'card', style: 'margin-bottom:12px' },
    h('div', { class: 'pair-head' }, h('strong', null, p.pair), p.last ? h('span', { class: 'last' }, p.last, h('span', { class: 'unit-s' }, 'USDC last')) : h('span', { class: 'muted' }, 'no trades yet'),
      p.volume24h ? h('span', { class: 'muted small' }, `24 h volume ${p.volume24h.text} USDC`) : null, p.status !== 'open' ? h('span', { class: 'badge' }, 'paused') : null,
      p.bookAt ? h('span', { class: 'muted small' }, 'book ', when(p.bookAt)) : null),
    h('div', { class: 'book' }, ['sell', 'buy'].map(side => h('div', null, h('div', { class: `small ${side}` }, side === 'sell' ? 'Selling (lowest price first)' : 'Buying (highest price first)'),
      p.levels[side].length ? table([['Price', 'num'], ['Amount', 'num'], ['Offers', 'num']], p.levels[side].map(l => h('tr', null, h('td', { class: 'num' }, l.price), num(l.amount), h('td', { class: 'num' }, String(l.offers)))))
        : h('p', { class: 'muted small' }, 'Nothing here yet.')))),
    [...p.offers.sell, ...p.offers.buy].length ? h('div', { style: 'margin-top:10px' }, h('div', { class: 'small muted' }, 'Offers you can take'),
      table([['Side'], ['Price', 'num'], ['Amount', 'num'], ['Maker'], ['Expires'], ['']], [...p.offers.sell, ...p.offers.buy].map(o => h('tr', null,
        h('td', { class: o.side }, o.side === 'sell' ? 'they sell' : 'they buy'), h('td', { class: 'num' }, o.price), num(o.amount), h('td', { class: 'mono' }, o.maker), h('td', null, when(o.expiresAt)),
        h('td', null, h('button', { class: 'small', type: 'button', onclick: () => takeForm(o, p) }, o.side === 'sell' ? 'Buy' : 'Sell'))))))
      : h('p', { class: 'muted small' }, 'No offers from other traders on this pair right now.')))
    : empty('The book and last price per pair appear here once the venue’s signer list and book arrive.'));
  const history = section('History', h('span', { class: 'muted' }, 'last 50'), t.history.length ? paged('history', t.history, 10, list => table(
    [['When'], ['Pair'], ['Side'], ['Amount', 'num'], ['Price', 'num'], ['Total', 'num'], ['Outcome']],
    list.map(x => h('tr', null, h('td', null, when(x.at)), h('td', null, x.pair), h('td', { class: x.side }, x.side), num(x.base), h('td', { class: 'num' }, x.price), num(x.quote),
      h('td', { class: 'wrap' }, h('span', { class: `icon ${x.outcome.tone === 'good' ? 'ok' : x.outcome.tone === 'bad' ? 'bad' : ''}` }, x.outcome.tone === 'good' ? '✓' : x.outcome.tone === 'bad' ? '✕' : '·'), ' ', x.outcome.text)))))
    : empty('Finished trades appear here.'));
  return [section('Overview', null, tiles), attention, running, offers, market, history, wallets(data.wallets)];
}

function signer(s) {
  const hl = s.health;
  return [
    section(s.healthy ? 'Healthy' : 'Needs a look', h('span', { class: 'muted' }, 'checked ', when(hl.checkedAt)), h('ul', { class: 'attention', style: 'grid-template-columns:repeat(auto-fit,minmax(260px,1fr))' },
      [check(hl.peerConnected, 'Own peer connected'), check(hl.trac, 'Trac reader answering'), check(hl.reset, 'RESET reader answering'),
        check(hl.heartbeatOk, 'Last heartbeat sent', when(hl.lastHeartbeatAt)), check(hl.registryVersion != null, hl.registryVersion != null ? `Signer list v${hl.registryVersion}` : 'No signer list yet')]
        .map(li => { li.style.background = 'var(--raised)'; li.style.border = '1px solid var(--line)'; return li; }))),
    s.warnings.length ? section('Warnings', null, h('ul', { class: 'attention' }, s.warnings.map(w => h('li', null, h('span', { class: 'icon warn' }, '!'), w)))) : null,
    section('Key pieces and earnings', null, h('div', { class: 'tiles' }, tile('Key pieces held', String(s.pieces.held), null, s.pieces.nextAt ? h('span', null, 'next change ', when(s.pieces.nextAt)) : 'none waiting'),
      tile('Earned, provisional', s.earnings.provisional.text, 'USDC', 'becomes final 7 days after a trade'), tile('Earned, final', s.earnings.final.text, 'USDC', `${s.earnings.trades} released key pieces`),
      tile('Paid', '—', null, 'recorded by the venue; not visible from here'))),
    section('Held key pieces', null, s.pieces.list.length ? paged('pieces', s.pieces.list, 10, list => table([['Trade'], ['Pair'], ['Amount', 'num'], ['What happens'], ['Until']],
      list.map(p => h('tr', null, h('td', { class: 'mono' }, p.tradeId), h('td', null, p.pair), num(p.base), h('td', { class: 'wrap' }, p.text), h('td', null, when(p.until))))))
      : empty('Key pieces you hold for running trades appear here. Each is released only after the seller’s transfer is confirmed.')),
    section('Recent', h('span', { class: 'muted' }, 'last 50'), s.recent.length ? paged('recent', s.recent, 10, list => table([['When'], ['Trade'], ['Pair'], ['Amount', 'num'], ['Outcome']],
      list.map(r => h('tr', null, h('td', null, when(r.at)), h('td', { class: 'mono' }, r.tradeId), h('td', null, r.pair), num(r.base), h('td', { class: 'wrap' }, r.text)))))
      : empty('Trades this signer took part in appear here.')),
  ];
}

function service(v) {
  const hl = v.health, offers = Object.values(v.book).reduce((a, b) => a + b, 0);
  return [
    section('Overview', null, h('div', { class: 'tiles' },
      tile('Trades today', String(v.today.trades), null, `${v.today.volume.text} USDC volume`), tile('Trades, 7 days', String(v.week.trades), null, `${v.week.volume.text} USDC volume`),
      tile('Fees today', v.today.fees.text, 'USDC', `7 days: ${v.week.fees.text} USDC`), tile('Fees, all time', v.all.fees.text, 'USDC', `signers’ share ${v.signersShare.text} USDC`),
      tile('Reports waiting for proof', String(v.reports.waiting), null, v.reports.oldestAt ? h('span', null, 'oldest ', when(v.reports.oldestAt)) : 'none'),
      tile('Offers in the book', String(offers), null, Object.entries(v.book).map(([p, n]) => `${p}: ${n}`).join(' · ') || 'no open pairs'))),
    section('Health', null, h('ul', { class: 'attention', style: 'grid-template-columns:repeat(auto-fit,minmax(260px,1fr))' },
      [check(hl.peerConnected, 'Own peer connected'), check(hl.channels === 4, `Channels joined: ${hl.channels ?? '?'} of 4`), check(hl.connections > 0, `Peers connected: ${hl.connections ?? '?'}`),
        check(hl.lastRegistryAt != null && Date.now() / 1000 - hl.lastRegistryAt < 120, `Signer list v${hl.registryVersion} last published`, when(hl.lastRegistryAt))]
        .map(li => { li.style.background = 'var(--raised)'; li.style.border = '1px solid var(--line)'; return li; }))),
    section('Signers', h('span', { class: 'muted' }, String(v.signers.length)), v.signers.length ? paged('signers', v.signers, 20, list => table(
      [['Signer'], ['Online'], ['Limit', 'num'], ['Earned', 'num'], ['Owed', 'num'], ['Paid', 'num'], ['']],
      list.map(s => h('tr', null, h('td', null, s.label, h('span', { class: 'muted mono' }, ` ${s.short}`), s.removed ? h('span', { class: 'badge' }, 'removed') : null),
        h('td', null, h('span', { class: `icon ${s.online ? 'ok' : 'bad'}` }, s.online ? '●' : '○'), s.online ? ' online' : ' offline'), num(s.limit), num(s.earned), num(s.owed), num(s.paid),
        h('td', null, h('button', { class: 'small', type: 'button', disabled: s.owedTrades === 0, onclick: () => review('markPaid', { dexKey: s.dexKey }) }, 'Mark paid'))))))
      : empty('Signers from the venue’s signer list appear here.')),
    wallets(data.wallets),
  ];
}

// ---- Traffic: built once per visit so the filter inputs keep their focus; only the lists are refreshed.
const CHANNEL_NAMES = { 'intercom-dex': 'Venue announcements', 'intercom-dex:offers': 'Offers', 'intercom-dex:signers': 'Signers' };
const channelName = c => CHANNEL_NAMES[c] ?? (c.startsWith('intercom-dex:t:') ? `Trade ${c.slice(15, 21)}…` : c);

function trafficTab() {
  const rates = h('div'), list = h('div');
  const channel = h('select', { onchange: e => { filters.channel = e.target.value; filters.page = 0; loadTraffic(); } });
  const kind = h('select', { onchange: e => { filters.kind = e.target.value; filters.page = 0; loadTraffic(); } });
  const trade = h('input', { placeholder: 'trade id starts with…', value: filters.trade, oninput: e => { filters.trade = e.target.value.trim().toLowerCase(); filters.page = 0; loadTraffic(); } });
  trafficView = { rates, list, channel, kind };
  return [section('Received bytes per channel', h('span', { class: 'muted' }, 'last 5 s, against the 64 KB/s per-connection limit'), rates),
    section('Received messages', h('span', { class: 'muted' }, 'identical signed messages are folded into one row'), h('div', { class: 'filters' }, channel, kind, trade), list)];
}

function options(select, values, all, label = v => v) {
  const current = select.value || '';
  select.replaceChildren(h('option', { value: '' }, all), values.map(v => h('option', { value: v }, label(v))));
  select.value = values.includes(current) ? current : '';
}

async function loadTraffic() {
  if (tab !== 'traffic' || !trafficView) return;
  const q = new URLSearchParams(Object.entries(filters).map(([k, v]) => [k, String(v)]));
  let t;
  try { t = await api('/api/traffic?' + q); } catch { return; }
  const v = trafficView;
  options(v.channel, t.channels, 'All channels', channelName); options(v.kind, t.kinds, 'All kinds');
  const rates = Object.entries(t.rates).sort((a, b) => b[1] - a[1]);
  v.rates.replaceChildren(...(rates.length ? rates.map(([c, n]) => {
    const share = n / t.limitBytes;
    return h('div', { class: 'meter' }, h('span', { title: c }, channelName(c)),
      h('div', { class: 'track', role: 'meter', 'aria-valuenow': n, 'aria-valuemax': t.limitBytes, 'aria-label': channelName(c) },
        h('div', { class: `fill ${share >= 0.9 ? 'bad' : share >= 0.6 ? 'warn' : ''}`, style: `width:${Math.min(100, share * 100).toFixed(1)}%` })),
      h('span', { class: 'num' }, `${bytes(n)}/s`));
  }) : [empty('Nothing received in the last few seconds.')]));
  const pagesCount = Math.max(1, Math.ceil(t.total / t.pageSize));
  const rows = t.rows.flatMap(r => {
    const open = expanded.has('t' + r.id);
    const toggle = () => { open ? expanded.delete('t' + r.id) : expanded.add('t' + r.id); loadTraffic(); };
    return [h('tr', { onclick: toggle, style: 'cursor:pointer' }, h('td', null, when(Math.floor(r.lastSeen / 1000))), h('td', { title: r.channel }, channelName(r.channel)), h('td', null, r.kind),
      h('td', null, r.label ? [r.label, ' '] : null, h('span', { class: 'mono muted' }, r.from ? `${r.from.slice(0, 6)}…${r.from.slice(-4)}` : '?')),
      h('td', { class: 'num' }, bytes(r.bytes)), h('td', { class: 'num' }, r.count > 1 ? `×${r.count}` : '')),
    open ? h('tr', { class: 'detail' }, h('td', { colspan: 6 }, h('div', null, 'First seen ', when(Math.floor(r.firstSeen / 1000)), ` · seen ${r.count} time(s)`),
      h('div', null, 'Sender ', h('code', null, r.from || 'unknown')), r.trade ? h('div', null, 'Trade ', h('code', null, r.trade)) : null,
      h('div', { class: 'muted small' }, 'Message digest ', h('code', null, r.id), ' · contents are not verified or kept here'))) : null];
  });
  v.list.replaceChildren(t.rows.length ? table([['Last seen'], ['Channel'], ['Kind'], ['Sender'], ['Size', 'num'], ['Repeats', 'num']], rows)
    : empty(t.total === 0 && !filters.channel && !filters.kind && !filters.trade ? 'Messages this peer receives appear here (kept in memory only).' : 'No messages match these filters.'),
  pagesCount > 1 ? h('div', { class: 'pager' },
    h('button', { class: 'small', type: 'button', disabled: t.page === 0, onclick: () => { filters.page = t.page - 1; loadTraffic(); } }, '‹ Newer'), `Page ${t.page + 1} of ${pagesCount}`,
    h('button', { class: 'small', type: 'button', disabled: t.page >= pagesCount - 1, onclick: () => { filters.page = t.page + 1; loadTraffic(); } }, 'Older ›')) : '');
}

// ---- Page
const ROLE_TABS = { trader: 'Trading', signer: 'Signer', service: 'Venue' };
function tabs() {
  const names = [[data.role, ROLE_TABS[data.role]], ['traffic', 'Traffic']];
  tab ??= location.hash === '#traffic' ? 'traffic' : data.role;
  $('#tabs').replaceChildren(...names.map(([id, label]) => h('button', { role: 'tab', type: 'button', 'aria-selected': String(tab === id), onclick: () => {
    tab = id; history.replaceState(null, '', id === 'traffic' ? '#traffic' : '#'); trafficView = null; tabs(); render(); loadTraffic();
  } }, label)));
}

function render() {
  if (!data) return;
  if (tab === 'traffic') { if (!trafficView) main.replaceChildren(...trafficTab()); return; }
  const content = { trader: () => trader(data.trader), signer: () => signer(data.signer), service: () => service(data.service) }[data.role]();
  main.replaceChildren(...content.flat().filter(Boolean));
}

async function poll() {
  try {
    data = await api('/api/state');
    $('#stale').hidden = true;
    $('#role').textContent = { trader: 'trader', signer: 'signer', service: 'venue' }[data.role];
    $('#network').textContent = data.network;
    if (!$('#tabs').children.length) tabs();
    render();
  } catch { $('#stale').hidden = false; }
}

const themes = ['', 'dark', 'light'];
function applyTheme(t) { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
applyTheme(localStorage.getItem('theme') ?? '');
$('#theme').addEventListener('click', () => {
  const next = themes[(themes.indexOf(document.documentElement.dataset.theme ?? '') + 1) % themes.length];
  localStorage.setItem('theme', next); applyTheme(next);
});

poll();
setInterval(() => { poll(); loadTraffic(); }, 2000);
