import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { duplexPair } from 'node:stream';
import Protomux from '../../peer/node_modules/protomux/index.js';
import Sidechannel from '../../peer/features/sidechannel/index.js';
import { collect, turn } from '../unit/peer/retention-fixture.mjs';

if (typeof globalThis.gc !== 'function') throw new Error('Run with node --expose-gc');
const streams = duplexPair(), refs = [];
const nodes = streams.map(connection => {
  connection.userData = new Protomux(connection);
  const swarm = Object.assign(new EventEmitter(), { connections: new Set([connection]), join() {}, leave() {}, flush: async () => {} });
  return new Sidechannel({ swarm }, { welcomeRequired: false });
});
async function cycle(i) {
  const name = 'intercom-dex:t:' + i.toString(16).padStart(64, '0');
  // DexBridge grants this property before each authenticated dex_join.
  for (const [i, node] of nodes.entries()) {
    node.openChannels.add(name);
    const entry = node._registerChannel(name);
    // In-memory writes can deliver before the other addChannel call. Pair
    // both endpoints first; Sidechannel installs its own callback when opening.
    streams[i].userData.pair({ protocol: entry.protocol }, () => {});
  }
  await Promise.all(nodes.map(node => node.addChannel(name)));
  const records = nodes.map((node, i) => node.connections.get(streams[i]).get(name));
  assert.ok(records.every(Boolean), `cycle ${i} has live protocol records`);
  await Promise.all(records.map(record => record.channel.fullyOpened()));
  for (const record of records) refs.push(new WeakRef(record.channel));
  await Promise.all(nodes.map(node => node.removeChannel(name)));
  await turn();
}
try {
  await Promise.all(nodes.map(node => node.start()));
  for (let i = 0; i < 1000; i++) await cycle(i);
  await collect();
  const retainedChannels = refs.filter(ref => ref.deref()).length;
  assert.equal(retainedChannels, 0);
  console.log(JSON.stringify({ cycles: 1000, closedChannels: refs.length, retainedChannels,
    nodes: nodes.map((node, i) => ({ registered: node.channels.size, openPolicyNames: node.openChannels.size,
      paired: node.connections.get(streams[i])._paired.size, openRetries: node.connections.get(streams[i])._openRetries.size,
      muxInfos: streams[i].userData._infos.size, muxNotify: streams[i].userData._notify.size,
      swarmListeners: node.peer.swarm.listenerCount('connection') })) }));
  const node = nodes[0];
  await node.stop();
  for (let i = 0; i < 8; i++) { await node.start(); await node.stop(); }
  console.log(JSON.stringify({ extraStarts: 8, stopped: !node.started,
    swarmListeners: node.peer.swarm.listenerCount('connection') }));
} finally {
  for (const stream of streams) stream.destroy();
  await turn();
  await Promise.all(nodes.map(node => node.stop()));
}
