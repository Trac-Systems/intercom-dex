import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { duplexPair } from 'node:stream';
import Protomux from '../../../peer/node_modules/protomux/index.js';
import Sidechannel, { PUBLIC_REPAIR_MS } from '../../../peer/features/sidechannel/index.js';
import { dexTransport } from '../../../peer/features/dex-transport.js';

const venueKey = 'a'.repeat(64), traderKey = 'b'.repeat(64), oldKey = 'c'.repeat(64);
const offers = 'intercom-dex:offers', trade = 'intercom-dex:t:' + 'd'.repeat(64);
const turn = () => new Promise(resolve => setImmediate(resolve));

function node(key, role, legacy = false) {
  const config = dexTransport({ role, servicePeerKey: venueKey }).sidechannel;
  if (legacy) { delete config.publicDelivery; delete config.noRelayChannels; delete config.publicSend; }
  const received = [];
  const sc = new Sidechannel({}, { ...config, powEnabled: false, channels: [offers, trade],
    onMessage: (channel, payload) => received.push({ channel, message: payload.message }) });
  return { key, sc, received };
}

function connect(t, a, b) {
  const [left, right] = duplexPair();
  t.after(() => { left.destroy(); right.destroy(); });
  for (const [source, target, connection] of [[a, b, left], [b, a, right]]) {
    connection.remotePublicKey = Buffer.from(target.key, 'hex');
    connection.userData = Protomux.from(connection);
    for (const entry of source.sc.channels.values()) source.sc._openChannelForConnection(connection, entry);
  }
  return [left, right];
}

test('legacy venue forwards both maker versions while its new leaf refuses public protocols to legacy neighbors', async t => {
  const venue = node(venueKey, 'service', true), leaf = node(traderKey, 'trader'), old = node(oldKey, 'trader', true);
  const nodes = [venue, leaf, old];
  t.after(async () => { for (const n of nodes) await n.sc.stop(); });
  const [venueLeaf, leafVenue] = connect(t, venue, leaf);
  const [venueOld, oldVenue] = connect(t, venue, old);
  const [leafOld, oldLeaf] = connect(t, leaf, old);
  await Promise.all([[venue, venueLeaf], [leaf, leafVenue], [venue, venueOld], [old, oldVenue]]
    .map(([n, c]) => n.sc.connections.get(c).get(offers).channel.fullyOpened()));
  assert.equal(leaf.sc.connections.get(leafOld).has(offers), false);
  const privateA = leaf.sc.connections.get(leafOld).get(trade), privateB = old.sc.connections.get(oldLeaf).get(trade);
  await Promise.all([privateA.channel.fullyOpened(), privateB.channel.fullyOpened()]);
  await old.sc.broadcast(offers, { kind: 'offer', id: 'old' });
  await turn(); await turn();
  assert.deepEqual(leaf.received.filter(m => m.channel === offers).map(m => m.message.id), ['old']);
  await leaf.sc.broadcast(offers, { kind: 'offer', id: 'new' });
  await turn(); await turn();
  assert.deepEqual(old.received.filter(m => m.channel === offers).map(m => m.message.id), ['new']);
  await old.sc.broadcast(trade, { kind: 'terms' });
  await turn(); await turn();
  assert.ok(leaf.received.some(m => m.channel === trade && m.message.kind === 'terms'));
  // Loss of the venue does not silently reopen the flooding public protocols.
  leafVenue.destroy(); await turn();
  leaf.sc._openChannelForConnection(leafOld, leaf.sc.channels.get(offers));
  assert.equal(leaf.sc.connections.get(leafOld).has(offers), false);
});

test('trader and feed never discover public DEX topics, including late joins and restarts; private discovery remains', async () => {
  for (const role of ['trader', 'market-feed']) {
    const calls = [], swarm = new EventEmitter();
    Object.assign(swarm, { connections: new Set(), join: (topic, options) => calls.push(options), leave() {}, flush: async () => {} });
    const config = dexTransport({ role, servicePeerKey: venueKey }).sidechannel;
    const sc = new Sidechannel({ swarm }, { ...config, channels: [offers] });
    await sc.start(); assert.equal(calls.length, 0);
    assert.equal(await sc.addChannel('intercom-dex:signers'), true); assert.equal(calls.length, 0);
    assert.equal(await sc.addChannel(trade), true); assert.deepEqual(calls, [{ server: true, client: true }]);
    await sc.stop(); await sc.start(); assert.equal(calls.length, 2);
    await sc.stop();
  }
});

test('only the configured venue public key can open public protocols; an absent key is rejected', () => {
  const leaf = node(traderKey, 'trader');
  for (const connection of [{}, { remotePublicKey: Buffer.from(oldKey, 'hex') }]) {
    connection.userData = { createChannel() { throw new Error('Untrusted public protocol opened'); } };
    leaf.sc._openChannelForConnection(connection, leaf.sc.channels.get(offers));
    assert.equal(leaf.sc.connections.has(connection), false);
  }
});

test('a listening trader repairs closed venue protocols and hears makers and books again without broadcasting', async t => {
  const callbacks = [];
  t.mock.method(globalThis, 'setInterval', (fn, ms) => { if (ms === PUBLIC_REPAIR_MS) callbacks.push(fn); return { unref() {} }; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const venue = node(venueKey, 'service'), leaf = node(traderKey, 'trader');
  t.after(async () => { await venue.sc.stop(); await leaf.sc.stop(); });
  const [venueLeaf, leafVenue] = connect(t, venue, leaf);
  for (const [n, connection] of [[venue, venueLeaf], [leaf, leafVenue]]) {
    const swarm = new EventEmitter();
    Object.assign(swarm, { connections: new Set([connection]), join() {}, flush: async () => {} });
    n.sc.peer.swarm = swarm;
    await n.sc.start();
  }
  await Promise.all([venue.sc.connections.get(venueLeaf).get(offers).channel.fullyOpened(), leaf.sc.connections.get(leafVenue).get(offers).channel.fullyOpened()]);
  leaf.sc.connections.get(leafVenue).get(offers).channel.close(); await turn();
  assert.equal(leaf.sc.connections.get(leafVenue).has(offers), false);
  assert.equal(callbacks.length, 2, 'venue discovery and leaf sessions both have recovery timers');
  callbacks[1](); await turn(); await turn();
  const record = leaf.sc.connections.get(leafVenue).get(offers);
  assert.ok(record); assert.equal(await record.channel.fullyOpened(), true);
  for (const kind of ['offer', 'bookDelta', 'tradeLog']) await venue.sc.broadcast(offers, { kind });
  await turn(); await turn();
  assert.deepEqual(leaf.received.map(m => m.message.kind), ['offer', 'bookDelta', 'tradeLog']);
  const before = leaf.sc.connections.get(leafVenue).get(offers);
  callbacks[1](); assert.equal(leaf.sc.connections.get(leafVenue).get(offers), before, 'healthy sessions stay open');
  await leaf.sc.stop(); callbacks[1](); assert.equal(leaf.sc.connections.size, 0);
});

test('public repair replaces a stuck opening session after its deadline, and ignores untrusted peers', async () => {
  const leaf = node(traderKey, 'trader');
  let now = 0, closed = 0, created = 0;
  leaf.sc._now = () => now; leaf.sc.started = true;
  const connection = { remotePublicKey: Buffer.from(venueKey, 'hex'), userData: { pair() {}, createChannel(options) {
    if (options.protocol === `sidechannel/${offers}`) created++;
    return { opened: false, closed: false, addMessage: message => message, open() {}, fullyOpened: () => new Promise(() => {}),
      close() { this.closed = true; closed++; options.onclose(); } };
  } } };
  const stranger = { remotePublicKey: Buffer.from(oldKey, 'hex'), userData: { createChannel() { assert.fail('untrusted peer'); } } };
  leaf.sc.peer.swarm = { connections: new Set([connection, stranger]) };
  leaf.sc._repairPublicChannels(); assert.equal(created, 1);
  now = 15000; leaf.sc._repairPublicChannels(); assert.equal(created, 1);
  now = 30000; leaf.sc._repairPublicChannels(); assert.equal(created, 2); assert.equal(closed, 1);
  await leaf.sc.stop();
});
