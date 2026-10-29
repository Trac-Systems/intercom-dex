import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Bridge } from '../../../src/net/bridge.js';

class Socket extends EventEmitter {
  constructor({ open = true, auth = 'auth_ok' } = {}) {
    super(); this.readyState = 0; this.sent = []; this.auth = auth;
    if (open) queueMicrotask(() => { this.readyState = 1; this.emit('open'); });
  }
  send(text, callback) {
    const message = JSON.parse(text); this.sent.push(message);
    if (this.sendError) { callback(this.sendError); return; }
    if (message.type === 'auth' && this.auth) queueMicrotask(() => this.reply(message.id, { type: this.auth }));
  }
  reply(id, body) { this.emit('message', Buffer.from(JSON.stringify({ id, ...body }))); }
  close() { this.readyState = 2; } // Simulate a socket that never delivers close.
  terminate() { this.readyState = 3; this.terminated = true; }
}

function fixture(t, options = {}) {
  const sockets = [];
  const bridge = new Bridge({ url: 'unused', token: 'unit-test', timeoutMs: 50,
    socketFactory: () => { const socket = new Socket(options); sockets.push(socket); return socket; } });
  t.after(() => bridge.close({ force: true }));
  return { bridge, sockets };
}

test('forced reconnect fails pending work immediately, fences late socket events and never replays requests', async t => {
  const { bridge, sockets } = fixture(t); await bridge.connect();
  const first = sockets[0]; let closes = 0; bridge.on('close', () => closes++);
  const pending = bridge.send('intercom-dex:t:trade', { kind: 'deal' });
  const failed = assert.rejects(pending, /Bridge closed/);
  const reconnecting = bridge.reconnect();
  assert.equal(bridge.reconnect(), reconnecting, 'concurrent reconnects share a socket');
  await Promise.all([failed, reconnecting]);
  assert.equal(first.terminated, true); assert.equal(closes, 1);
  assert.equal(bridge.pending.size, 0); assert.equal(sockets.length, 2);
  assert.deepEqual(sockets[1].sent.map(m => m.type), ['auth']);
  const info = bridge.info(), id = sockets[1].sent.at(-1).id;
  first.reply(id, { type: 'info', info: 'wrong' }); first.emit('close'); first.emit('error', Error('late'));
  assert.equal(bridge.pending.size, 1); assert.equal(closes, 1);
  sockets[1].reply(id, { type: 'info', info: 'current' });
  assert.equal((await info).info, 'current'); assert.ok(bridge.lastReplyAt !== null);
});

test('connection and authentication stalls have deadlines and clean up sockets', async t => {
  for (const options of [{ open: false }, { auth: null }, { auth: 'denied' }]) {
    const { bridge, sockets } = fixture(t, options);
    await assert.rejects(bridge.connect(), /timeout|authentication failed/);
    assert.equal(sockets[0].terminated, true); assert.equal(bridge.pending.size, 0);
    assert.equal(bridge.ws, null);
  }
});

test('send callback and synchronous errors leave no pending requests or timers', async t => {
  const { bridge, sockets } = fixture(t); await bridge.connect();
  sockets[0].sendError = Error('send failed');
  await assert.rejects(bridge.info(), /send failed/); assert.equal(bridge.pending.size, 0);
  sockets[0].send = () => { throw Error('sync failure'); };
  await assert.rejects(bridge.info(), /sync failure/); assert.equal(bridge.pending.size, 0);
  bridge.close({ force: true });
  await assert.rejects(bridge.info(), /not connected/); assert.equal(bridge.pending.size, 0);
});

test('reconnect during a stalled opening cannot let the old handshake close the new one', async t => {
  const { bridge, sockets } = fixture(t, { open: false });
  const opening = assert.rejects(bridge.connect(), /Bridge closed/);
  const replacement = bridge.reconnect();
  sockets[1].readyState = 1; sockets[1].emit('open');
  await Promise.all([opening, replacement]);
  assert.equal(bridge.ws, sockets[1]); assert.equal(sockets[1].terminated, undefined);
});
