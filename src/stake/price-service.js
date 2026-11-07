import { CompletionLog } from './price.js';
import { signFact, verifyFact, verifyCertificate, factDigest, matchingCertificate } from './certificates.js';
import { sha256Hex, stableJSON } from '../core/canonical.js';
import { verifySummon } from '../roles/common.js';
import { transferNonce } from '../trac/transfers.js';
import { effectiveSettings } from './settings.js';

export const stakeContext = registry => {
  const p = registry?.sellerBond;
  if (!p) throw new Error('A signed stake policy is required');
  return { networkId: p.networkId, venueKey: p.venueKey, epoch: p.epoch };
};

export class StakePriceService {
  constructor({ store, identity, registry, snapshot, clock, solana, trac, request, venue = false }) {
    Object.assign(this, { store, identity, registry, snapshot, clock, solana, trac, request, venue });
    this.queue = Promise.resolve();
  }
  context() { return stakeContext(this.registry()); }
  originalPolicy(id) {
    const policies = [this.registry()?.sellerBond, ...['stake-retained-epoch-', 'stake-venue-epoch-', 'stake-client-epoch-'].flatMap(prefix =>
      this.store.list(prefix).map(name => this.store.get(name))), ...this.store.list('registry-v').map(name => this.store.get(name)?.sellerBond)];
    const policy = policies.find(p => p?.epoch.id === id && p.networkId === this.context().networkId && p.venueKey === this.context().venueKey);
    if (!policy) throw new Error('Authenticated original price epoch required');
    return policy;
  }
  originalContext(id) { return stakeContext({ sellerBond: this.originalPolicy(id) }); }
  async historyPrefix(context, position) {
    const log = new CompletionLog({ store: this.store, context });
    for (let page = 0; log.read().position < position && page < 32; page++) {
      const from = log.read().position + 1, limit = Math.min(12, position - from + 1);
      const result = await this.request(this.context().venueKey, 'priceHistoryPage', { epochId: context.epoch.id, from, limit });
      if (!Array.isArray(result.entries) || result.entries.length !== limit) throw new Error('Incomplete original history page');
      for (const item of result.history ?? []) {
        if (stableJSON(this.originalContext(item.context.epoch.id)) !== stableJSON(item.context)) throw new Error('Unknown history authority');
      }
      if (result.history?.length) log.inherit(result.history);
      for (const entry of result.entries) log.append(entry, (await this.clock()).at);
    }
    if (log.read().position < position) throw new Error('Price history catch-up pending');
    return log;
  }
  log() {
    const context = this.context();
    if (this.store.get(`stake-epoch-draining-${context.epoch.id}`)) throw new Error('Complete price history reconciliation is required before leaving a draining epoch');
    return new CompletionLog({ store: this.store, context });
  }
  fact(kind, body) {
    const c = this.context();
    return { v: 1, networkId: c.networkId, venueKey: c.venueKey, epochId: c.epoch.id, kind, body };
  }
  // Finishes as soon as three matching original members have voted: waiting for a slow fourth spent the caller's whole
  // 30 s on every price snapshot. Outstanding requests keep their rejection handlers and their own transport deadlines.
  quorum(method, body) {
    const context = this.context(), members = context.epoch.members, kind = method === 'priceVote' ? 'completion' : 'price-head';
    return new Promise((resolve, reject) => {
      const votes = [], refusals = new Array(members.length).fill(null);
      let remaining = members.length, finished = false;
      const settle = () => {
        if (finished) return;
        if (votes.length >= 3) {
          try { const certificate = matchingCertificate(votes, context, kind); finished = true; resolve(certificate); return; } catch {}
        }
        if (--remaining > 0) return;
        finished = true;
        // Name each member's refusal so a missing quorum explains itself in the logs.
        if (votes.length < 3) reject(new Error(`Three stake signers are required (${method}; ${refusals.filter(Boolean).join('; ')})`));
        else reject(new Error('Three matching stake votes are required'));
      };
      members.forEach((m, i) => Promise.resolve().then(() => this.request(m.dexKey, method, body)).then(value => {
        if (value?.from === m.dexKey) votes.push(value); else refusals[i] = `${m.dexKey.slice(0, 8)}: wrong signer`;
        settle();
      }, error => { refusals[i] = `${m.dexKey.slice(0, 8)}: ${String(error?.message ?? error).slice(0, 160)}`; settle(); }));
    });
  }
  // Called only when the venue first verifies both settlement legs, before its
  // report is published. The original signed completion time is retained.
  observe(report, summon) {
    if (!this.venue || report.terms.pair !== 'RESET/USDC' || !this.registry()?.sellerBond || !summon) return Promise.resolve();
    const work = this.queue.then(async () => {
      await this.finishPending();
      const log = this.log(), head = log.read(), id = summon.tradeId;
      if (head.trades[id]) return;
      const { at } = await this.clock();
      const entry = { logPosition: head.position + 1, prevHash: head.hash, tradeId: id, escrowId: report.hashHex,
        nonce: transferNonce(id), pair: 'RESET/USDC', baseAmount: report.terms.baseAmount, quoteAmount: report.terms.quoteAmount,
        completedAt: at, termsDigest: sha256Hex(stableJSON(report.terms)),
        escrowDigest: sha256Hex(stableJSON({ H: report.hashHex, terms: report.terms })),
        deliveryDigest: sha256Hex(stableJSON({ txHash: report.txHash, nonce: transferNonce(id) })) };
      const proposal = { venue: signFact(this.fact('completion', entry), this.identity.secretKey), report, summon };
      this.store.put('stake-price-pending', proposal);
      await this.finishPending();
    });
    this.queue = work.catch(() => {}); return work;
  }
  async finishPending() {
    const proposal = this.store.get('stake-price-pending'); if (!proposal) return;
    let certificate;
    try { certificate = await this.quorum('priceVote', proposal); }
    catch (error) {
      // Signers refuse completions older than ten minutes. Past fifteen the trade no longer counts for the price,
      // instead of blocking every later price snapshot.
      if ((await this.clock()).at - proposal.venue.fact.body.completedAt <= 900) throw error;
      this.store.put('stake-price-pending', null); return;
    }
    const record = { venue: proposal.venue, certificate };
    this.log().append(record, (await this.clock()).at);
    await Promise.allSettled(this.context().epoch.members.map(m => this.request(m.dexKey, 'priceCommit', record)));
    this.store.put('stake-price-pending', null);
  }
  handle(method, body, from) {
    // Prefix serving is read-only and must remain available while a head vote
    // waits for another member to catch up.
    if (['pricePrefix', 'priceHistoryPage'].includes(method) && this.venue) return this.apply(method, body, from);
    // Concurrent readers need the same fresh certified head. Serial duplicate
    // rounds can outlive the transport window and keep their retries queued.
    if (method === 'priceSnapshot' && this.venue && this.snapshotPending) return this.snapshotPending;
    const work = this.queue.then(() => this.apply(method, body, from)); this.queue = work.catch(() => {});
    if (method === 'priceSnapshot' && this.venue) {
      this.snapshotPending = work;
      work.finally(() => { if (this.snapshotPending === work) this.snapshotPending = null; }).catch(() => {});
    }
    return work;
  }
  async apply(method, body, from) {
    if (method === 'priceHistoryPage' && this.venue) {
      const context = this.originalContext(body.epochId), log = new CompletionLog({ store: this.store, context });
      if (!Number.isSafeInteger(body.from) || body.from < 1 || !Number.isSafeInteger(body.limit) || body.limit < 1 || body.limit > 12)
        throw new Error('Invalid history page');
      return { history: log.history(), entries: Array.from({ length: Math.max(0, Math.min(body.limit, log.read().position - body.from + 1)) }, (_, i) => log.entry(body.from + i)) };
    }
    if (method === 'priceHistoryReady') {
      if (from !== this.context().venueKey) throw new Error('Venue history authorization required');
      const previous = this.originalContext(body.previousEpochId), current = this.context();
      const head = verifyCertificate(body.certificate, previous, 'history-head').body;
      const log = new CompletionLog({ store: this.store, context: current });
      if (head.nextEpochId !== current.epoch.id || log.entry(head.headPosition)?.hash !== head.headHash ||
          !log.history().some(h => factDigest(h.certificate[0].fact) === factDigest(body.certificate[0].fact)))
        throw new Error('Complete successor history required');
      const reward = this.registry().sellerBond.rewardService;
      if (stableJSON(this.originalPolicy(body.previousEpochId).rewardService ?? null) !== stableJSON(reward ?? null))
        throw new Error('Unchanged payout authority required');
      if (reward) {
        const liability = verifyFact(body.liability, previous, 'liability-handoff', reward.dexKey).body;
        if (liability.nextEpochId !== current.epoch.id || liability.cursor.epochId !== previous.epoch.id ||
            Object.values(liability.accounts).reduce((sum, a) => sum + BigInt(a.unpaid), 0n).toString() !== liability.unpaid)
          throw new Error('Original reward liability reconciliation required');
      } else if (body.liability) throw new Error('Unexpected reward liability');
      this.store.put(`stake-history-ready-${current.epoch.id}`, body);
      this.store.put(`stake-epoch-draining-${current.epoch.id}`, null);
      return { ready: true, epochId: current.epoch.id };
    }
    if (['priceHistoryVote', 'priceHistoryAdopt'].includes(method)) {
      if (from !== this.context().venueKey) throw new Error('Venue history authorization required');
      const previous = this.originalContext(body.previousEpochId);
      const head = method === 'priceHistoryVote' ? body.head : verifyCertificate(body.certificate, previous, 'history-head').body;
      if (head.nextEpochId !== this.context().epoch.id || previous.epoch.id === this.context().epoch.id) throw new Error('History successor differs');
      const source = await this.historyPrefix(previous, head.headPosition);
      if (source.read().position !== head.headPosition || source.read().hash !== head.headHash) throw new Error('History head omits a known completion');
      if (method === 'priceHistoryVote') {
        if (!previous.epoch.members.some(m => m.dexKey === this.identity.publicKey)) throw new Error('Original history member required');
        const fact = { v: 1, networkId: previous.networkId, venueKey: previous.venueKey, epochId: previous.epoch.id, kind: 'history-head', body: head };
        const name = `stake-price-handoff-${previous.epoch.id}`, prior = this.store.get(name);
        if (prior && factDigest(prior.fact) !== factDigest(fact)) throw new Error('Original history vote already fixed');
        const vote = prior ?? signFact(fact, this.identity.secretKey); this.store.put(name, vote); return vote;
      }
      const log = new CompletionLog({ store: this.store, context: this.context() });
      log.adoptHistory(body.certificate, previous); return { adopted: true, position: log.read().position };
    }
    const context = this.context(), log = this.log();
    if (method === 'pricePrefix' && this.venue) {
      if (!Number.isSafeInteger(body.from) || body.from < 1 || !Number.isSafeInteger(body.limit) || body.limit < 1 || body.limit > 12)
        throw new Error('Invalid price prefix page');
      const through = Math.min(log.read().position, body.from + body.limit - 1);
      return { entries: Array.from({ length: Math.max(0, through - body.from + 1) }, (_, i) => {
        const e = log.entry(body.from + i); if (!e) throw new Error('Missing price archive');
        return { venue: e.venue, certificate: e.certificate };
      }) };
    }
    if (method === 'priceVote') {
      if (from !== context.venueKey) throw new Error('Only the venue proposes completion order');
      const f = verifyFact(body.venue, context, 'completion', context.venueKey), e = f.body;
      const { report, summon } = body, r = this.snapshot(report?.terms?.registryVersion);
      if (!r || !summon || stableJSON(summon.terms) !== stableJSON(report.terms)) throw new Error('Original signed terms unavailable');
      const { terms, tradeId } = verifySummon(summon, r, report.terms.sendBy - r.params.sendWindowSec,
        { networkId: context.networkId, required: true });
      if (terms.pair !== 'RESET/USDC' || e.tradeId !== tradeId || e.escrowId !== report.hashHex || e.nonce !== transferNonce(tradeId) ||
          e.baseAmount !== terms.baseAmount || e.quoteAmount !== terms.quoteAmount || e.termsDigest !== sha256Hex(stableJSON(terms)) ||
          e.escrowDigest !== sha256Hex(stableJSON({ H: report.hashHex, terms })) ||
          e.deliveryDigest !== sha256Hex(stableJSON({ txHash: report.txHash, nonce: transferNonce(tradeId) }))) throw new Error('Completion binding differs');
      await this.catchUp(e.logPosition - 1);
      const now = (await this.clock()).at, head = log.read(), name = `stake-price-vote-${e.logPosition}`;
      let prior = this.store.get(name);
      // A proposal that never reached three votes is abandoned by the venue after 15 minutes; its position is reused.
      if (prior && factDigest(prior.fact) !== factDigest(f)) {
        if (now - prior.fact.body.completedAt <= 900 || head.position >= e.logPosition) throw new Error('Conflicting completion order');
        prior = null;
      }
      if (!prior && (e.completedAt > now || now - e.completedAt > 600 || e.logPosition !== head.position + 1 || e.prevHash !== head.hash))
        throw new Error('Stale completion or missing prefix');
      const [escrow, transfer] = await Promise.all([
        this.solana.checkEscrow({ terms, hashHex: report.hashHex, purpose: 'settlement' }),
        this.trac.verifyTransfer({ asset: 'RESET', txHash: report.txHash, from: terms.seller.tracAddr,
          to: terms.buyer.tracAddr, minAmount: terms.baseAmount, nonce: transferNonce(tradeId), tradeId, finalBefore: Number.MAX_SAFE_INTEGER, fresh: true })
      ]);
      if (!escrow.ok || escrow.status !== 'claimed' || !transfer.ok || !transfer.final) throw new Error('Completion is not finalized on both chains');
      const vote = prior ?? signFact(f, this.identity.secretKey); this.store.put(name, vote); return vote;
    }
    if (method === 'priceCommit') {
      const record = log.append(body, (await this.clock()).at); return { position: record.entry.logPosition };
    }
    if (method === 'priceHeadVote') {
      if (from !== context.venueKey) throw new Error('Only the venue proposes a price head');
      const f = verifyFact(body.venue, context, 'price-head', context.venueKey);
      await this.catchUp(f.body.headPosition);
      const head = log.read(), now = (await this.clock()).at;
      if (f.body.cutoffAt > now || now - f.body.cutoffAt > 30 || !head.position || f.body.headPosition !== head.position || f.body.headHash !== head.hash)
        throw new Error('Price head is stale or omits a completion');
      const name = `stake-price-head-vote-${f.body.cutoffAt}`, prior = this.store.get(name);
      if (prior && factDigest(prior.fact) !== factDigest(f)) throw new Error('Conflicting price head');
      const vote = prior ?? signFact(f, this.identity.secretKey); this.store.put(name, vote); return vote;
    }
    if (method === 'priceSnapshot' && this.venue) {
      await this.finishPending();
      const { at } = await this.clock(), head = log.read();
      if (!head.position) throw new Error('A certified completed RESET trade is required');
      const venue = signFact(this.fact('price-head', { cutoffAt: at, headPosition: head.position, headHash: head.hash }), this.identity.secretKey);
      const certificate = await this.quorum('priceHeadVote', { venue });
      const settings = effectiveSettings(this.registry().sellerBond, at)?.settings;
      const checkpoint = { venue, certificate }, reference = log.reference(checkpoint, at, 60, settings?.priceLookbackSec ?? 0);
      return { history: log.history(), entries: Array.from({ length: Math.min(head.position, 12) }, (_, i) => {
        const e = log.entry(i + 1); return { venue: e.venue, certificate: e.certificate };
      }), checkpoint, reference };
    }
    throw new Error('Unsupported price request');
  }
  async catchUp(position) {
    if (!Number.isSafeInteger(position) || position < 0) throw new Error('Invalid completion head');
    const log = this.log();
    for (let page = 0; log.read().position < position && page < 32; page++) {
      if (typeof this.request !== 'function') throw new Error('A complete price prefix is unavailable');
      const from = log.read().position + 1, limit = Math.min(12, position - from + 1);
      const result = await this.request(this.context().venueKey, 'pricePrefix', { from, limit });
      if (!Array.isArray(result.entries) || result.entries.length !== limit) throw new Error('Incomplete completion page');
      const now = (await this.clock()).at;
      for (const entry of result.entries) log.append(entry, now);
      if (log.read().position < from) throw new Error('Completion prefix did not advance');
    }
    if (log.read().position < position) throw new Error('Price synchronization is still pending; retry');
  }
  import(input) {
    const work = this.queue.then(() => this.importPrefix(input)); this.queue = work.catch(() => {}); return work;
  }
  async importPrefix(input) {
    if (!Array.isArray(input?.entries) || input.entries.length > 100) throw new Error('Invalid price prefix');
    const now = (await this.clock()).at, log = this.log();
    if (input.history?.length) {
      for (const h of input.history) {
        const known = this.originalContext(h.context?.epoch.id);
        if (stableJSON(known.epoch.members) !== stableJSON(h.context.epoch.members) || known.networkId !== h.context.networkId || known.venueKey !== h.context.venueKey)
          throw new Error('Unknown price history authority');
      }
      log.inherit(input.history);
    }
    const head = verifyCertificate(input.checkpoint?.certificate, this.context(), 'price-head');
    for (const entry of input.entries) log.append(entry, now);
    await this.catchUp(head.body.headPosition);
    const checkedAt = (await this.clock()).at, settings = effectiveSettings(this.registry().sellerBond, checkedAt)?.settings;
    const q = log.verifyReference(input.reference, input.checkpoint, checkedAt, 60, settings?.priceLookbackSec ?? 0);
    this.store.put('stake-price-reference', { ...input.reference, epochId: this.context().epoch.id });
    return q;
  }
}
