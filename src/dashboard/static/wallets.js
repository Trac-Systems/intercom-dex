// Wallets: deposit addresses, each balance split into in use / free, withdrawals and where the keys live.
import { h, fill, amt, whenLong, copyButton, panel } from './dom.js';
import { virtualList } from './vlist.js';
import { review, form, field } from './dialogs.js';

function withdrawForm(a) {
  form(`Withdraw ${a.asset}`, [
    h('p', { class: 'note' }, `Free to withdraw: ${a.free.text} ${a.asset}`),
    field('Amount', h('input', { name: 'amount', inputmode: 'decimal', placeholder: 'e.g. 1.5' })),
    h('label', { class: 'inline' }, h('input', { type: 'checkbox', name: 'all' }), 'All free funds'),
    a.payoutLock ? h('p', null, 'Destination (fixed payout address): ', h('code', null, a.payoutLock))
      : field(`Destination (${a.chain === 'solana' ? 'Solana address' : 'trac1 address'})`, h('input', { name: 'to', autocomplete: 'off', spellcheck: 'false' })),
  ], v => review('withdraw', { asset: a.asset, amount: v.all ? 'all' : v.amount, to: v.to || undefined }));
}

export function walletsView() {
  const head = h('div'), balances = h('div', { class: 'table cols-assets' }), keys = h('div');
  const withdrawals = virtualList({ rowHeight: 32, key: x => x.id, label: 'Withdrawals', emptyText: 'No withdrawals waiting for confirmation.',
    row: x => h('div', { class: 'vl-row', role: 'listitem' }, h('div', { class: 'cells' }, h('span', { class: 'num' }, amt(x.amount)),
      h('span', { class: 'clip mono', title: x.to }, x.to), h('span', { class: 'clip', title: x.reason ?? '' }, x.status, x.reason ? ` (${x.reason})` : ''),
      h('span', { class: 'end' }, x.link ? h('a', { href: x.link, target: '_blank', rel: 'noopener noreferrer' }, 'transaction') : x.tx ? h('code', { title: x.tx }, `${x.tx.slice(0, 10)}…`) : '—'))) });
  const el = h('div', { class: 'page' }, head,
    panel('Balances', null, balances),
    panel('Withdrawals still being confirmed', null, h('div', { class: 'table cols-withdrawals' },
      h('div', { class: 'thead' }, h('span', { class: 'num' }, 'Amount'), h('span', null, 'To'), h('span', null, 'Status'), h('span', { class: 'end' }, 'Transaction')), withdrawals.el)),
    keys);
  let open = false, sig = '';

  return {
    el,
    update(data) {
      const w = data.wallets;
      if (!w) { head.replaceChildren(h('p', { class: 'empty' }, 'This role has no wallets.')); return; }
      withdrawals.set(w.withdrawals.length, i => w.withdrawals[i]);
      const next = JSON.stringify({ ...w, withdrawals: null });
      if (next === sig) return;
      sig = next;
      const addresses = [...new Map(w.assets.map(a => [a.chain, a])).values()];
      fill(head,
        h('div', { class: 'page-head' }, h('h1', null, 'Wallets'), w.readAt ? h('span', { class: 'muted' }, 'balances read ', whenLong(w.readAt)) : null),
        w.error ? h('p', { class: 'error' }, `Balances could not be read just now (${w.error}). Showing the last known values.`) : null,
        w.notes.length ? h('ul', { class: 'notes' }, w.notes.map(n => h('li', null, h('span', { class: 'icon warn' }, '!'), n))) : null,
        h('div', { class: 'addresses' }, addresses.map(a => h('div', { class: 'address' }, h('div', { class: 'muted small' }, a.chain === 'solana' ? 'Solana deposit address (USDC, SOL)' : 'Trac deposit address (TNK, RESET)'),
          h('div', { class: 'copy' }, h('code', null, a.address), copyButton(a.address))))));
      fill(balances, h('div', { class: 'thead' }, h('span', null, 'Asset'), h('span', { class: 'num' }, 'Total'), h('span', { class: 'num hide-s' }, 'In use'), h('span', { class: 'num' }, 'Free'), h('span', null, '')),
        w.assets.map(a => h('div', { class: 'row' }, h('span', null, h('strong', null, a.asset)), h('span', { class: 'num' }, amt(a.total)),
          h('span', { class: 'num hide-s', title: `offers ${a.parts.offers.text}, trades ${a.parts.trades.text}, locked ${a.parts.escrow.text}, fee reserve ${a.parts.fees.text}, withdrawals ${a.parts.withdrawals.text}` }, amt(a.inUse)),
          h('span', { class: 'num' }, amt(a.free)), h('span', { class: 'end' }, a.canWithdraw ? h('button', { class: 'small', type: 'button', onclick: () => withdrawForm(a) }, 'Withdraw') : null))));
      const s = w.storage;
      fill(keys, s ? h('details', { class: 'panel keys', open, ontoggle: e => { open = e.target.open; } },
        h('summary', null, 'Where your keys are and how to back them up'),
        h('div', { class: 'keys-body' },
          h('div', null, 'Encrypted key file: ', h('code', null, s.keyringFile)),
          s.tracWalletFile ? h('div', null, 'Encrypted Trac wallet: ', h('code', null, s.tracWalletFile)) : null,
          h('div', null, 'Data folder: ', h('code', null, s.dataDir)),
          h('div', null, 'Password comes from the environment setting ', h('code', null, s.passwordEnv),
            s.tracPasswordEnv && s.tracPasswordEnv !== s.passwordEnv ? [' (Trac wallet: ', h('code', null, s.tracPasswordEnv), ')'] : null, '.'),
          w.backup ? [h('div', null, w.backup.instruction), h('div', { class: 'copy' }, h('code', null, w.backup.exportCommand), copyButton(w.backup.exportCommand)),
            h('div', { class: 'muted small' }, w.backup.exportInstruction)] : null)) : '');
    },
  };
}
