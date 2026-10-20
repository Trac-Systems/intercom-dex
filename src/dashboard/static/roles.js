// The signer's and the venue's screens: health, a row of figures, and their lists as virtual lists.
import { h, fill, api, amt, when, whenLong, tile, check, panel } from './dom.js';
import { serverList } from './vlist.js';
import { review } from './dialogs.js';

const ROW = 32;
const fetchList = name => (offset, limit) => api(`/api/list?${new URLSearchParams({ name, offset, limit })}`);
const rowOf = (...cells) => h('div', { class: 'vl-row', role: 'listitem' }, h('div', { class: 'cells' }, cells));
const head = cols => h('div', { class: 'thead' }, cols.map(([t, c]) => h('span', { class: c ?? null }, t)));
const listPanel = (title, cls, cols, list) => panel(title, null, h('div', { class: `table ${cls}` }, head(cols), list.el));

// Parts rebuilt only when their data changed, so nothing flickers between polls.
function part() {
  const el = h('div', { class: 'part' });
  let sig = '';
  return { el, set(value, build) { const next = JSON.stringify(value); if (next !== sig) { sig = next; fill(el, build()); } } };
}

export function signerView() {
  const top = part(), figures = part();
  const pieces = serverList({ fetchBlock: fetchList('signer.pieces'), rowHeight: ROW, key: p => p.tradeId, label: 'Held key pieces',
    emptyText: 'Key pieces you hold for running trades appear here. Each is released only after the seller’s transfer is confirmed.',
    row: p => rowOf(h('span', { class: 'mono' }, p.tradeId), h('span', null, p.pair), h('span', { class: 'num' }, amt(p.base)), h('span', { class: 'clip', title: p.text }, p.text), h('span', null, when(p.until))) });
  const recent = serverList({ fetchBlock: fetchList('signer.recent'), rowHeight: ROW, key: (r, i) => `${r.tradeId}:${r.at}:${i}`, label: 'Recent',
    emptyText: 'Trades this signer took part in appear here.',
    row: r => rowOf(h('span', null, when(r.at)), h('span', { class: 'mono' }, r.tradeId), h('span', null, r.pair), h('span', { class: 'num' }, amt(r.base)), h('span', { class: 'clip', title: r.text }, r.text)) });
  const el = h('div', { class: 'page' }, top.el, figures.el, h('div', { class: 'split' },
    listPanel('Held key pieces', 'cols-pieces', [['Trade'], ['Pair'], ['Amount', 'num'], ['What happens'], ['Until']], pieces),
    listPanel('Recent', 'cols-recent', [['When'], ['Trade'], ['Pair'], ['Amount', 'num'], ['Outcome']], recent)));
  return {
    el,
    update(data) {
      const s = data.signer, hl = s.health;
      top.set([s.healthy, hl, s.warnings], () => [
        h('div', { class: 'page-head' }, h('h1', null, h('span', { class: `dot ${s.healthy ? 'on' : 'off'}`, 'aria-hidden': 'true' }), s.healthy ? 'Healthy' : 'Needs a look'),
          h('span', { class: 'muted' }, 'checked ', whenLong(hl.checkedAt))),
        h('ul', { class: 'checks' }, check(hl.peerConnected, 'Own peer connected'), check(hl.trac, 'Trac reader answering'), check(hl.reset, 'RESET reader answering'),
          check(hl.heartbeatOk, 'Last heartbeat sent', when(hl.lastHeartbeatAt)), check(hl.registryVersion != null, hl.registryVersion != null ? `Signer list v${hl.registryVersion}` : 'No signer list yet')),
        s.warnings.length ? h('ul', { class: 'notes' }, s.warnings.map(w => h('li', null, h('span', { class: 'icon warn' }, '!'), w))) : null]);
      figures.set([s.pieces, s.earnings], () => h('div', { class: 'tiles' },
        tile('Key pieces held', String(s.pieces.held), null, s.pieces.nextAt ? h('span', null, 'next change ', when(s.pieces.nextAt)) : 'none waiting'),
        tile('Earned, provisional', s.earnings.provisional.text, 'USDC', 'becomes final 7 days after a trade'),
        tile('Earned, final', s.earnings.final.text, 'USDC', `${s.earnings.trades} released key pieces`),
        tile('Paid', '—', null, 'recorded by the venue; not visible from here')));
      pieces.refresh(); recent.refresh();
    },
  };
}

export function venueView() {
  const figures = part(), health = part();
  const signers = serverList({ fetchBlock: fetchList('service.signers'), rowHeight: ROW, key: s => s.dexKey, label: 'Signers', emptyText: 'Signers from the venue’s signer list appear here.',
    row: s => rowOf(h('span', { class: 'clip', title: s.dexKey }, s.label, h('span', { class: 'muted mono' }, ` ${s.short}`), s.removed ? h('span', { class: 'badge' }, 'removed') : null),
      h('span', null, h('span', { class: `dot ${s.online ? 'on' : 'off'}`, 'aria-hidden': 'true' }), s.online ? 'online' : 'offline'),
      h('span', { class: 'num' }, amt(s.limit)), h('span', { class: 'num', title: `provisional ${s.provisional.text} USDC, forfeited ${s.forfeited.text} USDC` }, amt(s.earned)),
      h('span', { class: 'num' }, amt(s.owed)), h('span', { class: 'num' }, amt(s.paid)),
      h('span', { class: 'end' }, h('button', { class: 'small', type: 'button', disabled: s.owedTrades === 0, onclick: () => review('markPaid', { dexKey: s.dexKey }) }, 'Mark paid'))) });
  const el = h('div', { class: 'page' }, figures.el, health.el,
    listPanel('Signers', 'cols-signers', [['Signer'], ['Online'], ['Limit', 'num'], ['Earned', 'num'], ['Owed', 'num'], ['Paid', 'num'], ['', 'end']], signers));
  return {
    el,
    update(data) {
      const v = data.service, hl = v.health, offers = Object.values(v.book).reduce((a, b) => a + b, 0);
      figures.set([v.today, v.week, v.all, v.signersShare, v.reports, v.book], () => [h('div', { class: 'page-head' }, h('h1', null, 'Venue')), h('div', { class: 'tiles' },
        tile('Trades today', String(v.today.trades), null, `${v.today.volume.text} USDC volume`), tile('Trades, 7 days', String(v.week.trades), null, `${v.week.volume.text} USDC volume`),
        tile('Fees today', v.today.fees.text, 'USDC', `7 days: ${v.week.fees.text} USDC`), tile('Fees, all time', v.all.fees.text, 'USDC', `signers’ share ${v.signersShare.text} USDC`),
        tile('Reports waiting for proof', String(v.reports.waiting), null, v.reports.oldestAt ? h('span', null, 'oldest ', when(v.reports.oldestAt)) : 'none'),
        tile('Offers in the book', String(offers), null, Object.entries(v.book).map(([p, n]) => `${p}: ${n}`).join(' · ') || 'no open pairs'))]);
      health.set(hl, () => h('ul', { class: 'checks' }, check(hl.peerConnected, 'Own peer connected'), check(hl.channels === 4, `Channels joined: ${hl.channels ?? '?'} of 4`),
        check(hl.connections > 0, `Peers connected: ${hl.connections ?? '?'}`),
        check(hl.lastRegistryAt != null && Date.now() / 1000 - hl.lastRegistryAt < 120, `Signer list v${hl.registryVersion} last published`, when(hl.lastRegistryAt))));
      signers.refresh();
    },
  };
}
