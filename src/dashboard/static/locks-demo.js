// Demo data for the Borrow & Lend and Options tabs (open the page with ?locksDemo=1): every locks call is answered
// here, in memory, so the tabs can be seen and tried without a trader. Every state of every product, both sides,
// RESET and TNK.
import { about, blockNo, TAKE, assetOf } from './locks-text.js';

const COUNTED = 917144, PRICES = { RESET: 250, TNK: 0.08 }, PAGE = 50;
const LOAN_BPS = 50, OPTION_BPS = 1000, OPTION_MIN = 0.05;
const DECIMALS = { USDC: 6, RESET: 8, TNK: 18 };
const now = () => Math.floor(Date.now() / 1000);
// USDC with cents once it has any ("99.50"), the assets as they are ("2,000", "0.5").
const fmt = (n, unit) => (unit === 'USDC' && !Number.isInteger(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })
  : Number(n.toFixed(8)).toLocaleString('en-US', { maximumFractionDigits: 8 }));
const units = (n, unit) => { const [w, f = ''] = n.toFixed(Math.min(DECIMALS[unit], 8)).split('.'); return String(BigInt(w) * 10n ** BigInt(DECIMALS[unit]) + BigInt(f.padEnd(DECIMALS[unit], '0'))); };
const A = (n, unit) => ({ units: units(n, unit), text: fmt(n, unit), unit });
const usdc = n => A(n, 'USDC'), coin = (n, asset) => A(n, asset);
const num = a => Number(String(a.text).replaceAll(',', ''));
const money = a => `${a.text} ${a.unit}`;
const until = (block, left) => `block ${blockNo(block)} (~${about(left)})`;
// §16.6: charged once on the opening payment, out of what the maker receives.
const loanFee = u => Math.floor(u * 1e6 * LOAN_BPS / 10000) / 1e6;
const optionFee = f => Math.min(f, Math.max(OPTION_MIN, Math.floor(f * 1e6 * OPTION_BPS / 10000) / 1e6));

let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const hex = n => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('');
const short = () => `${hex(6)}…${hex(4)}`;
const id = () => hex(64);

// ---- Open offers from other traders. Every fifth one is taken by someone else the moment it is tried.
const offers = { loan: [], call: [], put: [] };
const SIZES = { RESET: [0.5, 1, 1, 2, 4, 10], TNK: [1000, 2000, 2000, 5000, 10000, 500] };
for (const [asset, count] of [['RESET', 120], ['TNK', 40]]) {
  for (let i = 0; i < count; i++) {
    const collateral = SIZES[asset][i % 6], principal = Math.max(1, Math.round(collateral * PRICES[asset] * [0.4, 0.5, 0.6][i % 3]));
    const term = [144, 1008, 2016, 4320][i % 4], fee = Math.max(1, Math.round(principal * term / 2016 * 0.03 * 100) / 100);
    offers.loan.push({ positionId: id(), product: 'loan', asset, maker: short(), principal: usdc(principal), repay: usdc(principal + fee), collateral: coin(collateral, asset),
      collateralNow: usdc(collateral * PRICES[asset]), termBlocks: term, offerUntilBlock: COUNTED + 864, race: i % 5 === 1 });
  }
}
for (const [product, asset, count] of [['call', 'RESET', 80], ['call', 'TNK', 30], ['put', 'RESET', 60], ['put', 'TNK', 25]]) {
  for (let i = 0; i < count; i++) {
    const amount = SIZES[asset][i % 5], left = [144, 432, 1008, 2016][i % 4], worth = amount * PRICES[asset];
    const strike = Math.round(worth * (product === 'call' ? [1.1, 1.2, 1.3][i % 3] : [0.7, 0.8, 0.9][i % 3]));
    offers[product].push({ positionId: id(), product, asset, maker: short(), amount: coin(amount, asset), strikeTotal: usdc(strike),
      premium: usdc(Math.max(1, Math.round(worth * [0.012, 0.02, 0.032][i % 3]))), priceNow: usdc(worth), expiryBlock: COUNTED + left, blocksLeft: left, race: i % 5 === 1 });
  }
}

// ---- The reader's own positions: what they posted (maker) and what they took (taker). `paid` = running, payment
// counted, release about an hour away.
function loanLines(p) {
  const r = money(p.repay), c = money(p.collateral), lent = money(p.principal), got = money(usdc(num(p.principal) - loanFee(num(p.principal))));
  const due = p.dueBlock && until(p.dueBlock, p.blocksLeft);
  const maker = {
    creating: [`The signers are setting up a lock for your ${c}.`, 'If this does not finish, nothing is locked and you can ask again.'],
    funding: [`Your ${c} is on its way into the lock.`, 'If it never arrives, the request ends and nothing is lost.'],
    posted: [`Your request is open. A lender who takes it pays you ${got}.`, `If nobody takes it by ${until(COUNTED + 720, 720)}, your ${c} comes back to you.`],
    taking: [`A lender is paying you ${got} right now.`, 'If their payment does not arrive within 10 minutes, your request opens again.'],
    running: [`You have the ${got}. Pay back ${r} by ${due}.`, `The lender keeps your ${c}.`],
    paid: [`You paid back ${r}.`, null],
    'ended:repaid': [`You paid back ${r}. Your ${c} is back in your wallet.`, null],
    'ended:defaulted': [`The payment was missed, so the lender kept your ${c}.`, null],
    'ended:cancelled': [`You cancelled the request. Your ${c} is back.`, null],
    'ended:unfunded': [`The ${assetOf(p)} never arrived in the lock, so the request ended. Nothing was lost.`, null],
    released: [`Finished. Your ${c} is back in your wallet.`, null],
  };
  const taker = {
    taking: [`You are paying ${lent} to the borrower.`, 'Your payment must be confirmed within 10 minutes, or the request opens again for others.'],
    running: [`You lent ${lent}. The borrower pays back ${r} by ${due}.`, `You get their ${c} (~${p.collateralNow.text} USDC now).`],
    paid: [`The borrower paid back ${r}.`, null],
    'ended:repaid': [`The borrower paid back ${r}.`, null],
    'ended:defaulted': [`The borrower did not pay back. Their ${c} is on its way to you.`, null],
    released: [`Finished. The ${c} is in your wallet.`, null],
  };
  return (p.role === 'maker' ? maker : taker)[p.paid ? 'paid' : p.state];
}
function optionLines(p) {
  const a = money(p.amount), k = money(p.strikeTotal), f = money(p.premium), got = money(usdc(num(p.premium) - optionFee(num(p.premium))));
  const when = p.expiryBlock && until(p.expiryBlock, p.blocksLeft), call = p.product === 'call', mine = call ? a : k;
  const maker = {
    creating: [`The signers are setting up a lock for your ${mine}.`, 'If this does not finish, nothing is locked and you can offer again.'],
    funding: [call ? `Your ${a} is on its way into the lock.` : `Your ${k} is going into the Solana escrow.`, 'If it never arrives, the offer ends and nothing is lost.'],
    posted: [call ? `Your ${a} is offered: whoever takes it pays you ${got} and may buy it for ${k} until ${when}.`
      : `Your ${k} is offered: whoever takes it locks ${a}, pays you ${got} and may sell it to you for ${k} until ${when}.`, `If nobody takes it, your ${mine} comes back to you.`],
    taking: [call ? `Someone is paying you ${got} right now.` : `Someone is locking ${a} and paying you ${got} right now.`, 'If this does not finish within 10 minutes, your offer opens again.'],
    running: [call ? `You got ${got}. Until ${when} they may buy your ${a} for ${k}.` : `You got ${got}. Their ${a} is locked; until ${when} they may sell it to you for your ${k}.`,
      `Your ${mine} comes back to you, and you keep the ${got}.`],
    paid: [call ? `They paid ${k} for your ${a}.` : `They sold you ${a} for your ${k}.`, null],
    'ended:exercised': [call ? `They bought your ${a}. You got ${k}.` : `They sold you ${a} for your ${k}.`, null],
    'ended:expired': [`It was not used. Your ${mine} is coming back, and you kept the ${got}.`, null],
    'ended:cancelled': [`You cancelled the offer. Your ${mine} is back.`, null],
    'ended:unfunded': [call ? `The ${assetOf(p)} never arrived in the lock, so the offer ended. Nothing was lost.` : 'The USDC never arrived in the escrow, so the offer ended. Nothing was lost.', null],
    released: [`Finished. Your ${mine} is back in your wallet.`, null],
  };
  const taker = {
    taking: [call ? `You are paying a ${f} fee.` : `Your ${a} is going into a lock and your ${f} fee is on its way.`,
      call ? 'Your payment must be confirmed within 10 minutes, or the offer opens again for others.' : `If this does not finish within 10 minutes, your ${a} comes back to you.`],
    running: [call ? `You may buy ${a} for ${k} until ${when}. The price now is ${p.priceNow.text}.` : `Your ${a} is locked. You may sell it for ${k} until ${when}.`,
      call ? `The right ends; the ${f} fee is not returned.` : `Your ${a} comes back to you; the fee is not returned.`],
    paid: [call ? `You paid ${k} for ${a}.` : `You sold your ${a} for ${k}.`, null],
    'ended:exercised': [call ? `You bought ${a} for ${k}.` : `You sold your ${a} for ${k}.`, null],
    'ended:expired': [call ? `You did not use it. The right ended; the ${f} fee was spent.` : `You did not use it. Your ${a} came back to you; the ${f} fee was spent.`, null],
    released: [call ? `Finished. The ${a} is in your wallet.` : `Finished. The ${k} is in your wallet.`, null],
  };
  return (p.role === 'maker' ? maker : taker)[p.paid ? 'paid' : p.state];
}

function position(product, role, state, extra = {}) {
  const p = { positionId: id(), product, role, state, asset: 'RESET', counterparty: ['creating', 'funding', 'posted', 'ended:cancelled', 'ended:unfunded'].includes(state) ? null : short(),
    at: now() - Math.floor(rnd() * 86400 * 3), ...extra };
  p.createdAt ??= p.at;
  // A counted payment: when it was paid and where Bitcoin's clock (median time) stands, unless `clock: false`.
  if (p.paid && p.clock !== false) { p.paidAt ??= now() - 900; p.bitcoinTime ??= p.paidAt - 2700; }
  delete p.clock;
  const price = PRICES[p.asset];
  if (product === 'loan') {
    p.principal ??= usdc(100); p.repay ??= usdc(103); p.collateral ??= coin(1, p.asset); p.collateralNow = usdc(num(p.collateral) * price); p.termBlocks ??= 2016;
    if (['running', 'taking'].includes(state)) { p.blocksLeft ??= state === 'taking' ? p.termBlocks : 1500; p.dueBlock = COUNTED + p.blocksLeft; }
    if (role === 'maker' && state === 'running' && !p.paid) p.nextAction = { action: 'repay' };
  } else {
    p.amount ??= coin(1, p.asset); p.strikeTotal ??= usdc(product === 'call' ? 300 : 200); p.premium ??= usdc(5); p.priceNow ??= usdc(num(p.amount) * price);
    if (!/^(ended|released)/.test(state)) { p.blocksLeft ??= 1008; p.expiryBlock = COUNTED + p.blocksLeft; }
    if (role === 'taker' && state === 'running' && !p.paid) {
      p.nextAction = { action: 'exercise' };
      p.worthUsing = product === 'call' ? num(p.priceNow) > num(p.strikeTotal) : num(p.priceNow) < num(p.strikeTotal);
    }
    if (product === 'put' && role === 'maker' && ['posted', 'taking', 'running'].includes(state) && !p.paid) {
      p.refundAfter = now() + p.blocksLeft * 600 + 604800;
      p.recovery = `If the signers ever stop answering, you can take your ${p.strikeTotal.text} USDC back yourself after ${new Date((now() + (p.blocksLeft * 600 + 604800)) * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.`;
    }
  }
  if (role === 'maker' && state === 'posted') p.nextAction = { action: 'cancel' };
  return lines(p);
}
function lines(p) {
  const [n, m] = (p.product === 'loan' ? loanLines : optionLines)(p);
  p.now = n; p.ifMissed = m;
  return p;
}

const TNK = { asset: 'TNK' };
const tnkLoan = { ...TNK, principal: usdc(100), repay: usdc(103), collateral: coin(2000, 'TNK') };
const tnkCall = { ...TNK, amount: coin(5000, 'TNK'), strikeTotal: usdc(480), premium: usdc(9) };
const tnkPut = { ...TNK, amount: coin(2000, 'TNK'), strikeTotal: usdc(140), premium: usdc(4) };
const MAKER = ['creating', 'funding', 'posted', 'taking', 'running', 'ended:repaid', 'ended:defaulted', 'ended:cancelled', 'ended:unfunded', 'released'];
const OPT_MAKER = ['creating', 'funding', 'posted', 'taking', 'running', 'ended:exercised', 'ended:expired', 'ended:cancelled', 'ended:unfunded', 'released'];
const OPT_TAKER = ['taking', 'running', 'ended:exercised', 'ended:expired', 'released'];
const mine = [
  position('loan', 'maker', 'running', { principal: usdc(50), repay: usdc(51.5), collateral: coin(0.5, 'RESET'), blocksLeft: 30 }),
  position('call', 'taker', 'running', { priceNow: usdc(320), blocksLeft: 400 }),
  position('put', 'taker', 'running', { priceNow: usdc(180), blocksLeft: 260 }),
  position('loan', 'maker', 'running', { paid: true, blocksLeft: 900, at: now() - 300 }),
  position('loan', 'taker', 'running', { ...tnkLoan, paid: true, blocksLeft: 700, at: now() - 300, clock: false }),
  position('call', 'taker', 'running', { ...tnkCall, priceNow: usdc(520), paid: true, blocksLeft: 300, at: now() - 300, paidAt: now() - 4000, bitcoinTime: now() - 3700 }),
  position('call', 'maker', 'running', { paid: true, blocksLeft: 500, at: now() - 300, clock: false }),
  position('put', 'taker', 'running', { ...tnkPut, priceNow: usdc(120), paid: true, blocksLeft: 200, at: now() - 300 }),
  position('put', 'maker', 'running', { paid: true, blocksLeft: 600, at: now() - 300, paidAt: now() - 5400, bitcoinTime: now() - 5300 }),
  // A deadline before the block height is known: the row shows the block number only.
  Object.assign(position('call', 'maker', 'running', { blocksLeft: 2000 }), { blocksLeft: null }),
  ...MAKER.map(s => position('loan', 'maker', s)),
  position('loan', 'maker', 'running', { ...tnkLoan, blocksLeft: 1500 }),
  position('loan', 'maker', 'posted', tnkLoan),
  ...['taking', 'running', 'ended:repaid', 'ended:defaulted', 'released'].map(s => position('loan', 'taker', s, { principal: usdc(250), repay: usdc(258), collateral: coin(2, 'RESET') })),
  position('loan', 'taker', 'running', tnkLoan),
  ...OPT_MAKER.map(s => position('call', 'maker', s)),
  position('call', 'maker', 'posted', tnkCall),
  ...OPT_TAKER.map(s => position('call', 'taker', s, { ...tnkCall, priceNow: usdc(400) })),
  ...OPT_MAKER.map(s => position('put', 'maker', s)),
  position('put', 'maker', 'running', tnkPut),
  ...OPT_TAKER.map(s => position('put', 'taker', s, { amount: coin(2, 'RESET'), strikeTotal: usdc(420), premium: usdc(8), priceNow: usdc(500) })),
  ...OPT_TAKER.map(s => position('put', 'taker', s, { ...tnkPut, priceNow: usdc(160) })),
];
const order = p => (/^(ended|released)/.test(p.state) ? 2 : (p.nextAction?.action === 'repay' || p.worthUsing) && !p.paid ? 0 : 1);

let eventId = 3, settings = { autoRepay: true, autoRepayBlocks: 6, autoExercise: true };
// Times in milliseconds, as the trader sends them.
const events = [
  { id: 1, at: (now() - 3600 * 5) * 1000, product: 'call', text: 'Your offer to earn on 1 RESET was taken' },
  { id: 2, at: (now() - 900) * 1000, product: 'loan', text: 'The borrower paid back 103 USDC' },
  { id: 3, at: (now() - 120) * 1000, product: 'loan', text: 'Your loan request was funded' },
];
const event = (text, product) => events.push({ id: ++eventId, at: Date.now(), product, text });
const fail = (message, reason, whatToDo) => Object.assign(new Error(message), { reason, hint: whatToDo });

// The plain sentence and the fee line for a step, as the trader would answer /api/locks/preview.
function preview(input) {
  if (input.action === 'post') {
    const n = k => { const v = Number(input[k]); if (!(v > 0)) throw fail('Fill in every amount above 0.', 'invalid'); return v; };
    const asset = input.asset ?? 'RESET';
    if (input.product === 'loan') {
      const u = n('principal'), c = n('collateral'), f = n('fee'), term = Number(input.termBlocks), cut = loanFee(u);
      return { sentence: `Once a lender takes this, pay back ${money(usdc(u + f))} by ${until(COUNTED + term, term)}, or the lender keeps your ${money(coin(c, asset))}.`,
        fees: { receive: usdc(u - cut), fee: usdc(cut) } };
    }
    const a = money(coin(n('amount'), asset)), k = money(usdc(n('strikeTotal'))), f = n('premium'), left = Number(input.expiryBlock) - COUNTED, cut = optionFee(f);
    const fees = { receive: usdc(f - cut), fee: usdc(cut), gross: usdc(f) };
    return input.product === 'call'
      ? { sentence: `You lock ${a} now. Whoever takes it may buy it for ${k} until ${until(input.expiryBlock, left)}. If they don't, it comes back to you.`, fees }
      : { sentence: `You put ${k} in the Solana escrow now. Whoever takes it locks ${a} and may sell it to you for ${k} until ${until(input.expiryBlock, left)}. If they don't, your USDC comes back to you.`, fees };
  }
  const o = offers[input.product]?.find(x => x.positionId === input.positionId);
  if (input.action === 'take') {
    if (!o || o.race) throw fail('Someone else just took this.', 'already_taken');
    if (o.product === 'loan') return { sentence: `You get ${money(o.repay)} back by ${until(COUNTED + o.termBlocks, o.termBlocks)}, or their ${money(o.collateral)} (~${o.collateralNow.text} USDC now).`, fees: { pay: o.principal } };
    return { fees: { pay: o.premium }, sentence: o.product === 'call'
      ? `Until ${until(o.expiryBlock, o.blocksLeft)} you may buy ${money(o.amount)} for ${money(o.strikeTotal)}. If you don't, the fee is not returned.`
      : `You lock ${money(o.amount)} until ${until(o.expiryBlock, o.blocksLeft)}. Until then you may sell it for ${money(o.strikeTotal)} with one click. If you don't, it comes back to you; the fee is not returned.` };
  }
  const p = mine.find(x => x.positionId === input.positionId);
  if (!p) throw fail('This is no longer there.', 'not_found');
  if (input.action === 'repay') return { sentence: `You pay ${money(p.repay)} to the lender now. Your ${money(p.collateral)} is released about an hour after the payment.` };
  if (input.action === 'exercise') {
    return p.product === 'call' ? { sentence: `You pay ${money(p.strikeTotal)} now. The ${money(p.amount)} is released to you about an hour after the payment.` }
      : { sentence: `You send a small Solana message now; no coins move at that moment. Your ${money(p.amount)} goes to the writer and their ${money(p.strikeTotal)} is released to you in about an hour.` };
  }
  if (input.action === 'cancel') return { sentence: `Your ${p.product === 'loan' ? 'request' : 'offer'} is taken off the list and your ${p.product === 'put' ? money(p.strikeTotal) : money(p.collateral ?? p.amount)} comes back to you.` };
  throw fail('Unknown step.', 'invalid');
}

function act(input) {
  preview(input);
  if (input.action === 'post') {
    const asset = input.asset ?? 'RESET';
    const terms = input.product === 'loan'
      ? { principal: usdc(Number(input.principal)), repay: usdc(Number(input.repay)), collateral: coin(Number(input.collateral), asset), termBlocks: Number(input.termBlocks) }
      : { amount: coin(Number(input.amount), asset), strikeTotal: usdc(Number(input.strikeTotal)), premium: usdc(Number(input.premium)), blocksLeft: Number(input.expiryBlock) - COUNTED };
    const p = position(input.product, 'maker', 'posted', { ...terms, asset, at: now() });
    mine.unshift(p);
    event(input.product === 'loan' ? 'Your loan request is open' : 'Your offer is open', input.product);
    return { positionId: p.positionId };
  }
  if (input.action === 'take') {
    const list = offers[input.product], i = list.findIndex(x => x.positionId === input.positionId), o = list[i];
    list.splice(i, 1);
    const p = position(o.product, 'taker', 'running', { ...o, race: undefined, positionId: o.positionId, at: now(), blocksLeft: o.product === 'loan' ? o.termBlocks : o.blocksLeft });
    p.counterparty = o.maker;
    mine.unshift(lines(p));
    event(`You took an offer: ${TAKE[o.product].toLowerCase()} ${o.product === 'loan' ? money(o.principal) : money(o.amount)}`, o.product);
    return { positionId: p.positionId };
  }
  const p = mine.find(x => x.positionId === input.positionId);
  if (input.action === 'cancel') p.state = 'ended:cancelled';
  else { p.paid = true; p.paidAt = now(); p.bitcoinTime = now() - 3600; }
  delete p.nextAction; delete p.worthUsing; delete p.recovery;
  lines(p);
  event({ repay: 'You paid back your loan', exercise: 'You used your right', cancel: 'Cancelled; your funds are coming back' }[input.action], p.product);
  return { positionId: p.positionId };
}

// The same paths and shapes as the trader's /api/locks/* (see locks.js).
export async function demoApi(path, payload) {
  await new Promise(r => setTimeout(r, 60));
  const url = new URL(path, 'http://demo.invalid'), q = url.searchParams;
  switch (url.pathname) {
    case '/api/locks': {
      const term = o => o.termBlocks ?? o.blocksLeft, min = Number(q.get('minTerm') ?? 0), max = Number(q.get('maxTerm') ?? Infinity);
      const list = (offers[q.get('product')] ?? []).filter(o => (!q.get('asset') || o.asset === q.get('asset')) && term(o) >= min && term(o) <= max), page = Number(q.get('page') ?? 0);
      return { rows: list.slice(page * PAGE, page * PAGE + PAGE).map(({ race, ...o }) => o), total: list.length, page, pageSize: PAGE, counted: COUNTED };
    }
    case '/api/locks/mine':
      return { rows: [...mine].sort((a, b) => order(a) - order(b) || b.at - a.at), counted: COUNTED, prices: { RESET: usdc(PRICES.RESET), TNK: usdc(PRICES.TNK) } };
    case '/api/locks/events': {
      const since = Number(q.get('since') ?? 0);
      return { rows: events.filter(e => e.id > since).slice(-20), next: String(eventId) };
    }
    case '/api/locks/settings':
      if (payload) settings = { ...settings, ...payload };
      return settings;
    case '/api/locks/preview':
      return { ...preview(payload), confirm: 'demo', input: payload };
    case '/api/locks/act':
      return { ok: true, result: act(payload) };
  }
  throw fail('not found', 'not_found');
}

// Enough of /api/state for the page to draw when no trader answers.
export const demoState = () => ({ role: 'trader', network: 'demo', wallets: null, trader: { pairs: [], balances: null, counts: {}, signersOnline: 0, registryVersion: null } });
