// Traffic: bytes per channel against the per-connection limit, and every received message (folded when repeated).
import { h, fill, api, when, whenLong, bytes, panel } from './dom.js';
import { virtualList, serverList } from './vlist.js';

const CHANNEL_NAMES = { 'intercom-dex': 'Venue announcements', 'intercom-dex:offers': 'Offers', 'intercom-dex:signers': 'Signers', 'intercom-dex:chat': 'Chat' };
const channelName = c => CHANNEL_NAMES[c] ?? (c.startsWith('intercom-dex:t:') ? `Trade ${c.slice(15, 21)}…` : c);

function options(select, values, all, label = v => v) {
  const current = select.value || '';
  if (select.dataset.sig === JSON.stringify(values)) return;
  select.dataset.sig = JSON.stringify(values);
  fill(select, h('option', { value: '' }, all), values.map(v => h('option', { value: v }, label(v))));
  select.value = values.includes(current) ? current : '';
}

export function trafficView() {
  const filters = { channel: '', kind: '', trade: '' };
  let limit = 1;
  const rates = virtualList({ rowHeight: 28, key: r => r[0], className: 'rates', label: 'Bytes per channel', emptyText: 'Nothing received in the last few seconds.',
    row: ([c, n]) => {
      const share = n / limit, fill = h('div', { class: `fill${share >= 0.9 ? ' bad' : share >= 0.6 ? ' warn' : ''}` });
      fill.style.width = `${Math.min(100, share * 100).toFixed(1)}%`;
      return h('div', { class: 'vl-row meter', role: 'listitem' }, h('span', { class: 'clip', title: c }, channelName(c)),
        h('div', { class: 'track', role: 'meter', 'aria-valuenow': String(n), 'aria-valuemin': '0', 'aria-valuemax': String(limit), 'aria-label': channelName(c) }, fill),
        h('span', { class: 'num' }, `${bytes(n)}/s`));
    } });
  const messages = serverList({ size: 100, rowHeight: 32, key: r => r.id, label: 'Received messages',
    emptyText: 'Messages this peer receives appear here (kept in memory only).',
    fetchBlock: offset => api(`/api/traffic?${new URLSearchParams({ ...filters, page: String(offset / 100) })}`),
    onPage: t => {
      limit = t.limitBytes;
      options(channel, t.channels, 'All channels', channelName); options(kind, t.kinds, 'All kinds');
      const list = Object.entries(t.rates).sort((a, b) => b[1] - a[1]);
      rates.set(list.length, i => list[i]);
    },
    row: (r, { open, toggle }) => h('div', { class: `vl-row${open ? ' open' : ''}`, role: 'listitem' },
      h('div', { class: 'cells', role: 'button', tabindex: '0', 'aria-expanded': String(open), onclick: toggle, onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } } },
        h('span', null, when(Math.floor(r.lastSeen / 1000))), h('span', { class: 'clip', title: r.channel }, channelName(r.channel)), h('span', { class: 'clip' }, r.kind),
        h('span', { class: 'clip' }, r.label ? [r.label, ' '] : null, h('span', { class: 'mono muted' }, r.from ? `${r.from.slice(0, 6)}…${r.from.slice(-4)}` : '?')),
        h('span', { class: 'num' }, bytes(r.bytes)), h('span', { class: 'num' }, r.count > 1 ? `×${r.count}` : ''), h('span', { class: 'chev', 'aria-hidden': 'true' }, open ? '▾' : '▸')),
      open ? h('div', { class: 'detail' }, h('p', null, 'First seen ', whenLong(Math.floor(r.firstSeen / 1000)), ` · seen ${r.count} time(s)`),
        h('p', null, 'Sender ', h('code', null, r.from || 'unknown')), r.trade ? h('p', null, 'Trade ', h('code', null, r.trade)) : null,
        h('p', { class: 'muted' }, 'Message digest ', h('code', null, r.id), ' · contents are not verified or kept here')) : null) });
  const set = (k, v) => {
    filters[k] = v;
    messages.list.emptyText(Object.values(filters).some(Boolean) ? 'No messages match these filters.' : 'Messages this peer receives appear here (kept in memory only).');
    messages.reset();
  };
  const channel = h('select', { 'aria-label': 'Channel', onchange: e => set('channel', e.target.value) });
  const kind = h('select', { 'aria-label': 'Kind', onchange: e => set('kind', e.target.value) });
  const trade = h('input', { placeholder: 'trade id starts with…', 'aria-label': 'Trade id', oninput: e => set('trade', e.target.value.trim().toLowerCase()) });
  const el = h('div', { class: 'page traffic' },
    panel('Received bytes per channel', h('span', { class: 'muted small' }, 'last 5 s, against the 64 KB/s per-connection limit'), rates.el),
    panel('Received messages', h('span', { class: 'muted small' }, 'identical signed messages are folded into one row'),
      h('div', { class: 'filters' }, channel, kind, trade),
      h('div', { class: 'table cols-traffic' }, h('div', { class: 'thead' }, ['Last seen', 'Channel', 'Kind', 'Sender'].map(t => h('span', null, t)),
        h('span', { class: 'num' }, 'Size'), h('span', { class: 'num' }, 'Repeats'), h('span')), messages.el)));
  return { el, update() { messages.refresh(); } };
}
