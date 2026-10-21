// Pushed chain view: a few RPC nodes send every new slot over a WebSocket (slotSubscribe), with the node's root, which
// is its finalized slot. One subscription costs no requests, so a trader keeps a fresh view without polling and stays
// under the public RPC servers' request limits. The view is used like the polled one: the finalized slot is the
// highest one that `need` nodes have reached, the tip is the highest slot any fresh node names.

// solana-test-validator and agave serve WebSocket on the HTTP port + 1 when the URL names a port.
export function webSocketUrl(httpUrl) {
  const u = new URL(httpUrl);
  if (!['http:', 'https:'].includes(u.protocol)) throw new TypeError('Invalid RPC URL');
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  if (u.port) u.port = String(Number(u.port) + 1);
  return u.href;
}

const SILENT_MS = 10_000;           // a socket without a slot for this long is replaced
const RETRY_MS = [5_000, 30_000, 120_000, 600_000];

export class ChainWatch {
  constructor({ endpoints, need = 2, sockets = 3, WebSocketImpl = globalThis.WebSocket, now = () => performance.now(),
    onUpdate = () => {}, log = () => {} }) {
    if (!Array.isArray(endpoints) || !endpoints.length) throw new TypeError('Endpoints required');
    if (!Number.isInteger(need) || need < 1 || need > endpoints.length) throw new TypeError('Invalid quorum');
    Object.assign(this, { need, WebSocketImpl, now, onUpdate, log });
    this.sockets = Math.min(Math.max(sockets, need), endpoints.length);
    this.endpoints = endpoints.map(url => ({ url, ws: webSocketUrl(url), socket: null, failures: 0, retryAt: 0, reading: null, lastAt: 0 }));
    this.stopped = true;
  }

  get available() { return typeof this.WebSocketImpl === 'function'; }

  start() {
    if (!this.available || !this.stopped) return;
    this.stopped = false;
    this.#fill();
    this.timer = setInterval(() => this.#check(), 2_000);
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const e of this.endpoints) this.#close(e);
  }

  // { finalized, tip, at } from nodes heard within maxAgeMs, or null when fewer than `need` are fresh. `at` is the time
  // of the oldest reading used, so the view's age is never understated.
  view(maxAgeMs) {
    const now = this.now();
    const fresh = this.endpoints.map(e => e.reading).filter(r => r && now - r.at < maxAgeMs);
    if (fresh.length < this.need) return null;
    const roots = fresh.map(r => r.finalized).sort((a, b) => b - a);
    return { finalized: roots[this.need - 1], tip: Math.max(...fresh.map(r => r.tip)), at: Math.min(...fresh.map(r => r.at)) };
  }

  #open() { return this.endpoints.filter(e => e.socket).length; }

  #fill() {
    if (this.stopped) return;
    const now = this.now();
    for (const e of this.endpoints) {
      if (this.#open() >= this.sockets) break;
      if (!e.socket && e.retryAt <= now) this.#connect(e);
    }
  }

  #connect(e) {
    let socket;
    try { socket = new this.WebSocketImpl(e.ws); } catch { this.#failed(e); return; }
    e.socket = socket; e.lastAt = this.now();
    socket.onopen = () => {
      try { socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'slotSubscribe' })); } catch { this.#failed(e); }
    };
    socket.onmessage = event => {
      let m;
      try { m = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { return; }
      if (m?.method !== 'slotNotification') return;
      const r = m.params?.result;
      if (!Number.isSafeInteger(r?.slot) || !Number.isSafeInteger(r?.root) || r.root < 0 || r.slot < r.root) return;
      e.failures = 0; e.lastAt = this.now();
      e.reading = { tip: r.slot, finalized: r.root, at: e.lastAt };
      try { this.onUpdate(); } catch {}
    };
    socket.onerror = () => {};
    socket.onclose = () => { if (e.socket === socket) this.#failed(e); };
  }

  #failed(e) {
    this.#close(e);
    e.retryAt = this.now() + RETRY_MS[Math.min(e.failures, RETRY_MS.length - 1)];
    e.failures++;
    this.#fill();
  }

  #close(e) {
    const socket = e.socket;
    e.socket = null; e.reading = null;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    try { socket.close(); } catch {}
  }

  #check() {
    if (this.stopped) return;
    const now = this.now();
    for (const e of this.endpoints) if (e.socket && now - e.lastAt > SILENT_MS) this.#failed(e);
    this.#fill();
  }
}
