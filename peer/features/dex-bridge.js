import ScBridge from './sc-bridge/index.js';
import { peerPresent } from './dex-presence.js';
import b4a from 'b4a';

export const DEX_CHANNELS = ['intercom-dex', 'intercom-dex:offers', 'intercom-dex:signers', 'intercom-dex:chat'];
const TRADE_CHANNEL = /^intercom-dex:t:[0-9a-f]{64}$/;
const MAX_MAKER_PINS = 16;
// Makers a client keeps connected before any take (the best offers of the market it shows), so a take starts at once.
const MAX_WARM = 4;

// SC-Bridge plus the dex commands: joining trade channels and the Trac handlers the peer was started with.
export default class DexBridge extends ScBridge {
  constructor(peer, config = {}) {
    super(peer, config);
    this.handlers = config.handlers ?? {};
    this.makerPins = new Map();
    this.makerRoutes = new Map();
    this.makerClients = new WeakSet();
    this.warmRoutes = new Map();
  }

  _releaseMaker(client, channel, route = this.makerRoutes.get(client)?.get(channel)) {
    const routes = this.makerRoutes.get(client);
    if (!route || routes?.get(channel) !== route) return;
    routes.delete(channel);
    if (!routes.size) this.makerRoutes.delete(client);
    this._dropPin(route.peerKey, route.pin);
  }

  _releaseMakerClient(client) {
    for (const channel of this.makerRoutes.get(client)?.keys() ?? []) this._releaseMaker(client, channel);
    this._setWarm(client, []);
  }

  _dropPin(peerKey, pin) {
    if (--pin.refs) return;
    if (this.makerPins.get(peerKey) === pin) this.makerPins.delete(peerKey);
    if (pin.owned && !pin.swarm.destroyed && !this.registryPins?.has(peerKey)) pin.swarm.leavePeer(pin.key);
  }

  // The registry's relay keys are the signers' and the venue's peers. Every node keeps a direct connection to them: a
  // trade channel is new for each trade and only opens over a direct connection, so a buyer that happened not to be
  // connected to a committee signer could never deliver its dealing to it and the trade was called off.
  _pinRegistryPeers(keys) {
    const swarm = this.peer.swarm;
    if (!swarm || swarm.destroyed) return;
    this.registryPins ??= new Map();
    const self = swarm.keyPair?.publicKey ? b4a.toString(swarm.keyPair.publicKey, 'hex') : null;
    const wanted = new Set(keys.filter(k => k !== self));
    for (const [peerKey, pin] of this.registryPins) {
      if (wanted.has(peerKey)) continue;
      this.registryPins.delete(peerKey);
      if (pin.owned && !swarm.destroyed && !this.makerPins.has(peerKey)) swarm.leavePeer(pin.key);
    }
    let added = false;
    for (const peerKey of wanted) {
      if (this.registryPins.has(peerKey)) continue;
      const key = b4a.from(peerKey, 'hex'), owned = !swarm.peers.get(peerKey)?.explicit;
      swarm.joinPeer(key);
      this.registryPins.set(peerKey, { key, owned });
      added = true;
    }
    // Installed Hyperswarm does not wake its scheduler when joinPeer finds an already queued peer.
    if (added) swarm._attemptClientConnections?.();
  }

  // One Hyperswarm pin per maker peer, shared by its routes and warm entries (counted in refs).
  _acquirePin(peerKey) {
    const swarm = this.peer.swarm;
    if (!swarm || swarm.destroyed) throw new Error('Peer connection not ready.');
    let pin = this.makerPins.get(peerKey);
    if (!pin) {
      if (this.makerPins.size >= MAX_MAKER_PINS) throw new Error('Maker peer limit reached.');
      const key = b4a.from(peerKey, 'hex'), owned = !swarm.peers.get(peerKey)?.explicit;
      try {
        swarm.joinPeer(key);
        // Installed Hyperswarm does not wake its scheduler when joinPeer finds an already queued peer.
        swarm._attemptClientConnections();
      } catch (error) {
        if (owned) swarm.leavePeer(key);
        throw error;
      }
      pin = { key, swarm, owned, refs: 0 };
      this.makerPins.set(peerKey, pin);
    }
    pin.refs++;
    return pin;
  }

  _watchClient(client) {
    if (this.makerClients.has(client)) return;
    this.makerClients.add(client);
    const cleanup = () => this._releaseMakerClient(client);
    for (const event of ['close', 'end', 'error']) client.socket.once(event, cleanup);
  }

  // Replaces the client's warm makers; a maker that cannot be pinned (limit reached) is skipped. Returns the kept keys.
  _setWarm(client, peerKeys) {
    const current = this.warmRoutes.get(client) ?? new Map();
    for (const [peerKey, pin] of current) if (!peerKeys.includes(peerKey)) { current.delete(peerKey); this._dropPin(peerKey, pin); }
    for (const peerKey of peerKeys) {
      if (current.has(peerKey)) continue;
      try { current.set(peerKey, this._acquirePin(peerKey)); } catch {}
    }
    if (current.size) { this.warmRoutes.set(client, current); this._watchClient(client); } else this.warmRoutes.delete(client);
    return [...current.keys()];
  }

  _pinMaker(client, channel, peerKey) {
    if (peerKey === undefined) return null;
    if (peerKey === null) { this._releaseMaker(client, channel); return null; }
    if (typeof peerKey !== 'string' || !/^[0-9a-f]{64}$/.test(peerKey)) throw new Error('Invalid maker peer key.');
    const previous = this.makerRoutes.get(client)?.get(channel);
    if (previous?.peerKey === peerKey) return previous;
    if (client.socket?.destroyed) throw new Error('Peer connection not ready.');
    const pin = this._acquirePin(peerKey);
    this._releaseMaker(client, channel);
    let routes = this.makerRoutes.get(client);
    if (!routes) this.makerRoutes.set(client, routes = new Map());
    this._watchClient(client);
    const route = { peerKey, pin };
    routes.set(channel, route);
    return route;
  }

  stop() {
    for (const client of new Set([...this.makerRoutes.keys(), ...this.warmRoutes.keys()])) this._releaseMakerClient(client);
    super.stop();
  }

  _handleClientMessage(client, message) {
    const type = message?.type;
    if (!['dex_join', 'dex_presence', 'dex_warm', 'leave', 'relays.set', 'relays.stats'].includes(type) && !Object.hasOwn(this.handlers, type)) return super._handleClientMessage(client, message);
    const reply = (payload) => this._broadcastToClient(client, Number.isInteger(message.id) ? { id: message.id, ...payload } : payload);
    if (this.requireAuth && !client.authed) return reply({ type: 'error', error: 'Unauthorized.' });
    if (type === 'leave') {
      const channel = String(message.channel ?? '').trim();
      for (const owner of this.makerRoutes.keys()) this._releaseMaker(owner, channel);
      return super._handleClientMessage(client, message);
    }
    if (type === 'relays.set' || type === 'relays.stats') {
      try {
        if (!this.peer.blindRelay) throw new Error('Relay feature not ready');
        if (type === 'relays.stats') return reply({ type, stats: this.peer.blindRelay.stats() });
        if (!Array.isArray(message.keys) || message.keys.length > 4097 || message.keys.some(k => typeof k !== 'string' || !/^[0-9a-f]{64}$/.test(k)) ||
            Object.keys(message).some(k => !['id', 'type', 'keys'].includes(k))) throw new Error('Invalid relay keys');
        const keys = this.peer.blindRelay.setRelays(message.keys);
        this._pinRegistryPeers(message.keys);
        return reply({ type, keys });
      } catch (error) { return reply({ type: 'error', error: error.message }); }
    }
    if (type === 'dex_warm') {
      const keys = message.peerKeys;
      if (!Array.isArray(keys) || keys.length > MAX_WARM || keys.some(k => typeof k !== 'string' || !/^[0-9a-f]{64}$/.test(k)) ||
          new Set(keys).size !== keys.length || Object.keys(message).some(k => !['id', 'type', 'peerKeys'].includes(k))) {
        return reply({ type: 'error', error: 'Invalid warm peer keys.' });
      }
      if (client.socket?.destroyed) return;
      return reply({ type: 'dex_warm', peerKeys: this._setWarm(client, keys) });
    }
    if (type === 'dex_presence') {
      try { return reply({ type: 'dex_presence', connected: peerPresent(this.sidechannel, message.channel, message.peerKey) }); }
      catch (error) { return reply({ type: 'error', error: error.message }); }
    }
    if (type === 'dex_join') {
      const channel = String(message.channel ?? '');
      if (!TRADE_CHANNEL.test(channel)) return reply({ type: 'error', error: 'Not a trade channel.' });
      const previous = this.makerRoutes.get(client)?.get(channel);
      let route;
      const rollback = () => { if (route && route !== previous && !route.joined) this._releaseMaker(client, channel, route); };
      try {
        if (!this.sidechannel) throw new Error('Sidechannel not ready.');
        route = this._pinMaker(client, channel, message.makerPeer);
        this.sidechannel.openChannels.add(channel);
        this.sidechannel.addChannel(channel).then(
          (ok) => {
            if (!ok) rollback();
            else if (route) route.joined = true;
            reply(ok ? { type: 'joined', channel, announced: true } : { type: 'error', error: 'Join denied.' });
          },
          (error) => { rollback(); reply({ type: 'error', error: `Join failed: ${error.message}` }); });
      } catch (error) { rollback(); reply({ type: 'error', error: `Join failed: ${error.message}` }); }
      return;
    }
    Promise.resolve().then(() => this.handlers[type](message.params ?? {})).then(
      (result) => reply({ type: `${type}_result`, result }),
      (error) => reply({ type: 'error', error: error.message }));
  }
}
