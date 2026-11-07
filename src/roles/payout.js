import { RewardLedger } from '../stake/rewards.js';
import { settingsSchema } from '../stake/settings.js';

// Separate ordinary RESET wallet. The adapter never receives stake keys or a stake collection method.
// prepare signs without broadcasting; sendPrepared only rebroadcasts the exact saved bytes; outcome proves finality.
export class PayoutService {
  constructor({ store, context, identity, adapter, settings, minWeeklyReset = '0', publish = async () => {}, now = () => Math.floor(Date.now() / 1000) }) {
    if (!/^(0|[1-9][0-9]*)$/.test(minWeeklyReset)) throw new Error('minWeeklyReset must be RESET base units');
    for (const method of ['pool', 'prepare', 'sendPrepared', 'outcome']) if (typeof adapter?.[method] !== 'function') throw new Error(`Payout adapter requires ${method}`);
    this.ledger = new RewardLedger({ store, context, identity });
    Object.assign(this, { adapter, settings, minWeeklyReset, publish, now }); this.queue = Promise.resolve();
  }
  enqueue(fn) { const work = this.queue.then(fn); this.queue = work.catch(() => {}); return work; }
  onBlock(facts) {
    return this.enqueue(async () => {
      this.ledger.read(); // Finish an interrupted accrual before consulting a new wallet snapshot.
      const saved = this.ledger.store.get(this.ledger.summaryName(facts.height));
      if (saved) {
        const summary = this.ledger.accrue({ ...facts, settings: saved.settings, poolBalance: saved.summary.body.poolBalance });
        await this.publish(summary); return summary;
      }
      const pool = await this.adapter.pool({ height: facts.height, blockHash: facts.blockHash });
      if (pool.confirmed !== true) throw new Error('Confirmed pool balance unavailable');
      const summary = this.ledger.accrue({ ...facts, settings: settingsSchema.parse(this.settings(facts)), poolBalance: pool.RESET });
      await this.publish(summary); return summary;
    });
  }
  payout() {
    return this.enqueue(async () => {
      const settings = settingsSchema.parse(this.settings()), now = this.now();
      let p = this.ledger.read().pending;
      if (p?.transfer) {
        const outcome = await this.adapter.outcome(p.transfer);
        if (outcome.confirmed === true) {
          if (outcome.txHash !== p.transfer.txHash || outcome.amount !== p.amount || outcome.to !== p.address) throw new Error('Payout confirmation mismatch');
          return this.ledger.paid(p.id, { txHash: outcome.txHash, at: now });
        }
        if (outcome.pending === true || outcome.unknown === true) return { state: 'pending', operationId: p.id };
        if (Object.values(this.ledger.read().forfeits).some(f => f.state === 'pending' && f.payoutId === p.id))
          return { state: 'pending', operationId: p.id, reason: 'forfeit_reconciliation' };
      }
      const pool = await this.adapter.pool();
      if (pool.confirmed !== true || !/^(0|[1-9][0-9]*)$/.test(pool.TNK ?? '') || !/^(0|[1-9][0-9]*)$/.test(pool.feeTnk ?? '')) throw new Error('Confirmed payout fee balance unavailable');
      if (BigInt(pool.TNK) < BigInt(pool.feeTnk)) return { state: 'pending', reason: 'tnk_short' };
      p ??= this.ledger.beginPayout(now, settings, this.minWeeklyReset);
      if (!p) return { state: 'idle' };
      if (BigInt(pool.RESET) < BigInt(p.amount)) return { state: 'pending', reason: 'pool_empty', operationId: p.id };
      if (!p.transfer) p = this.ledger.prepared(p.id, await this.adapter.prepare({ operationId: p.id, nonce: p.id, to: p.address, amount: p.amount, asset: 'RESET' }));
      // Never replace signed bytes if the fee quote moved; leave the intent recoverable.
      const fresh = await this.adapter.pool();
      if (fresh.confirmed !== true || BigInt(fresh.RESET) < BigInt(p.amount)) return { state: 'pending', reason: 'pool_empty', operationId: p.id };
      if (BigInt(fresh.TNK) < BigInt(p.transfer.feeTnk) || fresh.feeTnk !== p.transfer.feeTnk) return { state: 'pending', reason: 'tnk_short', operationId: p.id };
      await this.adapter.sendPrepared(p.transfer);
      return { state: 'pending', operationId: p.id, tx: p.transfer.txHash };
    });
  }
  forfeit(input) { return this.enqueue(() => this.ledger.forfeit({ ...input, now: this.now() })); }
  status(address) { return this.ledger.status(address, this.settings()); }
}
