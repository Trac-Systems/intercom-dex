import { z } from 'zod';
import { sha256Hex, stableJSON } from '../core/canonical.js';
import { settingsSchema } from './settings.js';
import { verifyCertificate, factDigest } from './certificates.js';
import { rewardWeights, verifyRewardSummary } from './rewards.js';

const uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hex = z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/);
const units = z.string().regex(/^(0|[1-9][0-9]{0,30})$(?![\s\S])/);
const blockSchema = z.object({ height: uint, blockHash: hex, previousHash: hex, at: uint }).strict();

// A public audit needs no payout secret or wallet. The caller independently establishes the block,
// effective signed settings, confirmed pool balance and unpaid liabilities (including payouts/forfeits).
// A signature authenticates the publisher; this check also reproduces the block's arithmetic and facts.
export function auditRewardBlock({ summary, payoutKey, context, block, settings, poolBalance, unpaidBefore,
  inventoryCertificate, bookCertificate, priceCertificate }) {
  if (!verifyRewardSummary(summary, payoutKey)) throw new Error('Invalid reward summary signature');
  const head = blockSchema.parse(block), policy = settingsSchema.parse(settings);
  units.parse(poolBalance); units.parse(unpaidBefore);
  const inventory = verifyCertificate(inventoryCertificate, context, 'inventory'),
    book = verifyCertificate(bookCertificate, context, 'book'), price = verifyCertificate(priceCertificate, context, 'price');
  const weights = rewardWeights({ inventory: inventory.body, book: book.body, price: price.body, settings: policy });
  if (inventory.body.height !== head.height || inventory.body.blockHash !== head.blockHash) throw new Error('Wrong audited reward block');
  const inventoryDigest = factDigest(inventory), bookDigest = factDigest(book), priceDigest = factDigest(price);
  const inputHash = sha256Hex(stableJSON({ ...head, settings: policy, poolBalance,
    inventory: inventoryDigest, book: bookDigest, price: priceDigest }));
  const height = BigInt(head.height), daily = BigInt(policy.rewards.dailyReset);
  const budget = daily * (height + 1n) / 144n - daily * height / 144n;
  const totalWeight = weights.reduce((n, w) => n + BigInt(w.weight), 0n);
  const state = BigInt(poolBalance) - BigInt(unpaidBefore) < budget ? 'empty' : totalWeight === 0n ? 'no_weight' : 'active';
  const allocations = weights.map(w => ({ address: w.address, amount: state === 'active' ? budget * BigInt(w.weight) / totalWeight : 0n,
    remainder: state === 'active' ? budget * BigInt(w.weight) % totalWeight : 0n }));
  if (state === 'active') {
    let remainder = budget - allocations.reduce((n, a) => n + a.amount, 0n);
    const order = [...allocations].sort((a, b) => a.remainder === b.remainder ? a.address.localeCompare(b.address) : a.remainder > b.remainder ? -1 : 1);
    for (const a of order) { if (!remainder) break; a.amount++; remainder--; }
    if (remainder) throw new Error('Reward rounding did not conserve atoms');
  }
  const expected = { ...head, inputHash, state, budget: budget.toString(), accrued: state === 'active' ? budget.toString() : '0',
    poolBalance, unpaidBefore, totalWeight: totalWeight.toString(), weights,
    allocations: allocations.map(a => ({ address: a.address, amount: a.amount.toString() })), inventoryDigest, bookDigest, priceDigest };
  if (stableJSON(summary.body) !== stableJSON(expected)) throw new Error('Reward summary differs from independently supplied facts');
  return structuredClone(expected);
}
