// Bound each venue connection's public traffic and pending memory. Trade channels bypass this queue.
export class PublicSend {
  constructor({ rate = 32000, burst = 224000, maxQueue = 512000, now = Date.now, send }) {
    if (![rate, burst, maxQueue].every(n => Number.isSafeInteger(n) && n > 0) || maxQueue < burst || typeof send !== 'function')
      throw new Error('Invalid public send limits');
    Object.assign(this, { rate, burst, maxQueue, now, send });
    this.states = new Map(); this.dropped = 0; this.coalesced = 0;
  }

  push(record, channel, payload, direction, bytes, authenticated = false) {
    const connection = record.connection ?? record;
    if (connection.destroyed || bytes > this.burst) { this.dropped++; return false; }
    let state = this.states.get(connection);
    if (!state) {
      state = { connection, queue: new Map(), bytes: 0, tokens: this.burst, at: this.now(), timer: null, blocked: false };
      state.close = () => this.remove(connection);
      state.drain = () => { state.blocked = false; this.flush(state); };
      connection.once?.('close', state.close); this.states.set(connection, state);
    }
    const kind = payload.message?.kind, body = payload.message?.body;
    const replaceable = authenticated && ['offer', 'cancel'].includes(kind) && /^[0-9a-f]{64}$/.test(body?.offerId ?? '');
    const key = replaceable ? `${channel}/offer/${payload.from}/${body.offerId}`
      : authenticated && kind === 'heartbeat' ? `${channel}/heartbeat/${payload.from}/${payload.message.from}` : `${channel}/${payload.id}`;
    const old = state.queue.get(key);
    // Cancellation is final for an offer ID; a delayed reannouncement must not erase its queued tombstone.
    if (replaceable && kind === 'offer' && old?.payload.message.kind === 'cancel') { this.coalesced++; return true; }
    if (state.bytes - (old?.bytes ?? 0) + bytes > this.maxQueue) { this.dropped++; return false; }
    if (old) this.coalesced++;
    state.bytes += bytes - (old?.bytes ?? 0);
    state.queue.set(key, { record, channel, payload, direction, bytes });
    this.flush(state);
    return true;
  }

  flush(state) {
    if (this.states.get(state.connection) !== state || state.blocked) return;
    clearTimeout(state.timer); state.timer = null;
    const now = this.now();
    state.tokens = Math.min(this.burst, state.tokens + Math.max(0, now - state.at) * this.rate / 1000); state.at = now;
    for (const [key, item] of state.queue) {
      if (item.record.channel?.closed || item.record.channel?.destroyed || state.connection.destroyed) {
        state.queue.delete(key); state.bytes -= item.bytes; continue;
      }
      if (state.tokens < item.bytes) {
        state.timer = setTimeout(() => this.flush(state), Math.max(1, Math.ceil((item.bytes - state.tokens) * 1000 / this.rate)));
        state.timer.unref?.(); return;
      }
      state.tokens -= item.bytes; state.queue.delete(key); state.bytes -= item.bytes;
      let result;
      try { result = this.send(item); }
      catch { this.dropped++; this.remove(state.connection); return; }
      if (result === false && typeof state.connection.once === 'function') {
        state.blocked = true; state.connection.once('drain', state.drain); return;
      }
    }
  }

  stats() { return { peers: this.states.size, queuedBytes: [...this.states.values()].reduce((n, s) => n + s.bytes, 0), dropped: this.dropped, coalesced: this.coalesced }; }

  remove(connection) {
    const state = this.states.get(connection); if (!state) return;
    clearTimeout(state.timer); connection.off?.('close', state.close); connection.off?.('drain', state.drain);
    this.states.delete(connection);
  }

  close() { for (const connection of this.states.keys()) this.remove(connection); }
}
