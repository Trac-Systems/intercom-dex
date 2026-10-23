import { termsOf, assetOf } from './products/index.js';
import { formatUnits } from './position.js';

// The lock venue's public summary (Market World and other viewers): open offers, running positions and recent
// outcomes, which committee members' releases counted, which signers are online and the Bitcoin block the locks run
// on. Only facts the public channels already carry; amounts are plain decimal strings without the coin name.
// counted and blockAt are 0 while the venue's clock has not answered.
export const SUMMARY_LIMITS = Object.freeze({ offers: 30, running: 40, ended: 20 });
const ONLINE_SEC = 120;

const amount = (value, asset) => value === undefined ? undefined : formatUnits(value, asset).split(' ')[0];
const party = p => p ? { trac: p.trac, sol: p.sol } : null;
const dueOf = p => p.post.product === 'loan'
  ? Object.values(p.opened ?? {}).map(m => m.body.dueBlock).find(Number.isSafeInteger) ?? null : termsOf(p).expiryBlock;

function terms(p) {
  const t = termsOf(p), asset = assetOf(p), product = p.post.product;
  const row = { id: p.positionId, product, asset, amount: amount(t.collateral ?? t.amount, asset), maker: party(p.post.maker), postedAt: p.post.createdAt };
  if (product === 'loan') Object.assign(row, { principal: amount(t.principal, 'USDC'), repay: amount(t.repay, 'USDC'), termBlocks: t.termBlocks });
  else Object.assign(row, { strikeTotal: amount(t.strikeTotal, 'USDC'), premium: amount(t.premium, 'USDC'), expiryBlock: t.expiryBlock });
  return row;
}

export function lockSummary(positions, { now, counted = null, blockAt = null, signers = [], seen = new Map() }) {
  const all = [...positions], newest = (a, b) => (b.endedAt ?? b.post.createdAt) - (a.endedAt ?? a.post.createdAt) || a.positionId.localeCompare(b.positionId);
  const offers = all.filter(p => p.state === 'posted' && (counted === null || termsOf(p).offerUntilBlock > counted)).sort(newest)
    .slice(0, SUMMARY_LIMITS.offers).map(p => ({ ...terms(p), offerUntilBlock: termsOf(p).offerUntilBlock }));
  const running = all.filter(p => p.state === 'running').map(p => ({ p, due: dueOf(p) }))
    .sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity) || a.p.positionId.localeCompare(b.p.positionId)).slice(0, SUMMARY_LIMITS.running)
    .map(({ p, due }) => ({ ...terms(p), taker: party(p.taker), dueBlock: due }));
  const ended = all.filter(p => p.state.startsWith('ended:') && p.endedAt !== undefined).sort(newest).slice(0, SUMMARY_LIMITS.ended)
    .map(p => ({ ...terms(p), taker: party(p.taker), outcome: p.state.slice(6), winner: p.winner ?? null, endedAt: p.endedAt,
      keys: Object.values(p.releases ?? {}).filter(m => !m.body.takeId && m.body.outcome === p.state.slice(6)).map(m => m.body.j).sort((a, b) => a - b) }));
  return { ts: now, counted: counted ?? 0, blockAt: blockAt ?? 0, signers: signers.map((s, i) => ({ n: i + 1, online: now - (seen.get(s.lockKey) ?? -Infinity) <= ONLINE_SEC })), offers, running, ended };
}
