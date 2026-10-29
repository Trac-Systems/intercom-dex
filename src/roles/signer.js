import { RegistryRelays } from '../net/relays.js';
import { createSigner, rescueTrade } from '../core/trade-signer.js';
import { TradeHost, isFinished } from './host.js';
import { RegistryView, publicReceiver, nowSec, verifySummon } from './common.js';

import { SOFTWARE, meetsVersion } from '../core/software.js';
import { registryPair, pairStatus } from '../market/assets.js';
import { checkProfileTerms } from '../net/profile.js';
import { SellerStrikes, BuyerStrikes, strikeSettings } from './signer-strikes.js';
import { addressProofRequired } from '../core/address-proof.js';
import { buyerPauseText } from '../market/buyer-pauses.js';

const MAIN = 'intercom-dex', SIGNERS = 'intercom-dex:signers';
// Unfinished trades a signer holds at once, in total and per trader key (buyer or seller). Summons beyond them are
// refused; buyers repeat summons, so a refused trade is taken once a slot frees.
export const MAX_HELD_TRADES = 32, MAX_HELD_PER_TRADER = 8;
// Released traders and venues keep a heartbeat fresh for 90 s.
export const HEARTBEAT_MS = 30_000;
// Fits the public-channel traffic budget even when every signer drains maximum-length pause notices.
export const BUYER_PAUSES_PER_BEAT = 3;
// Trades on offers posted under an earlier registry stay possible this long after that registry was replaced.
export const OLD_REGISTRY_SEC = 31 * 86400;

// A committee signer: joins trades it is summoned to (only when it is really in the signed terms' committee and the
// registry it trusts lists it), holds its encrypted share, verifies the seller's transfer on its own node, publishes.
export class Signer {
  constructor({ bridge, identity, box, store, trac, solana = null, serviceKey, profile = null, strikes, log = console.log }) {
    Object.assign(this, { bridge, identity, box, store, serviceKey, profile, log });
    this.strikes = new SellerStrikes({ store, log, ...strikeSettings(strikes) });
    this.buyerStrikes = new BuyerStrikes({ store, log, ...strikeSettings(strikes) });
    this.strikeHeartbeats = new Map();
    this.host = new TradeHost({ bridge, identity, store, solana: null, trac, profile, serviceKey, log,
      addressProofRequired: () => !this.registry.usable || addressProofRequired(this.registry.usable),
      signerStrikes: this.strikes, buyerStrikes: this.buyerStrikes, signerSolana: solana,
      buyerStrikeHealth: terms => this.#buyerHealth(terms) });
    this.registry = new RegistryView(serviceKey, store, log, profile);
    this.relays = new RegistryRelays(bridge);
    this.receive = publicReceiver();
  }

  async start() {
    this.log(`seller and buyer strikes ${this.strikes.enabled ? 'enabled' : 'disabled'}`);
    this.#rescue(process.env.DEX_RESCUE_TRADES);
    await this.relays.update(this.registry.usable);
    for (const ch of [MAIN, SIGNERS]) await this.bridge.join(ch);
    this.host.hooks.unrouted.push((ch, m) => this.#public(ch, m));
    await this.host.start();
    this.heartbeat = setInterval(() => this.#beat(), HEARTBEAT_MS);
  }

  stop() { this.host.stop(); clearInterval(this.heartbeat); }

  listSellerStrikes() { return { ...this.strikes.list(nowSec()), buyers: this.buyerStrikes.list(nowSec()) }; }
  clearSellerStrikes(seller) { return this.host.clearSellerStrikes(seller); }
  async clearBuyerStrikes(buyer) {
    const result = this.host.clearBuyerStrikes(buyer);
    await this.publishingBuyerPauses; await this.#publishBuyerPauses(); return result;
  }

  #buyerHealth(terms) {
    const now = nowSec();
    if (now - (this.venueHeardAt ?? -Infinity) > 90 || !this.registry.usable) return false;
    return terms.committee.filter(s => this.registry.usable.signers.some(member => member.dexKey === s.dexKey && member.status === 'active') &&
      !this.registry.usable.removed.some(r => r.dexKey === s.dexKey) && now - (s.dexKey === this.identity.publicKey ? this.lastHeartbeatAt ?? -Infinity :
      this.strikeHeartbeats.get(s.dexKey) ?? -Infinity) <= 90).length >= terms.k;
  }

  #publishBuyerPauses() {
    this.publishingBuyerPauses ??= this.#sendBuyerPauses().finally(() => { this.publishingBuyerPauses = null; });
    return this.publishingBuyerPauses;
  }

  async #sendBuyerPauses() {
    const now = nowSec(), prior = this.store.get('buyer-pause-announcements') ?? [];
    const active = this.buyerStrikes.enabled ? this.buyerStrikes.list(now).refusals : [];
    const previous = new Map(prior.map(p => [p.tracAddr, p]));
    const entries = [...active.map(r => ({ ...previous.get(r.tracAddr), ...r, retainUntil: r.until })), ...prior.filter(p => p.retainUntil > now &&
      !active.some(r => r.tracAddr === p.tracAddr)).map(p => ({ ...p, until: 0 }))];
    // Save clears before sending; failed delivery or a restart retries them along with active refusals.
    this.store.put('buyer-pause-announcements', entries);
    const priority = r => r.announcedUntil === r.until ? 2 : r.until === 0 ? 0 : 1;
    const due = [...entries].sort((a, b) => priority(a) - priority(b) || (a.announcedAt ?? 0) - (b.announcedAt ?? 0));
    for (const r of due.slice(0, BUYER_PAUSES_PER_BEAT)) {
      await this.host.sendPublic(SIGNERS, 'status', { status: r.until ? 'degraded' : 'online',
        software: SOFTWARE, ts: nowSec(), message: buyerPauseText(r) });
      r.announcedAt = nowSec(); r.announcedUntil = r.until;
      this.store.put('buyer-pause-announcements', entries);
    }
  }

  // DEX_RESCUE_TRADES: comma-separated trade ids the operator rescues (see rescueTrade). Applied once per record.
  #rescue(list) {
    const ids = new Set(String(list ?? '').split(',').map(x => x.trim()).filter(x => /^[0-9a-f]{64}$/.test(x)));
    if (!ids.size) return;
    for (const name of this.store.list('trade-')) {
      const record = this.store.get(name);
      if (!record || !ids.has(record.state?.tradeId)) continue;
      const state = rescueTrade(record.state, nowSec());
      this.log('rescue', record.state.tradeId.slice(0, 12), state ? 'checking the transfer again until ' + state.rescueUntil : 'not eligible (' + record.state.phase + ')');
      if (state) this.store.put(name, { ...record, state });
    }
  }

  // One heartbeat at a time; a failed one (the peer timed out the send) is sent again at once.
  #beat() {
    this.beating ??= this.#heartbeat().catch(() => this.#heartbeat()).catch(() => {}).finally(() => { this.beating = null; });
    return this.beating;
  }

  async #heartbeat() {
    if (!this.registry.current) return;
    const holding = [...this.host.trades.values()].filter(t => !isFinished(t)).length;
    await this.host.sendPublic(SIGNERS, 'heartbeat', { registryVersion: this.registry.current.version, software: SOFTWARE, status: 'online', holdCount: holding });
    this.lastHeartbeatAt = nowSec();
    // Policy announcements must never hold back the next heartbeat (or the buyer health evidence it supplies).
    this.#publishBuyerPauses().catch(error => this.log('buyer pause announcement', error.message));
  }

  async #public(channel, raw) {
    const m = this.receive(raw);
    if (!m || m.ch !== channel) return;
    if (channel === MAIN && m.from === this.serviceKey && m.kind === 'registry') {
      if (this.registry.offer(m)) this.log('registry', this.registry.current.version);
      this.venueHeardAt = nowSec();
      await this.relays.update(this.registry.usable);
    } else if (channel === MAIN && m.from === this.serviceKey && m.kind === 'status') {
      this.venueHeardAt = m.body.status === 'offline' ? -Infinity : nowSec();
    } else if (channel === SIGNERS && m.kind === 'heartbeat' && this.registry.usable?.signers.some(s => s.dexKey === m.from && s.status === 'active')) {
      if (m.body.status === 'online') this.strikeHeartbeats.set(m.from, nowSec()); else this.strikeHeartbeats.delete(m.from);
    } else if (channel === SIGNERS && m.kind === 'summon') {
      await this.#summon(m).catch(e => this.log('summon rejected', e.message));
    }
  }

  async #summon(m) {
    const { tradeId } = m.body, now = nowSec(), reg = this.registry.usable;
    if ([...this.host.trades.values()].some(t => t.state.tradeId === tradeId)) return;
    if (!reg) throw new Error('No usable registry');
    // The trade's registry must be the current one, or an earlier one that was replaced less than OLD_REGISTRY_SEC ago:
    // offers live up to 30 days and keep naming the registry they were posted under.
    const version = m.body.terms?.registryVersion, next = Number.isSafeInteger(version) && this.registry.snapshot(version + 1);
    if (!(version === reg.version || (version < reg.version && next && now - next.issuedAt < OLD_REGISTRY_SEC))) throw new Error('Registry version not current');
    if (version !== reg.version && m.body.terms.committee?.some(s => reg.removed?.some(r => r.dexKey === s.dexKey))) throw new Error('Committee member removed since');
    const { terms, sigs, lifetimeSec } = verifySummon(m.body, this.registry.snapshot(version), now,
      { networkId: this.profile?.peer?.msbNetworkId, required: addressProofRequired(reg) });
    if (!meetsVersion(SOFTWARE, reg.minSoftware)) throw new Error('update required');
    const pair = registryPair(this.registry.snapshot(version), terms.pair);
    if (this.profile) checkProfileTerms(terms, this.profile);
    const me = reg.signers.find(s => s.dexKey === this.identity.publicKey && s.status === 'active');
    if (!me || !me.assets.includes(pair.base.id) || !meetsVersion(me.software, reg.minSoftware) || me.boxKey !== this.box.publicKey) throw new Error('Not an active signer in the registry');
    const index = terms.committee.findIndex(s => s.dexKey === this.identity.publicKey);
    if (index < 0 || terms.committee[index].boxKey !== this.box.publicKey) throw new Error('Not in this committee');
    if (BigInt(me.limitUsdc) < BigInt(terms.quoteAmount)) throw new Error('Trade above my limit');
    const held = [...this.host.trades.values()].filter(t => !isFinished(t));
    if (held.length >= MAX_HELD_TRADES) throw new Error('Holding too many trades');
    for (const key of [terms.buyer.dexKey, terms.seller.dexKey]) {
      if (held.filter(t => [t.state.terms.buyer.dexKey, t.state.terms.seller.dexKey].includes(key)).length >= MAX_HELD_PER_TRADER) {
        throw new Error('Holding too many trades of this trader');
      }
    }
    const state = createSigner({ terms, signerIndex: index + 1, boxSecret: this.box.secretKey, now,
      networkId: this.profile?.peer?.msbNetworkId, requireAddressProof: addressProofRequired(reg) });
    const key = `sign-${tradeId}`;
    await this.host.addTrade({ key, role: 'signer', state, lifetimeSec });
    for (const sig of sigs) await this.host.inject(key, sig);
    this.log('summoned', tradeId.slice(0, 12), 'as signer', index + 1);
  }

  status() {
    return { software: SOFTWARE, strikes: { enabled: this.strikes.enabled }, updateRequired: !!this.registry.usable && !meetsVersion(SOFTWARE, this.registry.usable.minSoftware),
      message: this.registry.usable && !meetsVersion(SOFTWARE, this.registry.usable.minSoftware) ? 'update required' : '', pairs: pairStatus(this.registry.usable), dexKey: this.identity.publicKey, registryVersion: this.registry.current?.version ?? null, registryConflict: this.registry.conflict,
      trades: [...this.host.trades.values()].map(t => ({ tradeId: t.state.tradeId, phase: t.state.phase, reason: t.state.reason ?? null })) };
  }
}
