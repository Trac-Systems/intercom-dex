import { randomBytes, createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountBalances, amountUnits, withdrawalDestination, validatePayout, MIN_SOL, MIN_TNK } from './accounting.js';
import { walletFile } from './setup.js';
import { SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { calculateFees } from '../solana/escrow.js';

const DISPLAY_CACHE_MS = 10_000;
// New trades need a local clock within 30 s of Solana's: deadlines are judged locally, signers judge them too.
export const MAX_CLOCK_SKEW_SEC = 30;
const CLOCK_CHECK_MS = 60_000;

const BASES = { TNK: { kind: 'trac-native', id: 'TNK', decimals: 18 }, RESET: { kind: 'trac-contract-token', id: 'RESET', decimals: 8 } };
const finished = w => ['confirmed', 'failed'].includes(w.status);
const TOKEN_PROGRAMS = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map(p => p.toBase58());
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";

export class WalletManager {
  constructor({ config, configFile, store, role, solana, trac, addresses }) {
    validatePayout(config.payout);
    Object.assign(this, { config, configFile, store, role, solana, trac, addresses });
    this.queue = Promise.resolve(); this.busy = new Set(); this.recovering = null;
  }

  exclusive(work) {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }

  pending() { return this.store.list('withdraw-').map(n => this.store.get(n)).filter(w => !finished(w)); }

  async raw(addresses = this.addresses) {
    const own = addresses === this.addresses;
    const [sol, trac] = await Promise.all([
      this.solana.walletBalances(addresses.solana, { fees: own && this.config.role === 'service' }),
      addresses.trac ? this.trac.balances(addresses.trac) : Promise.resolve({ TNK: '0', RESET: '0', feeTnk: '0' }),
    ]);
    return { ...sol, ...trac };
  }

  state() {
    return { offers: [...(this.role.mine?.values() ?? [])], trades: [...(this.role.host?.trades.values() ?? [])].map(t => ({ role: t.role, state: t.state })),
      withdrawals: this.pending() };
  }

  async balances() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = JSON.stringify(this.state()), balances = await this.raw(), state = this.state();
      if (before !== JSON.stringify(state)) continue;
      const result = accountBalances({ balances, ...state, trader: this.config.role === 'trader', feeTnk: balances.feeTnk,
        registry: version => this.role.registry.snapshot(version) });
      if (balances.collectors) Object.assign(result.USDC, { collectedFees: balances.collectedFees, collectors: balances.collectors });
      return result;
    }
    throw new Error('Wallet state changed during balance reads; retry');
  }

  // Withdrawals and payouts go to wallets, not to token accounts (for SOL, not to anything a program other than System
  // owns): USDC sent there lands in a token account of that address, and nobody can sign for it. Off-curve
  // addresses are already refused with the payout and destination rules.
  async checkWallet(address, asset) {
    const owner = await this.solana.accountOwner(address);
    if (TOKEN_PROGRAMS.includes(owner)) throw new Error('This is a token account, give the wallet address');
    if (asset === 'SOL' && owner && owner !== SystemProgram.programId.toBase58()) throw new Error('This account belongs to a program, give the wallet address');
  }

  // Checked once at start.
  async checkPayout() {
    if (this.config.payout?.solana) await this.checkWallet(this.config.payout.solana, 'SOL');
  }

  // A successful comparison is reused for a minute.
  async checkClock() {
    if (this.clockAt !== undefined && performance.now() - this.clockAt < CLOCK_CHECK_MS) return;
    let chain;
    try { chain = await this.solana.chainTime(); }
    catch (e) { throw new Error(`Cannot compare this computer's clock with Solana's right now (${e.message}); no new trade starts until it can`); }
    const skew = Math.floor(Date.now() / 1000) - chain;
    if (Math.abs(skew) > MAX_CLOCK_SKEW_SEC) {
      throw new Error(`This computer's clock is ${Math.abs(skew)} s ${skew > 0 ? 'ahead of' : 'behind'} Solana's clock (at most ${MAX_CLOCK_SKEW_SEC} s allowed). Set the system clock to automatic time; no new trade starts until then.`);
    }
    this.clockAt = performance.now();
  }

  // Checked before every new offer and take.
  async requireFunds(terms) {
    await this.checkClock();
    const balances = await this.balances(), asset = terms.role === 'buyer' ? 'USDC' : terms.base.id;
    const amount = terms.role === 'buyer' ? calculateFees(BigInt(terms.quoteAmount), terms.fees.platformFeeBps, terms.fees.tradeFeeBps).totalAmount : BigInt(terms.baseAmount);
    if (amount > BigInt(balances[asset].free)) throw new Error('Insufficient free balance for this offer or trade');
  }

  // Display reads share one balance result for 10 s while offers, trades and every withdrawal record are unchanged;
  // trading and withdrawals always read fresh through balances().
  async displayBalances() {
    const key = JSON.stringify([this.state(), this.store.list('withdraw-').map(n => [n, this.store.get(n)?.status])]);
    if (this.shown?.key === key && performance.now() - this.shown.at < DISPLAY_CACHE_MS) return this.shown.value;
    const value = await this.balances();
    this.shown = { at: performance.now(), key, value };
    return value;
  }

  async info({ short = false } = {}) {
    // Addresses and storage stay available when the chains cannot be read right now.
    let balances = null, balanceError;
    try { await this.recover(); balances = await this.displayBalances(); } catch (e) { balanceError = `Balances unavailable right now: ${e.message}`; }
    const result = { addresses: this.addresses, balances, ...(balanceError ? { balanceError } : {}), minimumFees: { SOL: MIN_SOL, TNK: this.addresses.trac ? MIN_TNK : '0', units: 'base units' },
      payout: this.config.payout ?? {}, withdrawals: this.pending().map(w => this.publicWithdrawal(w)) };
    if (short) return result;
    const bin = fileURLToPath(new URL('../../bin/dex.mjs', import.meta.url));
    const passwordEnv = this.config.keyPasswordEnv ?? 'DEX_KEY_PASSWORD';
    return { ...result, storage: { dataDir: resolve(this.config.dataDir), keyringFile: join(resolve(this.config.dataDir), 'keyring.json'),
      tracWalletFile: this.addresses.trac ? walletFile(this.config) : null, passwordEnv,
      tracPasswordEnv: this.addresses.trac ? this.config.trac?.passwordEnv ?? passwordEnv : null,
      encryption: 'scrypt-131072-8-1 and XChaCha20-Poly1305; passwords are not stored in the data folder' },
      backup: { instruction: 'Back up the encrypted data folder and any separately configured Trac wallet file; keep its password separately. Wallets live on this machine.',
        exportCommand: `node ${quote(bin)} export --config ${quote(resolve(this.configFile))} --out ${quote(join(resolve(this.config.dataDir), 'wallet-export'))}`,
        exportInstruction: 'Run this once in your own terminal. Enter the wallet password with hidden input. The new directory contains plaintext secrets: keep it private and offline.' } };
  }

  publicWithdrawal(w) {
    return { id: w.id, asset: w.asset, amount: w.amount, to: w.to, status: w.status,
      ...(w.parts ? { collectors: w.parts.map(p => ({ ...p })) } : {}),
      ...(w.signature ? { signature: w.signature } : {}), ...(w.txHash ? { txHash: w.txHash } : {}), ...(w.reason ? { reason: w.reason } : {}) };
  }

  withdraw({ asset, amount, to } = {}) {
    if (this.busy.has(asset)) return Promise.reject(new Error('Withdrawal already in progress for this asset'));
    this.busy.add(asset);
    return this.exclusive(async () => {
      const destination = withdrawalDestination(asset, to, this.config.payout);
      if (this.config.role === 'service' && !this.config.payout?.solana) throw new Error('Service withdrawals require payout.solana');
      if (this.config.role !== 'trader' && !['SOL', 'USDC'].includes(asset)) throw new Error('This role has no Trac wallet');
      const from = ['SOL', 'USDC'].includes(asset) ? this.addresses.solana : this.addresses.trac;
      if (destination === from) throw new Error('Withdrawal destination must differ from the trader');
      const pending = this.pending().find(w => w.asset === asset);
      if (pending) {
        await this.check(pending);
        return { ...this.publicWithdrawal(this.store.get('withdraw-' + pending.id)), existing: true };
      }
      if (['SOL', 'USDC'].includes(asset)) await this.checkWallet(destination, asset);
      const balances = await this.balances(), free = BigInt(balances[asset].free);
      const units = amount === 'all' ? free : amountUnits(asset, amount);
      if (units <= 0n || units > free) throw new Error('Withdrawal exceeds free balance or nothing is free');
      const chain = ['SOL', 'USDC'].includes(asset) ? 'solana' : 'trac';
      const feeAsset = chain === 'solana' ? 'SOL' : 'TNK';
      if (BigInt(balances[feeAsset].wallet) < BigInt(balances[feeAsset].breakdown.fees)) throw new Error(`Insufficient ${feeAsset} fee reserve`);
      const w = { id: randomBytes(32).toString('hex'), asset, amount: units.toString(), to: destination, status: 'unconfirmed',
        sendBy: Math.floor(Date.now() / 1000) + 300 };
      if (this.config.role === 'service' && asset === 'USDC' && balances.USDC.collectors) {
        let remaining = units;
        w.parts = [];
        for (const c of balances.USDC.collectors) {
          const held = BigInt(c.balance), amount = held < remaining ? held : remaining;
          if (!amount) continue;
          w.parts.push({ id: createHash('sha256').update(w.id + ':' + c.collector).digest('hex'), collector: c.collector,
            amount: amount.toString(), status: 'unconfirmed' });
          remaining -= amount;
        }
        if (remaining) w.parts.push({ id: createHash('sha256').update(w.id + ':wallet').digest('hex'), collector: null,
          amount: remaining.toString(), status: 'unconfirmed' });
        // Save the entire sweep before any collector signs, including collectors not reached before a crash.
        this.store.put('withdraw-' + w.id, w);
        await this.check(w);
        return this.publicWithdrawal(this.store.get('withdraw-' + w.id));
      }
      // Persist the owner request before invoking either signing adapter.
      this.store.put('withdraw-' + w.id, w);
      let result;
      try {
        result = chain === 'solana' ? await this.solana.walletWithdraw({ ...w, fees: this.config.role === 'service' }) :
          await this.trac.sendTransfer({ tradeId: w.id, terms: { base: BASES[asset], baseAmount: w.amount,
            seller: { tracAddr: from }, buyer: { tracAddr: destination }, sendBy: w.sendBy } });
      } catch { result = { ok: false, unknown: true, reason: 'Submission outcome is unconfirmed' }; }
      Object.assign(w, { signature: result.signature, txHash: result.txHash, reason: result.reason });
      if (!result.ok && !result.unknown) w.status = 'failed';
      this.store.put('withdraw-' + w.id, w);
      if (!finished(w)) await this.check(w);
      return this.publicWithdrawal(this.store.get('withdraw-' + w.id));
    }).finally(() => this.busy.delete(asset));
  }

  // The outcome comes from the transaction itself, never from balances that other payments also move: confirmed on
  // final evidence of this exact transfer, failed once it is proven rejected or never executed (the amount is free
  // again), otherwise unconfirmed and checked again later.
  async check(w) {
    if (w.parts) return this.#sweep(w);
    try {
      const sol = ['SOL', 'USDC'].includes(w.asset);
      const result = sol ? await this.solana.walletWithdrawalStatus(w.id) : await this.trac.withdrawalStatus(w);
      if (result.signature) w.signature = result.signature;
      if (result.txHash) w.txHash = result.txHash;
      if (result.ok) { w.status = 'confirmed'; delete w.reason; }
      else if (result.unknown === false) { w.status = 'failed'; w.reason = result.reason ?? 'Transaction rejected'; }
      else w.reason = result.reason ?? 'Withdrawal unconfirmed; no second payment will be sent';
    } catch { w.reason = 'Withdrawal unconfirmed; transaction history unavailable'; }
    this.store.put('withdraw-' + w.id, w);
  }

  async #sweep(w) {
    for (const part of w.parts) {
      if (finished(part)) continue;
      try {
        // The adapter keeps completed requests too: replaying a part after a crash cannot pay twice.
        const result = await this.solana.walletWithdraw({ id: part.id, asset: 'USDC', amount: part.amount,
          to: w.to, collector: part.collector });
        if (result.signature) part.signature = result.signature;
        if (result.ok) { part.status = 'confirmed'; delete part.reason; }
        else {
          part.reason = result.reason ?? 'Collector withdrawal unconfirmed';
          if (!result.unknown) part.status = 'failed';
        }
      } catch { part.reason = 'Collector withdrawal unconfirmed; resume the same journaled request'; }
      this.store.put('withdraw-' + w.id, w);
      // Do not hide an unknown payment behind more activity. Recovery continues in collector order.
      if (!finished(part)) break;
    }
    w.status = w.parts.every(p => p.status === 'confirmed') ? 'confirmed' : w.parts.every(finished) ? 'failed' : 'unconfirmed';
    if (w.status === 'confirmed') delete w.reason;
    else w.reason = 'See each collector withdrawal for its outcome';
    this.store.put('withdraw-' + w.id, w);
  }

  recover() {
    if (this.recovering) return this.recovering;
    this.recovering = this.exclusive(async () => {
      for (const w of this.pending()) await this.check(w);
    }).finally(() => { this.recovering = null; });
    return this.recovering;
  }
}
