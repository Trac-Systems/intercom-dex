import ScBridge from './sc-bridge/index.js';
import { peerPresent } from './dex-presence.js';

export const DEX_CHANNELS = ['intercom-dex', 'intercom-dex:offers', 'intercom-dex:signers', 'intercom-dex:chat'];
const TRADE_CHANNEL = /^intercom-dex:t:[0-9a-f]{64}$/;

// SC-Bridge plus the dex commands: joining trade channels and the Trac handlers the peer was started with.
export default class DexBridge extends ScBridge {
  constructor(peer, config = {}) {
    super(peer, config);
    this.handlers = config.handlers ?? {};
  }

  _handleClientMessage(client, message) {
    const type = message?.type;
    if (!['dex_join', 'dex_presence', 'relays.set', 'relays.stats'].includes(type) && !Object.hasOwn(this.handlers, type)) return super._handleClientMessage(client, message);
    const reply = (payload) => this._broadcastToClient(client, Number.isInteger(message.id) ? { id: message.id, ...payload } : payload);
    if (this.requireAuth && !client.authed) return reply({ type: 'error', error: 'Unauthorized.' });
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
      this.sidechannel.openChannels.add(channel);
      this.sidechannel.addChannel(channel).then(
        (ok) => reply(ok ? { type: 'joined', channel, announced: true } : { type: 'error', error: 'Join denied.' }),
        (error) => reply({ type: 'error', error: `Join failed: ${error.message}` }));
      return;
    }
    Promise.resolve().then(() => this.handlers[type](message.params ?? {})).then(
      (result) => reply({ type: `${type}_result`, result }),
      (error) => reply({ type: 'error', error: error.message }));
  }
}
