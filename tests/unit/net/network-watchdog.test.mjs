import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { NetworkWatchdog, NETWORK_SILENCE_MS, NETWORK_RETRY_MS, MARKET_CHANNELS, NETWORK_RECONNECTING } from '../../../src/net/network-watchdog.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

class Bridge extends EventEmitter {
  constructor() { super(); this.calls = []; this.channels = ['intercom-dex:t:running', 'intercom-locks:p:running']; this.connections = 0; }
  async subscribe(channels) { this.calls.push(['subscribe', channels]); return this.stall?.promise ?? { channels: [...this.channels] }; }
  async request(body) {
    this.calls.push([body.type, body.channels]);
    if (body.type === 'unsubscribe') this.channels = this.channels.filter(ch => !body.channels.includes(ch));
    return {};
  }
  async join(channel) { this.calls.push(['join', channel]); }
  async stats() { return { connectionCount: 2, sidechannelStarted: true, channels: MARKET_CHANNELS }; }
  async reconnect() {
    this.connections++; this.emit('close');
    if (this.fail) throw Error('peer unavailable');
    this.stall = null; this.channels = [];
    if (this.opening) await this.opening.promise;
  }
  close() { this.calls.push(['close']); this.emit('close'); }
}

function fixture(t, { validate } = {}) {
  let now = 0, signers = true, restored = 0;
  const bridge = new Bridge(), logs = [];
  const watch = new NetworkWatchdog({ bridge, hasSigners: () => signers, now: () => now,
    restore: async () => { restored++; }, validate, log: (...args) => logs.push(args) });
  bridge.on('message', kind => watch.heard(kind));
  watch.start(); t.after(() => watch.stop());
  return { watch, bridge, logs, restored: () => restored, time: value => { now = value; watch.check(); }, signers: value => { signers = value; } };
}

test('silent bridge re-subscribes at 90 s, preserves all trade/locks subscriptions and recovers on a heartbeat', async t => {
  const f = fixture(t);
  f.time(NETWORK_SILENCE_MS - 1); assert.equal(f.bridge.calls.length, 0); assert.equal(f.watch.status().reconnecting, false);
  f.time(NETWORK_SILENCE_MS); await turn();
  assert.equal(f.watch.status().message, NETWORK_RECONNECTING);
  assert.deepEqual(f.bridge.channels, [], 'empty subscription means ALL, including future trade and locks channels');
  assert.deepEqual(f.bridge.calls.filter(c => c[0] === 'join').map(c => c[1]), MARKET_CHANNELS);
  f.time(NETWORK_SILENCE_MS + 30000); f.bridge.emit('message', 'heartbeat'); f.watch.check();
  f.time(NETWORK_SILENCE_MS + NETWORK_RETRY_MS);
  assert.equal(f.bridge.connections, 0); assert.equal(f.watch.status().reconnecting, false);
  assert.equal(f.logs.filter(l => l[0] === 'DEX network traffic recovered').length, 1);
});

test('a resubscription that hangs without close cannot prevent bridge replacement; late completions do no work', async t => {
  const f = fixture(t), stuck = deferred(); f.bridge.stall = stuck;
  f.time(NETWORK_SILENCE_MS); await turn();
  assert.equal(f.bridge.connections, 0);
  f.time(NETWORK_SILENCE_MS + NETWORK_RETRY_MS - 1); assert.equal(f.bridge.connections, 0);
  f.time(NETWORK_SILENCE_MS + NETWORK_RETRY_MS); await turn();
  assert.equal(f.bridge.connections, 1); assert.equal(f.restored(), 1);
  const calls = f.bridge.calls.length;
  stuck.resolve({ channels: ['obsolete'] }); await turn(); assert.equal(f.bridge.calls.length, calls);
  f.bridge.emit('message', 'market'); f.watch.check(); assert.equal(f.watch.status().reconnecting, false);
});

test('request replies do not count as market traffic and continued silence retries at a bounded cadence', async t => {
  const f = fixture(t); f.time(NETWORK_SILENCE_MS); await turn();
  assert.ok(f.logs.some(l => l[0] === 'DEX bridge responding'));
  f.time(NETWORK_SILENCE_MS + NETWORK_RETRY_MS); await turn(); assert.equal(f.bridge.connections, 1);
  for (let i = 0; i < 10; i++) f.watch.check();
  assert.equal(f.bridge.connections, 1);
  f.time(NETWORK_SILENCE_MS + 2 * NETWORK_RETRY_MS); await turn(); assert.equal(f.bridge.connections, 2);
});

test('a registry without active signers and a market with continuing authenticated traffic do not trigger recovery', async t => {
  const f = fixture(t); f.signers(false); f.time(10 * NETWORK_SILENCE_MS); assert.equal(f.bridge.calls.length, 0);
  f.bridge.emit('message', 'market'); f.signers(true); f.watch.check();
  assert.equal(f.watch.status().reconnecting, false); assert.equal(f.bridge.calls.length, 0);
  f.time(11 * NETWORK_SILENCE_MS - 1); assert.equal(f.bridge.calls.length, 0);
});

test('close recovers immediately, failed handshakes retry, and stop cancels pending restore and detaches listeners', async t => {
  const f = fixture(t); f.bridge.fail = true;
  f.bridge.emit('close'); await turn(); assert.equal(f.bridge.connections, 1); assert.equal(f.restored(), 0);
  f.time(NETWORK_RETRY_MS - 1); assert.equal(f.bridge.connections, 1);
  f.bridge.fail = false; f.bridge.opening = deferred();
  f.time(NETWORK_RETRY_MS); await turn(); assert.equal(f.bridge.connections, 2);
  f.watch.stop(); f.bridge.opening.resolve(); await turn();
  f.bridge.emit('close'); f.time(10 * NETWORK_RETRY_MS); await turn();
  assert.equal(f.restored(), 0); assert.equal(f.bridge.connections, 2); assert.equal(f.bridge.listenerCount('close'), 0);
});

test('a reconnected peer must pass validation before subscriptions or trade restoration', async t => {
  const f = fixture(t, { validate: async () => { throw Error('wrong peer'); } });
  f.bridge.emit('close'); await turn();
  assert.equal(f.restored(), 0); assert.deepEqual(f.bridge.calls, [['close']]);
  assert.ok(f.logs.some(l => l[0] === 'DEX bridge recovery failed; will retry' && l[1] === 'wrong peer'));
});
