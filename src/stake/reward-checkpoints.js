import { liveRewardBook, verifyObservedOffers } from './reward-book.js';
import { registryPair } from '../market/assets.js';
import { signFact, verifyFact, verifyCertificate, factDigest, matchingCertificate } from './certificates.js';
import { stakeContext } from './price-service.js';
import { stableJSON } from '../core/canonical.js';
import { rewardWeights } from './rewards.js';
import { effectiveSettings } from './settings.js';
import { CompletionLog } from './price.js';

// Checkpoints are taken only at the current signed RESET height. An unavailable
// historical checkpoint is never reconstructed from today's inventory or book.
export class RewardCheckpoints {
  constructor({ store, identity, registry, price, clock, blockClock, request, offers = () => [], balances, venue = false }) {
    Object.assign(this, { store, identity, registry, price, clock, blockClock, request, offers, balances, venue }); this.queue = Promise.resolve();
  }
  handle(method, input, from) {
    if (method === 'rewardOriginalInventory') return this.apply(method, input, from);
    const run = this.queue.then(() => this.apply(method, input, from)); this.queue = run.catch(() => {}); return run;
  }
  observe() {
    const run = this.queue.then(async () => {
      const context = stakeContext(this.registry()), height = await this.blockClock.counted(), { at } = await this.clock();
      const name = `stake-reward-observer-${context.epoch.id}`, before = this.store.get(name);
      if (before && height < before.height) throw new Error('Reward observer height regressed');
      if (before && height === before.height + 1 && at >= before.at && at - before.at <= 15) {
        const head = await this.block(height);
        const capture = { ...head, at, offers: this.offers(), ...(!this.venue ? { inventory: this.inventory(head) } : {}) };
        this.store.put(`stake-reward-capture-${context.epoch.id}-${height}`, capture);
        if (!this.venue) {
          const policies = [this.registry().sellerBond, ...this.store.list('stake-retained-epoch-').map(name => this.store.get(name))];
          for (const policy of policies.filter(p => p?.epoch.members.some(m => m.dexKey === this.identity.publicKey)))
            this.store.put(`stake-reward-original-${policy.epoch.id}-${height}`, this.inventory(head, policy.epoch.id));
        }
      }
      // Startup, missed heights and long read outages establish a new baseline,
      // never a historical inventory reconstructed after the fact.
      this.store.put(name, { height, at });
    }); this.queue = run.catch(() => {}); return run;
  }
  async block(height) {
    if (!Number.isSafeInteger(height) || height < 1 || await this.blockClock.counted() !== height) throw new Error('Current counted reward height required');
    return { height, blockHash: await this.blockClock.hash(height), previousHash: await this.blockClock.hash(height - 1) };
  }
  inventory(head, epochId = stakeContext(this.registry()).epoch.id) {
    const context = stakeContext(this.registry()), accounts = new Map();
    for (const name of this.store.list('stake-ledger-')) {
      for (const p of Object.values(this.store.get(name)?.pieces ?? {})) {
        const d = p.descriptor;
        if (d.networkId !== context.networkId || d.venueKey !== context.venueKey || p.state === 'retired' || p.refundCertificate || d.epochId !== epochId) continue;
        const list = accounts.get(d.owner.tracAddr) ?? [];
        list.push({ unitId: p.unitId, generation: p.generation, principalReset: d.principalReset, purpose: d.purpose, state: p.state });
        accounts.set(d.owner.tracAddr, list);
      }
    }
    return { height: head.height, blockHash: head.blockHash, accounts: [...accounts].sort(([a], [b]) => a.localeCompare(b))
      .map(([address, pieces]) => ({ address, pieces: pieces.sort((a, b) => a.unitId.localeCompare(b.unitId)) })) };
  }
  async completeInventory(head, capture) {
    const context = stakeContext(this.registry()), history = new CompletionLog({ store: this.store, context }).history();
    if (!history.length) return capture.inventory;
    const name = `stake-reward-merged-${context.epoch.id}-${head.height}`, prior = this.store.get(name);
    if (prior) { if (prior.blockHash !== head.blockHash) throw new Error('Inherited reward block differs'); return prior.inventory; }
    const accounts = new Map(capture.inventory.accounts.map(a => [a.address, [...a.pieces]])), certificates = [];
    for (const origin of history) {
      const old = origin.context;
      const replies = await Promise.allSettled(old.epoch.members.map(m => this.request(m.dexKey, 'rewardOriginalInventory', { ...head, epochId: old.epoch.id })));
      const certificate = matchingCertificate(replies.flatMap(r => r.status === 'fulfilled' ? [r.value] : []), old, 'inventory');
      const inventory = verifyCertificate(certificate, old, 'inventory').body;
      if (inventory.height !== head.height || inventory.blockHash !== head.blockHash) throw new Error('Original reward inventory differs');
      certificates.push(certificate);
      for (const account of inventory.accounts) accounts.set(account.address, [...(accounts.get(account.address) ?? []), ...account.pieces]);
    }
    const inventory = { height: head.height, blockHash: head.blockHash, accounts: [...accounts].sort(([a], [b]) => a.localeCompare(b))
      .map(([address, pieces]) => ({ address, pieces: pieces.sort((a, b) => a.unitId.localeCompare(b.unitId)) })) };
    this.store.put(name, { blockHash: head.blockHash, inventory, certificates }); return inventory;
  }
  async apply(method, input, from) {
    const policy = this.registry()?.sellerBond, context = stakeContext(this.registry());
    if (!policy.rewardService) throw new Error('Reward service is not configured');
    const fact = (kind, body) => ({ v: 1, networkId: context.networkId, venueKey: context.venueKey, epochId: context.epoch.id, kind, body });
    if (method === 'rewardOriginalInventory' && !this.venue) {
      const policy = this.store.get(`stake-retained-epoch-${input.epochId}`) ?? this.registry().sellerBond;
      if (policy.epoch.id !== input.epochId || policy.networkId !== context.networkId || policy.venueKey !== context.venueKey ||
          !policy.epoch.members.some(m => m.dexKey === this.identity.publicKey) ||
          from !== context.venueKey && !context.epoch.members.some(m => m.dexKey === from)) throw new Error('Original reward inventory authorization required');
      const head = await this.block(input.height), inventory = this.store.get(`stake-reward-original-${input.epochId}-${input.height}`);
      if (!inventory || inventory.blockHash !== head.blockHash || input.blockHash !== head.blockHash) throw new Error('Original block inventory unavailable');
      return signFact({ ...fact('inventory', inventory), epochId: input.epochId }, this.identity.secretKey);
    }
    if (method === 'rewardBlock' && this.venue) {
      if (from !== policy.rewardService.dexKey) throw new Error('Configured payout service required');
      const name = `stake-reward-block-${context.epoch.id}-${input.height}`, saved = this.store.get(name);
      if (saved) return saved;
      const head = await this.block(input.height), capture = this.store.get(`stake-reward-capture-${context.epoch.id}-${input.height}`);
      if (!capture) throw new Error('Contemporaneous reward checkpoint is unavailable');
      const { at } = capture;
      const inventoryReplies = await Promise.allSettled(context.epoch.members.map(m => this.request(m.dexKey, 'rewardInventory', head)));
      const inventoryCertificate = matchingCertificate(inventoryReplies.flatMap(r => r.status === 'fulfilled' ? [r.value] : []), context, 'inventory');
      const inventory = verifyCertificate(inventoryCertificate, context, 'inventory').body;
      const price = await this.price.handle('priceSnapshot', {}, from), q = await this.price.import(price);
      const offers = capture.offers.filter(o => o.side === 'sell');
      const book = signFact(fact('book', liveRewardBook({ inventory, offers, registry: this.registry(), settings: effectiveSettings(policy, at).settings, price: q, at })), this.identity.secretKey);
      const proposal = { ...head, at, book, price, offers };
      const results = await Promise.allSettled(context.epoch.members.map(m => this.request(m.dexKey, 'rewardVote', proposal)));
      const values = results.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);
      const certificates = Object.fromEntries(['inventory', 'book', 'price'].map(kind =>
        [kind + 'Certificate', matchingCertificate(values.map(v => v[kind]), context, kind)]));
      const headCertificate = matchingCertificate(values.map(v => v.head), context, 'reward-head');
      const certified = verifyCertificate(headCertificate, context, 'reward-head').body;
      for (const kind of ['inventory', 'book', 'price']) if (certified[kind + 'Digest'] !== factDigest(verifyCertificate(certificates[kind + 'Certificate'], context, kind)))
        throw new Error('Reward checkpoint components differ');
      const archive = { height: certified.height, blockHash: certified.blockHash, previousHash: certified.previousHash,
        at: certified.at, headCertificate, ...certificates };
      this.store.put(name, archive); return archive;
    }
    if (method === 'rewardInventory' && !this.venue) {
      if (from !== context.venueKey) throw new Error('Only venue checkpoints are accepted');
      const head = await this.block(input.height), capture = this.store.get(`stake-reward-capture-${context.epoch.id}-${input.height}`);
      if (!capture || capture.blockHash !== head.blockHash || input.blockHash !== head.blockHash) throw new Error('Contemporaneous reward inventory is unavailable');
      return signFact(fact('inventory', await this.completeInventory(head, capture)), this.identity.secretKey);
    }
    if (method === 'rewardVote' && !this.venue) {
      if (from !== context.venueKey) throw new Error('Only venue checkpoints are accepted');
      const name = `stake-reward-votes-${context.epoch.id}-${input.height}`, saved = this.store.get(name);
      if (saved) {
        if (saved.blockHash !== input.blockHash) throw new Error('Conflicting reward checkpoint');
        return saved.votes;
      }
      const head = await this.block(input.height), now = (await this.clock()).at;
      const capture = this.store.get(`stake-reward-capture-${context.epoch.id}-${input.height}`);
      if (!capture || capture.blockHash !== head.blockHash || Math.abs(capture.at - input.at) > 15) throw new Error('Contemporaneous reward inventory is unavailable');
      if (stableJSON(head) !== stableJSON({ height: input.height, blockHash: input.blockHash, previousHash: input.previousHash }) ||
          !Number.isSafeInteger(input.at) || input.at > now || now - input.at > 60) throw new Error('Stale reward checkpoint');
      const book = verifyFact(input.book, context, 'book', context.venueKey).body;
      const q = await this.price.import(input.price), inventory = await this.completeInventory(head, capture), price = { height: head.height, blockHash: head.blockHash, price: q };
      verifyObservedOffers(input.offers, capture.offers, input.at);
      const expected = liveRewardBook({ inventory, offers: input.offers, registry: this.registry(), settings: effectiveSettings(policy, input.at).settings, price: q, at: input.at });
      if (stableJSON(book) !== stableJSON(expected)) throw new Error('Live reward backing differs');
      const required = new Map();
      for (const o of input.offers) {
        const asset = registryPair(this.registry(), o.pair).base.id, key = o.maker.tracAddr;
        const own = required.get(key) ?? { TNK: 0n, RESET: 0n, fees: 0n };
        own[asset] += BigInt(o.baseAmount); own.fees++; required.set(key, own);
      }
      for (const [address, needed] of required) {
        const funds = await this.balances(address);
        if (!funds || !/^[0-9]+$/.test(funds.feeTnk ?? '') || BigInt(funds.TNK) < needed.TNK + needed.fees * BigInt(funds.feeTnk) || BigInt(funds.RESET) < needed.RESET) throw new Error('Live reward offer funding unavailable');
      }
      rewardWeights({ inventory, book, price, settings: effectiveSettings(policy, input.at).settings });
      if (await this.blockClock.counted() !== head.height) throw new Error('Reward height advanced during verification');
      const votes = Object.fromEntries(Object.entries({ inventory, book, price }).map(([kind, body]) => [kind, signFact(fact(kind, body), this.identity.secretKey)]));
      votes.head = signFact(fact('reward-head', { ...head, at: input.at, policyId: effectiveSettings(policy, input.at).policyId,
        ...Object.fromEntries(['inventory', 'book', 'price'].map(kind => [kind + 'Digest', factDigest(votes[kind].fact)])) }), this.identity.secretKey);
      this.store.put(name, { blockHash: head.blockHash, votes }); return votes;
    }
    throw new Error('Unsupported reward checkpoint request');
  }
}
