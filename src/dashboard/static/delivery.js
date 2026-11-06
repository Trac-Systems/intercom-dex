// Sale deliveries on the page: one message block per sale (in its running-trade row and in the banners pinned under
// the header), and browser notifications when a sale fails or runs late, also while the tab is in the background.
import { h, fill, when, clock } from './dom.js';
import { review } from './dialogs.js';
import { deliveryText, toNotify, paymentsLabel } from './stake-text.js';

const RANK = { red: 0, yellow: 1, info: 2, good: 3 };
const coin = x => `${x.base.text} ${x.base.unit}`;
const canNotify = () => 'Notification' in window;

// A decided bond shows its verified RESET transfers to the buyer (the core gives their hashes), not the sale's delivery.
export function deliveryNote(x, cls = '') {
  const d = x.delivery, t = deliveryText(d, coin(x), when), paid = ['penalty_collecting', 'penalty_paid'].includes(d.state) ? d.payments : [];
  return h('div', { class: `delivery ${t.tone} ${cls}`, role: t.tone === 'red' ? 'alert' : 'status' },
    h('div', { class: 'msg' }, h('strong', null, t.head), '. ', t.parts,
      paid.length ? [' ', paymentsLabel(paid), ' ', paid.map((tx, i) => [i ? ', ' : '', h('code', { title: tx }, `${tx.slice(0, 10)}…`)])]
        : d.link && !['penalty_collecting', 'penalty_paid'].includes(d.state) ? [' ', h('a', { href: d.link, target: '_blank', rel: 'noopener noreferrer' }, 'transaction')] : null),
    t.retry ? h('button', { class: 'small primary', type: 'button', onclick: e => { e.stopPropagation(); review('retryDelivery', { key: x.key }); } }, 'Retry now') : null);
}
export const deliveryTone = x => deliveryText(x.delivery, coin(x)).tone;

export function bannersView(el) {
  const seen = new Set();
  let sig = '', asking = false;
  const ask = () => { if (canNotify() && Notification.permission === 'default') { asking = true; Notification.requestPermission().finally(() => { asking = false; }); } };
  return {
    ask,
    update(trader) {
      const items = (trader?.deliveries ?? []).slice().sort((a, b) => RANK[deliveryTone(a)] - RANK[deliveryTone(b)]);
      if (canNotify() && Notification.permission === 'granted') {
        for (const n of toNotify(items, seen, clock)) {
          const note = new Notification(n.title, { body: n.body, tag: n.tag, requireInteraction: true });
          note.onclick = () => { window.focus(); note.close(); };
        }
      }
      // A seller whose offers were listed elsewhere (an agent, the CLI) is asked here, with one click.
      const offer = trader?.stake?.selling && canNotify() && Notification.permission === 'default' && !asking;
      const next = JSON.stringify([items, offer]);
      if (next === sig) return;
      sig = next;
      fill(el, items.map(x => deliveryNote(x, 'banner')), offer ? h('div', { class: 'delivery info banner' },
        h('div', { class: 'msg' }, 'Get a browser notification when a sale fails or runs late, even with this tab in the background.'),
        h('button', { class: 'small', type: 'button', onclick: () => { ask(); sig = ''; } }, 'Turn on')) : null);
    },
  };
}
