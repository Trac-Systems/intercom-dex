import WebSocket from 'ws';
import { EventEmitter } from 'node:events';

// The agent's link to its own peer (SC-Bridge over local WebSocket). Requests carry an id and resolve on the
// matching reply; channel messages are emitted as 'message' (channel, message).
export class Bridge extends EventEmitter {
  constructor({ url, token, timeoutMs = 30000 }) {
    super();
    this.url = url; this.token = token; this.timeoutMs = timeoutMs;
    this.nextId = 1; this.pending = new Map(); this.ws = null;
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', reject); });
    this.ws.on('message', (data) => this.#receive(data));
    this.ws.on('close', () => {
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error('Bridge closed')); }
      this.pending.clear(); this.emit('close');
    });
    const reply = await this.request({ type: 'auth', token: this.token });
    if (reply.type !== 'auth_ok') throw new Error('Bridge authentication failed');
    return this;
  }

  #receive(data) {
    let msg; try { msg = JSON.parse(String(data)); } catch { return; }
    if (Number.isInteger(msg.id) && this.pending.has(msg.id)) {
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
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Bridge timeout: ${body.type}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, ...body }));
    });
  }

  setRelays(keys) { return this.request({ type: 'relays.set', keys }); }
  relayStats() { return this.request({ type: 'relays.stats' }); }
  send(channel, message) { return this.request({ type: 'send', channel, message }); }
  subscribe(channels) { return this.request({ type: 'subscribe', channels }); }
  join(channel) { return this.request({ type: channel.startsWith('intercom-dex:t:') ? 'dex_join' : 'join', channel }, 120000); }
  leave(channel) { return this.request({ type: 'leave', channel }); }
  info() { return this.request({ type: 'info' }); }
  stats() { return this.request({ type: 'stats' }); }
  async peerPresent(channel, peerKey) { return (await this.request({ type: 'dex_presence', channel, peerKey })).connected === true; }
  async call(type, params, timeoutMs) { return (await this.request({ type, params }, timeoutMs)).result; }
  close() { this.ws?.close(); }
}
