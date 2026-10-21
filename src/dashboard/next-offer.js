import { priceUnits, registryPair } from '../market/assets.js';
import { ownTakes } from './market.js';

// Takes started from the dashboard keep going at their price: when the maker does not answer, declines or gives up
// while the two traders are still agreeing the trade, the next offer at the same price is taken at once, for the
// amount still wanted, until one goes through or no offer is left there.
//
// Never two orders for one take: only one trade of a chain runs at a time; the chain moves on only from a trade that
// ended while still agreeing terms (no lock, transfer or signer step can have started, so nothing can still fill);
// and while a chain runs, no other dashboard take on that pair and side starts.
export const MAX_NEXT_TAKES = 10;
const AGREEING = new Set(['new', 'awaitAccept', 'awaitReveal', 'awaitRandomness', 'awaitTerms', 'awaitTermsSig']);
const NOT_THE_MAKER = /signers/i;

export const movesOn = (before, state) => state.phase === 'aborted' && AGREEING.has(before?.phase) &&
  !state.lockAttempted && !state.locked && !NOT_THE_MAKER.test(String(state.reason ?? ''));

export function createNextOffer({ role, log = () => {}, defer = fn => setTimeout(fn, 0) }) {
  const follows = new Map(), notes = new Map();
  const running = (pair, side) => [...follows.values()].some(f => f.pair === pair && f.side === side);

  function next(f) {
    const price = priceUnits(f.price), { skip, running: held } = ownTakes(role.host.trades.values());
    const rows = [];
    for (const seen of role.offers.values()) {
      const id = seen.offer.offerId;
      if (seen.offer.pair !== f.pair || seen.offer.side !== f.side || f.tried.has(id) || skip.has(id) || held.has(id)) continue;
      let same; try { same = priceUnits(seen.offer.price) === price; } catch { same = false; }
      const o = same ? role.availableOffer(id) : null;
      if (!o) continue;
      let min; try { min = BigInt(registryPair(role.registry.snapshot(o.registryVersion), o.pair).minBaseAmount); } catch { continue; }
      if (BigInt(o.baseAmount) >= min) rows.push({ o, left: BigInt(o.baseAmount), at: seen.firstSeen ?? seen.lastSeen });
    }
    rows.sort((a, b) => a.at - b.at || (a.o.offerId < b.o.offerId ? -1 : 1));
    return rows[0] ?? null;
  }

  // Refuses a second take on a pair and side while a chain there is still agreeing terms or moving on.
  function check(offer) {
    if (offer && running(offer.pair, offer.side)) throw new Error('Your last take at this market is still being agreed; wait until it goes through or ends.');
  }

  async function take(offerId, baseAmount, price) {
    const o = role.offers.get(offerId)?.offer;
    if (!o) return role.takeOffer(offerId, baseAmount, price);
    check(o);
    // Held before the take starts, so a second request arriving meanwhile is refused.
    const hold = Symbol('starting'), f = { pair: o.pair, side: o.side, price: o.price, want: 0n, tried: new Set([offerId]), count: 0, moving: true };
    follows.set(hold, f);
    try {
      const r = await role.takeOffer(offerId, baseAmount, price);
      f.want = BigInt(r?.baseAmount ?? baseAmount ?? o.baseAmount); f.moving = false;
      if (r?.key) follows.set(r.key, f);
      return r;
    } finally { follows.delete(hold); }
  }

  async function moveOn(key) {
    const f = follows.get(key);
    if (!f || f.moving) return;
    f.moving = true;
    try {
      const n = f.count < MAX_NEXT_TAKES ? next(f) : null;
      if (!n) { notes.set(key, { moved: false, text: 'No other offer at this price could take over.' }); return; }
      f.tried.add(n.o.offerId);
      const r = await role.takeOffer(n.o.offerId, (f.want < n.left ? f.want : n.left).toString(), n.o.price);
      f.count++;
      notes.set(key, { moved: true, text: 'The next offer at this price was taken instead.' });
      follows.set(r.key, { ...f, moving: false });
    } catch (e) {
      log('next offer', e.message);
      notes.set(key, { moved: false, text: `The next offer at this price could not be taken: ${e.message}` });
    } finally { follows.delete(key); }
  }

  role.host.hooks?.afterStep.push((trade, before) => {
    const f = follows.get(trade.key);
    if (!f || f.moving) return;
    if (movesOn(before, trade.state)) defer(() => moveOn(trade.key).catch(e => log('next offer', e.message)));
    else if (!AGREEING.has(trade.state.phase)) follows.delete(trade.key);
  });
  return { take, check, note: key => notes.get(key) ?? null };
}
