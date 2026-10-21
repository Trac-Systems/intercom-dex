import test from 'node:test';
import assert from 'node:assert/strict';
import { ChainWatch, webSocketUrl } from '../../../src/solana/chain-watch.js';

class FakeSocket {
  static all = [];
  constructor(url) { this.url = url; this.sent = []; this.closed = false; FakeSocket.all.push(this); }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.closed = true; }
  open() { this.onopen?.(); }
  slot(slot, root) { this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', method: 'slotNotification', params: { result: { slot, root, parent: slot - 1 }, subscription: 1 } }) }); }
  drop() { this.onclose?.(); }
}

const endpoints = ['https://a.example/', 'https://b.example/rpc?key=FREE', 'https://c.example/', 'http://127.0.0.1:8899/'];
function watch(options = {}) {
  FakeSocket.all = [];
  let now = 1000, updates = 0;
  const w = new ChainWatch({ endpoints, need: 2, WebSocketImpl: FakeSocket, now: () => now, onUpdate: () => updates++, ...options });
  return { w, advance: ms => { now += ms; }, updates: () => updates, socket: url => FakeSocket.all.filter(s => s.url === url).at(-1) };
}

test('WebSocket URLs follow the RPC URL, with the port + 1 when a port is named', () => {
  assert.equal(webSocketUrl('https://api.mainnet-beta.solana.com'), 'wss://api.mainnet-beta.solana.com/');
  assert.equal(webSocketUrl('https://b.example/rpc?key=FREE'), 'wss://b.example/rpc?key=FREE');
  assert.equal(webSocketUrl('http://127.0.0.1:8899'), 'ws://127.0.0.1:8900/');
  assert.throws(() => webSocketUrl('ftp://x.example'));
});

test('subscribes to slots on three nodes and reports the finalized slot `need` nodes reached and the highest tip', () => {
  const { w, socket, updates } = watch();
  w.start();
  assert.equal(FakeSocket.all.length, 3);
  for (const s of FakeSocket.all) { s.open(); assert.deepEqual(s.sent, [{ jsonrpc: '2.0', id: 1, method: 'slotSubscribe' }]); }
  assert.equal(w.view(3000), null);
  socket('wss://a.example/').slot(1100, 1060);
  assert.equal(w.view(3000), null);                       // one node is not a quorum
  socket('wss://b.example/rpc?key=FREE').slot(1102, 1062);
  socket('wss://c.example/').slot(1099, 1058);
  assert.deepEqual(w.view(3000), { finalized: 1060, tip: 1102, at: 1000 });
  assert.equal(updates(), 3);
  w.stop();
  assert.ok(FakeSocket.all.every(s => s.closed));
});

test('stale readings drop out of the view; malformed notifications are ignored', () => {
  const { w, socket, advance } = watch();
  w.start();
  socket('wss://a.example/').slot(10, 5);
  advance(2000);
  socket('wss://b.example/rpc?key=FREE').slot(12, 6);
  assert.deepEqual(w.view(3000), { finalized: 5, tip: 12, at: 1000 });
  advance(1500);
  assert.equal(w.view(3000), null);
  socket('wss://c.example/').onmessage({ data: '{"method":"slotNotification","params":{"result":{"slot":3,"root":9}}}' });
  socket('wss://c.example/').onmessage({ data: 'not json' });
  assert.equal(w.view(3000), null);
  w.stop();
});

test('a dropped or silent node is replaced by the next one and retried later', () => {
  const { w, socket, advance } = watch();
  w.start();
  socket('wss://a.example/').drop();
  assert.ok(socket('ws://127.0.0.1:8900/'), 'the fourth node takes the place of the dropped one');
  assert.equal(FakeSocket.all.filter(s => !s.closed && s.onmessage).length, 3);
  advance(1_000);
  w.stop(); w.start();                                    // restart: the dropped node waits for its retry time
  assert.equal(FakeSocket.all.filter(s => s.url === 'wss://a.example/').length, 1);
  w.stop(); advance(5_000); w.start();
  assert.equal(FakeSocket.all.filter(s => s.url === 'wss://a.example/').length, 2);
  w.stop();
});

test('without WebSocket support nothing starts and the view stays empty', () => {
  const w = new ChainWatch({ endpoints, need: 2, WebSocketImpl: null });
  assert.equal(w.available, false);
  w.start();
  assert.equal(w.view(3000), null);
  w.stop();
});
