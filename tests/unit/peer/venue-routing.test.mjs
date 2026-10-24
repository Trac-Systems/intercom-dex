import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { duplexPair } from 'node:stream';
import Protomux from '../../../peer/node_modules/protomux/index.js';
import Sidechannel from '../../../peer/features/sidechannel/index.js';
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
