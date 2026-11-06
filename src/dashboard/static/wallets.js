// Wallets: deposit addresses, each balance split into in use / free, the RESET stake and its rewards, withdrawals and
// where the keys live.
import { h, fill, amt, when, whenLong, copyButton, panel, tile } from './dom.js';
import { virtualList } from './vlist.js';
import { review, form, field } from './dialogs.js';
import { stakeNotes, coverageText, usd, duration, weightText, earningNow, poolText, yieldText } from './stake-text.js';

function withdrawForm(a) {
  form(`Withdraw ${a.asset}`, [
    h('p', { class: 'note' }, `Free to withdraw: ${a.free.text} ${a.asset}`),
    field('Amount', h('input', { name: 'amount', inputmode: 'decimal', placeholder: 'e.g. 1.5' })),
    h('label', { class: 'inline' }, h('input', { type: 'checkbox', name: 'all' }), 'All free funds'),
    a.payoutLock ? h('p', null, 'Destination (fixed payout address): ', h('code', null, a.payoutLock))
      : field(`Destination (${a.chain === 'solana' ? 'Solana address' : 'trac1 address'})`, h('input', { name: 'to', autocomplete: 'off', spellcheck: 'false' })),
  ], v => review('withdraw', { asset: a.asset, amount: v.all ? 'all' : v.amount, to: v.to || undefined }));
}

function depositForm(s, wallet) {
  form('Stake RESET', [
    h('p', { class: 'note' }, `Free in your wallet: ${wallet ? `${wallet.free.text} RESET` : 'unknown right now'}. ${s.selling && s.suggested ? `Suggested stake: ${usd(s.suggested)}.` : ''}`),
    field('Amount', h('input', { name: 'amount', inputmode: 'decimal', placeholder: 'e.g. 0.5' })),
    h('p', { class: 'note' }, `Limit ${usd(s.cap)} per address. Withdrawing later waits ${duration(s.withdrawDelaySec)}.`),
  ], v => review('stakeDeposit', { amount: v.amount }));
}
function stakeWithdrawForm(s) {
  const backing = Number(s.reserved.units) > 0;
  form('Withdraw stake', [
    h('p', { class: 'note' }, `Free stake: ${s.free.text} RESET. It waits ${s.withdrawDelaySec === null ? 'the venue’s withdrawal period' : duration(s.withdrawDelaySec)} before it is back in your wallet and earns no rewards meanwhile.`,
      backing ? ` ${s.reserved.text} RESET backs running sales: withdrawn, it is returned after the sale it backs closes, then waits.` : null),
    field('Amount', h('input', { name: 'amount', inputmode: 'decimal', placeholder: 'e.g. 0.5' })),
    h('label', { class: 'inline' }, h('input', { type: 'checkbox', name: 'all' }), backing ? 'All my stake' : 'All free stake'),
  ], v => review('stakeWithdraw', { amount: v.all ? 'all' : v.amount }));
}

// The stake as one more balance row, with what it covers and what is on its way underneath.
function stakeRows(s, wallet) {
  const badge = s.state === 'pending' ? 'deposit confirming' : s.state === 'withdrawing' ? 'withdrawing' : s.busy ? 'confirming' : s.draining ? 'moving to new signers' : s.selling ? 'required to sell' : 'optional · earns rewards';
  const facts = [coverageText(s), s.selling && s.suggested && !s.draining ? `Suggested ${usd(s.suggested)}` : null, s.cap ? `Limit ${usd(s.cap)} per address` : null,
    s.withdrawDelaySec === null ? null : `Withdrawals wait ${duration(s.withdrawDelaySec)}`].filter(Boolean);
  const notes = stakeNotes(s, whenLong);
  return [h('div', { class: 'row stake' }, h('span', null, h('strong', null, 'Stake')),
    h('span', { class: 'num' }, amt(s.locked)), h('span', { class: 'num hide-s', title: 'Reserved for running sales' }, amt(s.reserved)), h('span', { class: 'num' }, amt(s.free)),
    h('span', { class: 'end actions' }, h('button', { class: 'small', type: 'button', disabled: !s.offered || s.busy, onclick: () => depositForm(s, wallet) }, 'Deposit'),
      h('button', { class: 'small', type: 'button', disabled: Number(s.free.units) + Number(s.reserved.units) === 0 || s.busy, onclick: () => stakeWithdrawForm(s) }, 'Withdraw'))),
  h('div', { class: 'stake-more' }, h('div', { class: 'facts' }, h('span', { class: `badge${s.short || s.state === 'none' && s.selling ? ' warn' : ''}` }, badge), facts.map(f => h('span', null, f))),
    notes.some(n => n.tone === 'warn') ? h('ul', { class: 'notes' }, notes.filter(n => n.tone === 'warn').map(n => h('li', null, h('span', { class: 'icon warn' }, '!'), h('span', null, n.parts)))) : null,
    notes.filter(n => n.tone === 'note').map(n => h('p', null, n.parts)))];
}

function rewardsPanel(r, stake) {
  const last = r.lastPayout;
  return panel('Rewards', h('span', { class: `muted${r.poolState === 'active' ? '' : ' warn-text'}` }, poolText(r)),
    r.poolState === 'empty' || r.forfeited ? h('ul', { class: 'notes pad' },
      r.poolState === 'empty' ? h('li', null, h('span', { class: 'icon warn' }, '!'), 'Rewards paused, pool empty: nothing is earned until the pool is refilled, and paused time is not paid later.') : null,
      r.forfeited ? h('li', null, h('span', { class: 'icon warn' }, '!'), `${r.forfeited.text} RESET of unpaid rewards went back to the pool after a sale was not delivered in time.`) : null) : null,
    h('div', { class: 'tiles pad' },
      tile('Unpaid', r.unpaid.text, 'RESET', 'sent to your Trac wallet automatically'),
      tile('Paid so far', r.paidTotal.text, 'RESET', last ? ['last ', last.amount.text, ' RESET ', when(last.at), last.link ? [' · ', h('a', { href: last.link, target: '_blank', rel: 'noopener noreferrer' }, 'transaction')] : null] : 'no payout yet'),
      tile('Earning now', earningNow(r, stake), 'RESET / day', weightText(r, stake)),
      ((y) => tile('Yield (APY)', y.value, y.value === '—' ? '' : 'a year', y.note))(yieldText(r, stake)),
      tile('Reward pool', r.poolBalance ? r.poolBalance.text : 'unknown', r.poolBalance ? 'RESET' : '', r.dailyBudget ? `${r.dailyBudget.text} RESET a day shared by all stakers` : 'shared by all stakers')));
}

export function walletsView() {
  const head = h('div'), balances = h('div', { class: 'table cols-assets' }), rewards = h('div', { class: 'part' }), keys = h('div');
  const withdrawals = virtualList({ rowHeight: 32, key: x => x.id, label: 'Withdrawals', emptyText: 'No withdrawals waiting for confirmation.',
    row: x => h('div', { class: 'vl-row', role: 'listitem' }, h('div', { class: 'cells' }, h('span', { class: 'num' }, amt(x.amount)),
      h('span', { class: 'clip mono', title: x.to }, x.to), h('span', { class: 'clip', title: x.reason ?? '' }, x.status, x.reason ? ` (${x.reason})` : ''),
      h('span', { class: 'end' }, x.link ? h('a', { href: x.link, target: '_blank', rel: 'noopener noreferrer' }, 'transaction') : x.tx ? h('code', { title: x.tx }, `${x.tx.slice(0, 10)}…`) : '—'))) });
  const el = h('div', { class: 'page' }, head,
    panel('Balances', null, balances), rewards,
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
      const t = data.trader, next = JSON.stringify({ ...w, withdrawals: null, stake: t?.stake, rewards: t?.rewards });
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
          h('span', { class: 'num' }, amt(a.free)), h('span', { class: 'end' }, a.canWithdraw ? h('button', { class: 'small', type: 'button', onclick: () => withdrawForm(a) }, 'Withdraw') : null))),
        t?.stake ? stakeRows(t.stake, w.assets.find(a => a.asset === 'RESET')) : null);
      fill(rewards, t?.rewards ? rewardsPanel(t.rewards, t.stake) : null);
      rewards.hidden = !t?.rewards;
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
