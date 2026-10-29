import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Sidechannel, { CHANNEL_SILENCE_MS } from '../../../peer/features/sidechannel/index.js';
import { dexTransport } from '../../../peer/features/dex-transport.js';

const venueKey = 'a'.repeat(64), privateChannel = 'intercom-dex:t:' + 'b'.repeat(64);
const turn = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, role = 'trader') {
  let now = 0;
  const events = [], joins = [], pins = [], refreshes = [];
  const swarm = new EventEmitter();
  Object.assign(swarm, { connections: new Set(), join: topic => joins.push(topic), joinPeer: key => pins.push(key.toString('hex')),
    _attemptClientConnections() { this.attempts = (this.attempts ?? 0) + 1; }, flush: async () => {},
    status: topic => ({ refresh: () => { refreshes.push(topic); } }) });
  const sc = new Sidechannel({ swarm }, { ...dexTransport({ role, servicePeerKey: venueKey }).sidechannel,
    channels: ['intercom-dex', 'intercom-dex:signers'], networkLog: event => events.push(event) });
  sc._now = () => now;
  await sc.start(); t.after(() => sc.stop());
  return { sc, swarm, events, joins, pins, refreshes, time: value => { now = value; } };
}

test('missing venue sockets are redialed after three heartbeat periods, once for all public channels', async t => {
  const f = await fixture(t);
  f.time(CHANNEL_SILENCE_MS - 1); f.sc._repairDisconnectedChannels(); assert.equal(f.pins.length, 0);
  f.time(CHANNEL_SILENCE_MS); f.sc._repairDisconnectedChannels();
  assert.deepEqual(f.pins, [venueKey]); assert.equal(f.swarm.attempts, 1);
  assert.equal(f.joins.length, 0, 'venue-only leaves never join public DHT topics');
  f.sc._repairDisconnectedChannels(); assert.equal(f.pins.length, 1);
  const connection = { remotePublicKey: Buffer.from(venueKey, 'hex') }, records = new Map();
  for (const name of f.sc.channels.keys()) records.set(name, { channel: { opened: true }, message: {} });
  f.sc.connections.set(connection, records); f.swarm.connections.add(connection);
  f.time(2 * CHANNEL_SILENCE_MS); f.sc._repairDisconnectedChannels();
  assert.equal(f.pins.length, 1); assert.equal(f.events.filter(e => e.event === 'channel recovered').length, 2);
  f.sc._repairDisconnectedChannels(); assert.equal(f.events.filter(e => e.event === 'channel recovered').length, 2);
  connection.destroyed = true; f.sc._repairDisconnectedChannels();
  f.time(3 * CHANNEL_SILENCE_MS); f.sc._repairDisconnectedChannels(); assert.equal(f.pins.length, 2);
});

test('zero-connection discovery refreshes are single-flight and cannot resurrect removed/stopped channels', async t => {
  const f = await fixture(t, 'service'); let resolve, calls = 0;
  f.swarm.status = () => ({ refresh: () => { calls++; return new Promise(yes => { resolve = yes; }); } });
  f.time(CHANNEL_SILENCE_MS); f.sc._repairDisconnectedChannels(); await turn();
  assert.equal(calls, 2); assert.equal(f.joins.length, 2);
  f.time(3 * CHANNEL_SILENCE_MS); f.sc._repairDisconnectedChannels(); await turn(); assert.equal(calls, 2);
  await f.sc.stop(); resolve(); await turn();
  f.time(5 * CHANNEL_SILENCE_MS); f.sc._repairDisconnectedChannels(); assert.equal(calls, 2);
  assert.ok([...f.sc.channels.values()].every(e => !e.announced));
});

test('silent venue reopens public sessions then redials; private protocols remain untouched at the first step', async t => {
  const f = await fixture(t), reopened = [], closed = [];
  const records = new Map([...f.sc.channels.keys(), privateChannel].map(name => [name,
    { channel: { opened: true, close: () => closed.push(name) }, message: {} }]));
  const connection = { remotePublicKey: Buffer.from(venueKey, 'hex'), destroy() { this.destroyed = true; } };
  f.swarm.connections.add(connection); f.sc.connections.set(connection, records);
  f.sc._openChannelForConnection = (_c, entry) => reopened.push(entry.name);
  f.time(CHANNEL_SILENCE_MS); await f.sc.addChannel('intercom-dex');
  assert.deepEqual(closed, ['intercom-dex', 'intercom-dex:signers']);
  assert.ok(records.has(privateChannel)); assert.equal(connection.destroyed, undefined);
  assert.equal(f.events.at(-1).event, 'reopen silent venue channels');
  f.sc._repairSilentVenue(); assert.equal(reopened.length, 3, 'join opens once, repair opens the two public channels');
  f.time(2 * CHANNEL_SILENCE_MS); f.sc._repairSilentVenue();
  assert.equal(connection.destroyed, true); assert.deepEqual(f.pins, [venueKey]);
  assert.equal(f.events.at(-1).event, 'redial silent venue');
});

test('fresh public traffic clears a silence episode and a stopped peer does no repair', async t => {
  const f = await fixture(t);
  f.sc._silentVenueStage = 1; f.sc._publicHeardAt = CHANNEL_SILENCE_MS;
  f.time(CHANNEL_SILENCE_MS); f.sc._repairSilentVenue(); f.sc._repairSilentVenue();
  assert.equal(f.sc._silentVenueStage, 0); assert.equal(f.events.filter(e => e.event === 'venue traffic recovered').length, 1);
  await f.sc.stop(); f.time(3 * CHANNEL_SILENCE_MS); f.sc._repairSilentVenue(); f.sc._repairDisconnectedChannels();
  assert.equal(f.pins.length, 0);
});
