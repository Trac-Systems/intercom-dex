import { z } from 'zod';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes, sha256Hex, stableJSON, utf8 } from '../core/canonical.js';
import { isTracAddress } from '../core/addresses.js';
import { verifyCertificate, factDigest } from './certificates.js';
import { settingsSchema, policyId } from './settings.js';
import { rewardsStatus } from './status.js';
import { terminalDecisionSchema } from './ledger.js';

const uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hex = z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/);
const units = z.string().regex(/^(0|[1-9][0-9]{0,30})$(?![\s\S])/);
const address = z.string().refine(a => a === a.toLowerCase() && isTracAddress(a));
const snapshot = { height: uint, blockHash: hex };
const MAX_REWARD_PIECES = 5000;
const inventorySchema = z.object({ ...snapshot, accounts: z.array(z.object({ address,
  pieces: z.array(z.object({ unitId: hex, generation: uint, principalReset: units, purpose: z.enum(['buyer', 'seller']),
    state: z.enum(['free', 'reserved', 'withdrawing', 'decided-buyer', 'decided-seller', 'retired']) }).strict()).max(200) }).strict()).max(MAX_REWARD_PIECES) }).strict();
const bookSchema = z.object({ ...snapshot, backing: z.array(z.object({ address, unitId: hex, amount: units }).strict()).max(MAX_REWARD_PIECES) }).strict();
const priceSchema = z.object({ ...snapshot, price: z.object({ numerator: units.refine(n => BigInt(n) > 0n),
  denominator: units.refine(n => BigInt(n) > 0n) }).strict() }).strict();
const summaryBytes = body => utf8('intercom-dex/rewards/v1/summary\n' + stableJSON(body));

export function verifyRewardSummary(summary, payoutKey) {
  try { return summary.from === payoutKey && ed25519.verify(hexToBytes(summary.sig, 64), summaryBytes(summary.body), hexToBytes(payoutKey, 32), { zip215: false }); }
  catch { return false; }
}

export function rewardWeights({ inventory, book, price, settings }) {
  const i = inventorySchema.parse(inventory), b = bookSchema.parse(book), p = priceSchema.parse(price), s = settingsSchema.parse(settings);
  if (i.height !== b.height || i.height !== p.height || i.blockHash !== b.blockHash || i.blockHash !== p.blockHash) throw new Error('Reward snapshots disagree');
  if (new Set(i.accounts.map(a => a.address)).size !== i.accounts.length) throw new Error('Duplicate reward address');
  const all = new Map(), backing = new Map();
  for (const a of i.accounts) for (const unit of a.pieces) {
    if (all.has(unit.unitId)) throw new Error('Duplicate stake piece');
    all.set(unit.unitId, { ...unit, address: a.address });
  }
  // Bound reward verification independently of admission capacity. Paging can
  // carry the complete retained inventory; this does not grant funding slots.
  if (all.size > MAX_REWARD_PIECES) throw new Error('Reward inventory exceeds piece cap');
  for (const row of b.backing) {
    const unit = all.get(row.unitId);
    if (!unit || unit.address !== row.address || unit.purpose !== 'seller' || !['free', 'reserved'].includes(unit.state) ||
        BigInt(row.amount) > BigInt(unit.principalReset) || backing.has(row.unitId)) throw new Error('Invalid live offer backing');
    backing.set(row.unitId, BigInt(row.amount));
  }
  const cap = BigInt(s.stake.maxUsdPerAddress) * 100000000n * BigInt(p.price.denominator) / BigInt(p.price.numerator);
  return i.accounts.map(a => {
    let remaining = cap, weight = 0n, active = 0n, eligible = 0n;
    // Stable cap ordering is reproducible across services, aliases and restarts.
    for (const piece of [...a.pieces].sort((a, b) => a.unitId.localeCompare(b.unitId))) {
      if (!['free', 'reserved'].includes(piece.state)) continue;
      const principal = BigInt(piece.principalReset), counted = principal < remaining ? principal : remaining;
      remaining -= counted; eligible += counted;
      const backed = backing.get(piece.unitId) ?? 0n, live = backed < counted ? backed : counted;
      active += live; weight += counted * 10000n + live * BigInt(s.rewards.activeWeightBps - 10000);
    }
    return { address: a.address, weight: weight.toString(), eligibleReset: eligible.toString(), activeReset: active.toString() };
  }).sort((a, b) => a.address.localeCompare(b.address));
}

export class RewardLedger {
  constructor({ store, context, identity }) {
    if (!store?.get || !store?.put || !identity?.secretKey) throw new Error('Payout ledger needs an encrypted store and signing identity');
    this.store = store; this.context = context; this.identity = identity;
    this.name = 'rewards-ledger-' + sha256Hex(stableJSON({ networkId: context.networkId, venueKey: context.venueKey }));
  }
  read() {
    const current = this.store.get(this.name) ?? { v: 1, height: null, blockHash: null, accounts: {}, pending: null, payoutSequence: 0, forfeits: {} };
    const commit = this.store.get(`${this.name}-commit`);
    if (!commit) return current;
    const hash = sha256Hex(stableJSON(current));
    if (![commit.beforeHash, commit.afterHash].includes(hash) || sha256Hex(stableJSON(commit.nextState)) !== commit.afterHash ||
        commit.archiveName !== this.summaryName(commit.nextState.height)) throw new Error('Reward commit does not match durable head');
    const archive = this.store.get(commit.archiveName);
    if (archive && stableJSON(archive) !== stableJSON(commit.archive)) throw new Error('Reward audit archive conflicts with pending commit');
    if (!archive) this.store.put(commit.archiveName, commit.archive);
    if (hash !== commit.afterHash) this.store.put(this.name, commit.nextState);
    this.store.put(`${this.name}-commit`, null);
    return structuredClone(commit.nextState);
  }
  save(state) { this.store.put(this.name, state); }
  summaryName(height) { return `${this.name}-block-${height}`; }

  accrue({ height, blockHash, previousHash, at, inventoryCertificate, bookCertificate, priceCertificate, headCertificate, settings, poolBalance }) {
    uint.parse(height); uint.parse(at); hex.parse(blockHash); hex.parse(previousHash); units.parse(poolBalance);
    const s = settingsSchema.parse(settings), inventoryFact = verifyCertificate(inventoryCertificate, this.context, 'inventory'),
      bookFact = verifyCertificate(bookCertificate, this.context, 'book'), priceFact = verifyCertificate(priceCertificate, this.context, 'price');
    const weights = rewardWeights({ inventory: inventoryFact.body, book: bookFact.body, price: priceFact.body, settings: s });
    if (headCertificate) {
      const head = verifyCertificate(headCertificate, this.context, 'reward-head').body;
      if (head.height !== height || head.blockHash !== blockHash || head.previousHash !== previousHash || head.at !== at ||
          head.policyId !== policyId(s) || head.inventoryDigest !== factDigest(inventoryFact) || head.bookDigest !== factDigest(bookFact) ||
          head.priceDigest !== factDigest(priceFact)) throw new Error('Reward head does not bind its source facts');
    }
    if (inventoryFact.body.height !== height || inventoryFact.body.blockHash !== blockHash) throw new Error('Wrong reward block');
    const inputHash = sha256Hex(stableJSON({ height, blockHash, previousHash, at, settings: s, poolBalance,
      inventory: factDigest(inventoryFact), book: factDigest(bookFact), price: factDigest(priceFact) }));
    const r = this.read(), beforeHash = sha256Hex(stableJSON(r)), existing = this.store.get(this.summaryName(height));
    if (r.height !== null && height <= r.height) {
      if (!existing || existing.inputHash !== inputHash) throw new Error('Reward block replay differs');
      return existing.summary;
    }
    // A height without a contemporaneous checkpoint is skipped and earns nothing, like time with an empty pool.
    if (r.height !== null && (height === r.height + 1 && previousHash !== r.blockHash || at < r.at)) throw new Error('Reward chain reorganization');
    const unpaid = Object.values(r.accounts).reduce((n, a) => n + BigInt(a.unpaid), 0n);
    // Integer atom rounding is spread over 144 consecutive Bitcoin heights, totaling exactly the daily budget.
    const daily = BigInt(s.rewards.dailyReset), h = BigInt(height);
    const budget = daily * (h + 1n) / 144n - daily * h / 144n;
    const totalWeight = weights.reduce((n, a) => n + BigInt(a.weight), 0n);
    const state = BigInt(poolBalance) - unpaid < budget ? 'empty' : totalWeight === 0n ? 'no_weight' : 'active';
    const allocations = weights.map(w => ({ address: w.address, amount: state === 'active' ? budget * BigInt(w.weight) / totalWeight : 0n,
      remainder: state === 'active' ? budget * BigInt(w.weight) % totalWeight : 0n }));
    if (state === 'active') {
      let left = budget - allocations.reduce((n, a) => n + a.amount, 0n);
      for (const a of [...allocations].sort((a, b) => a.remainder === b.remainder ? a.address.localeCompare(b.address) : a.remainder > b.remainder ? -1 : 1)) {
        if (left === 0n) break; a.amount++; left--;
      }
    }
    for (const a of allocations) if (a.amount > 0n) {
      const entry = r.accounts[a.address] ?? { unpaid: '0', paidTotal: '0', forfeited: '0', since: at };
      entry.unpaid = (BigInt(entry.unpaid) + a.amount).toString(); r.accounts[a.address] = entry;
    }
    const body = { height, blockHash, previousHash, at, inputHash, state, budget: budget.toString(), accrued: state === 'active' ? budget.toString() : '0',
      poolBalance, unpaidBefore: unpaid.toString(), totalWeight: totalWeight.toString(), weights,
      allocations: allocations.map(a => ({ address: a.address, amount: a.amount.toString() })),
      inventoryDigest: factDigest(inventoryFact), bookDigest: factDigest(bookFact), priceDigest: factDigest(priceFact) };
    const secret = typeof this.identity.secretKey === 'string' ? hexToBytes(this.identity.secretKey, 32) : this.identity.secretKey;
    const summary = { body, from: bytesToHex(ed25519.getPublicKey(secret)), sig: bytesToHex(ed25519.sign(summaryBytes(body), secret)) };
    if (existing && stableJSON(existing.summary) !== stableJSON(summary)) throw new Error('Uncommitted reward block differs');
    // One write-ahead record makes archive + head recoverable before any payout, forfeit or next block can run.
    const nextState = { ...r, height, blockHash, at, lastSummary: summary };
    this.store.put(`${this.name}-commit`, { beforeHash, afterHash: sha256Hex(stableJSON(nextState)), nextState,
      archiveName: this.summaryName(height), archive: { inputHash, summary, inventoryCertificate, bookCertificate, priceCertificate,
        ...(headCertificate ? { headCertificate } : {}), settings: s } });
    this.read(); return summary;
  }

  beginPayout(now, settings) {
    uint.parse(now); const s = settingsSchema.parse(settings), r = this.read();
    if (r.pending) return structuredClone(r.pending);
    const account = Object.keys(r.accounts).sort().find(address => {
      const a = r.accounts[address];
      if (Object.values(r.forfeits).some(f => f.address === address && f.state === 'pending')) return false;
      return BigInt(a.unpaid) > 0n && (BigInt(a.unpaid) >= BigInt(s.rewards.payoutMinReset) || now - (a.lastPayout?.atUnix ?? a.since) >= s.rewards.payoutIntervalSec);
    });
    if (!account) return null;
    const id = sha256Hex('intercom-dex/rewards/v1/payout\n' + stableJSON({ address: account, sequence: ++r.payoutSequence, networkId: this.context.networkId, venueKey: this.context.venueKey }));
    r.pending = { id, address: account, amount: r.accounts[account].unpaid, createdAt: now, phase: 'preparing' };
    this.save(r); return structuredClone(r.pending);
  }

  prepared(id, transfer) {
    const t = z.object({ txHash: hex, bytes: z.string().min(1).max(200000), amount: units, to: address, nonce: hex, feeTnk: units }).strict().parse(transfer);
    const r = this.read(), p = r.pending;
    if (!p || p.id !== id || t.amount !== p.amount || t.to !== p.address || t.nonce !== p.id) throw new Error('Payout intent mismatch');
    if (p.transfer && stableJSON(p.transfer) !== stableJSON(t)) throw new Error('Cannot replace a prepared payout');
    p.transfer = t; p.phase = 'prepared'; this.save(r); return structuredClone(p);
  }

  paid(id, { txHash, at }) {
    hex.parse(txHash); uint.parse(at); const r = this.read(), p = r.pending;
    if (!p || p.id !== id || p.transfer?.txHash !== txHash || at < p.createdAt) throw new Error('Unknown confirmed payout');
    const a = r.accounts[p.address];
    if (BigInt(a.unpaid) < BigInt(p.amount)) throw new Error('Payout exceeds accrual');
    a.unpaid = (BigInt(a.unpaid) - BigInt(p.amount)).toString(); a.paidTotal = (BigInt(a.paidTotal) + BigInt(p.amount)).toString();
    a.lastPayout = { amount: p.amount, tx: txHash, at: new Date(at * 1000).toISOString(), atUnix: at };
    for (const f of Object.values(r.forfeits).filter(f => f.state === 'pending' && f.payoutId === p.id)) {
      const sinceAward = BigInt(a.forfeited) - BigInt(f.forfeitedBefore);
      const remaining = BigInt(f.unpaidAtAward) - BigInt(p.amount) - sinceAward;
      const amount = remaining > 0n ? remaining : 0n;
      if (amount > BigInt(a.unpaid)) throw new Error('Forfeit exceeds remaining unpaid rewards');
      a.unpaid = (BigInt(a.unpaid) - amount).toString(); a.forfeited = (BigInt(a.forfeited) + amount).toString();
      f.amount = amount.toString(); f.state = 'complete';
    }
    a.since = at; r.pending = null; this.save(r); return structuredClone(a.lastPayout);
  }

  forfeit({ address: owner, decisionCertificate, inventoryCertificate, fundedCertificates, now }) {
    address.parse(owner); uint.parse(now);
    const epochId = decisionCertificate?.[0]?.fact.epochId;
    const context = epochId === this.context.epoch.id ? this.context : this.store.get(`stake-reward-context-${epochId}`);
    if (!context || context.networkId !== this.context.networkId || context.venueKey !== this.context.venueKey) throw new Error('Original reward award epoch required');
    const decision = verifyCertificate(decisionCertificate, context, 'decision');
    const body = terminalDecisionSchema.parse(decision.body);
    if (body.outcome !== 'buyer-no-show' || !body.reservationId || body.at > now) throw new Error('A certified seller penalty is required');
    if (fundedCertificates) {
      if (!Array.isArray(fundedCertificates) || fundedCertificates.length > 100) throw new Error('Original funding certificates required');
      const funded = fundedCertificates.map(c => verifyCertificate(c, context, 'funded').body);
      if (body.pieces.some(ref => !funded.some(p => p.unitId === ref.unitId && p.descriptor?.owner.tracAddr === owner && p.descriptor.purpose === 'seller'))) throw new Error('Penalty belongs to another stake owner');
    } else {
      const inventory = inventorySchema.parse(verifyCertificate(inventoryCertificate, context, 'inventory').body);
      const pieces = inventory.accounts.find(a => a.address === owner)?.pieces ?? [];
      if (body.pieces.some(ref => !pieces.some(p => p.unitId === ref.unitId && p.generation === ref.generation && p.purpose === 'seller'))) throw new Error('Penalty belongs to another stake owner');
    }
    const r = this.read(), id = factDigest(decision);
    if (r.forfeits[id]) return r.forfeits[id];
    const a = r.accounts[owner], amount = a?.unpaid ?? '0';
    if (r.pending?.address === owner && r.pending.transfer) {
      // Latch the award before returning. No further broadcasts are allowed while the known send is unresolved.
      // Remember this balance so rewards earned after the award are not forfeited when confirmation arrives.
      r.forfeits[id] = { address: owner, amount: '0', decisionDigest: id, state: 'pending', payoutId: r.pending.id,
        unpaidAtAward: amount, forfeitedBefore: a.forfeited };
      this.save(r); return structuredClone(r.forfeits[id]);
    }
    if (r.pending?.address === owner) r.pending = null; // No prepared bytes exist and nothing could be sent.
    if (a) { a.unpaid = '0'; a.forfeited = (BigInt(a.forfeited) + BigInt(amount)).toString(); }
    r.forfeits[id] = { address: owner, amount, decisionDigest: id, state: 'complete' }; this.save(r); return structuredClone(r.forfeits[id]);
  }

  status(owner, settings) {
    address.parse(owner); const r = this.read(), a = r.accounts[owner], summary = r.lastSummary?.body,
      w = summary?.weights.find(w => w.address === owner), s = settingsSchema.parse(settings);
    const total = BigInt(summary?.totalWeight ?? '0'), weight = BigInt(w?.weight ?? '0');
    return rewardsStatus({ unpaid: a?.unpaid ?? '0', paidTotal: a?.paidTotal ?? '0', lastPayout: a?.lastPayout, forfeited: a?.forfeited ?? '0',
      weight: weight === 0n ? 'none' : BigInt(w.activeReset) > 0n ? 'active' : 'idle',
      ratePerDay: total > 0n && summary.state === 'active' ? (BigInt(s.rewards.dailyReset) * weight / total).toString() : '0',
      poolState: summary ? summary.state === 'empty' ? 'empty' : 'active' : 'unknown', poolBalance: summary?.poolBalance ?? null,
      dailyBudget: s.rewards.dailyReset, activeWeightBps: s.rewards.activeWeightBps });
  }
}
