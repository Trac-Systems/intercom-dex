import WebSocket from 'ws';
import { EventEmitter } from 'node:events';

// The agent's link to its own peer (SC-Bridge over local WebSocket). Requests carry an id and resolve on the
// matching reply; channel messages are emitted as 'message' (channel, message).
export class Bridge extends EventEmitter {
  constructor({ url, token, timeoutMs = 30000, socketFactory = url => new WebSocket(url) }) {
    super();
    Object.assign(this, { url, token, timeoutMs, socketFactory });
    this.nextId = 1; this.pending = new Map(); this.ws = null;
    this.lastReceivedAt = null; this.lastReplyAt = null;
  }

  connect() {
    if (this.connecting) return this.connecting;
    if (this.session?.authed) return Promise.resolve(this);
    const connecting = this.#connect().finally(() => {
      if (this.connecting === connecting) this.connecting = null;
    });
    this.connecting = connecting;
    return connecting;
  }

  async #connect() {
    const ws = this.socketFactory(this.url), session = { ws };
    this.ws = ws; this.session = session;
    ws.on('message', data => { if (this.session === session) this.#receive(data); });
    ws.on('close', () => this.#closed(session, new Error('Bridge closed')));
    ws.on('error', () => {
      // Do not include the URL or auth payload in errors/logs.
      this.#closed(session, new Error('Bridge socket error'));
      ws.terminate();
    });
    try {
      await new Promise((resolve, reject) => {
        session.rejectOpen = reject;
        session.openTimer = setTimeout(() => reject(new Error('Bridge connection timeout')), this.timeoutMs);
        ws.once('open', resolve);
      });
      clearTimeout(session.openTimer); session.rejectOpen = null;
      if (session.closed) throw new Error('Bridge closed');
      const reply = await this.request({ type: 'auth', token: this.token });
      if (reply.type !== 'auth_ok') throw new Error('Bridge authentication failed');
      if (session.closed) throw new Error('Bridge closed');
      session.authed = true;
      return this;
    } catch (error) {
      this.#closed(session, error); ws.terminate(); throw error;
    }
  }

  #failPending(error) {
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
  }

  #closed(session, error) {
    if (session.closed) return;
    session.closed = true; clearTimeout(session.openTimer); session.rejectOpen?.(error);
    if (this.session !== session) return;
    this.session = null; this.ws = null;
    this.#failPending(error); this.emit('close');
  }

  reconnect() {
    if (this.reconnecting) return this.reconnecting;
    this.close({ force: true });
    // The old handshake may still be settling; it cannot own the replacement socket.
    this.connecting = null;
    const reconnecting = this.connect().finally(() => {
      if (this.reconnecting === reconnecting) this.reconnecting = null;
    });
    this.reconnecting = reconnecting;
    return reconnecting;
  }

  #receive(data) {
    let msg; try { msg = JSON.parse(String(data)); } catch { return; }
    this.lastReceivedAt = performance.now();
    if (Number.isInteger(msg.id) && this.pending.has(msg.id)) {
      this.lastReplyAt = this.lastReceivedAt;
      const { resolve, reject, timer } = this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(timer);
      if (msg.type === 'error') reject(new Error(msg.error)); else resolve(msg);
      return;
    }
    if (msg.type === 'sidechannel_message') {
      this.emit('traffic', msg.channel, msg.message, Buffer.byteLength(data));   // the dashboard's traffic view
      this.emit('message', msg.channel, msg.message, msg);
    }
  }

  request(body, timeoutMs = this.timeoutMs) {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Bridge not connected'));
    const id = this.nextId++;
    const ws = this.ws;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Bridge timeout: ${body.type}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const failed = error => {
        if (!error || !this.pending.has(id)) return;
        clearTimeout(timer); this.pending.delete(id); reject(error);
      };
      try { ws.send(JSON.stringify({ id, ...body }), failed); } catch (error) { failed(error); }
    });
  }

  setRelays(keys) { return this.request({ type: 'relays.set', keys }); }
  relayStats() { return this.request({ type: 'relays.stats' }); }
  send(channel, message) { return this.request({ type: 'send', channel, message }); }
  subscribe(channels) { return this.request({ type: 'subscribe', channels }); }
  join(channel, makerPeer) {
    const trade = channel.startsWith('intercom-dex:t:');
    return this.request({ type: trade ? 'dex_join' : 'join', channel, ...(trade && makerPeer !== undefined ? { makerPeer } : {}) }, 120000);
  }
  leave(channel) { return this.request({ type: 'leave', channel }); }
  info() { return this.request({ type: 'info' }); }
  stats() { return this.request({ type: 'stats' }); }
  async peerPresent(channel, peerKey) { return (await this.request({ type: 'dex_presence', channel, peerKey })).connected === true; }
  async call(type, params, timeoutMs) { return (await this.request({ type, params }, timeoutMs)).result; }
  close({ force = false } = {}) {
    this.#failPending(new Error('Bridge closed'));
    const session = this.session;
    if (!session) return;
    if (force) { this.#closed(session, new Error('Bridge closed')); session.ws.terminate(); }
    else session.ws.close();
  }
}
