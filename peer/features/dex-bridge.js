import ScBridge from './sc-bridge/index.js';
import { peerPresent } from './dex-presence.js';
import b4a from 'b4a';

export const DEX_CHANNELS = ['intercom-dex', 'intercom-dex:offers', 'intercom-dex:signers', 'intercom-dex:chat'];
const TRADE_CHANNEL = /^intercom-dex:t:[0-9a-f]{64}$/;
const MAX_MAKER_PINS = 16;

// SC-Bridge plus the dex commands: joining trade channels and the Trac handlers the peer was started with.
export default class DexBridge extends ScBridge {
  constructor(peer, config = {}) {
    super(peer, config);
    this.handlers = config.handlers ?? {};
    this.makerPins = new Map();
    this.makerRoutes = new Map();
    this.makerClients = new WeakSet();
  }

  _releaseMaker(client, channel, route = this.makerRoutes.get(client)?.get(channel)) {
    const routes = this.makerRoutes.get(client);
    if (!route || routes?.get(channel) !== route) return;
    routes.delete(channel);
    if (!routes.size) this.makerRoutes.delete(client);
    if (--route.pin.refs) return;
    this.makerPins.delete(route.peerKey);
    if (route.pin.owned && !route.pin.swarm.destroyed) route.pin.swarm.leavePeer(route.pin.key);
  }

  _releaseMakerClient(client) {
    for (const channel of this.makerRoutes.get(client)?.keys() ?? []) this._releaseMaker(client, channel);
  }

  _pinMaker(client, channel, peerKey) {
    if (peerKey === undefined) return null;
    if (peerKey === null) { this._releaseMaker(client, channel); return null; }
    if (typeof peerKey !== 'string' || !/^[0-9a-f]{64}$/.test(peerKey)) throw new Error('Invalid maker peer key.');
    const previous = this.makerRoutes.get(client)?.get(channel);
    if (previous?.peerKey === peerKey) return previous;
    const swarm = this.peer.swarm;
    if (!swarm || swarm.destroyed || client.socket?.destroyed) throw new Error('Peer connection not ready.');
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
    this._releaseMaker(client, channel);
    let routes = this.makerRoutes.get(client);
    if (!routes) this.makerRoutes.set(client, routes = new Map());
    if (!this.makerClients.has(client)) {
      this.makerClients.add(client);
      const cleanup = () => this._releaseMakerClient(client);
      for (const event of ['close', 'end', 'error']) client.socket.once(event, cleanup);
    }
    const route = { peerKey, pin };
    routes.set(channel, route);
    return route;
  }

  stop() {
    for (const client of this.makerRoutes.keys()) this._releaseMakerClient(client);
    super.stop();
  }

  _handleClientMessage(client, message) {
    const type = message?.type;
    if (!['dex_join', 'dex_presence', 'leave', 'relays.set', 'relays.stats'].includes(type) && !Object.hasOwn(this.handlers, type)) return super._handleClientMessage(client, message);
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
        return reply({ type, keys: this.peer.blindRelay.setRelays(message.keys) });
      } catch (error) { return reply({ type: 'error', error: error.message }); }
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
