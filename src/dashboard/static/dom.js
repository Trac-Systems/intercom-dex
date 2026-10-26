// Small DOM and format helpers shared by every view. Data always goes into the page as text nodes.
export const $ = s => document.querySelector(s);

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

// replaceChildren for nested lists that may hold null or false.
export const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));

export async function api(path, payload, { timeoutMs = 0 } = {}) {
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const options = payload === undefined ? { credentials: 'same-origin' }
      : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) };
    if (controller) options.signal = controller.signal;
    const res = await fetch(path, options);
    const value = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (controller?.signal.aborted) throw new Error('Request timed out');
    if (!res.ok) throw new Error(value.error ?? `HTTP ${res.status}`);
    return value;
  } catch (error) {
    if (controller?.signal.aborted) throw new Error('Request timed out');
    throw error;
  } finally { clearTimeout(timer); }
}

// Times: local clock time (weekday or date when not today), with the relative time on hover or beside it.
export function clock(ts) {
  const d = new Date(ts * 1000), now = new Date(), t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return t;
  if (Math.abs(d - now) < 6 * 86400000) return `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${t}`;
}
export function relative(ts) {
  const s = ts - Date.now() / 1000, a = Math.abs(s);
  const v = a < 60 ? `${Math.round(a)} s` : a < 3600 ? `${Math.round(a / 60)} min` : a < 172800 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86400)} days`;
  return s >= 0 ? `in ${v}` : `${v} ago`;
}
export const when = ts => (ts ? h('span', { title: `${new Date(ts * 1000).toLocaleString()} (${relative(ts)})` }, clock(ts)) : h('span', { class: 'muted' }, '—'));
export const whenLong = ts => (ts ? h('span', { title: new Date(ts * 1000).toLocaleString() }, clock(ts), h('span', { class: 'muted' }, ` (${relative(ts)})`)) : h('span', { class: 'muted' }, '—'));
export const amt = a => (a ? [a.text, h('span', { class: 'unit' }, a.unit)] : '—');
export const bytes = n => (n < 1000 ? `${n} B` : n < 1e6 ? `${(n / 1000).toFixed(1)} KB` : `${(n / 1e6).toFixed(2)} MB`);
export const empty = text => h('p', { class: 'empty' }, text);
export const panel = (title, extra, ...content) => h('section', { class: 'panel' }, h('header', { class: 'panel-head' }, h('h2', null, title), extra), content);
export const tile = (label, value, unit, sub) => h('div', { class: 'tile' }, h('div', { class: 'label' }, label),
  h('div', { class: 'value' }, value, unit ? h('span', { class: 'unit' }, unit) : null), sub ? h('div', { class: 'sub' }, sub) : null);
export const check = (ok, text, extra) => h('li', { class: ok ? 'ok' : 'bad' }, h('span', { class: 'icon', 'aria-hidden': 'true' }, ok ? '✓' : '✕'),
  h('span', null, text, extra ? [' ', extra] : null));

// Decimal places in a price string, and a price written with exactly `places` decimals (cut, never rounded up).
export const placesOf = price => (String(price).split('.')[1] ?? '').length;
export function fixed(price, places) {
  if (price == null) return '—';
  const [whole, frac = ''] = String(price).split('.');
  return places > 0 ? `${whole}.${frac.padEnd(places, '0').slice(0, places)}` : whole;
}
// A fraction string ("-0.0412") as a signed percent ("-4.12%").
export function percent(fraction) {
  if (fraction == null) return '—';
  const v = Number(fraction) * 100;
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
}
export const tone = fraction => (fraction == null || Number(fraction) === 0 ? '' : Number(fraction) > 0 ? 'up' : 'down');

export function copyButton(text) {
  const b = h('button', { class: 'small', type: 'button', onclick: async () => {
    try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; }
    setTimeout(() => { b.textContent = 'Copy'; }, 1500);
  } }, 'Copy');
  return b;
}
