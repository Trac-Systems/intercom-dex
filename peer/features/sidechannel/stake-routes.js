import b4a from 'b4a';
import PeerWallet from 'trac-wallet';

const BONDS = 'intercom-dex:bonds';
const key = value => typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value)
  ? '[' + value.map(canonical).join(',') + ']'
  : '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';

// DEX keys and swarm keys are different. Learn a bounded, expiring return route
// from the signed inner identity and signed outer peer, including old traders'
// ordinary stake requests and old signers' heartbeats. Routes grant no RPC rights.
export class StakeRoutes {
  constructor({ venueKey, now, verifyOuter }) {
    Object.assign(this, { venueKey, now, verifyOuter }); this.routes = new Map(); this.checked = new WeakMap(); this.localKeys = new Set();
  }
  message(channel, payload) {
    if (this.checked.has(payload)) return this.checked.get(payload);
    let result = null;
    try {
      const m = payload.message, stake = channel === BONDS;
      if (m?.v === 1 && m.ch === channel && key(m.from) && typeof m.sig === 'string' && m.sig.length === 128 && /^[0-9a-f]{128}$/.test(m.sig) &&
          Number.isSafeInteger(stake ? m.at : m.ts) && Math.abs(this.now() / 1000 - (stake ? m.at : m.ts)) <= 120 &&
          (!stake || key(m.to) && key(m.id) && ['stakeRequest', 'stakeReply', 'stakeManifest', 'stakePage'].includes(m.kind))) {
        const { sig, ...unsigned } = m;
        const bytes = b4a.from((stake ? 'intercom-dex/stake/v1/rpc\n' : 'intercom-dex/v1\n') + canonical(unsigned));
        if (PeerWallet.verify(b4a.from(sig, 'hex'), bytes, b4a.from(m.from, 'hex'))) result = m;
      }
    } catch {}
    this.checked.set(payload, result); return result;
  }
  local(channel, payload) {
    const m = this.message(channel, payload);
    if (!m || !(channel === BONDS || channel === 'intercom-dex' && m.kind === 'registry' ||
        channel === 'intercom-dex:signers' && m.kind === 'heartbeat') ||
        this.localKeys.size >= 16 && !this.localKeys.has(m.from)) return;
    this.localKeys.add(m.from); this.routes.delete(m.from); return m.from;
  }
  learn(channel, payload, connection) {
    if (![BONDS, 'intercom-dex', 'intercom-dex:signers', 'intercom-dex:offers'].includes(channel)) return;
    const m = this.message(channel, payload), remote = connection?.remotePublicKey;
    if (!m || this.localKeys.has(m.from) || !remote || !key(payload.from) || !this.verifyOuter(payload, payload.from)) return;
    const peerKey = b4a.toString(remote, 'hex'), direct = peerKey === payload.from, now = this.now();
    for (const [id, route] of this.routes) if (route.until <= now) this.routes.delete(id);
    const prior = this.routes.get(m.from);
    // Rewrapping somebody else's public signed envelope cannot move an active
    // route to the attacker's peer. A replay also cannot extend its signed age.
    if (prior && prior.origin !== payload.from || prior?.direct && !direct || !prior && this.routes.size >= 4096) return;
    this.routes.set(m.from, { peerKey, origin: payload.from, direct, until: Math.min(now + 120000, ((channel === BONDS ? m.at : m.ts) + 120) * 1000) });
    return m.from;
  }
  route(to) { const route = this.routes.get(to); return route?.until > this.now() ? route : null; }
  allows(channel, payload, connection) {
    const m = this.message(channel, payload);
    if (!m || !connection?.remotePublicKey) return false;
    const peerKey = b4a.toString(connection.remotePublicKey, 'hex'), route = this.route(m.to);
    if (route) return peerKey === route.peerKey;
    // Servers and leaves can always ask the pinned venue. The venue never floods
    // an unknown addressee to its public leaves while waiting for their next beat.
    return peerKey === this.venueKey;
  }
  clear() { this.routes.clear(); this.checked = new WeakMap(); this.localKeys.clear(); }
}
