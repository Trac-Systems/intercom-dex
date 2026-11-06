import { z } from 'zod';
import { sha256Hex, stableJSON } from '../core/canonical.js';
import { verifyCertificate, verifyFact, factDigest } from './certificates.js';

const uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hex = z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/);
const positive = z.string().regex(/^[1-9][0-9]{0,30}$(?![\s\S])/);
const entrySchema = z.object({ logPosition: uint.min(1), prevHash: hex, tradeId: hex, escrowId: hex, nonce: hex,
  pair: z.literal('RESET/USDC'), baseAmount: positive, quoteAmount: positive, completedAt: uint,
  termsDigest: hex, escrowDigest: hex, deliveryDigest: hex }).strict();
const headSchema = z.object({ cutoffAt: uint, headPosition: uint.min(1), headHash: hex }).strict();
const ZERO = '0'.repeat(64);
const compare = (a, b) => {
  const d = BigInt(a.numerator) * BigInt(b.denominator) - BigInt(b.numerator) * BigInt(a.denominator);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
};
const fraction = (n, d) => {
  let a = n, b = d;
  while (b) { const r = a % b; a = b; b = r; }
  return { numerator: (n / a).toString(), denominator: (d / a).toString() };
};
const price = e => fraction(BigInt(e.quoteAmount) * 100000000n, BigInt(e.baseAmount));
const utcDay = at => new Date(at * 1000).toISOString().slice(0, 10);

// Certificates attest verified signed terms, final claimed escrow and exact final RESET delivery.
// This log verifies their authorship/order; the chain-verifying signer must establish those facts first.
export class CompletionLog {
  constructor({ store, context }) {
    if (!store?.get || !store?.put) throw new Error('Completion log requires a durable store');
    this.store = store; this.context = structuredClone(context);
    this.name = 'stake-price-' + sha256Hex(stableJSON({ networkId: context.networkId, venueKey: context.venueKey, epochId: context.epoch.id }));
  }
  read() { return this.store.get(this.name) ?? { position: 0, hash: ZERO, completedAt: 0, trades: {}, escrows: {}, nonces: {} }; }
  entry(position) { uint.parse(position); return this.store.get(`${this.name}-entry-${position}`); }
  history() { return this.store.get(`${this.name}-history`) ?? []; }
  inherit(history) {
    if (!Array.isArray(history) || history.length > 32) throw new Error('Invalid price history chain');
    const epochs = new Set([this.context.epoch.id]); let position = 0;
    for (const [i, item] of history.entries()) {
      const fact = verifyCertificate(item.certificate, item.context, 'history-head');
      const next = history[i + 1]?.context ?? this.context;
      if (item.context.networkId !== this.context.networkId || item.context.venueKey !== this.context.venueKey ||
          epochs.has(item.context.epoch.id) || fact.body.headPosition < position ||
          fact.body.nextEpochId !== next.epoch.id || !Number.isSafeInteger(fact.body.headPosition) || fact.body.headPosition < 1 || !hex.safeParse(fact.body.headHash).success)
        throw new Error('Price history handoff scope differs');
      epochs.add(item.context.epoch.id); position = fact.body.headPosition;
    }
    const prior = this.history();
    if (prior.length && stableJSON(prior) !== stableJSON(history)) throw new Error('Price history already fixed');
    this.store.put(`${this.name}-history`, history);
  }
  adoptHistory(certificate, previous) {
    const fact = verifyCertificate(certificate, previous, 'history-head'), source = new CompletionLog({ store: this.store, context: previous });
    if (fact.body.nextEpochId !== this.context.epoch.id || fact.body.headPosition !== source.read().position || fact.body.headHash !== source.read().hash)
      throw new Error('Complete original price history required');
    this.inherit([...source.history(), { context: previous, certificate }]);
    for (let i = 1; i <= source.read().position; i++) {
      const entry = source.entry(i);
      if (!entry) throw new Error('Missing original price history page');
      this.append(entry, source.read().completedAt);
    }
    return this.read();
  }
  certified({ venue, certificate }, kind) {
    let context = this.context;
    if (kind === 'completion' && certificate?.[0]?.fact.epochId !== context.epoch.id) {
      const origin = this.history().find(h => h.context.epoch.id === certificate?.[0]?.fact.epochId);
      if (!origin || certificate[0].fact.body.logPosition > origin.certificate[0].fact.body.headPosition) throw new Error('Completion is outside the original certified history');
      context = origin.context;
    }
    const f = verifyCertificate(certificate, context, kind);
    if (factDigest(f) !== factDigest(verifyFact(venue, context, kind, context.venueKey))) throw new Error('Venue and committee facts differ');
    return f;
  }
  append(input, now) {
    uint.parse(now);
    const f = this.certified(input, 'completion'), e = entrySchema.parse(f.body), hash = factDigest(f), state = this.read();
    if (e.completedAt > now) throw new Error('Future completion');
    const archived = this.entry(e.logPosition);
    if (e.logPosition <= state.position) {
      if (archived?.hash !== hash) throw new Error('Completion replay conflicts');
      return archived;
    }
    if (e.logPosition !== state.position + 1 || e.prevHash !== state.hash || e.completedAt < state.completedAt)
      throw new Error('Completion log gap, fork or changed time');
    if (state.trades[e.tradeId] || state.escrows[e.escrowId] || state.nonces[e.nonce]) throw new Error('Duplicate completion');
    if (archived && archived.hash !== hash) throw new Error('Uncommitted completion conflicts');
    const record = { entry: e, hash, venue: input.venue, certificate: input.certificate };
    // Archive before publishing the new head. Replaying after either write cannot re-date or duplicate a trade.
    this.store.put(`${this.name}-entry-${e.logPosition}`, record);
    this.store.put(this.name, { position: e.logPosition, hash, completedAt: e.completedAt,
      trades: { ...state.trades, [e.tradeId]: e.logPosition }, escrows: { ...state.escrows, [e.escrowId]: e.logPosition },
      nonces: { ...state.nonces, [e.nonce]: e.logPosition } });
    return structuredClone(record);
  }
  reference(checkpoint, now, maxAgeSec = 60, lookbackSec = 0) {
    uint.parse(now);
    z.number().int().min(60).max(600).parse(maxAgeSec);
    uint.max(2592000).parse(lookbackSec);
    const f = this.certified(checkpoint, 'price-head'), head = headSchema.parse(f.body), state = this.read();
    if (head.cutoffAt > now || now - head.cutoffAt > maxAgeSec || !lookbackSec && utcDay(head.cutoffAt) !== utcDay(now)) throw new Error('bond_price_unavailable');
    if (head.headPosition > state.position || this.entry(head.headPosition)?.hash !== head.headHash) throw new Error('Incomplete completion log');
    // A locally known completion before the cutoff cannot be omitted from a certified head.
    const next = this.entry(head.headPosition + 1);
    if (next && next.entry.completedAt <= head.cutoffAt) throw new Error('Price head omits a known completion');
    const entries = [];
    let hash = ZERO, completedAt = 0, priceDay;
    for (let pos = 1; pos <= head.headPosition; pos++) {
      const record = this.entry(pos);
      if (!record || record.entry.logPosition !== pos || record.entry.prevHash !== hash || record.entry.completedAt < completedAt)
        throw new Error('Incomplete day prefix');
      if (record.entry.completedAt > head.cutoffAt) throw new Error('Price head includes a future completion');
      hash = record.hash; completedAt = record.entry.completedAt;
      // Keep the complete latest trading day, including prints older than the
      // lookback boundary. Truncating that day would change its median.
      const day = utcDay(completedAt);
      if (day !== priceDay) { entries.length = 0; priceDay = day; }
      entries.push(record);
    }
    if (!entries.length || hash !== head.headHash) throw new Error('bond_price_unavailable');
    // With a lookback the latest certified trading day stays the price until a newer trade replaces it: staking and
    // bonded sales must never wait for a trade that needs a bond to happen.
    if (priceDay !== utcDay(now) && !lookbackSec) throw new Error('bond_price_unavailable');
    const prices = entries.map(r => price(r.entry)).sort(compare), mid = Math.floor(prices.length / 2);
    const median = prices.length % 2 ? prices[mid] : fraction(
      BigInt(prices[mid - 1].numerator) * BigInt(prices[mid].denominator) + BigInt(prices[mid].numerator) * BigInt(prices[mid - 1].denominator),
      2n * BigInt(prices[mid - 1].denominator) * BigInt(prices[mid].denominator));
    const last = entries.at(-1), lastPrice = price(last.entry), q = compare(lastPrice, median) <= 0 ? lastPrice : median;
    return { lastTradeId: last.entry.tradeId, lastLogPosition: last.entry.logPosition, lastEntryHash: last.hash,
      utcDay: priceDay, cutoffAt: head.cutoffAt, headPosition: head.headPosition, headHash: head.headHash,
      dayCount: entries.length, median, q, checkpointDigest: factDigest(f) };
  }
  verifyReference(reference, checkpoint, now, maxAgeSec = 60, lookbackSec = 0) {
    if (stableJSON(reference) !== stableJSON(this.reference(checkpoint, now, maxAgeSec, lookbackSec))) throw new Error('Price reference differs from complete certified prefix');
    return structuredClone(reference.q);
  }
}
