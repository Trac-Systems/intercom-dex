import { RegistryView, publicReceiver } from './common.js';
import { RegistryRelays } from '../net/relays.js';
import { PayoutService } from './payout.js';
import { stakeContext } from '../stake/price-service.js';
import { effectiveSettings } from '../stake/settings.js';
import { factDigest, verifyCertificate, signFact, verifyFact } from '../stake/certificates.js';
import { stableJSON, sha256Hex } from '../core/canonical.js';
import { RewardLedger } from '../stake/rewards.js';
import { Clock } from '../locks/clock.js';
import { rewardsStatus } from '../stake/status.js';

export class PayoutRole {
  constructor({ bridge, identity, store, serviceKey, profile, adapter, address, log = () => {}, blockClock = new Clock({ bridge }), now = () => Math.floor(Date.now() / 1000) }) {
    Object.assign(this, { bridge, identity, store, serviceKey, adapter, address, log, blockClock, now });
    this.adapter = { ...adapter, pool: async input => {
      const result = await adapter.pool(input);
      this.poolSnapshot = result?.confirmed === true ? { ...result, at: this.now() } : null;
      return result;
    } };
    this.registry = new RegistryView(serviceKey, store, log, profile); this.relays = new RegistryRelays(bridge); this.receive = publicReceiver();
    this.onMessage = (channel, raw) => {
      const m = this.receive(raw);
      if (channel === 'intercom-dex' && m?.ch === channel && m.from === serviceKey && m.kind === 'registry') {
        try { this.registry.offer(m); void this.relays.update(this.registry.usable).catch(e => log('payout relays', e.message)); }
        catch (e) { log('payout registry', e.message); }
      }
    };
  }
  async start() {
    await this.relays.update(this.registry.usable); this.bridge.on('message', this.onMessage); await this.bridge.join('intercom-dex');
    const tick = () => { this.running ??= this.tick().catch(e => { this.error = e.message; this.log('payout waiting', e.message); }).finally(() => { this.running = null; }); };
    this.timer = setInterval(tick, 5000); this.timer.unref?.(); tick();
  }
  stop() { clearInterval(this.timer); this.bridge.off('message', this.onMessage); }
  policy(at = this.now()) {
    const policy = this.registry.usable?.sellerBond;
    if (policy?.rewardService?.dexKey !== this.identity.publicKey || policy.rewardService.tracAddr !== this.address) throw new Error('Signed payout identity and pool address are required');
    if (this.service && this.epochId !== policy.epoch.id) throw new Error('Reward epoch migration is required');
    const settings = effectiveSettings(policy, at); if (!settings) throw new Error('Reward settings are not effective');
    return { policy, settings };
  }
  async tick() {
    if (this.handoffPending || this.store.get('stake-payout-handoff')?.frozen) return;
    const { policy } = this.policy(), context = stakeContext({ sellerBond: policy });
    if (!this.service) {
      this.epochId = policy.epoch.id;
      this.service = new PayoutService({ store: this.store, context, identity: this.identity, adapter: this.adapter,
        settings: facts => this.policy(facts?.at).settings.settings, now: this.now,
        publish: async summary => { this.store.put(`stake-payout-audit-${summary.body.height}`, summary); } });
    }
    const counted = await this.blockClock.counted(), record = this.service.ledger.read();
    let cursor = this.store.get('stake-payout-cursor');
    if (!cursor) {
      cursor = { height: record.height ?? counted, blockHash: record.blockHash ?? await this.blockClock.hash(counted), epochId: context.epoch.id };
      this.store.put('stake-payout-cursor', cursor);
    }
    if (cursor.epochId !== context.epoch.id || await this.blockClock.hash(cursor.height) !== cursor.blockHash) throw new Error('Reward chain or epoch changed');
    if (counted < cursor.height) throw new Error('Reward counted height regressed');
    // A changed chain or epoch must stop new payments too, including immediately
    // after restart. Only then reconcile before computing the next liabilities.
    await this.syncAwards(context);
    await this.service.payout();
    if (counted > cursor.height) {
      // Checkpoints exist only for the current counted height. After a missed height the cursor moves on to the
      // current one; the skipped heights earn nothing instead of stopping rewards for good.
      const height = counted === cursor.height + 1 ? cursor.height + 1 : counted;
      const facts = await this.stakeRuntime.request(context.venueKey, 'rewardBlock', { height });
      const head = verifyCertificate(facts.headCertificate, context, 'reward-head').body;
      if (head.height !== height || head.blockHash !== await this.blockClock.hash(head.height) ||
          head.height === cursor.height + 1 && head.previousHash !== cursor.blockHash ||
          head.at > this.now() || head.policyId !== this.policy(head.at).settings.policyId) throw new Error('Reward checkpoint does not follow the counted chain');
      for (const field of ['height', 'blockHash', 'previousHash', 'at']) if (facts[field] !== head[field]) throw new Error('Reward head mismatch');
      for (const kind of ['inventory', 'book', 'price']) if (head[kind + 'Digest'] !== factDigest(verifyCertificate(facts[kind + 'Certificate'], context, kind)))
        throw new Error('Reward component mismatch');
      await this.service.onBlock(facts);
      this.store.put('stake-payout-cursor', { height: head.height, blockHash: head.blockHash, epochId: context.epoch.id });
      await this.syncAwards(context);
    await this.service.payout();
    }
    this.error = null;
  }
  async rewardHandoff(method, body, from) {
    const current = this.registry.usable?.sellerBond;
    if (from !== this.serviceKey || current?.rewardService?.dexKey !== this.identity.publicKey || current.rewardService.tracAddr !== this.address)
      throw new Error('Venue and unchanged payout authority required');
    const previous = this.store.list('registry-v').map(name => this.store.get(name)?.sellerBond).find(p => p?.epoch.id === body.previousEpochId);
    if (!previous || stableJSON(previous.rewardService) !== stableJSON(current.rewardService) || current.epoch.id !== body.nextEpochId)
      throw new Error('Authenticated original reward policy required');
    this.handoffPending = true;
    try {
      await this.running;
      const context = stakeContext({ sellerBond: previous }), ledger = new RewardLedger({ store: this.store, context, identity: this.identity });
      const name = 'stake-payout-handoff', saved = this.store.get(name), record = ledger.read(), cursor = this.store.get('stake-payout-cursor');
      if (method === 'rewardHandoffRelease' && saved?.adopted && !saved.frozen && saved.nextEpochId === body.nextEpochId &&
          factDigest(saved.vote.fact) === factDigest(body.liability?.fact)) return { adopted: true, ledgerHash: saved.vote.fact.body.ledgerHash };
      if (method === 'rewardHandoffFreeze') {
        if (saved?.nextEpochId === current.epoch.id) return saved.vote;
        if (!cursor || cursor.epochId !== previous.epoch.id || record.pending || Object.values(record.forfeits).some(f => f.state === 'pending'))
          throw new Error('Finish original reward payment reconciliation before handoff');
        if (await this.blockClock.hash(cursor.height) !== cursor.blockHash || await this.blockClock.counted() !== cursor.height) throw new Error('Reward chain changed at handoff');
        const pool = await this.adapter.pool();
        if (!pool.confirmed) throw new Error('Confirmed reward pool required');
        const unpaid = Object.values(record.accounts).reduce((n, a) => n + BigInt(a.unpaid), 0n).toString();
        const fact = { v: 1, networkId: context.networkId, venueKey: context.venueKey, epochId: context.epoch.id, kind: 'liability-handoff',
          body: { nextEpochId: current.epoch.id, cursor, ledgerHash: sha256Hex(stableJSON(record)), unpaid, poolBalance: pool.RESET,
            payoutSequence: record.payoutSequence, accounts: record.accounts, forfeits: record.forfeits } };
        const vote = signFact(fact, this.identity.secretKey);
        this.store.put(name, { previousEpochId: previous.epoch.id, nextEpochId: current.epoch.id, frozen: true, vote }); return vote;
      }
      const fact = verifyFact(body.liability, context, 'liability-handoff', this.identity.publicKey);
      if (!saved || factDigest(saved.vote.fact) !== factDigest(fact) || fact.body.ledgerHash !== sha256Hex(stableJSON(record)))
        throw new Error('Reward liabilities changed during handoff');
      this.store.put(`stake-reward-context-${context.epoch.id}`, context);
      this.store.put('stake-payout-cursor', { ...fact.body.cursor, epochId: current.epoch.id });
      if (this.service) this.service.ledger.context = stakeContext({ sellerBond: current });
      this.epochId = current.epoch.id;
      this.store.put(name, { ...saved, adopted: true, frozen: method !== 'rewardHandoffRelease' });
      return { adopted: true, ledgerHash: fact.body.ledgerHash };
    } finally { this.handoffPending = false; }
  }
  async syncAwards(context) {
    let cursor = this.store.get('stake-payout-award-cursor')?.after ?? 0;
    for (let pages = 0; pages < 64; pages++) {
      const page = await this.stakeRuntime.request(context.venueKey, 'penaltyAwards', { after: cursor });
      if (!page || page.after !== cursor || !Array.isArray(page.awards) || page.awards.length > 32 ||
          page.through !== cursor + page.awards.length || !Number.isSafeInteger(page.total) || page.total < page.through) throw new Error('Invalid penalty archive page');
      for (const award of page.awards) await this.service.forfeit(award);
      cursor = page.through; this.store.put('stake-payout-award-cursor', { after: cursor });
      if (cursor === page.total) return;
      if (!page.awards.length) throw new Error('Penalty archive stalled');
    }
    throw new Error('Penalty archive catch-up pending');
  }
  rewardRead(method, body) {
    if (!this.service) throw new Error('Reward ledger is not initialized');
    this.policy();
    if (method === 'rewardStatus') return { address: body.address, rewards: this.accountStatus(body.address) };
    if (method === 'rewardAudit') {
      if (!Number.isSafeInteger(body.height) || body.height < 0) throw new Error('Invalid audit height');
      return this.store.get(this.service.ledger.summaryName(body.height));
    }
    throw new Error('Unsupported reward read');
  }
  poolStatus() {
    const snapshot = this.poolSnapshot, r = this.service?.ledger.read();
    if (!snapshot || !r || this.now() < snapshot.at || this.now() - snapshot.at > 900)
      return { poolState: 'unknown', poolBalance: null };
    const unpaid = Object.values(r.accounts).reduce((sum, a) => sum + BigInt(a.unpaid), 0n);
    const daily = BigInt(this.policy().settings.settings.rewards.dailyReset), next = BigInt((r.height ?? 0) + 1);
    const budget = daily * (next + 1n) / 144n - daily * next / 144n;
    return { poolState: BigInt(snapshot.RESET) - unpaid < budget ? 'empty' : 'active', poolBalance: snapshot.RESET };
  }
  accountStatus(address) {
    const account = this.service.status(address), pool = this.poolStatus();
    return rewardsStatus({ ...account, ...pool, ...(pool.poolState !== 'active' ? { ratePerDay: '0' } : {}) });
  }
  status() {
    const ledger = this.service?.ledger.read();
    let pool = { poolState: 'unknown', poolBalance: null }, accounts = [];
    try { pool = this.poolStatus(); accounts = Object.keys(ledger?.accounts ?? {}).map(address => ({ address, ...this.accountStatus(address) })); }
    catch { accounts = Object.entries(ledger?.accounts ?? {}).map(([address, a]) => ({ address, ...rewardsStatus({ unpaid: a.unpaid,
      paidTotal: a.paidTotal, lastPayout: a.lastPayout, forfeited: a.forfeited }) })); }
    return { role: 'payout', dexKey: this.identity.publicKey, poolAddress: this.address, registryVersion: this.registry.current?.version ?? null,
      observedHeight: this.store.get('stake-payout-cursor')?.height ?? null,
      height: ledger?.height ?? null, ...pool, pending: ledger?.pending ?
        { operationId: ledger.pending.id, amount: ledger.pending.amount, to: ledger.pending.address } : null,
      accounts,
      summary: ledger?.lastSummary ?? null, error: this.error ?? null };
  }
}
