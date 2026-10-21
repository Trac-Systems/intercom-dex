import test from 'node:test';
import assert from 'node:assert/strict';
import { duplexPair } from 'node:stream';
import Protomux from '../../../peer/node_modules/protomux/index.js';
import Sidechannel from '../../../peer/features/sidechannel/index.js';
import { peerPresent } from '../../../peer/features/dex-presence.js';

const channel = 'intercom-dex:t:' + 'b'.repeat(64), peerKey = 'a'.repeat(64);
const turn = () => new Promise(resolve => setImmediate(resolve));

function pair(t) {
  const streams = duplexPair();
  t.after(() => { for (const stream of streams) stream.destroy(); });
  const peers = streams.map(connection => {
    connection.userData = new Protomux(connection);
    connection.remotePublicKey = Buffer.from(peerKey, 'hex');
    const received = [], sc = new Sidechannel({}, { welcomeRequired: false, onMessage: (_ch, p) => received.push(p) });
    const entry = sc._registerChannel(channel);
    sc._openChannelForConnection(connection, entry);
    return { connection, sc, entry, received, record: () => sc.connections.get(connection)?.get(channel) };
  });
  return peers;
}

test('real Protomux closes, reports absent, reopens and delivers; a late close cannot delete the replacement', async t => {
  const [a, b] = pair(t);
  await Promise.all([a.record().channel.fullyOpened(), b.record().channel.fullyOpened()]);
  assert.equal(peerPresent(a.sc, channel, peerKey), true);
  const old = a.record();
  old.channel.close();
  assert.equal(old.channel.opened, true, 'Protomux retains opened after close');
  assert.equal(peerPresent(a.sc, channel, peerKey), false);
  await turn();
  assert.equal(peerPresent(b.sc, channel, peerKey), false);
  a.sc._openChannelForConnection(a.connection, a.entry);
  b.sc._openChannelForConnection(b.connection, b.entry);
  const replacement = a.record();
  await Promise.all([replacement.channel.fullyOpened(), b.record().channel.fullyOpened()]);
  old.channel.onclose();
  assert.equal(a.record(), replacement);
  assert.equal(peerPresent(a.sc, channel, peerKey), true);
  await a.sc.broadcast(channel, { text: 'after reopen' });
  await turn();
  assert.equal(b.received.length, 1);
  assert.deepEqual(b.received[0].message, { text: 'after reopen' });
  a.connection.destroy();
  assert.equal(peerPresent(a.sc, channel, peerKey), false);
  a.sc._openChannelForConnection(a.connection, a.entry);
  await turn();
  assert.equal(a.record(), undefined);
});

function pending(t) {
  const timers = [], protocols = [];
  t.mock.method(globalThis, 'setTimeout', fn => { timers.push(fn); return timers.length; });
  const sc = new Sidechannel({}, { welcomeRequired: false });
  const entry = sc._registerChannel(channel);
  let paired;
  const connection = { userData: {
    pair(_options, fn) { paired = fn; },
    createChannel(options) {
      let resolve, reject;
      const opened = new Promise((yes, no) => { resolve = yes; reject = no; });
      const protocol = { ...options, opened: false, closed: false, destroyed: false, resolve, reject,
        addMessage: message => message, open() {}, fullyOpened: () => opened,
        close() { this.closed = true; options.onclose(); } };
      protocols.push(protocol); return protocol;
    }
  } };
  const open = () => sc._openChannelForConnection(connection, entry);
  open();
  return { sc, connection, entry, open, protocols, timers, paired: () => paired(), record: () => sc.connections.get(connection)?.get(channel) };
}

test('closed or destroyed records are replaced before the existing-record check; stale open callbacks do nothing', async t => {
  const f = pending(t), first = f.protocols[0];
  first.closed = true;
  f.open();
  const second = f.record();
  first.onclose(); first.resolve(false);
  await turn();
  assert.equal(f.record(), second); assert.equal(second.channel.closed, false); assert.equal(f.timers.length, 0);
  second.channel.destroyed = true;
  f.open();
  const third = f.record();
  second.channel.resolve(true);
  await turn();
  assert.equal(f.record(), third); assert.equal(third.authSent, false);
});

test('a rejected open retries, but an old retry cannot affect a later replacement', async t => {
  const f = pending(t);
  f.protocols[0].reject(new Error('open rejected'));
  await turn();
  assert.equal(f.record(), undefined); assert.equal(f.timers.length, 1);
  f.timers[0]();
  assert.equal(f.protocols.length, 2);
  const replacement = f.record();
  f.timers[0](); f.protocols[0].onclose();
  assert.equal(f.record(), replacement); assert.equal(f.protocols.length, 2);
});

for (const invalidation of ['destroy', 'remove', 'replace channel', 'stop']) test(`retry and pair callbacks ignore ${invalidation}`, async t => {
  const f = pending(t);
  f.protocols[0].close(); f.protocols[0].resolve(false);
  await turn();
  assert.equal(f.timers.length, 1);
  if (invalidation === 'destroy') f.connection.destroyed = true;
  if (invalidation === 'remove' || invalidation === 'replace channel') await f.sc.removeChannel(channel);
  if (invalidation === 'replace channel') f.sc._registerChannel(channel);
  if (invalidation === 'stop') await f.sc.stop();
  f.timers[0](); f.paired();
  assert.equal(f.protocols.length, 1);
  assert.equal(f.record(), undefined);
});

test('mux-not-ready timers cannot resurrect a stopped feature or destroyed connection', async t => {
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', fn => { timers.push(fn); return timers.length; });
  const sc = new Sidechannel({}), entry = sc._registerChannel(channel), connection = {};
  sc._openChannelForConnection(connection, entry);
  connection.destroyed = true;
  timers[0]();
  assert.equal(timers.length, 1); assert.equal(sc.connections.size, 0);
  connection.destroyed = false;
  sc._openChannelForConnection(connection, entry);
  await sc.stop(); timers[1]();
  assert.equal(timers.length, 2); assert.equal(sc.connections.size, 0);
});

test('a new join opens real Protomux on existing swarm connections before the announce flush finishes', async t => {
  const streams = duplexPair();
  let resolve;
  const flushed = new Promise(yes => { resolve = yes; });
  t.after(() => { resolve(); for (const stream of streams) stream.destroy(); });
  const peers = streams.map(connection => {
    connection.userData = new Protomux(connection);
    const swarm = { connections: new Set([connection]), join() {}, flush: () => flushed };
    const received = [], sc = new Sidechannel({ swarm }, { welcomeRequired: false, onMessage: (_ch, p) => received.push(p) });
    sc.started = true;
    let finished = false;
    const joining = sc.addChannel(channel).then(ok => { finished = true; return ok; });
    return { sc, connection, received, joining, finished: () => finished };
  });
  await Promise.all(peers.map(p => p.sc.connections.get(p.connection).get(channel).channel.fullyOpened()));
  await peers[0].sc.broadcast(channel, { text: 'before DHT flush' }); await turn();
  assert.equal(peers[1].received.length, 1);
  assert.ok(peers.every(p => !p.finished() && !p.sc.channels.get(channel).announced));
  resolve(); assert.deepEqual(await Promise.all(peers.map(p => p.joining)), [true, true]);
});

test('idempotent announced joins repair closed records over real Protomux', async t => {
  const peers = pair(t);
  await Promise.all(peers.map(p => p.record().channel.fullyOpened()));
  for (const p of peers) p.entry.announced = true;
  peers[0].record().channel.close(); await turn();
  for (const p of peers) assert.equal(await p.sc.addChannel(channel), true);
  await Promise.all(peers.map(p => p.record().channel.fullyOpened()));
  await peers[0].sc.broadcast(channel, { text: 'rejoined' }); await turn();
  assert.equal(peers[1].received.length, 1);
});

test('removing a channel during announcement closes its sessions, leaves its topic and cannot resurrect it', async t => {
  const f = pending(t); let resolve, left = 0;
  const flushed = new Promise(yes => { resolve = yes; });
  f.sc.peer.swarm = { join() {}, leave() { left++; }, flush: () => flushed };
  f.sc.started = true;
  const joining = f.sc.addChannel(channel);
  const removing = f.sc.removeChannel(channel);
  resolve();
  assert.equal(await joining, false); assert.equal(await removing, true);
  assert.equal(left, 1); assert.equal(f.entry.announced, false); assert.equal(f.record(), undefined);
  f.protocols[0].resolve(false); f.paired(); await turn();
  assert.equal(f.protocols.length, 1); assert.equal(f.sc.channels.has(channel), false);
});

test('a failed announcement reports failure after attempting to open existing connections', async t => {
  const f = pending(t);
  f.protocols[0].closed = true;
  f.sc.peer.swarm = { join() { throw new Error('announce rejected'); } };
  f.sc.started = true;
  assert.equal(await f.sc.addChannel(channel), false);
  assert.equal(f.protocols.length, 2); assert.notEqual(f.record().channel, f.protocols[0]);
  assert.notEqual(f.entry.announced, true);
  f.sc.peer.swarm.join = () => {};
  assert.equal(await f.sc.addChannel(channel), true, 'a failed announce can retry');
});

test('relay sends immediately only to usable authorized sessions; pending sessions are never awaited', () => {
  const sc = new Sidechannel({}), sent = [];
  const add = (name, connection = {}, protocol = {}) => {
    const record = { channel: { opened: true, ...protocol }, message: { send: p => sent.push({ name, p }) } };
    sc.connections.set(connection, new Map([[channel, record]])); return connection;
  };
  const origin = add('origin'); add('live'); add('closed', {}, { closed: true }); add('destroyed protocol', {}, { destroyed: true });
  add('destroyed connection', { destroyed: true });
  add('pending', {}, { opened: false, fullyOpened() { assert.fail('relay must not wait'); } });
  const unauthorized = add('unauthorized');
  sc.connections.set({}, new Map());
  sc._remoteAuthorized = (_ch, connection) => connection !== unauthorized;
  const payload = { id: 'repeat', channel, ttl: 3, message: { text: 'hello' } };
  sc._relay(channel, payload, origin);
  assert.deepEqual(sent.map(x => x.name), ['live']); assert.equal(sent[0].p.ttl, 2); assert.equal(payload.ttl, 3);
  sc._relay(channel, { ...payload, ttl: 0 }, origin);
  sc._relay(channel, { ...payload, message: { control: 'auth' } }, origin);
  sc._relay(channel, { ...payload, message: { control: 'welcome' } }, origin);
  assert.equal(sent.length, 1);
});

for (const invalidation of ['none', 'replace', 'remove', 'close', 'destroy', 'unauthorize', 'expire']) test(`pending broadcasts recheck their session after ${invalidation}`, async t => {
  const f = pending(t), sent = [], record = f.record();
  record.message.send = payload => sent.push(payload);
  let now = 100000, authorized = true;
  f.sc._now = () => now; f.sc.powEnabled = true; f.sc.powDifficulty = 4;
  f.sc._remoteAuthorized = () => authorized;
  await f.sc.broadcast(channel, { text: 'waiting' });
  assert.equal(sent.length, 0);
  if (invalidation === 'replace') { record.channel.closed = true; f.open(); }
  if (invalidation === 'remove') await f.sc.removeChannel(channel);
  if (invalidation === 'close') record.channel.close();
  if (invalidation === 'destroy') f.connection.destroyed = true;
  if (invalidation === 'unauthorize') authorized = false;
  if (invalidation === 'expire') now += 60000;
  record.channel.opened = true; record.channel.resolve(true);
  await turn();
  assert.equal(sent.length, invalidation === 'none' ? 1 : 0);
});
