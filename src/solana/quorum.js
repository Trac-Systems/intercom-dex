import { createHash } from 'node:crypto';
import { DEFAULT_ENDPOINTS, DEFAULT_SLOT_TOLERANCE } from './constants.js';
import { readAccount } from './rpc.js';

// The message names what each reader answered, so an operator can see which endpoint failed and how.
const describe = reports => reports.map(r => `${new URL(r.endpoint).host}: ${r.status}${r.slot !== undefined ? ` at slot ${r.slot}` : ''}${r.message ? ` (${r.message})` : ''}`).join('; ');

export class QuorumError extends Error {
  constructor(message, reports) {
    super(reports?.length ? `${message}: ${describe(reports)}` : message);
    this.name = 'QuorumError';
    this.reports = reports;
  }
}

function fingerprint(value) {
  if (value === null) return 'missing';
  return createHash('sha256').update(JSON.stringify([
    value.owner, value.lamports, value.executable, value.data.toString('base64'),
  ])).digest('hex');
}

export async function readAccountQuorum(address, {
  endpoints = DEFAULT_ENDPOINTS, need = 2, timeoutMs = 5000,
  slotTolerance = DEFAULT_SLOT_TOLERANCE, minContextSlot, commitment = 'confirmed', unanimous = false,
} = {}) {
  if (!Array.isArray(endpoints) || endpoints.length === 0) throw new TypeError('Endpoints required');
  const normalized = endpoints.map(endpoint => {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.hash || url.username || url.password) throw new TypeError('Invalid RPC URL');
    return url.href;
  });
  if (new Set(normalized).size !== endpoints.length) throw new TypeError('Duplicate RPC endpoints');
  if (!Number.isSafeInteger(need) || need < 1 || need > endpoints.length) throw new RangeError('Invalid quorum need');
  if (!Number.isSafeInteger(slotTolerance) || slotTolerance < 0) throw new RangeError('Invalid slotTolerance');
  const results = await Promise.allSettled(normalized.map(endpoint => readAccount(endpoint, address, { timeoutMs, minContextSlot, commitment })));
  const slots = results.filter(r => r.status === 'fulfilled').map(r => r.value.slot);
  // Freshness is judged against the highest slot that a majority of the responders (and at least need) reached, so
  // readers that report a far-ahead slot cannot turn the others stale.
  const newestSlot = slots.sort((a, b) => b - a)[Math.max(need, Math.floor(slots.length / 2) + 1) - 1];
  const groups = new Map();
  const reports = results.map((result, i) => {
    const endpoint = normalized[i];
    if (result.status === 'rejected') return { endpoint, status: 'error', kind: result.reason.kind ?? 'input', message: result.reason.message };
    const { slot, value } = result.value;
    const digest = fingerprint(value);
    if (newestSlot - slot > slotTolerance) return { endpoint, slot, digest, status: 'stale' };
    const group = groups.get(digest) ?? [];
    group.push({ endpoint, slot, value });
    groups.set(digest, group);
    return { endpoint, slot, digest, status: 'disagreed' };
  });
  const winners = [...groups.entries()].filter(([, values]) => values.length >= need);
  if (winners.length !== 1) throw new QuorumError(winners.length ? 'Ambiguous account quorum' : 'No fresh account quorum', reports);
  const [digest, agreeing] = winners[0];
  // Safety reads also fail when any reader that answered, stale or not, saw something else.
  if (unanimous && reports.some(r => r.status !== 'error' && r.digest !== digest)) throw new QuorumError('Account readers disagree', reports);
  for (const report of reports) if (report.status === 'disagreed' && report.digest === digest) report.status = 'agreed';
  const slot = agreeing.map(r => r.slot).sort((a, b) => b - a)[need - 1];
  return { value: agreeing[0].value, slot, newestSlot, agreeing: agreeing.map(r => r.endpoint), reports };
}
