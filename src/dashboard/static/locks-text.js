// Short words and numbers for the Borrow & Lend and Options tabs: block deadlines, table cells, status pills, the
// release wait, the step tracker, fee rows and short errors. No DOM, so it runs anywhere.
export const BLOCK_SEC = 600;
export const ASSETS = ['RESET', 'TNK'];
export const TERMS = [[144, '1 day'], [1008, '1 week'], [2016, '2 weeks']];
export const STATES = {
  creating: 'Setting up', funding: 'Locking', posted: 'Open', taking: 'Being taken', running: 'Running', released: 'Finished',
  'ended:repaid': 'Paid back', 'ended:defaulted': 'Not paid back', 'ended:exercised': 'Used', 'ended:expired': 'Not used',
  'ended:cancelled': 'Cancelled', 'ended:unfunded': 'Never locked',
};

export const blockNo = n => Number(n).toLocaleString('en-US');
// Blocks as time, one block about ten minutes: "40 min", "5 hours", "1 day", "14 days".
export function about(blocks) {
  const min = Math.max(0, Number(blocks)) * BLOCK_SEC / 60, hours = Math.round(min / 60), days = Math.round(min / 1440);
  if (min < 60) return `${Math.max(1, Math.round(min))} min`;
  if (min < 20 * 60) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${days} day${days === 1 ? '' : 's'}`;
}
// The same for a table cell: "40m", "23h", "14d".
export function short(blocks) {
  const min = Math.max(0, Number(blocks)) * BLOCK_SEC / 60;
  if (min < 60) return `${Math.max(1, Math.round(min))}m`;
  if (min < 48 * 60) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)}d`;
}
// Seconds as a short wait: "45m", "2h".
export const wait = s => (s < 90 * 60 ? `${Math.max(1, Math.round(s / 60))}m` : `${Math.round(s / 3600)}h`);
export const money = a => (a ? `${a.text} ${a.unit}` : '—');
export const plain = s => String(s ?? '').replaceAll(',', '').trim();
export const positive = s => /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(s) && /[1-9]/.test(s);
const num = a => Number(plain(a?.text));
const fmt = (v, digits) => Number(v.toFixed(digits)).toLocaleString('en-US', { maximumFractionDigits: digits });

// a + b for decimal strings, exact (no floating point), with at most `places` decimals.
export function addDecimal(a, b, places) {
  const units = s => { const [w, f = ''] = s.split('.'); return BigInt(w) * 10n ** BigInt(places) + BigInt(f.padEnd(places, '0').slice(0, places) || '0'); };
  const sum = String(units(a) + units(b)).padStart(places + 1, '0');
  const whole = sum.slice(0, sum.length - places), frac = sum.slice(sum.length - places).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

// price × amount as a decimal string with `places` decimals, rounded to the nearest unit (no floats).
export function mulDecimal(price, amount, places) {
  const parse = x => { const [w, f = ''] = x.split('.'); return [BigInt(w + f), f.length]; };
  const [p, ps] = parse(price), [a, as] = parse(amount), shift = BigInt(ps + as - places);
  const units = shift >= 0n ? (p * a + 10n ** shift / 2n) / 10n ** shift : p * a * 10n ** -shift;
  return addDecimal(units === 0n ? '0' : (String(units).padStart(places + 1, '0').replace(new RegExp(`(\\d{${places}})$`), '.$1')), '0', places);
}

// The price per coin of a total, for display only ("300", "0.096"); null when either is missing.
export function priceText(total, amount) {
  const t = num(total), a = num(amount);
  if (!(t > 0 && a > 0)) return null;
  const v = t / a;
  return fmt(v, v >= 100 ? 2 : v >= 1 ? 4 : 6);
}
// A loan's fee as a share of the amount for its term, and roughly per year: { rate: '3.00%', apr: '78%' }.
export function loanRate(principal, repay, termBlocks) {
  const p = num(principal), r = num(repay);
  if (!(p > 0 && r >= p)) return null;
  const pct = (r - p) / p * 100, apr = termBlocks > 0 ? pct * (365 * 144) / termBlocks : null;
  return { rate: `${pct.toFixed(2)}%`, apr: apr == null ? null : `${fmt(apr, apr >= 10 ? 0 : 1)}%` };
}
// How much of the security's value is lent: "40%".
export function loanToValue(principal, valueNow) {
  const p = num(principal), v = num(valueNow);
  return p > 0 && v > 0 ? `${Math.round(p / v * 100)}%` : null;
}

export const stateOf = p => (p.state === 'ended' && p.outcome ? `ended:${p.outcome}` : p.state);
export const isDone = p => /^(ended|released)/.test(stateOf(p));
export const actionOf = p => (typeof p.nextAction === 'string' ? { action: p.nextAction } : p.nextAction ?? null);
export const isLoan = p => p.product === 'loan';
export const assetOf = p => p.asset ?? (isLoan(p) ? p.collateral : p.amount)?.unit ?? 'RESET';
// Paid (repaid, or a right used) and waiting for the early release: the row says so and asks for nothing more.
export const isPaid = p => p.paid === true && !isDone(p);
export const TAKE = { loan: 'Lend', call: 'Reserve', put: 'Protect' };

// Where a position stands, for the list filter.
export function groupOf(p) {
  const s = stateOf(p);
  if (['ended:cancelled', 'ended:unfunded'].includes(s)) return 'failed';
  if (s === 'released' || s.startsWith('ended:')) return 'done';
  if (['creating', 'funding', 'posted', 'taking'].includes(s)) return 'open';
  return 'active';
}

// Table cells for one of the reader's positions.
export const productLabel = p => (isLoan(p) ? (p.role === 'maker' ? 'Borrow' : 'Lend') : p.product === 'call' ? 'Call' : 'Put');
export const sideLabel = p => (isLoan(p) ? null : p.role === 'maker' ? 'sold' : 'bought');
export const sizeOf = p => (isLoan(p) ? p.collateral : p.amount);
// The money that matters most for the reader, signed: a borrower pays back, a lender gets back, an option's writer
// gets the fee and its holder pays it.
export function flowOf(p) {
  const maker = p.role === 'maker', a = isLoan(p) ? p.repay : p.premium;
  if (!a) return null;
  return { sign: isLoan(p) ? (maker ? '-' : '+') : (maker ? '+' : '-'), amount: a };
}
// The deadline that matters: due for loans, until for calls and puts. Without a known height, the block only.
export function deadlineOf(p) {
  const block = p.dueBlock ?? p.expiryBlock;
  if (block == null || isDone(p) || isPaid(p)) return null;
  return { block: blockNo(block), left: p.blocksLeft == null ? null : p.blocksLeft > 0 ? short(p.blocksLeft) : 'reached' };
}

// The one button of a row (short) and the heading of its dialog (with the amounts).
export function actionShort(p) {
  const a = actionOf(p);
  if (!a || isPaid(p) || a.action === 'take') return null;
  return { repay: 'Pay back', exercise: p.product === 'put' ? 'Sell now' : 'Buy now', cancel: 'Cancel', refund: 'Refund' }[a.action] ?? a.label ?? a.action;
}
export function actionHeading(p) {
  const a = actionOf(p);
  if (a?.label) return a.label;
  if (a?.action === 'repay') return `Pay back ${money(p.repay)}`;
  if (a?.action === 'exercise') return `${p.product === 'put' ? 'Sell' : 'Buy'} ${money(p.amount)} for ${money(p.strikeTotal)}`;
  if (a?.action === 'refund') return `Refund ${money(p.strikeTotal)}`;
  return a?.action === 'cancel' ? `Cancel ${isLoan(p) ? 'request' : 'offer'}` : a?.action ?? '';
}

// Only what the reader must do: paying back a loan, or using a right that is worth using. Cancelling never counts.
export function needsAction(p) {
  if (typeof p.needsAction === 'boolean') return p.needsAction;
  if (isPaid(p)) return false;
  const a = actionOf(p)?.action;
  return a === 'repay' || (a === 'exercise' && p.worthUsing === true);
}

export const stateLabel = p => (isPaid(p) ? 'Releasing' : STATES[stateOf(p)] ?? stateOf(p));
// The pill colour: running, open, waiting on the network, good end, failed, neutral end.
export function toneOf(p) {
  if (isPaid(p)) return 'up';
  const s = stateOf(p);
  if (s === 'running') return 'run';
  if (s === 'posted') return 'open';
  if (['creating', 'funding', 'taking'].includes(s)) return 'wait';
  if (['released', 'ended:repaid', 'ended:exercised'].includes(s)) return 'up';
  return p.reason ? 'down' : 'off';
}

export const hhmm = s => new Date(s * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
// The early release once a payment counts: the signers release when Bitcoin's clock (the middle time of the last 11
// blocks, usually 1–2 hours behind) passes the payment. `left` is how far that clock still has to go; `progress`
// compares it with the time since paying. Without both times only that it is releasing is known.
export function releaseWait(p, now) {
  if (!isPaid(p)) return null;
  if (!Number.isFinite(p.paidAt) || !Number.isFinite(p.bitcoinTime)) return { left: null, progress: null, text: null, tip: ['Payment counted', 'Release usually 1–2h'] };
  const left = Math.max(0, p.paidAt - p.bitcoinTime), since = Math.max(0, now - p.paidAt);
  return { left, progress: left === 0 ? 1 : since / (since + left), text: left === 0 ? 'now' : `~${wait(left)}`,
    tip: [`Paid ${hhmm(p.paidAt)}`, `Bitcoin clock ${hhmm(p.bitcoinTime)}`] };
}

// The four steps of a position, or the steps up to how it ended: [{ label, at: 'done' | 'now' | 'next' | 'end' }].
const ENDED = { defaulted: 'Not paid back', expired: 'Not used', cancelled: 'Cancelled', unfunded: 'Never locked' };
export function steps(p) {
  const s = stateOf(p), outcome = s.startsWith('ended:') ? s.slice(6) : p.outcome ?? null;
  const labels = ['Created', 'Running', isLoan(p) ? 'Paid back' : 'Used', 'Released'];
  const make = (...at) => at.map((a, i) => ({ label: labels[i], at: a }));
  if (outcome === 'cancelled' || outcome === 'unfunded') return [{ label: 'Created', at: 'done' }, { label: ENDED[outcome], at: 'end' }];
  if (outcome === 'defaulted' || outcome === 'expired') return [{ label: 'Created', at: 'done' }, { label: 'Running', at: 'done' }, { label: ENDED[outcome], at: 'end' }, { label: 'Released', at: s === 'released' ? 'done' : 'now' }];
  if (s === 'released') return make('done', 'done', 'done', 'done');
  if (s.startsWith('ended:') || isPaid(p)) return make('done', 'done', 'done', 'now');
  if (s === 'running') return make('done', 'now', 'next', 'next');
  return make('now', 'next', 'next', 'next');
}

// Rows of the fee table for a preview's `fees` (§16.6: the fee comes out of what the maker receives; whoever takes
// pays exactly the amount shown). With the service's split, the fee is shown as venue and signers' shares.
export function feeRows(f, service) {
  if (!f) return [['Service fee', 'None']];
  if (f.pay) return [['You pay', money(f.pay)], ['Service fee', 'Paid by maker']];
  if (!f.receive) return [];
  const rows = f.gross ? [['Fee asked', money(f.gross)]] : [];
  rows.push(['Service fee', money(f.fee)]);
  if (service && Number.isFinite(Number(service.venuePct)) && f.fee) {
    const part = pct => `${mulDecimal(plain(f.fee.text), String(Number(pct) / 100), 6)} ${f.fee.unit}`;
    rows.push([`Venue ${service.venuePct}%`, part(service.venuePct), 'sub'], [`Signers ${service.signerPct}%`, part(service.signerPct), 'sub']);
  }
  rows.push(['You receive', money(f.receive), 'total']);
  return rows;
}

// An error for a one-line slot: [short, full] — the full text goes behind "?" when the short one leaves some out.
export function shortError(text, max = 80) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (t.length <= max) return [t, null];
  const first = t.match(/^.+?[.!?](?=\s|$)/)?.[0];
  return [first && first.length <= max ? first : `${t.slice(0, max - 1).trimEnd()}…`, t];
}
