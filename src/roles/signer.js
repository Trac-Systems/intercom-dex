import { RegistryRelays } from '../net/relays.js';
import { createSigner, rescueTrade } from '../core/trade-signer.js';
import { TradeHost, isFinished } from './host.js';
import { RegistryView, publicReceiver, nowSec, verifySummon } from './common.js';

import { SOFTWARE, meetsVersion } from '../core/software.js';
import { registryPair, pairStatus } from '../market/assets.js';
import { checkProfileTerms } from '../net/profile.js';

const MAIN = 'intercom-dex', SIGNERS = 'intercom-dex:signers';
// Unfinished trades a signer holds at once, in total and per trader key (buyer or seller). Summons beyond them are
// refused; buyers repeat summons, so a refused trade is taken once a slot frees.
export const MAX_HELD_TRADES = 32, MAX_HELD_PER_TRADER = 8;
// Released traders and venues keep a heartbeat fresh for 90 s.
export const HEARTBEAT_MS = 30_000;

// A committee signer: joins trades it is summoned to (only when it is really in the signed terms' committee and the
// registry it trusts lists it), holds its encrypted share, verifies the seller's transfer on its own node, publishes.
export class Signer {
  constructor({ bridge, identity, box, store, trac, serviceKey, profile = null, log = console.log }) {
    Object.assign(this, { bridge, identity, box, store, serviceKey, profile, log });
    this.host = new TradeHost({ bridge, identity, store, solana: null, trac, profile, serviceKey, log });
    this.registry = new RegistryView(serviceKey, store, log, profile);
    this.relays = new RegistryRelays(bridge);
    this.receive = publicReceiver();
  }

  async start() {
    this.#rescue(process.env.DEX_RESCUE_TRADES);
    await this.relays.update(this.registry.usable);
    for (const ch of [MAIN, SIGNERS]) await this.bridge.join(ch);
    this.host.hooks.unrouted.push((ch, m) => this.#public(ch, m));
    await this.host.start();
    this.heartbeat = setInterval(() => this.#beat(), HEARTBEAT_MS);
  }

  stop() { this.host.stop(); clearInterval(this.heartbeat); }

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
  }

  async #public(channel, raw) {
    const m = this.receive(raw);
    if (!m || m.ch !== channel) return;
    if (channel === MAIN && m.from === this.serviceKey && m.kind === 'registry') {
      if (this.registry.offer(m)) this.log('registry', this.registry.current.version);
      await this.relays.update(this.registry.usable);
    } else if (channel === SIGNERS && m.kind === 'summon') {
      await this.#summon(m).catch(e => this.log('summon rejected', e.message));
    }
  }

  async #summon(m) {
    const { tradeId } = m.body, now = nowSec(), reg = this.registry.usable;
    if ([...this.host.trades.values()].some(t => t.state.tradeId === tradeId)) return;
    if (!reg) throw new Error('No usable registry');
    // The trade's registry must be the current one, or the one just before it if that was replaced minutes ago.
    const version = m.body.terms?.registryVersion;
    if (!(version === reg.version || (version === reg.version - 1 && now - reg.issuedAt < 600))) throw new Error('Registry version not current');
    const { terms, sigs, lifetimeSec } = verifySummon(m.body, this.registry.snapshot(version), now);
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
    const state = createSigner({ terms, signerIndex: index + 1, boxSecret: this.box.secretKey, now });
    const key = `sign-${tradeId}`;
    await this.host.addTrade({ key, role: 'signer', state, lifetimeSec });
    for (const sig of sigs) await this.host.inject(key, sig);
    this.log('summoned', tradeId.slice(0, 12), 'as signer', index + 1);
  }

  status() {
    return { software: SOFTWARE, updateRequired: !!this.registry.usable && !meetsVersion(SOFTWARE, this.registry.usable.minSoftware),
      message: this.registry.usable && !meetsVersion(SOFTWARE, this.registry.usable.minSoftware) ? 'update required' : '', pairs: pairStatus(this.registry.usable), dexKey: this.identity.publicKey, registryVersion: this.registry.current?.version ?? null, registryConflict: this.registry.conflict,
      trades: [...this.host.trades.values()].map(t => ({ tradeId: t.state.tradeId, phase: t.state.phase, reason: t.state.reason ?? null })) };
  }
}
