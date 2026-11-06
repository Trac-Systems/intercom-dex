import { z } from 'zod';
import { sha256Hex, stableJSON } from '../core/canonical.js';
import { encodeKey, identityPublic } from '../core/keys.js';
import { unitId } from './ledger.js';
import { usdForReset } from './amounts.js';
import { settingsSchema } from './settings.js';
import { signFact, verifyCertificate, factDigest } from './certificates.js';

const uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hex = z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/);
const units = z.string().regex(/^(0|[1-9][0-9]{0,30})$(?![\s\S])/);
const tokenSchema = z.object({ id: uint.min(1), generation: uint }).strict();
const rangeSchema = z.object({ from: units, to: units, generation: uint }).strict().refine(r => BigInt(r.to) > BigInt(r.from));
const rangesSchema = z.array(rangeSchema).min(1).max(4001).refine(a => a.every((r, i) => !i || BigInt(r.from) >= BigInt(a[i - 1].to)));
const grantUnit = z.object({ unitId: hex, ownerAddress: z.string(), principalReset: units, exposureUsd: units,
  globalToken: tokenSchema, addressToken: tokenSchema, globalRanges: rangesSchema, addressRanges: rangesSchema }).strict();
const grantSchema = z.object({ grantId: hex, units: z.array(grantUnit).min(1).max(100) }).strict();
const LIMITS = Object.freeze({ pieces: 2000, addressPieces: 200, usd: '10000000000000', depositUsd: '1000000000000' });
// Each address draws from its own USD interval up to the highest per-address cap a policy can sign; the signed cap
// limits what is used of it. Records written before 0.1.49 hold a $400 interval and the first, smaller limits.
const ADDRESS_POOL = '1000000000000', FIRST_ADDRESS_POOL = '400000000';
const limitSchema = z.object({ pieces: uint.min(1).max(LIMITS.pieces), addressPieces: uint.min(1).max(LIMITS.addressPieces),
  usd: units.refine(n => BigInt(n) > 0n && BigInt(n) <= BigInt(LIMITS.usd)),
  depositUsd: units.refine(n => BigInt(n) > 0n && BigInt(n) <= BigInt(LIMITS.depositUsd)) }).strict();
const contextSchema = z.object({ networkId: uint, venueKey: hex, epoch: z.object({ id: hex,
  members: z.array(z.object({ dexKey: hex, boxKey: hex }).strict()).length(4), n: z.literal(4), k: z.literal(3), maxFaulty: z.literal(1),
  startAt: uint, stopNewAt: uint.optional() }).strict() }).strict().refine(c => new Set(c.epoch.members.map(m => m.dexKey)).size === 4);
const epochDigest = epoch => { const { stopNewAt, ...identity } = epoch; return sha256Hex(stableJSON(identity)); };
export const capacityName = context => 'stake-capacity-' + sha256Hex(stableJSON({ networkId: context.networkId, venueKey: context.venueKey }));
export function assertEpochAdmission(store, context) {
  const state = store.get(capacityName(context));
  if (state && (state.handoff || state.epochId !== context.epoch.id || state.epochDigest !== epochDigest(context.epoch)))
    throw new Error('Capacity epoch is closed to new work');
}
const grantId = rows => sha256Hex('intercom-dex/stake/v1/capacity\n' + stableJSON(rows));
const total = ranges => ranges.reduce((n, r) => n + BigInt(r.to) - BigInt(r.from), 0n);
const pool = limit => [{ from: '0', to: limit, generation: 0 }];
const firstToken = (tokens, limit) => {
  for (let id = 1; id <= limit; id++) if (!tokens[id]?.unitId) return { id, generation: tokens[id]?.generation ?? 0 };
  throw new Error('bond_setup_unavailable');
};
const selectRanges = (free, amount, limit) => {
  let left = BigInt(amount); const ranges = [];
  for (const r of free) {
    if (!left) break;
    const from = BigInt(r.from), end = BigInt(r.to) < BigInt(limit) ? BigInt(r.to) : BigInt(limit);
    if (end <= from) continue;
    const count = end - from < left ? end - from : left;
    ranges.push({ from: r.from, to: (from + count).toString(), generation: r.generation }); left -= count;
  }
  if (left) throw new Error('bond_setup_unavailable');
  return ranges;
};
function consume(free, requested) {
  let remaining = structuredClone(free);
  for (const r of requested) {
    const index = remaining.findIndex(p => p.generation === r.generation && BigInt(p.from) <= BigInt(r.from) && BigInt(p.to) >= BigInt(r.to));
    if (index < 0) throw new Error('Capacity range is already held or its generation changed');
    const p = remaining[index], splits = [];
    if (p.from !== r.from) splits.push({ ...p, to: r.from });
    if (p.to !== r.to) splits.push({ ...p, from: r.to });
    remaining.splice(index, 1, ...splits);
  }
  return remaining;
}
function restore(free, released) {
  const all = [...free, ...released.map(r => ({ ...r, generation: uint.parse(r.generation + 1) }))]
    .sort((a, b) => BigInt(a.from) < BigInt(b.from) ? -1 : 1), result = [];
  for (const r of all) {
    const last = result.at(-1);
    if (last && BigInt(last.to) > BigInt(r.from)) throw new Error('Capacity release overlaps free ranges');
    if (last && last.to === r.from && last.generation === r.generation) last.to = r.to;
    else result.push(r);
  }
  return result;
}
function retireState(state, certificate, current) {
  const id = certificate?.[0]?.fact.body.unitId, piece = state.pieces[id];
  const origin = piece?.epochId ?? state.epochId;
  const context = origin === current.epoch.id ? current : state.predecessors?.[origin];
  if (!context) throw new Error('Original capacity epoch required');
  const fact = verifyCertificate(certificate, context, 'collected');
  z.object({ unitId: hex, generation: uint, decisionId: hex, txHash: hex.nullable(), asset: z.literal('TNK').optional() }).strict().parse(fact.body);
  const digest = factDigest(fact);
  if (!piece) throw new Error('Unknown capacity retirement');
  if (piece.retired) { if (piece.retirementDigest !== digest) throw new Error('Conflicting capacity retirement'); return piece; }
  const owner = state.owners[piece.ownerAddress];
  state.tokens[piece.globalToken.id] = { generation: uint.parse(piece.globalToken.generation + 1) };
  owner.tokens[piece.addressToken.id] = { generation: uint.parse(piece.addressToken.generation + 1) };
  state.free = restore(state.free, piece.globalRanges); owner.free = restore(owner.free, piece.addressRanges);
  piece.retired = true; piece.retirementDigest = digest; piece.retirementCertificate = certificate;
  return piece;
}

// Raising limits only adds free USD at the top of the venue and address intervals; held ranges, tokens and
// generations stay as they are. Lowering any limit still needs an epoch handoff.
function raiseLimits(state, limits) {
  const old = state.limits, oldPool = state.addressPool ?? FIRST_ADDRESS_POOL;
  if (stableJSON(old) === stableJSON(limits) && oldPool === ADDRESS_POOL) return state;
  if (!old || limits.pieces < old.pieces || limits.addressPieces < old.addressPieces || BigInt(limits.usd) < BigInt(old.usd) ||
      BigInt(limits.depositUsd) < BigInt(old.depositUsd) || BigInt(ADDRESS_POOL) < BigInt(oldPool)) throw new Error('Capacity lease handoff required');
  const next = structuredClone(state);
  if (BigInt(limits.usd) > BigInt(old.usd)) next.free.push({ from: old.usd, to: limits.usd, generation: 0 });
  if (BigInt(ADDRESS_POOL) > BigInt(oldPool)) for (const owner of Object.values(next.owners)) owner.free.push({ from: oldPool, to: ADDRESS_POOL, generation: 0 });
  next.limits = structuredClone(limits); next.addressPool = ADDRESS_POOL;
  return next;
}

// A single atomic record serializes numbered count tokens and exact USD intervals across every owner.
// A handoff transfers the complete capacity map, including all held and pending
// units. Original custody stays with its original committee; it never resets caps.
export class CapacityLedger {
  constructor({ store, context, identity, limits = LIMITS }) {
    if (!store?.get || !store?.put || !context.epoch.members.some(m => m.dexKey === identity?.publicKey)) throw new Error('Capacity requires a pinned signer and durable store');
    if (context.epoch.n !== 4 || context.epoch.k !== 3 || context.epoch.maxFaulty !== 1 || context.epoch.members.length !== 4 ||
        new Set(context.epoch.members.map(m => m.dexKey)).size !== 4 || encodeKey(identityPublic(identity.secretKey)) !== identity.publicKey)
      throw new Error('Invalid capacity signer or epoch');
    this.store = store; this.context = structuredClone(context); this.identity = identity; this.limits = limitSchema.parse(limits);
    this.epochDigest = epochDigest(context.epoch);
    this.name = capacityName(context);
  }
  read() {
    const state = this.store.get(this.name) ?? { epochId: this.context.epoch.id, epochDigest: this.epochDigest, limits: this.limits, tokens: {},
      free: pool(this.limits.usd), owners: {}, pieces: {}, grants: {}, addressPool: ADDRESS_POOL };
    if (state.epochId !== this.context.epoch.id || state.epochDigest !== this.epochDigest) throw new Error('Capacity lease handoff required');
    return raiseLimits(state, this.limits);
  }
  owner(state, address) { return state.owners[address] ??= { tokens: {}, free: pool(state.addressPool ?? FIRST_ADDRESS_POOL) }; }
  inputs(descriptors, { settings, price, now }) {
    assertEpochAdmission(this.store, this.context);
    uint.parse(now); const s = settingsSchema.parse(settings);
    if (now < this.context.epoch.startAt || this.context.epoch.stopNewAt !== undefined && now >= this.context.epoch.stopNewAt)
      throw new Error('Capacity epoch is closed to new work');
    if (!Array.isArray(descriptors) || !descriptors.length || descriptors.length > 100) throw new Error('Invalid capacity batch');
    const rows = descriptors.map(d => {
      const id = unitId(d);
      if (d.networkId !== this.context.networkId || d.venueKey !== this.context.venueKey || d.epochId !== this.context.epoch.id || d.createdAt > now || d.expiresAt <= now)
        throw new Error('Capacity descriptor scope differs');
      return { unitId: id, ownerAddress: d.owner.tracAddr, principalReset: d.principalReset, exposureUsd: usdForReset(d.principalReset, price, true) };
    }).sort((a, b) => a.unitId.localeCompare(b.unitId));
    if (new Set(rows.map(r => r.unitId)).size !== rows.length || new Set(rows.map(r => r.ownerAddress)).size !== 1) throw new Error('Capacity batch must have unique pieces and one address');
    if (rows.reduce((n, r) => n + BigInt(r.exposureUsd), 0n) > BigInt(this.limits.depositUsd)) throw new Error('bond_setup_unavailable');
    return { rows, settings: s, price };
  }
  apply(state, rows, verified) {
    const { settings, price } = verified, address = rows[0].ownerAddress;
    const active = Object.values(state.pieces).filter(p => !p.retired);
    const added = rows.reduce((n, p) => n + BigInt(p.exposureUsd), 0n);
    const marked = list => list.reduce((n, p) => n + BigInt(usdForReset(p.principalReset, price, true)), 0n);
    const admitted = list => list.reduce((n, p) => n + BigInt(p.exposureUsd), 0n);
    const own = active.filter(p => p.ownerAddress === address), cap = BigInt(settings.stake.maxUsdPerAddress);
    if (marked(active) + added > BigInt(this.limits.usd) || admitted(active) + added > BigInt(this.limits.usd) ||
        marked(own) + added > cap || admitted(own) + added > cap) throw new Error('bond_setup_unavailable');
    for (const row of rows) {
      if (state.pieces[row.unitId]) throw new Error('Stake capacity already exists or is retired');
      const owner = this.owner(state, row.ownerAddress);
      for (const [token, map, max] of [[row.globalToken, state.tokens, this.limits.pieces], [row.addressToken, owner.tokens, this.limits.addressPieces]]) {
        if (token.id > max || map[token.id]?.unitId || token.generation !== (map[token.id]?.generation ?? 0)) throw new Error('Capacity token conflict');
        map[token.id] = { generation: token.generation, unitId: row.unitId };
      }
      if (total(row.globalRanges) !== BigInt(row.exposureUsd) || total(row.addressRanges) !== BigInt(row.exposureUsd) ||
          row.addressRanges.some(r => BigInt(r.to) > cap)) throw new Error('Capacity exposure mismatch');
      state.free = consume(state.free, row.globalRanges); owner.free = consume(owner.free, row.addressRanges);
      state.pieces[row.unitId] = { ...row, retired: false };
    }
    return state;
  }
  propose(descriptors, options) {
    const verified = this.inputs(descriptors, options), state = this.read(), rows = [];
    for (const input of verified.rows) {
      const owner = this.owner(state, input.ownerAddress), row = { ...input, globalToken: firstToken(state.tokens, this.limits.pieces),
        addressToken: firstToken(owner.tokens, this.limits.addressPieces), globalRanges: selectRanges(state.free, input.exposureUsd, this.limits.usd),
        addressRanges: selectRanges(owner.free, input.exposureUsd, verified.settings.stake.maxUsdPerAddress) };
      // Simulate this choice before selecting another unit. The durable vote validates the whole batch again.
      state.tokens[row.globalToken.id] = { ...row.globalToken, unitId: row.unitId }; owner.tokens[row.addressToken.id] = { ...row.addressToken, unitId: row.unitId };
      state.free = consume(state.free, row.globalRanges); owner.free = consume(owner.free, row.addressRanges); rows.push(row);
    }
    this.apply(this.read(), rows, verified);
    return { grantId: grantId(rows), units: rows };
  }
  vote(input, descriptors, options) {
    assertEpochAdmission(this.store, this.context);
    const body = grantSchema.parse(input), state = this.read();
    if (body.grantId !== grantId(body.units)) throw new Error('Capacity grant differs from descriptors or price');
    const fact = { v: 1, networkId: this.context.networkId, venueKey: this.context.venueKey, epochId: this.context.epoch.id, kind: 'capacity', body };
    const prior = state.grants[body.grantId];
    if (prior) {
      if (prior.digest !== factDigest(fact) || body.units.some(u => state.pieces[u.unitId]?.retired)) throw new Error('Capacity grant is retired or conflicting');
    } else {
      const verified = this.inputs(descriptors, options);
      if (stableJSON(body.units.map(({ unitId, ownerAddress, principalReset, exposureUsd }) => ({ unitId, ownerAddress, principalReset, exposureUsd }))) !==
          stableJSON(verified.rows)) throw new Error('Capacity grant differs from descriptors or price');
      this.apply(state, body.units, verified);
      state.grants[body.grantId] = { digest: factDigest(fact), body };
      this.store.put(this.name, state);
    }
    return signFact(fact, this.identity.secretKey);
  }
  handoffVote(nextInput, now) {
    const next = contextSchema.parse(nextInput); uint.parse(now);
    if (next.networkId !== this.context.networkId || next.venueKey !== this.context.venueKey || next.epoch.id === this.context.epoch.id ||
        this.context.epoch.stopNewAt === undefined || now < this.context.epoch.stopNewAt || next.epoch.startAt < this.context.epoch.stopNewAt)
      throw new Error('A stopped original epoch and a distinct successor are required');
    const state = this.read();
    if (state.handoff) {
      if (stableJSON(state.handoff.body.next) !== stableJSON(next)) throw new Error('Capacity handoff already fixed');
      return signFact(state.handoff.fact, this.identity.secretKey);
    }
    const snapshot = structuredClone(state);
    for (const piece of Object.values(snapshot.pieces)) piece.epochId ??= this.context.epoch.id;
    const body = { next, state: snapshot }, fact = { v: 1, networkId: this.context.networkId, venueKey: this.context.venueKey,
      epochId: this.context.epoch.id, kind: 'capacity-handoff', body };
    // A certificate repeats this body in three/four signatures. Refuse before
    // freezing when the existing authenticated transport cannot carry it.
    if (Buffer.byteLength(stableJSON(fact)) > 40000) throw new Error('Capacity handoff requires paginated reconciliation');
    // The old epoch irrevocably stops granting before any release vote escapes.
    state.handoff = { body, fact }; this.store.put(this.name, state);
    return signFact(fact, this.identity.secretKey);
  }
  adoptHandoff(certificate, previousInput) {
    const previous = contextSchema.parse(previousInput), fact = verifyCertificate(certificate, previous, 'capacity-handoff');
    const { next, state: snapshot } = fact.body, digest = factDigest(fact);
    if (stableJSON(contextSchema.parse(next)) !== stableJSON(this.context) || previous.epoch.id === this.context.epoch.id ||
        previous.networkId !== this.context.networkId || previous.venueKey !== this.context.venueKey ||
        snapshot.epochId !== previous.epoch.id || snapshot.epochDigest !== epochDigest(previous.epoch) ||
        stableJSON(snapshot.limits) !== stableJSON(this.limits) || snapshot.handoff)
      throw new Error('Capacity handoff scope differs');
    const existing = this.store.get(this.name);
    if (existing?.handoffs?.[previous.epoch.id]) {
      if (existing.handoffs[previous.epoch.id].digest !== digest) throw new Error('Conflicting capacity handoff');
      return this.read();
    }
    const reconciled = structuredClone(snapshot);
    if (existing) {
      const local = structuredClone(existing); delete local.handoff;
      for (const piece of Object.values(local.pieces)) piece.epochId ??= previous.epoch.id;
      // Original collections can finish between the freeze vote and adoption.
      // Carry only certified retirements; no other local divergence is safe.
      for (const piece of Object.values(local.pieces)) {
        if (piece.retired && reconciled.pieces[piece.unitId] && !reconciled.pieces[piece.unitId].retired)
          retireState(reconciled, piece.retirementCertificate, previous);
      }
      if (stableJSON(local) !== stableJSON(reconciled)) throw new Error('Local capacity obligations differ; reconcile before handoff');
    }
    const state = { ...reconciled, epochId: this.context.epoch.id, epochDigest: this.epochDigest,
      predecessors: { ...snapshot.predecessors, [previous.epoch.id]: previous },
      handoffs: { ...snapshot.handoffs, [previous.epoch.id]: { digest, certificate } } };
    this.store.put(this.name, state); return this.read();
  }
  retire(certificate) {
    // Original members can finalize an old collection even when an overlapping
    // member has already adopted the successor capacity map.
    const state = this.store.get(this.name) ?? this.read();
    if (state.epochId !== this.context.epoch.id &&
        epochDigest(state.predecessors?.[this.context.epoch.id]?.epoch ?? {}) !== this.epochDigest) throw new Error('Original capacity epoch required');
    const piece = retireState(state, certificate, this.context);
    this.store.put(this.name, state); return structuredClone(piece);
  }
}
