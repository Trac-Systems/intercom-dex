// Dialogs: a form, then a review of exactly what happens (from /api/preview), then the result of /api/act.
import { $, h, api } from './dom.js';

const dialog = $('#dialog'), body = $('#dialog-body');
body.addEventListener('submit', e => e.preventDefault());
let afterAction = () => {};
export const onAction = fn => { afterAction = fn; };

export function show(...content) {
  body.replaceChildren(...content.flat(Infinity).filter(x => x != null && x !== false));
  if (!dialog.open) dialog.showModal();
}
// A dialog opened by a click: live() stays true until the reader closes it or another dialog replaces it. Late
// answers and quiet refreshes check live() first, so nothing ever opens the dialog on its own.
let session = 0;
dialog.addEventListener('close', () => { session++; });
export function begin(...content) {
  const mine = ++session;
  show(...content);
  return () => mine === session && dialog.open;
}
const close = () => h('button', { type: 'button', onclick: () => dialog.close() }, 'Close');
const failed = (title, e) => show(h('h3', null, title), h('p', { class: 'error' }, e.message), h('div', { class: 'actions' }, close()));

export async function review(action, input) {
  const live = begin(h('p', { class: 'muted' }, 'Checking…'));
  let p;
  try { p = await api('/api/preview', { action, input }); } catch (e) { return live() && failed('Cannot do this', e); }
  if (!live()) return;
  const confirm = h('button', { class: 'primary', type: 'button', onclick: async () => {
    confirm.disabled = true; confirm.textContent = 'Working…';
    try { const r = (await api('/api/act', { action, input: p.input, confirm: p.confirm })).result; afterAction(action); if (live()) result(action, r); }
    catch (e) { if (live()) failed('It did not go through', e); }
  } }, 'Confirm');
  show(h('h3', null, p.title), h('dl', null, p.lines.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
    p.warning ? h('p', { class: 'warning' }, p.warning) : null, p.note ? h('p', { class: 'note' }, p.note) : null,
    h('div', { class: 'actions' }, confirm, h('button', { type: 'button', onclick: () => dialog.close() }, 'Back')));
}

function result(action, r) {
  const lines = {
    offer: () => ['Your offer is posted. It appears under Open offers.'],
    take: () => ['The trade has started. Follow it under Running trades.'],
    cancel: () => ['The offer is cancelled.'],
    markPaid: () => [`Recorded: ${r.trades} trade(s) marked paid.`],
    withdraw: () => [`Status: ${r.status}`, `${r.amount.text} ${r.asset} to ${r.to}`, r.reason,
      r.tx ? ['Transaction: ', r.link ? h('a', { href: r.link, target: '_blank', rel: 'noopener noreferrer' }, r.tx) : h('code', null, r.tx)] : null],
  }[action]();
  show(h('h3', null, 'Done'), lines.filter(Boolean).map(l => h('p', null, l)), h('div', { class: 'actions' }, close()));
}

export function form(title, fields, submit) {
  const el = h('div', { class: 'fields' }, fields);
  show(h('h3', null, title), el, h('div', { class: 'actions' },
    h('button', { class: 'primary', type: 'button', onclick: () => submit(Object.fromEntries([...el.querySelectorAll('[name]')].map(i => [i.name, i.type === 'checkbox' ? i.checked : i.value]))) }, 'Review'),
    h('button', { type: 'button', onclick: () => dialog.close() }, 'Cancel')));
}
export const field = (label, input) => h('label', null, label, input);
