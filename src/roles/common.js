import { existsSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { sha256Hex, stableJSON } from '../core/canonical.js';
import { readPrivateFile } from './keyring.js';
import { open, createReplayCache } from '../core/envelope.js';
import { registrySchema } from '../core/schemas.js';
import { tradeId as termsTradeId, validateTerms } from '../core/terms.js';
import { selectCommittee } from '../core/committee.js';
import { quoteAmount, registryPair } from '../market/assets.js';
import { meetsVersion } from '../core/software.js';
import { checkProfileRegistry } from '../net/profile-core.js';
import { validAddressProof, validTermsAddressProofs } from '../core/address-proof.js';

// An offer id is the hash of the offer's content, so one id always means one maker, price, size and expiry.
export function offerIdOf({ pair, side, baseAmount, price, maker, peerKey, expiresAt, registryVersion, software }) {
  return sha256Hex(stableJSON({ v: 'intercom-dex/v1/offer', pair, side, baseAmount, price, maker, peerKey, expiresAt, registryVersion, software }));
}

export const validOffer = (offer, from, policy = { required: false }) => offer.maker.dexKey === from &&
  offer.offerId === offerIdOf(offer) && validAddressProof(offer.maker, { ...policy, validUntil: offer.expiresAt });

// A local access token (bridge, control API) in a private 0600 file, created on first use. Never printed. Keys are
// not kept like this; they live in the role's encrypted keyring (keyring.js).
export function secretFile(path) {
  if (!existsSync(path)) {
    const fd = openSync(path, 'wx', 0o600);
    try { writeSync(fd, randomBytes(32).toString('hex')); fsyncSync(fd); } finally { closeSync(fd); }
  }
  const hex = readPrivateFile(path, 256).trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`Invalid token file ${path}`);
  return hex;
}

export const nowSec = () => Math.floor(Date.now() / 1000);
export const random32 = () => randomBytes(32).toString('hex');

// Verifies messages on the public dex channels (two-minute window). Each sender first spends its own quota, so one
// key cannot fill the receiver's shared replay cache.
export const PUBLIC_PER_SENDER = 512;
export function publicReceiver(now = nowSec) {
  const seen = createReplayCache({ maxEntries: 65536 }), senders = new Map();   // key -> {cache, until}, least recent first
  return message => {
    try {
      const t = now();
      for (const [key, sender] of senders) { if (sender.until >= t) break; senders.delete(key); }
      const sender = senders.get(message?.from) ?? { cache: createReplayCache({ maxEntries: PUBLIC_PER_SENDER }), until: 0 };
      const m = open(message, { now: t, seen: sender.cache });
      seen.consume(m.from + ':' + m.nonce, m.ts + 120, t);
      senders.delete(m.from); senders.set(m.from, { cache: sender.cache, until: Math.max(sender.until, m.ts + 120) });
      return m;
    } catch { return null; }
  };
}

// Keeps the newest registry the service signed (registry messages on intercom-dex from the service key). The accepted
// version and every accepted snapshot are stored, so a restart never goes back to an older one. Two different
// registries under one version mean the service equivocated: `usable` is then null and no new trade starts.
export class RegistryView {
  #latest;

  constructor(serviceKey, store = null, log = () => {}, profile = null) {
    Object.assign(this, { serviceKey, store, log, profile });
    this.current = store?.get('registry-current') ?? null;
    this.conflict = store?.get('registry-conflict') ?? null;
    this.conflictStored = this.conflict !== null;
    this.digests = store?.get('registry-digests') ?? null;
    if (!this.digests) {
      // Digests of every snapshot still on disk (stores written before digests existed).
      this.digests = {};
      for (const name of store?.list('registry-v') ?? []) { const r = store.get(name); if (r) this.digests[r.version] = sha256Hex(stableJSON(r)); }
      if (this.current) this.digests[this.current.version] = sha256Hex(stableJSON(this.current));
    }
    this.#latest = this.current;
    this.current = this.#checked(this.current);
  }

  get usable() { return this.conflict ? null : this.current; }

  #checked(registry) {
    if (!registry || !this.profile) return registry;
    try { checkProfileRegistry(registry, this.profile); return registry; }
    catch (error) {
      if (!this.profileWarning) { this.profileWarning = true; this.log('registry ignored', error.message); }
      return null;
    }
  }

  offer(message, now = nowSec()) {
    if (message.kind !== 'registry' || message.from !== this.serviceKey) return false;
    const registry = registrySchema.parse(message.body), cur = this.#latest;
    if (!this.#checked(registry)) return false;
    if (registry.issuedAt > now + 60) return false;
    // Every accepted version's digest is kept for good (snapshots only for the last 50), so a second, different
    // registry under any earlier version is caught too.
    const digest = sha256Hex(stableJSON(registry)), known = this.digests[registry.version];
    if (known && known !== digest && !this.conflict) {
      this.conflict = { version: registry.version, at: now };   // trading pauses at once, stored or not
      this.conflictStored = false;
      this.log('registry equivocation at version', registry.version);
    }
    if (this.conflict && !this.conflictStored && this.store) {
      this.store.put('registry-conflict', this.conflict);       // retried with every registry message until stored
      this.conflictStored = true;
    }
    if (cur && (registry.version <= cur.version || registry.issuedAt < cur.issuedAt)) return false;
    // Stored first: a registry that could not be persisted is not used (the next copy of it is tried again).
    const digests = { ...this.digests, [registry.version]: digest };
    if (this.store) {
      this.store.put('registry-digests', digests);
      this.store.put(`registry-v${registry.version}`, registry);
      this.store.put('registry-current', registry);
    }
    this.current = registry;
    this.#latest = registry;
    this.digests = digests;
    if (this.store) {
      for (const name of this.store.list('registry-v')) if (Number(name.slice(10)) <= registry.version - 50) this.store.delete(name);
    }
    return true;
  }

  snapshot(version) {
    if (this.current?.version === version) return this.current;
    return this.#checked(this.store?.get(`registry-v${version}`) ?? null);
  }
}

// Terms follow a registry snapshot when they name it, use its threshold, dimensions, grace and every fee field, and
// their committee is exactly the one it selects for the trade's randomness.
export function checkTermsAgainstRegistry(terms, registry) {
  if (!registry || registry.version !== terms.registryVersion) throw new Error('Unknown registry version');
  const pair = registryPair(registry, terms.pair);
  if (stableJSON(terms.base) !== stableJSON(pair.base) || BigInt(terms.baseAmount) < BigInt(pair.minBaseAmount)) throw new Error('Terms do not follow the registry pair');
  const p = registry.params, f = registry.fee;
  if (terms.k !== p.k || terms.committee.length !== p.n || terms.graceSec !== p.graceSec ||
      terms.fees.platformFeeBps !== f.platformFeeBps || terms.fees.tradeFeeBps !== f.tradeFeeBps || terms.fees.signerShareBps !== f.signerShareBps || terms.fees.collector !== f.collector) {
    throw new Error('Terms do not follow the registry');
  }
  const expected = selectCommittee(registry, terms.R, { n: p.n, k: p.k, quoteAmount: terms.quoteAmount, pair: terms.pair,
    exclude: [terms.buyer.dexKey, terms.seller.dexKey] }).map(({ dexKey, boxKey }) => ({ dexKey, boxKey }));
  if (stableJSON(expected) !== stableJSON(terms.committee)) throw new Error('Committee is not the registry selection');
}

// A summon is only valid for terms both traders signed that follow the registry snapshot they name, and only while
// the trade can still lock: sendBy lies within one send window (plus clock skew) from now, and refundAfter keeps the
// registry's distance from it.
export const SUMMON_SKEW_SEC = 120;
export function verifySummon(body, registry, now, addressProof = { required: false }) {
  const terms = validateTerms(body.terms), id = body.tradeId;
  if (!validTermsAddressProofs(terms, { ...addressProof, now })) throw new Error('Invalid Trac address proof');
  if (termsTradeId(terms) !== id) throw new Error('Trade id does not match terms');
  checkTermsAgainstRegistry(terms, registry);
  const p = registry.params;
  if (terms.sendBy <= now || terms.sendBy > now + p.sendWindowSec + SUMMON_SKEW_SEC ||
      terms.refundAfter - terms.sendBy !== p.refundSec - p.sendWindowSec) throw new Error('Summon deadlines outside the registry window');
  const lifetimeSec = terms.refundAfter - now + 3600;
  const seen = createReplayCache(), signed = new Set(), sigs = [];
  for (const raw of body.sigs) {
    const sig = open(raw, { now, seen, maxAgeSec: Math.max(120, lifetimeSec) });
    if (sig.kind !== 'termsSig' || sig.body.tradeId !== id || sig.ch !== `intercom-dex:t:${id}`) throw new Error('Invalid terms signature');
    signed.add(sig.from); sigs.push(sig);
  }
  if (!signed.has(terms.buyer.dexKey) || !signed.has(terms.seller.dexKey)) throw new Error('Terms not signed by both traders');
  return { terms, tradeId: id, sigs, lifetimeSec };
}

// The draft both traders build independently from the same offer, take and registry. The committee and R are
// placeholders here; negotiation replaces them.
export function buildDraft({ offer, baseAmount, maker, taker, registry, sendBy, refundAfter, mint, platformCollector }) {
  const pair = registryPair(registry, offer.pair);
  if (offer.registryVersion !== registry.version || BigInt(baseAmount) < BigInt(pair.minBaseAmount)) throw new Error('Invalid registry pair or amount');
  const makerSells = offer.side === 'sell';
  const seller = makerSells ? maker : taker, buyer = makerSells ? taker : maker;
  const quote = quoteAmount(pair, baseAmount, offer.price);
  const placeholder = registry.signers.filter(s => s.status === 'active' && s.assets.includes(pair.base.id) && meetsVersion(s.software, registry.minSoftware) &&
    BigInt(s.limitUsdc) >= BigInt(quote) && ![seller.dexKey, buyer.dexKey].includes(s.dexKey))
    .slice(0, registry.params.n).map(({ dexKey, boxKey }) => ({ dexKey, boxKey }));
  if (placeholder.length < registry.params.n) throw new Error('Not enough active signers');
  return {
    offerId: offer.offerId, pair: offer.pair, base: pair.base, baseAmount, quoteAmount: quote, mint,
    seller: { dexKey: seller.dexKey, tracAddr: seller.tracAddr, solRecipient: seller.solAddr,
      ...(seller.tracProof ? { tracProof: seller.tracProof } : {}) },
    buyer: { dexKey: buyer.dexKey, tracAddr: buyer.tracAddr, solPayer: buyer.solAddr,
      ...(buyer.tracProof ? { tracProof: buyer.tracProof } : {}) },
    registryVersion: registry.version, committee: placeholder, k: registry.params.k,
    fees: { platformFeeBps: registry.fee.platformFeeBps, tradeFeeBps: registry.fee.tradeFeeBps, signerShareBps: registry.fee.signerShareBps,
      collector: registry.fee.collector, platformCollector },
    sendBy, refundAfter, graceSec: registry.params.graceSec, R: '0'.repeat(64),
  };
}
