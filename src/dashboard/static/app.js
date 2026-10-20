// The dashboard page: polls /api/state, keeps one view per tab and lets each view update itself in place.
import { $, h, api } from './dom.js';
import { onAction } from './dialogs.js';
import { tradingView } from './trading.js';
import { walletsView } from './wallets.js';
import { trafficView } from './traffic.js';
import { signerView, venueView } from './roles.js';

const main = $('#main');
const ROLE_TABS = { trader: ['Trading', tradingView], signer: ['Signer', signerView], service: ['Venue', venueView] };
const views = {};
let data = null, tab = null;

function tabs() {
  const list = [[data.role, ROLE_TABS[data.role][0]], ...(data.wallets ? [['wallets', 'Wallets']] : []), ['traffic', 'Traffic']];
  const wanted = location.hash.slice(1);
  tab ??= list.some(([id]) => id === wanted) ? wanted : data.role;
  $('#tabs').replaceChildren(...list.map(([id, label]) => h('button', { role: 'tab', type: 'button', 'aria-selected': String(tab === id), onclick: () => {
    tab = id; history.replaceState(null, '', id === data.role ? '#' : `#${id}`); tabs(); show();
  } }, label)));
}

function show() {
  const make = { wallets: walletsView, traffic: trafficView }[tab] ?? ROLE_TABS[data.role][1];
  views[tab] ??= make();
  if (main.firstChild !== views[tab].el) main.replaceChildren(views[tab].el);
  main.className = tab === 'trader' ? 'wide' : '';
  views[tab].update(data);
}

async function poll() {
  try {
    data = await api('/api/state');
    $('#stale').hidden = true;
    $('#role').textContent = { trader: 'trader', signer: 'signer', service: 'venue' }[data.role];
    $('#network').textContent = data.network;
    if (!$('#tabs').children.length) tabs();
    show();
  } catch { $('#stale').hidden = false; }
}
onAction(() => poll());

// Dark by default; the toggle switches to light and back.
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  for (const v of Object.values(views)) v.theme?.();
}
applyTheme(localStorage.getItem('theme') === 'light' ? 'light' : 'dark');
$('#theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  localStorage.setItem('theme', next); applyTheme(next);
});

poll();
setInterval(poll, 2000);
