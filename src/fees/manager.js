import { randomBytes } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { stableJSON } from '../core/canonical.js';
import { percentBps, platformBps, readAuthorityKeypair, PLATFORM_WARNING } from './input.js';

const RECORD = 'service-fee-change';

// One service process owns this queue, its keyring, and the Solana transaction journal.
export class FeeManager {
  constructor({ config, keys, store, service, solana }) {
    if (config.role !== 'service') throw new Error('Fee commands are service only');
    Object.assign(this, { keys, store, service, solana });
    this.queue = Promise.resolve();
  }

  exclusive(work) {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }

  async initialize() {
    if (!this.keys.collectors.length) {
      const main = Keypair.fromSecretKey(this.keys.solanaSecret).publicKey.toBase58();
      if (this.service.registry.fee.collector !== main) throw new Error('Initial registry collector must be the service Solana key');
      await this.solana.assertFeeConfig(this.service.registry.fee, this.service.profile?.platformCollector);
      await this.keys.ensureCollector({ id: 'initial', feeBps: this.service.registry.fee.tradeFeeBps, useMain: true });
    }
    if (!this.keys.collectors.some(c => c.collector === this.service.registry.fee.collector && c.feeBps === this.service.registry.fee.tradeFeeBps)) throw new Error('Registry collector is missing from the service keyring');
    return this.recover();
  }

  set({ tradeFee, signerShare } = {}) {
    return this.exclusive(async () => {
      if (tradeFee === undefined && signerShare === undefined) throw new Error('Provide tradeFee or signerShare');
      const fee = { ...this.service.registry.fee };
      if (tradeFee !== undefined) fee.tradeFeeBps = percentBps(tradeFee, 1000);
      if (signerShare !== undefined) fee.signerShareBps = percentBps(signerShare, 10000);
      if (fee.platformFeeBps + fee.tradeFeeBps > 1500) throw new Error('Total fees exceed 15%');
      const request = { kind: 'venue', tradeFeeBps: fee.tradeFeeBps, signerShareBps: fee.signerShareBps, platformFeeBps: fee.platformFeeBps };
      return this.#begin(request, fee);
    });
  }

  platform({ bps, authorityKeypair, yes } = {}) {
    return this.exclusive(async () => {
      if (yes !== true) throw new Error(PLATFORM_WARNING);
      const fee = { ...this.service.registry.fee, platformFeeBps: platformBps(bps) };
      if (fee.platformFeeBps + fee.tradeFeeBps > 1500) throw new Error('Total fees exceed 15%');
      const authority = readAuthorityKeypair(authorityKeypair);
      try {
        const state = await this.solana.platformFeeConfig();
        if (state.authority !== authority.publicKey.toBase58()) throw new Error('Platform authority does not match config');
        return await this.#begin({ kind: 'platform', platformFeeBps: fee.platformFeeBps, authority: authority.publicKey.toBase58() }, fee, authority);
      } finally { authority.secretKey.fill(0); }
    });
  }

  async #begin(request, fee, authority = null) {
    let record = this.store.get(RECORD);
    if (record && record.phase !== 'published') {
      if (stableJSON(record.request) !== stableJSON(request)) throw new Error('A fee change is pending; resume that change first');
    } else {
      if (stableJSON(fee) === stableJSON(this.service.registry.fee)) {
        await this.solana.assertFeeConfig(fee, this.service.profile?.platformCollector);
        return this.service.registry;
      }
      record = { id: randomBytes(32).toString('hex'), request, fee, phase: 'requested',
        rotate: request.kind === 'venue' && fee.tradeFeeBps !== this.service.registry.fee.tradeFeeBps };
      this.store.put(RECORD, record);
    }
    return this.#resume(record, authority);
  }

  async #resume(record, authority = null) {
    if (record.rotate) {
      const collector = await this.keys.ensureCollector({ id: record.id, feeBps: record.fee.tradeFeeBps });
      record.fee.collector = collector.collector;
      record.phase = 'key-saved'; this.store.put(RECORD, record);
      const saved = this.keys.collectors.find(c => c.id === record.id), keypair = Keypair.fromSecretKey(saved.secretKey);
      try {
        const result = await this.solana.createCollectorConfig({ collectorKeypair: keypair, feeBps: record.fee.tradeFeeBps });
        if (!result.ok) throw new Error(result.reason);
      } finally { saved.secretKey.fill(0); keypair.secretKey.fill(0); }
    } else if (record.request.kind === 'platform') {
      const result = await this.solana.setPlatformConfig({ id: record.id, feeBps: record.fee.platformFeeBps,
        authority: record.request.authority, authorityKeypair: authority });
      if (!result.ok) throw new Error(result.reason);
    }
    await this.solana.assertFeeConfig(record.fee, this.service.profile?.platformCollector);
    record.phase = 'finalized'; this.store.put(RECORD, record);
    const registry = await this.service.publishFees(record.fee);
    record.phase = 'published'; record.registryVersion = registry.version; this.store.put(RECORD, record);
    return registry;
  }

  recover() {
    return this.exclusive(async () => {
      const record = this.store.get(RECORD);
      if (!record || record.phase === 'published') return this.service.registry;
      try { return await this.#resume(record); }
      catch (error) {
        // Before the authority signed anything, the operator must supply its file again. Never persist that key.
        if (record.request.kind === 'platform' && /authority keypair required/.test(error.message)) return this.service.registry;
        throw error;
      }
    });
  }
}
