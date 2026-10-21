import { existsSync } from 'node:fs';
import { isFinished } from '../roles/host.js';
import { LOCK_START_MARGIN_SEC } from '../core/trade-buyer.js';
import { open, createReplayCache } from '../core/envelope.js';
import { supportedBase, tradePrice, registryPair } from '../market/assets.js';
import { amount, shortKey } from './format.js';
import { buildBook, ownTakes } from './market.js';

const DAY = 86400, ONLINE_SEC = 90, PAYOUT_DELAY = 7 * DAY;
export const BALANCE_CACHE_MS = 30000;
const NEGOTIATING = ['new', 'awaitTake', 'awaitAccept', 'awaitReveal', 'awaitRandomness', 'awaitTerms', 'awaitTermsSig', 'negotiated'];
const HELD = ['holding', 'verifyingTransfer', 'persistingTransfer'];
const PUBLIC_CHANNELS = ['intercom-dex', 'intercom-dex:offers', 'intercom-dex:signers', 'intercom-dex:chat'];
const nowSec = () => Math.floor(Date.now() / 1000);
const sum = list => list.reduce((a, b) => a + BigInt(b), 0n);

// At most one call of `fn` per `ms`; callers in between get the last result. A failure keeps the last good value.
export function cached(fn, ms, clock = () => Date.now()) {
  let at = -Infinity, last = null, pending = null;
  return () => {
    if (pending) return pending;
    if (clock() - at < ms) return Promise.resolve(last);
    at = clock();
    pending = Promise.resolve().then(fn).then(value => ({ ok: true, value, at }), error => ({ ok: false, error: error.message, value: last?.value ?? null, at }))
      .then(result => { last = result; pending = null; return result; });
    return pending;
  };
}

// Like `cached`, but a caller never waits for a refresh once a result exists: it gets the last result while the
// next read runs in the background. Before the first result a caller waits at most `firstWaitMs`.
export function refreshing(fn, ms, clock = () => Date.now(), firstWaitMs = 2000) {
  const read = cached(fn, ms, clock);
  let last = null;
  return () => {
    const next = read().then(result => (last = result));
    if (last) return Promise.resolve(last);
    let timer;
    const waited = new Promise(resolve => { timer = setTimeout(() => resolve({ ok: false, error: 'still being read', value: null, at: null }), firstWaitMs); });
    return Promise.race([next, waited]).finally(() => clearTimeout(timer));
  };
}

const REASONS = [
  [/^Invalid (dealing|lock certificate)/, "the buyer's lock details did not check out"],
  [/^Timed out/, 'the other side took too long to answer'],
  [/^Signers did not confirm/, 'not enough signers confirmed in time'],
  [/^Negotiation deadline expired/, 'the trade could not be prepared in time'],
  [/^Not enough signers online/, 'not enough signers were online'],
];
export function plainReason(reason) {
  const text = String(reason ?? '').slice(0, 160);
  return REASONS.find(([re]) => re.test(text))?.[1] ?? (text || 'no reason given');
}

function tradeFacts(trade) {
  const s = trade.state, t = s.terms ?? s.draft, base = t.base.id;
  return { key: trade.key.slice(0, 16), tradeId: s.tradeId ?? null, pair: t.pair, side: trade.role === 'buyer' ? 'buy' : 'sell', mode: s.mode ?? null,
    base: amount(t.baseAmount, base), quote: amount(t.quoteAmount, 'USDC'), price: tradePrice({ base: t.base }, t.baseAmount, t.quoteAmount),
    peer: shortKey(s.peer), phase: s.phase, at: s.now };
}

// One plain line for a running trade: what happens now, who we wait for, the next deadline and what happens
// automatically when nothing happens. Times are Unix seconds; the page shows them in local time.
export function describeTrade(trade) {
  const s = trade.state, t = s.terms ?? s.draft, base = t.base.id, k = t.k;
  const confirmed = `signers confirmed: ${s.acks?.length ?? 0} of ${k}`;
  const line = (now, waitingFor, ifMissed, deadline, fallback, fallbackAt = null) => ({ now, waitingFor, ifMissed, deadline, fallback, fallbackAt });
  if (NEGOTIATING.includes(s.phase)) {
    return line('Agreeing the trade details with the other trader', 'the other trader', 'If the other trader stops answering', null,
      'the trade is called off within a few minutes; nothing is locked or sent');
  }
  if (trade.role === 'buyer') {
    const lockBy = t.sendBy - LOCK_START_MARGIN_SEC;
    switch (s.phase) {
      case 'awaitCertificate': case 'preparingDeal': case 'proving':
        return line('Preparing the lock for your USDC', 'this computer', 'If it is not ready by', lockBy, 'the trade is called off; nothing is locked');
      case 'awaitAcks':
        return line(`Waiting for signers to confirm they hold their key pieces (${confirmed})`, 'signers', 'If not enough signers confirm by', lockBy,
          'the trade is called off; nothing is locked');
      case 'locking':
        return line('Locking your USDC on Solana', 'Solana', 'If the lock cannot be confirmed', null, 'any USDC that was locked comes back automatically on', t.refundAfter);
      case 'locked':
        if (s.txHash || s.sellerClaimed) {
          return line(`Your USDC is locked and the seller has sent the ${base}; waiting for the key to be released so the trade can finish`,
            'signers and the seller', "If the seller doesn't collect by", t.refundAfter, 'your USDC comes back automatically');
        }
        return line(`Your USDC is locked. Waiting for the seller to send the ${base}`, 'the seller', "If the seller doesn't send by", t.sendBy,
          'your USDC comes back automatically on', t.refundAfter);
      case 'refunding':
        return line('Taking your USDC back from the lock, because the seller did not finish in time', 'Solana', null, null, 'This is retried automatically until it goes through.');
      case 'aborted':
        return line('Called off after the lock started', 'the refund time', null, null, 'Any locked USDC comes back automatically on', t.refundAfter);
    }
  } else {
    switch (s.phase) {
      case 'awaitDeal':
        return line("Waiting for the buyer's lock details", 'the buyer', "If they don't arrive soon", null, 'the trade is called off; you send nothing');
      case 'checkingProof':
        return line("Checking the buyer's lock details", 'this computer', 'If they do not check out', null, 'the trade is called off; you send nothing');
      case 'awaitReady':
        return line(`Waiting for the buyer to lock the USDC (${confirmed})`, 'the buyer and signers', 'If the USDC is not locked by', t.sendBy,
          'the trade is called off; you send nothing');
      case 'reservingEscrow': case 'transferring':
        return line(`Sending your ${base} to the buyer`, 'the Trac network', 'If it cannot be sent by', t.sendBy, 'nothing is sent and the trade is called off');
      case 'awaitShares':
        return line(`Your ${base} was sent. Waiting for signers to release the key (${s.shares?.length ?? 0} of ${k} key pieces)`, 'signers',
          'If the key is not released by', t.refundAfter, 'the buyer can take the USDC back');
      case 'claiming':
        return line('Collecting your USDC', 'Solana', 'This has to finish before', t.refundAfter, 'it is retried automatically until then');
    }
  }
  return line('Working', 'this computer', null, null, '');
}

// What a finished trade came to, in plain words.
export function outcome(trade, note = null) {
  const s = trade.state, t = s.terms ?? s.draft, base = t.base.id;
  if (s.phase === 'complete') return { tone: 'good', text: trade.role === 'buyer' ? `Done: you received the ${base}` : 'Done: you received the USDC' };
  if (s.phase === 'refunded') return { tone: 'neutral', text: 'Your USDC came back; the seller did not finish in time' };
  if (s.phase === 'lost') return { tone: 'bad', text: `The key was not released in time and the buyer took the USDC back; your ${base} had been sent` };
  return { tone: 'neutral', text: `Called off: ${plainReason(s.reason)}. Nothing was locked or sent.${note ? ' ' + note.text : ''}` };
}

function offerSizes(offer, trades) {
  let reserved = 0n, filled = 0n;
  for (const t of trades) {
    const s = t.state;
    if (s.offerId !== offer.offerId || s.mode !== 'maker' || ['aborted', 'refunded'].includes(s.phase)) continue;
    const units = BigInt((s.terms ?? s.draft).baseAmount);
    if (isFinished(t)) filled += units; else reserved += units;
  }
  return { reserved, filled, left: BigInt(offer.baseAmount) - reserved - filled };
}

const offerLine = o => `${o.side === 'sell' ? 'sell' : 'buy'} ${amount(o.baseAmount, o.pair.split('/')[0]).text} ${o.pair.split('/')[0]} at ${o.price} USDC`;

const EXPLORER = { solana: sig => `https://explorer.solana.com/tx/${sig}` };
export function withdrawalView(w, network) {
  return { id: w.id.slice(0, 16), asset: w.asset, amount: amount(w.amount, w.asset), to: w.to, status: w.status, reason: w.reason ?? null,
    tx: w.signature ?? w.txHash ?? null, link: network === 'mainnet' && w.signature ? EXPLORER.solana(w.signature) : null };
}

// The Wallets panel: deposit addresses, each balance split into in use / free, fee warnings, file locations and the
// owner's backup command. Built from WalletManager.info(), which never contains secrets.
export function walletView(info, { network, role }) {
  if (!info) return null;
  const chainOf = asset => (['SOL', 'USDC'].includes(asset) ? 'solana' : 'trac');
  // Balances are null while the chains cannot be read; addresses, storage and withdrawals still show.
  const assets = Object.entries(info.balances ?? {}).filter(([asset]) => info.addresses[chainOf(asset)]).map(([asset, b]) => {
    const chain = chainOf(asset), lock = info.payout?.[chain] ?? null;
    return { asset, chain, address: info.addresses[chain], total: amount(b.balance, asset), inUse: amount(b.committed, asset), free: amount(b.free, asset),
      parts: Object.fromEntries(Object.entries(b.breakdown).map(([k, v]) => [k, amount(v, asset)])),
      payoutLock: lock, canWithdraw: role === 'service' ? chain === 'solana' && !!lock : true };
  });
  const notes = [];
  for (const asset of ['SOL', 'TNK']) {
    const b = info.balances?.[asset];
    if (!b || !info.addresses[chainOf(asset)] || BigInt(b.breakdown.fees) === 0n || BigInt(b.wallet) >= BigInt(b.breakdown.fees)) continue;
    notes.push(`${asset} is below what fees need: keep at least ${amount(b.breakdown.fees, asset).text} ${asset} here (now ${amount(b.wallet, asset).text}).`);
  }
  if (role === 'service' && !info.payout?.solana) notes.push('Withdrawals need a fixed payout address: set payout.solana in the config.');
  return { assets, notes, withdrawals: (info.withdrawals ?? []).map(w => withdrawalView(w, network)),
    storage: info.storage ? { dataDir: info.storage.dataDir, keyringFile: info.storage.keyringFile, tracWalletFile: info.storage.tracWalletFile,
      passwordEnv: info.storage.passwordEnv, tracPasswordEnv: info.storage.tracPasswordEnv } : null,
    backup: info.backup ? { instruction: info.backup.instruction, exportCommand: info.backup.exportCommand, exportInstruction: info.backup.exportInstruction } : null };
}

const registryOf = role => ('usable' in role.registry ? role.registry.usable : role.registry);

function traderView({ role, config, wallet, expired, now, nextOffer }) {
  const status = role.status(), reg = registryOf(role), trades = [...role.host.trades.values()].filter(t => t.role !== 'signer');
  const running = trades.filter(t => !isFinished(t)).sort((a, b) => a.state.now - b.state.now);
  const finished = trades.filter(t => isFinished(t)).sort((a, b) => b.state.now - a.state.now);
  const attention = [];
  if (config.proof?.zkey && !existsSync(config.proof.zkey)) attention.push({ kind: 'key', text: 'The proving key file is missing. New trades cannot lock USDC until it is back at ' + config.proof.zkey + '.' });
  if (status.updateRequired) attention.push({ kind: 'update', text: 'This program needs an update before new trades can start.' });
  if (status.registryConflict) attention.push({ kind: 'paused', text: 'The venue published two different signer lists; new trades are paused.' });
  for (const t of running) if (t.state.phase === 'refunding') {
    attention.push({ kind: 'refund', at: t.state.now, text: `A refund became available for your ${t.state.draft.pair} trade: your USDC is being taken back automatically.` });
  }
  for (const o of expired) {
    const left = offerSizes(o, trades).left;
    if (left > 0n) attention.push({ kind: 'expired', at: o.expiresAt, text: `Your offer to ${offerLine(o)} expired; ${amount(left, o.pair.split('/')[0]).text} ${o.pair.split('/')[0]} were not traded.` });
  }
  const noteOf = t => nextOffer?.note(t.key) ?? null;
  for (const t of finished) if (['aborted', 'lost'].includes(t.state.phase) && t.state.now >= now - DAY && t.state.tradeId && !noteOf(t)?.moved) {
    attention.push({ kind: 'failed', at: t.state.now, text: `Your ${t.state.draft.pair} trade (${tradeFacts(t).side} ${tradeFacts(t).base.text} ${tradeFacts(t).base.unit}): ${outcome(t, noteOf(t)).text}` });
  }
  const pairs = (reg?.pairs ?? []).filter(p => supportedBase(p.base));
  const market = pairs.map(p => {
    const book = traderBook(role, p, now, status.mine), ticker = role.tickers.get(p.pair), base = p.base.id;
    const price = value => value && value !== '0' ? value : null;
    return { pair: p.pair, base, status: p.status, minBase: amount(p.minBaseAmount, base), last: price(ticker?.last),
      change24h: null, high24h: price(ticker?.high24h), low24h: price(ticker?.low24h),
      volume24h: ticker ? amount(ticker.volume24h, 'USDC') : null, bestAsk: book.asks[0]?.price ?? null, bestBid: book.bids[0]?.price ?? null };
  });
  return {
    signersOnline: status.signersOnline.length, software: status.software, registryVersion: status.registryVersion,
    balances: wallet?.balances ? Object.fromEntries(['TNK', 'RESET', 'USDC', 'SOL'].map(a => [a, { total: amount(wallet.balances[a].balance, a), free: amount(wallet.balances[a].free, a) }])) : null,
    attention: attention.sort((a, b) => (b.at ?? Infinity) - (a.at ?? Infinity)),
    offers: status.mine.filter(o => o.expiresAt > now).sort((a, b) => a.expiresAt - b.expiresAt).map(o => {
      const base = o.pair.split('/')[0];
      return { offerId: o.offerId, pair: o.pair, side: o.side, price: o.price, size: amount(o.baseAmount, base), filled: amount(o.filled, base),
        reserved: amount(o.reserved, base), left: amount(o.available, base), expiresAt: o.expiresAt };
    }),
    running: running.map(t => ({ ...tradeFacts(t), line: describeTrade(t) })),
    history: finished.map(t => ({ ...tradeFacts(t), outcome: outcome(t, noteOf(t)) })),
    pairs: market,
  };
}

function signerView({ role, now, health, venueAsks }) {
  const reg = registryOf(role), trades = [...role.host.trades.values()];
  const held = trades.filter(t => HELD.includes(t.state.phase));
  const published = trades.filter(t => t.state.phase === 'published');
  const releaseAt = t => (t.state.phase === 'holding' ? t.state.terms.sendBy + t.state.terms.graceSec : now);
  const credit = t => {
    const s = t.state.terms;
    return BigInt(s.quoteAmount) * BigInt(s.fees.tradeFeeBps) / 10000n * BigInt(s.fees.signerShareBps) / 10000n / BigInt(s.committee.length);
  };
  const finalAt = t => t.state.terms.refundAfter + PAYOUT_DELAY;
  const warnings = [];
  if (!reg) warnings.push('No signer list from the venue yet; this signer cannot be chosen for trades.');
  if (role.registry.conflict) warnings.push('The venue published two different signer lists; no new trades start.');
  const status = role.status();
  if (status.updateRequired) warnings.push('This program needs an update before it can sign new trades.');
  if (reg && !reg.signers.some(s => s.dexKey === role.identity.publicKey && s.status === 'active')) warnings.push('This signer is not listed as active by the venue.');
  for (const t of published) {
    const asked = venueAsks.get(t.state.tradeId);
    if (asked && asked >= now - 900) warnings.push(`The venue has not confirmed it received your released key piece for trade ${shortKey(t.state.tradeId)}; it is re-sent automatically.`);
  }
  const pieceText = t => ({
    holding: "Holding; released once the seller's transfer is confirmed",
    verifyingTransfer: "Checking the seller's transfer",
    persistingTransfer: 'Transfer confirmed; releasing now',
  })[t.state.phase];
  const recent = trades.filter(t => !HELD.includes(t.state.phase)).sort((a, b) => b.state.now - a.state.now).map(t => ({
    tradeId: shortKey(t.state.tradeId), pair: t.state.terms.pair, at: t.state.now, base: amount(t.state.terms.baseAmount, t.state.terms.base.id),
    text: t.state.phase === 'published' ? 'Key piece released after the transfer was confirmed'
      : t.state.phase === 'expired' ? 'No transfer arrived in time; the key piece was never released'
      : t.state.phase === 'aborted' ? `Refused: ${plainReason(t.state.reason)}` : 'Getting ready to hold a key piece',
  }));
  const heartbeatOk = role.lastHeartbeatAt != null && now - role.lastHeartbeatAt <= ONLINE_SEC;
  return {
    healthy: health.peerConnected && health.trac && health.reset && heartbeatOk && !!reg,
    health: { ...health, lastHeartbeatAt: role.lastHeartbeatAt ?? null, heartbeatOk, registryVersion: reg?.version ?? null },
    pieces: { held: held.length, nextAt: held.length ? Math.min(...held.map(releaseAt)) : null,
      list: held.sort((a, b) => releaseAt(a) - releaseAt(b)).map(t => ({ tradeId: shortKey(t.state.tradeId), pair: t.state.terms.pair,
        base: amount(t.state.terms.baseAmount, t.state.terms.base.id), text: pieceText(t), until: releaseAt(t) })) },
    earnings: { provisional: amount(sum(published.filter(t => now < finalAt(t)).map(credit)), 'USDC'),
      final: amount(sum(published.filter(t => now >= finalAt(t)).map(credit)), 'USDC'), paid: null, trades: published.length },
    warnings, recent,
  };
}

function serviceView({ role, now, health, midnight }) {
  const reg = role.registry, payouts = role.payouts, status = role.status();
  const online = new Set(status.signersOnline);
  const removed = new Map(reg.removed.map(r => [r.dexKey, r]));
  const keys = [...new Set([...reg.signers.map(s => s.dexKey), ...Object.keys(payouts)])];
  const signers = keys.map(dexKey => {
    const s = reg.signers.find(x => x.dexKey === dexKey), list = payouts[dexKey] ?? [], live = list.filter(p => !p.forfeited);
    const owed = live.filter(p => p.final && !p.paid);
    return { dexKey, short: shortKey(dexKey), label: s?.label ?? 'removed signer', online: online.has(dexKey), status: s ? s.status : 'removed',
      removed: removed.has(dexKey), limit: s ? amount(s.limitUsdc, 'USDC') : null,
      earned: amount(sum(live.map(p => p.amount)), 'USDC'), provisional: amount(sum(live.filter(p => !p.final).map(p => p.amount)), 'USDC'),
      owed: amount(sum(owed.map(p => p.amount)), 'USDC'), owedTrades: owed.length, paid: amount(sum(live.filter(p => p.paid).map(p => p.amount)), 'USDC'),
      forfeited: amount(sum(list.filter(p => p.forfeited).map(p => p.amount)), 'USDC') };
  });
  const logged = [...role.settlements.values()].filter(r => r.status === 'logged');
  const period = from => {
    const rows = logged.filter(r => r.entry.ts >= from);
    return { trades: rows.length, volume: amount(sum(rows.map(r => r.entry.quoteAmount)), 'USDC'),
      fees: amount(sum(rows.map(r => BigInt(r.report.terms.quoteAmount) * BigInt(r.report.terms.fees.tradeFeeBps) / 10000n)), 'USDC') };
  };
  const pending = [...role.settlements.values()].filter(r => r.status === 'pending');
  return {
    signers, today: period(midnight), week: period(now - 7 * DAY), all: period(0),
    signersShare: amount(sum(logged.flatMap(r => Object.values(r.credits ?? {}))), 'USDC'),
    reports: { waiting: pending.length, oldestAt: pending.length ? Math.min(...pending.map(r => r.reportedAt)) : null },
    book: status.book, chat: status.chat, health: { ...health, lastRegistryAt: role.registryPublishedAt ?? null, registryVersion: reg.version },
  };
}

function traderBook(role, pair, now, mine = role.status().mine) {
  return buildBook({ pair, offers: role.offers.values(), mine, dexKey: role.me.dexKey, book: role.book.get(pair.pair),
    inventory: role.bookView?.inventory.get(pair.pair) ?? role.book.get(pair.pair), now, taken: ownTakes(role.host.trades.values()) });
}

const LISTS = Object.freeze({ trader: ['offers', 'running', 'history', 'attention'], signer: ['pieces', 'recent'], service: ['signers'] });
function listRows(view, name) { return name === 'pieces' ? view.pieces.list : view[name]; }
function summary(view, kind) {
  const out = { ...view, counts: Object.fromEntries(LISTS[kind].map(name => [name, listRows(view, name).length])) };
  for (const name of LISTS[kind]) {
    if (name === 'pieces') { const { list, ...pieces } = view.pieces; out.pieces = pieces; }
    else if (name === 'attention') out.attention = view.attention.slice(0, 20);
    else delete out[name];
  }
  return out;
}

// The dashboard's read model for whichever role runs in this process. Everything comes from the role objects in
// memory; chain balances go through a 30-second cache, peer readings through short caches.
export function createModel({ config, role, wallets = null, bridge, nextOffer = null, clock = () => Date.now() }) {
  const kind = config.role, now = () => Math.floor(clock() / 1000);
  const balances = wallets ? refreshing(() => wallets.info(), BALANCE_CACHE_MS, clock) : null;
  const stats = cached(() => bridge.stats(), 10000, clock);
  const readers = cached(async () => {
    const [trac, reset] = await Promise.allSettled([bridge.call('dex_msb_info', {}, 5000), bridge.call('dex_reset_context', {}, 5000)]);
    return { trac: trac.status === 'fulfilled', reset: reset.status === 'fulfilled' };
  }, 30000, clock);
  const venueAsks = new Map();
  const offerRecords = new Map(), settled = new Set();
  const expired = cached(async () => {
    const sec = now();
    for (const name of role.store.list('offer-')) {
      if (settled.has(name)) continue;
      const r = role.store.get(name);
      if (!r?.offer) continue;
      if (r.cancelled || r.offer.expiresAt <= sec - DAY) { settled.add(name); offerRecords.delete(name); continue; }
      offerRecords.set(name, r);
    }
    return [...offerRecords.values()].filter(r => !r.cancelled && r.offer.expiresAt <= sec && r.offer.maker.dexKey === role.me.dexKey).map(r => r.offer);
  }, 30000, clock);

  const view = async (sec, wallet = null, health = {}) => {
    if (kind === 'trader') return traderView({ role, config, wallet, expired: (await expired()).value ?? [], now: sec, nextOffer });
    if (kind === 'signer') return signerView({ role, now: sec, venueAsks, health });
    const midnight = new Date(clock()); midnight.setHours(0, 0, 0, 0);
    return serviceView({ role, now: sec, midnight: Math.floor(midnight.getTime() / 1000), health });
  };

  return {
    balances,
    pair(name) { return registryPair(registryOf(role), name, { open: false }); },
    book(name) {
      if (kind !== 'trader') throw new Error('The order book is only available to traders');
      return traderBook(role, registryPair(registryOf(role), name, { open: false }), now());
    },
    async list(name, offset = 0, limit = 100) {
      const parts = typeof name === 'string' ? name.split('.') : [];
      if (parts.length !== 2 || parts[0] !== kind || !LISTS[kind]?.includes(parts[1])) throw new Error('Unknown list for this role');
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid list page');
      const rows = listRows(await view(now()), parts[1]);
      return { total: rows.length, rows: rows.slice(offset, offset + limit) };
    },
    labels() {
      const reg = registryOf(role), out = {};
      for (const s of reg?.signers ?? []) out[s.dexKey] = s.label;
      out[kind === 'service' ? role.identity.publicKey : role.serviceKey] = 'venue';
      out[role.identity.publicKey] = 'you';
      return out;
    },

    // Signers: a verified request from the venue for a share means the venue lacks that publication.
    note(channel, message) {
      if (kind !== 'signer' || channel !== 'intercom-dex:signers' || message?.kind !== 'shareRequest' || message.from !== role.serviceKey) return;
      try { open(message, { now: now(), seen: createReplayCache(), maxAgeSec: 120 }); } catch { return; }
      if (venueAsks.size >= 1000 && !venueAsks.has(message.body.tradeId)) venueAsks.delete(venueAsks.keys().next().value);
      venueAsks.set(message.body.tradeId, now());
    },

    async state() {
      const sec = now(), wallet = balances ? await balances() : null;
      const peerConnected = bridge.ws?.readyState === 1;
      const out = { role: kind, network: config.network, generatedAt: sec,
        wallets: wallet ? { ...(walletView(wallet.value, { network: config.network, role: kind }) ?? { assets: [], notes: [], withdrawals: [], storage: null, backup: null }),
          error: wallet.ok ? wallet.value?.balanceError ?? null : wallet.error, readAt: wallet.at ? Math.floor(wallet.at / 1000) : null } : null };
      if (kind === 'trader') out.trader = summary(await view(sec, wallet?.value), kind);
      if (kind === 'signer') {
        const r = await readers();
        out.signer = summary(await view(sec, null, { peerConnected, trac: !!r.value?.trac, reset: !!r.value?.reset, checkedAt: Math.floor(r.at / 1000) }), kind);
      }
      if (kind === 'service') {
        const s = await stats();
        out.service = summary(await view(sec, null, { peerConnected,
          channels: s.value ? PUBLIC_CHANNELS.filter(c => s.value.channels.includes(c)).length : null, connections: s.value?.connectionCount ?? null }), kind);
      }
      return out;
    },
  };
}
