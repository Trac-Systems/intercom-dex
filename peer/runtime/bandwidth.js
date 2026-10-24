import Hypercore from 'hypercore';

const size = (encoding, value) => { const state = { start: 0, end: 0 }; encoding.preencode(state, value); return state.end; };
const hex = value => value?.toString('hex') ?? 'unknown';

// Separate accounting layers: protocol payloads, Hypercore blocks, and native UDP totals overlap. Never add them.
// Keep counters only, with bounded cardinality; no message contents, addresses or wallet material are retained.
export class Bandwidth {
  constructor({ now = () => Date.now(), limit = 2048 } = {}) {
    this.now = now; this.started = now(); this.limit = limit;
    this.rows = new Map(); this.cleanups = new Set(); this.seen = new WeakSet(); this.samples = new Set();
    this.closed = false;
  }

  add(layer, subsystem, detail, direction, bytes) {
    if (this.closed || !Number.isFinite(bytes) || bytes <= 0) return;
    let key = JSON.stringify([layer, subsystem, detail, direction]);
    if (!this.rows.has(key) && this.rows.size >= this.limit) key = JSON.stringify([layer, subsystem, 'other', direction]);
    const row = this.rows.get(key) ?? { layer, subsystem, detail: JSON.parse(key)[2], direction, bytes: 0, events: 0 };
    row.bytes += bytes; row.events++; this.rows.set(key, row);
  }

  sidechannel(channel, payload, direction, bytes) {
    const group = /^(intercom-dex:t:|intercom-locks:p:)/.exec(channel)?.[1];
    const kind = payload?.message?.kind ?? payload?.message?.control;
    this.add('protocol', 'sidechannel', `${group ? group + '*' : channel.slice(0, 100)}/${typeof kind === 'string' ? kind.slice(0, 40) : 'unknown'}`, direction, bytes);
  }

  _wrap(object, name, wrapper) {
    const original = object[name], replacement = wrapper(original);
    object[name] = replacement;
    const restore = () => { if (object[name] === replacement) object[name] = original; this.cleanups.delete(restore); };
    this.cleanups.add(restore);
    return restore;
  }

  trackStore(store, subsystem) {
    if (this.closed || this.seen.has(store)) return;
    this.seen.add(store);
    const watch = core => {
      const monitor = new Hypercore({ core, weak: true, active: false });
      const detail = hex(core.discoveryKey);
      const peer = remote => this.trackCorePeer(remote, subsystem, detail);
      monitor.on('download', (_index, bytes) => this.add('blocks', subsystem, detail, 'received', bytes));
      monitor.on('upload', (_index, bytes) => this.add('blocks', subsystem, detail, 'sent', bytes));
      monitor.on('peer-add', peer);
      monitor.on('error', () => {});
      monitor.ready().then(() => { for (const remote of monitor.peers) peer(remote); }).catch(() => {});
      const close = () => { this.cleanups.delete(close); return monitor.close(); };
      monitor.once('close', () => this.cleanups.delete(close));
      this.cleanups.add(close);
    };
    store.watch(watch);
    this.cleanups.add(() => store.unwatch(watch));
    for (const core of store.cores) watch(core);
  }

  trackCorePeer(peer, subsystem, detail) {
    if (this.closed || this.seen.has(peer)) return;
    this.seen.add(peer);
    const restores = [];
    for (const message of peer.channel.messages) {
      restores.push(this._wrap(message, 'send', send => (...args) => {
        if (peer.channel.closed) return send(...args);
        const bytes = size(message.encoding, args[0]);
        const result = send(...args);
        this.add('protocol', subsystem, detail, 'sent', bytes);
        return result;
      }));
      restores.push(this._wrap(message, 'recv', recv => (state, ...args) => {
        const start = state.start;
        try { return recv(state, ...args); }
        finally { this.add('protocol', subsystem, detail, 'received', state.start - start); }
      }));
    }
    this.trackConnection(peer.stream, subsystem);
    restores.push(this._wrap(peer.channel, 'ondestroy', destroy => (...args) => {
      for (const restore of restores) restore();
      return destroy.apply(peer.channel, args);
    }));
  }

  trackConnection(connection, subsystem) {
    const raw = connection.rawStream;
    if (this.closed || !raw || this.seen.has(raw)) return;
    this.seen.add(raw);
    this._native(raw, 'streams', subsystem);
    this.trackUdx(raw.udx, subsystem);
    if (raw.socket) this.trackSocket(raw.socket, subsystem);
  }

  _native(object, layer, subsystem) {
    if (!Number.isFinite(object.bytesReceived) || !Number.isFinite(object.bytesTransmitted)) return;
    let rx = object.bytesReceived, tx = object.bytesTransmitted;
    const sample = () => {
      const nextRx = object.bytesReceived, nextTx = object.bytesTransmitted;
      this.add(layer, subsystem, 'total', 'received', nextRx - rx);
      this.add(layer, subsystem, 'total', 'sent', nextTx - tx);
      rx = nextRx; tx = nextTx;
    };
    this.samples.add(sample);
    const close = () => { sample(); this.samples.delete(sample); object.off?.('close', close); this.cleanups.delete(close); };
    object.once?.('close', close); this.cleanups.add(close);
  }

  trackUdx(udx, subsystem) {
    if (this.closed || !udx || this.seen.has(udx)) return;
    this.seen.add(udx);
    this._native(udx, 'udp', subsystem);
    this._wrap(udx, 'createSocket', create => (...args) => {
      const socket = create.apply(udx, args); this.trackSocket(socket, subsystem); return socket;
    });
  }

  trackSocket(socket, subsystem) {
    if (this.closed || this.seen.has(socket)) return;
    this.seen.add(socket);
    const receive = data => this.add('protocol', `${subsystem}/dht`, 'datagrams', 'received', data.byteLength);
    socket.on('message', receive);
    const restores = ['send', 'trySend'].map(name => this._wrap(socket, name, send => (...args) => {
      const closed = socket.closing, result = send.apply(socket, args);
      if (!closed) this.add('protocol', `${subsystem}/dht`, 'datagrams', 'sent', args[0].byteLength);
      return result;
    }));
    const close = () => { socket.off('message', receive); socket.off('close', close); for (const restore of restores) restore(); this.cleanups.delete(close); };
    this.cleanups.add(close); socket.once('close', close);
  }

  trackSwarm(swarm, subsystem) {
    if (this.closed) return;
    this.trackUdx(swarm.dht.udx, subsystem);
    for (const socket of [swarm.dht.io.clientSocket, swarm.dht.io.serverSocket]) if (socket) this.trackSocket(socket, subsystem);
    const connection = stream => this.trackConnection(stream, subsystem);
    swarm.on('connection', connection);
    this.cleanups.add(() => swarm.off('connection', connection));
    for (const stream of swarm.connections) connection(stream);
  }

  snapshot() {
    for (const sample of this.samples) sample();
    return { started: this.started, at: this.now(), units: 'bytes', rows: [...this.rows.values()].map(row => ({ ...row })) };
  }

  async close() {
    if (this.closed) return;
    this.snapshot();
    this.closed = true;
    for (const cleanup of [...this.cleanups]) await cleanup();
    this.cleanups.clear(); this.samples.clear();
  }
}
