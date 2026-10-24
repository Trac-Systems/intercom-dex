import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { duplexPair } from 'node:stream';
import { registerHooks } from 'node:module';
import Protomux from '../../../peer/node_modules/protomux/index.js';
import UDX from '../../../peer/node_modules/udx-native/lib/udx.js';
import c from '../../../peer/node_modules/compact-encoding/index.js';
import { Bandwidth } from '../../../peer/runtime/bandwidth.js';
import { replicateReader, RESET_CONNECTIONS } from '../../../peer/runtime/reader-network.js';
import { dexTransport, TRADER_DISCOVERY_PEERS } from '../../../peer/features/dex-transport.js';
import Hyperswarm from '../../../peer/node_modules/hyperswarm/index.js';
import { peerTransport, LOCKS_CHANNEL } from '../../../peer/features/locks-bridge.js';
import Sidechannel from '../../../peer/features/sidechannel/index.js';
import { measurePublic, measureReplication } from './bandwidth-fixture.mjs';
import { runBare } from './pow-bare.mjs';
import { fileURLToPath } from 'node:url';

const turn = () => new Promise(resolve => setImmediate(resolve));
const count = (snapshot, subsystem, direction, layer = 'protocol') => snapshot.rows
  .filter(row => row.layer === layer && row.subsystem === subsystem && row.direction === direction)
  .reduce((sum, row) => sum + row.bytes, 0);

test('public traffic reaches the venue and observer once while only the venue forwards to updated leaves', async () => {
  const before = await measurePublic({ legacy: true, traders: 4, seconds: 15 });
  const after = await measurePublic({ traders: 4, seconds: 15 });
  assert.equal(after.reachedVenue, before.reachedVenue);
  assert.equal(after.heard, before.heard);
  assert.equal(after.reachedVenue, 3); assert.equal(after.heard, 8);
  assert.equal(count(after, 'sidechannel', 'relayed'), 0);
  assert.ok(count(after, 'sidechannel', 'received') < count(before, 'sidechannel', 'received') / 3);
});

test('mixed legacy forwarders and makers interoperate, and existing full-book/delta refreshes arrive', async () => {
  const current = await measurePublic({ traders: 4, seconds: 60, books: true });
  const mixed = await measurePublic({ traders: 4, seconds: 60, books: true, legacyNodes: [0, 2, 6] });
  assert.equal(mixed.reachedVenue, current.reachedVenue); assert.equal(mixed.heard, current.heard);
  assert.equal(count(mixed, 'sidechannel', 'relayed'), 0);
  for (const kind of ['book', 'bookDelta']) assert.ok(current.rows.some(row => row.detail === `intercom-dex/${kind}`));
});

test('real optional delivery handshake suppresses only forwarded public copies to new leaves; legacy neighbors retain their path', async t => {
  const privateChannel = 'intercom-dex:t:' + 'c'.repeat(64);
  for (const legacy of [false, true]) {
    const streams = duplexPair(), nodes = [], delivered = [[], []];
    t.after(async () => { for (const node of nodes) await node.stop(); for (const stream of streams) stream.destroy(); });
    for (let i = 0; i < 2; i++) {
      const config = dexTransport({ role: i === 0 ? 'signer' : 'trader', servicePeerKey: 'a'.repeat(64) }).sidechannel;
      // Exercise the optional preference protocol independently of venue-only public routing.
      config.publicDelivery.venueOnly = false;
      if (legacy && i === 1) { delete config.publicDelivery; delete config.noRelayChannels; }
      const node = new Sidechannel({}, { ...config, powEnabled: false, onMessage: (ch, p) => delivered[i].push({ ch, p }) });
      nodes.push(node); streams[i].userData = new Protomux(streams[i]);
      for (const channel of ['intercom-dex:offers', privateChannel]) node._openChannelForConnection(streams[i], node._registerChannel(channel));
    }
    await Promise.all(nodes.map((node, i) => node.connections.get(streams[i]).get('intercom-dex:offers').channel.fullyOpened()));
    if (!legacy) await Promise.all(nodes.map((node, i) => node.deliverySessions.get(streams[i]).fullyOpened()));
    assert.equal(nodes[0].publicLeaves.has(streams[0]), false, 'without a direct venue channel, preserve the relay path');
    const venue = { remotePublicKey: Buffer.from('a'.repeat(64), 'hex') };
    if (!legacy) {
      nodes[1].connections.set(venue, new Map([['intercom-dex', { channel: { opened: true }, message: { send() {} } }]]));
      nodes[1]._updatePublicDelivery(); await turn();
    }
    assert.equal(nodes[0].publicLeaves.has(streams[0]), !legacy);
    nodes[0]._relay('intercom-dex:offers', await nodes[0]._buildPayload('intercom-dex:offers', { kind: 'offer' }), null);
    await turn(); assert.equal(delivered[1].length, legacy ? 1 : 0);
    await nodes[0].broadcast('intercom-dex:offers', { kind: 'heartbeat' });
    nodes[0]._relay(privateChannel, await nodes[0]._buildPayload(privateChannel, { kind: 'deal' }), null);
    await turn(); assert.equal(delivered[1].length, legacy ? 3 : 2);
    if (!legacy) {
      nodes[1].connections.delete(venue); nodes[1]._updatePublicDelivery(); await turn();
      assert.equal(nodes[0].publicLeaves.has(streams[0]), false, 'losing the venue re-enables signer forwarding');
      const delivery = nodes[0].deliverySessions.get(streams[0]);
      delivery.close(); await turn();
      assert.equal(nodes[0].publicLeaves.has(streams[0]), false);
      nodes[0]._relay('intercom-dex:offers', await nodes[0]._buildPayload('intercom-dex:offers', { kind: 'offer', retry: true }), null);
      await turn(); assert.equal(delivered[1].length, 3, 'closed preferences restore forwarding');
      await nodes[0].stop(); delivery.onopen(1);
      assert.equal(nodes[0].publicLeaves.has(streams[0]), false, 'a late handshake cannot resurrect a stopped preference');
    }
  }
});

test('invalid delivery flags grant no preference and a venue always forwards to an opted-in leaf', async () => {
  for (const role of ['service', 'signer']) {
    const node = new Sidechannel({}, dexTransport({ role, servicePeerKey: 'a'.repeat(64) }).sidechannel);
    let options; const connection = {}, sent = [];
    node._openPublicDelivery(connection, { createChannel(value) {
      options = value; return { open() {}, close: value.onclose, addMessage: () => ({ send() {} }) };
    } });
    options.onopen(2); assert.equal(node.publicLeaves.has(connection), false);
    const state = data => ({ start: 0, end: data.length, buffer: data });
    assert.throws(() => options.handshake.decode(state(Buffer.from([255]))), /Malformed public delivery frame/);
    node.rateLimits.clear(); node.rateBurstBytes = 1;
    assert.equal(options.handshake.decode(state(Buffer.from([0]))), 0);
    assert.equal(options.handshake.decode(state(Buffer.from([1]))), -1, 'delivery controls share the connection admission budget');
    options.onopen(1); assert.equal(node.publicLeaves.has(connection), true);
    options.onopen(-1); assert.equal(node.publicLeaves.has(connection), false, 'rate-refused controls restore forwarding');
    options.onopen(1);
    node.connections.set(connection, new Map([['intercom-dex:offers', {
      channel: { opened: true }, message: { send: payload => sent.push(payload) },
    }]]));
    node._relay('intercom-dex:offers', { ttl: 3, message: { kind: 'offer' } }, null);
    assert.equal(sent.length, role === 'service' ? 1 : 0);
    await node.stop();
  }
});

test('public forwarding policy preserves private trade relays and server discovery, including locks', async () => {
  for (const role of ['service', 'signer', 'trader', 'market-feed']) {
    const config = dexTransport({ role, servicePeerKey: 'a'.repeat(64) }).sidechannel;
    const sc = new Sidechannel({}, config), sent = [];
    for (const name of ['intercom-dex:offers', 'intercom-dex', 'intercom-dex:signers', 'intercom-dex:t:' + 'b'.repeat(64)]) {
      sc.connections.set({}, new Map([[name, { channel: { opened: true }, message: { send: value => sent.push(value) } }]]));
      const before = sent.length;
      sc._relay(name, { ttl: 3, message: { kind: 'offer' } }, null);
      assert.equal(sent.length - before, ['service', 'signer'].includes(role) || name.startsWith('intercom-dex:t:') ? 1 : 0);
    }
    await sc.stop();
  }
  const config = peerTransport({ role: 'trader', locks: true, servicePeerKey: 'a'.repeat(64) }).sidechannel;
  assert.ok(config.noRelayChannels.includes(LOCKS_CHANNEL));
  const joined = [], swarm = new EventEmitter();
  Object.assign(swarm, { join: (topic, options) => joined.push(options), flush: async () => {}, connections: new Set() });
  const sc = new Sidechannel({ swarm }, { ...config, channels: ['intercom-dex:offers'] });
  await sc.start();
  await sc.addChannel('intercom-dex:t:' + 'b'.repeat(64));
  assert.deepEqual(joined, [{ server: true, client: true }]);
  await sc.stop();
});

test('trader discovery is capped while the installed swarm still admits explicit trade peers at the cap', async t => {
  for (const role of ['trader', 'market-feed']) {
    const transport = peerTransport({ role, servicePeerKey: 'a'.repeat(64), locks: true });
    assert.deepEqual(transport.connections, { maxPeers: TRADER_DISCOVERY_PEERS, maxClientConnections: TRADER_DISCOVERY_PEERS });
  }
  for (const role of ['signer', 'service']) assert.equal(dexTransport({ role, servicePeerKey: 'a'.repeat(64) }).connections, undefined);
  const dht = new EventEmitter(), dialed = [];
  dht.createServer = () => ({ close: async () => {} });
  dht.destroy = async () => {};
  dht.connect = remotePublicKey => {
    const connection = new EventEmitter();
    Object.assign(connection, { remotePublicKey, destroy() { this.emit('close'); } });
    dialed.push(connection); return connection;
  };
  const swarm = new Hyperswarm({ dht, keyPair: { publicKey: Buffer.alloc(32, 99) },
    ...dexTransport({ role: 'trader', servicePeerKey: 'a'.repeat(64) }).connections });
  t.after(() => swarm.destroy());
  swarm._clientConnections = TRADER_DISCOVERY_PEERS;
  swarm._handlePeer({ publicKey: Buffer.alloc(32, 1) }, Buffer.alloc(32, 2));
  assert.equal(dialed.length, 0, 'ordinary discovery waits');
  swarm.joinPeer(Buffer.alloc(32, 1)); swarm._attemptClientConnections();
  assert.equal(dialed.length, 1, 'a pinned trade peer bypasses the discovery cap');
  dialed[0].destroy();
});

test('sidechannel counts encoded duplicate and rejected receives; distinguishes local sends from relays on real Protomux', async t => {
  const streams = duplexPair(), meters = [new Bandwidth(), new Bandwidth()], nodes = [];
  t.after(async () => { for (const stream of streams) stream.destroy(); for (const sc of nodes) await sc.stop(); for (const meter of meters) await meter.close(); });
  for (let i = 0; i < 2; i++) {
    const sc = new Sidechannel({}, { bandwidth: meters[i], welcomeRequired: false, onMessage() {} });
    nodes.push(sc); streams[i].userData = new Protomux(streams[i]);
    sc._openChannelForConnection(streams[i], sc._registerChannel('test'));
  }
  const records = nodes.map((node, i) => node.connections.get(streams[i]).get('test'));
  await Promise.all(records.map(record => record.channel.fullyOpened()));
  const payload = await nodes[0]._buildPayload('test', { kind: 'offer', text: 'é' });
  for (let i = 0; i < 2; i++) nodes[0]._send(records[0], 'test', payload);
  await turn();
  assert.equal(count(meters[0].snapshot(), 'sidechannel', 'originated'), c.encode(c.json, payload).length * 2);
  assert.equal(count(meters[1].snapshot(), 'sidechannel', 'received'), c.encode(c.json, payload).length * 2);
  nodes[1].rateBurstBytes = 1;
  nodes[1].rateLimits.clear();
  nodes[0]._send(records[0], 'test', payload, 'relayed'); await turn();
  assert.equal(count(meters[0].snapshot(), 'sidechannel', 'relayed'), c.encode(c.json, payload).length);
  assert.equal(count(meters[1].snapshot(), 'sidechannel', 'received'), c.encode(c.json, payload).length * 3);
  assert.ok(meters[1].snapshot().rows.some(row => row.detail === 'test/unknown'));
  records[0].channel.close();
  const before = count(meters[0].snapshot(), 'sidechannel', 'originated');
  assert.equal(nodes[0]._send(records[0], 'test', payload), false);
  assert.equal(count(meters[0].snapshot(), 'sidechannel', 'originated'), before);
});

test('bounded counters fold private trade IDs and never retain payloads', async () => {
  const meter = new Bandwidth({ limit: 8 });
  for (let i = 0; i < 100; i++) meter.sidechannel('intercom-dex:t:' + i.toString(16).padStart(64, '0'),
    { message: { kind: 'deal', secret: 'never-store-this' } }, 'received', 100);
  assert.equal(meter.snapshot().rows.length, 1);
  for (let i = 0; i < 100; i++) meter.sidechannel(`untrusted-${i}`, { message: { kind: i } }, 'received', 50);
  assert.ok(meter.snapshot().rows.length <= 9);
  assert.equal(count(meter.snapshot(), 'sidechannel', 'received'), 15000);
  assert.equal(JSON.stringify(meter.snapshot()).includes('never-store-this'), false);
  assert.doesNotThrow(() => meter.sidechannel('test', { message: { kind: { toString: 1, valueOf: 2 } } }, 'received', 40));
  await meter.close();
});

test('DHT datagrams and native UDP bytes are counted separately, hooks restore and closed sockets do not count sends', async t => {
  const udx = new UDX(), meter = new Bandwidth();
  meter.trackUdx(udx, 'peer');
  const a = udx.createSocket(), b = udx.createSocket();
  a.bind(0, '127.0.0.1'); b.bind(0, '127.0.0.1');
  t.after(async () => { await meter.close(); await a.close(); await b.close(); });
  const received = once(b, 'message');
  a.trySend(Buffer.from('local-dht-packet'), b.address().port, '127.0.0.1');
  await received;
  const snapshot = meter.snapshot();
  assert.equal(count(snapshot, 'peer/dht', 'sent'), 16);
  assert.equal(count(snapshot, 'peer/dht', 'received'), 16);
  assert.ok(count(snapshot, 'peer', 'sent', 'udp') >= 16);
  const wrapped = a.trySend;
  await meter.close(); assert.notEqual(a.trySend, wrapped);
});

test('real Autobase counters include per-core proofs and blocks without downloading deterministic view rewrites', async () => {
  const result = await measureReplication({ readers: 2, rounds: 2, viewBytes: 100000 });
  assert.ok(result.signedLength > 0);
  assert.ok(count({ rows: result.reader }, 'reset', 'received') > count({ rows: result.reader }, 'reset', 'received', 'blocks'));
  assert.ok(count({ rows: result.reader }, 'reset', 'received') < 10000);
  assert.ok(result.reader.every(row => /^[0-9a-f]{64}$/.test(row.detail)));
});

test('RESET discovery has three outgoing slots, no seed announcement, bounded flush and unchanged Autobase replication', async () => {
  class Swarm extends EventEmitter {
    constructor(options) { super(); this.options = options; }
    join(topic, options) { this.topic = topic; this.discovery = options; }
    flush() { return new Promise(() => {}); }
  }
  const replicated = [], reader = { config: { dhtBootstrap: ['127.0.0.1:1'], channel: Buffer.alloc(32) },
    base: { replicate: connection => { replicated.push(connection); return new EventEmitter(); } } };
  await replicateReader(reader, null, { Swarm, timeoutMs: 1 });
  assert.equal(reader.swarm.options.maxPeers, RESET_CONNECTIONS);
  assert.equal(reader.swarm.options.firewall(null, null), false);
  assert.equal(reader.swarm.options.firewall(null, {}), true);
  assert.deepEqual(reader.swarm.discovery, { server: false, client: true });
  const connection = new EventEmitter(); reader.swarm.emit('connection', connection);
  assert.deepEqual(replicated, [connection]);
  reader.base.closing = true; let destroyed = false;
  reader.swarm.emit('connection', { destroy: () => { destroyed = true; } });
  assert.equal(destroyed, true); assert.equal(replicated.length, 1);
  class Failing extends Swarm { flush() { return Promise.reject(new Error('discovery failed')); } }
  await assert.rejects(replicateReader(reader, null, { Swarm: Failing }), /discovery failed/);
});

test('bandwidth bridge snapshots require authentication and are additive to existing commands', async () => {
  const loader = registerHooks({ resolve: (name, context, next) => next(name === 'bare-ws' ? 'ws' : name, context) });
  const { default: DexBridge } = await import('../../../peer/features/dex-bridge.js'); loader.deregister();
  const meter = new Bandwidth(), bridge = new DexBridge({ bandwidth: meter }, { requireAuth: true });
  const replies = []; bridge._broadcastToClient = (_client, value) => replies.push(value);
  bridge._handleClientMessage({ authed: false }, { id: 1, type: 'bandwidth.stats' });
  assert.match(replies.at(-1).error, /Unauthorized/);
  bridge._handleClientMessage({ authed: true }, { id: 2, type: 'bandwidth.stats' });
  assert.equal(replies.at(-1).id, 2); assert.equal(replies.at(-1).type, 'bandwidth.stats');
  assert.deepEqual(replies.at(-1).stats.rows, []);
  await meter.close(); bridge.stop();
});

test('bandwidth accounting imports and measures native datagrams in the production Bare runtime', async () => {
  const result = await runBare(fileURLToPath(new URL('./bandwidth-runtime.mjs', import.meta.url)));
  assert.match(result.stdout, /Bare bandwidth accounting passed/);
});

test('the venue is pinned before any registry and retained when registry relay keys change; self is never dialed', async () => {
  const loader = registerHooks({ resolve: (name, context, next) => next(name === 'bare-ws' ? 'ws' : name, context) });
  const { default: DexBridge } = await import('../../../peer/features/dex-bridge.js'); loader.deregister();
  const joined = [], left = [], servicePeerKey = 'a'.repeat(64);
  const swarm = { peers: new Map(), keyPair: { publicKey: Buffer.alloc(32, 1) },
    joinPeer: key => joined.push(key.toString('hex')), leavePeer: key => left.push(key.toString('hex')),
    _attemptClientConnections() {} };
  const bridge = new DexBridge({ swarm }, { info: { servicePeerKey } });
  assert.deepEqual(joined, [servicePeerKey]);
  bridge._pinRegistryPeers(['b'.repeat(64)]); bridge._pinRegistryPeers([]);
  assert.deepEqual(left, ['b'.repeat(64)]); assert.ok(bridge.registryPins.has(servicePeerKey));
  bridge.stop();
  const self = new DexBridge({ swarm }, { info: { servicePeerKey: swarm.keyPair.publicKey.toString('hex') } });
  assert.equal(self.registryPins.size, 0); self.stop();
});
