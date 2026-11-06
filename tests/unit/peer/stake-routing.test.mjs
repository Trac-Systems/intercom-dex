import test from 'node:test';
import assert from 'node:assert/strict';
import { stakeNetwork, identity, turn } from '../../fixtures/stake-network.mjs';
import { StakeTransport, STAKE_CHANNEL, sealStakeMessage } from '../../../src/stake/transport.js';
import * as legacy from '../../fixtures/released-v0.1.48-stake-transport.mjs';
import { seal } from '../../../src/core/envelope.js';
import { randomBytes } from 'node:crypto';

const a = identity(1), b = identity(2), c = identity(3), payout = identity(4);
test('addressed reward traffic bypasses venue public queue and never reaches unrelated legacy traders or feeds', async t => {
  const net = stakeNetwork(), venue = net.node(a, 'service'), signer = net.node(b, 'signer'), old = net.node(c, 'trader', { legacy: true }),
    feed = net.node(identity(5), 'market-feed', { legacy: true }), pool = net.node(payout, 'payout');
  t.after(() => net.close());
  for (const leaf of [signer, old, feed, pool]) await net.connect(venue, leaf);
  const allowPagingPeer = key => [a, b, payout].some(i => i.publicKey === key);
  const transports = [];
  for (const n of [venue, signer, pool]) {
    n.transport = new StakeTransport({ bridge: n.bridge, identity: n.identity, allowPagingPeer, pageRate: key => key === payout.publicKey ? 48000 : 0, handle: async (_m, body) => body });
    await n.transport.start(); transports.push(n.transport);
  }
  const oldTransport = new legacy.StakeTransport({ bridge: old.bridge, identity: c }); await oldTransport.start();
  t.after(() => { transports.forEach(s => s.stop()); oldTransport.stop(); });
  // An ordinary old-trader request establishes its return route without a new handshake.
  assert.deepEqual(await oldTransport.request(a.publicKey, 'admissionInventory', { owner: 'old' }), { owner: 'old' });
  assert.equal(venue.sc.stakeWaiting.size, 0, 'already handled requests to the venue are never held for forwarding');
  // Old signer heartbeats establish routes before the venue starts any request.
  await signer.sc.broadcast('intercom-dex:signers', seal({ ch: 'intercom-dex:signers', kind: 'heartbeat', body: { registryVersion: 1, software: '0.1.48', status: 'online', holdCount: 0 } },
    b.secretKey, { ts: Math.floor(Date.now() / 1000), nonce: 'a'.repeat(64) }));
  await turn(); await turn();
  assert.deepEqual(await oldTransport.request(b.publicKey, 'admissionInventory', { through: 'venue' }), { through: 'venue' });
  await pool.transport.request(a.publicKey, 'status');
  const before = [old, feed].map(n => n.bandwidth.filter(r => r.ch === STAKE_CHANNEL && r.direction === 'received').reduce((sum, r) => sum + r.bytes, 0));
  const publicBefore = venue.sc.publicSend.stats();
  const large = { text: randomBytes(300000).toString('base64') };
  assert.deepEqual(await venue.transport.request(b.publicKey, 'rewardVote', large), large);
  assert.deepEqual(await pool.transport.request(a.publicKey, 'rewardBlock', large), large);
  await turn();
  assert.deepEqual([old, feed].map(n => n.bandwidth.filter(r => r.ch === STAKE_CHANNEL && r.direction === 'received').reduce((sum, r) => sum + r.bytes, 0)), before);
  assert.deepEqual(venue.sc.publicSend.stats(), publicBefore);
  assert.equal(old.sc._isBlocked([...old.sc.connections.keys()][0]), false);
  assert.deepEqual(await oldTransport.request(b.publicKey, 'admissionInventory', { after: 'pages' }), { after: 'pages' });
});

test('unknown, expired and spoofed identity routes cannot flood venue leaves', async t => {
  const net = stakeNetwork(), venue = net.node(a, 'service'), leaf = net.node(c, 'trader', { legacy: true });
  t.after(() => net.close()); const [connection] = await net.connect(venue, leaf);
  const message = sealStakeMessage({ kind: 'stakeRequest', to: b.publicKey, id: '1'.repeat(64), at: Math.floor(Date.now() / 1000), method: 'rewardVote', body: {} }, a.secretKey);
  await venue.sc.broadcast(STAKE_CHANNEL, message); await turn();
  assert.equal(leaf.received.length, 0);
  const payload = await leaf.sc._buildPayload(STAKE_CHANNEL, { ...message, from: c.publicKey });
  venue.sc.stakeRoutes.learn(STAKE_CHANNEL, payload, connection);
  assert.equal(venue.sc.stakeRoutes.routes.size, 0);
  const { sig, ...unsigned } = message;
  const valid = sealStakeMessage({ ...unsigned, to: a.publicKey }, c.secretKey);
  const signed = await leaf.sc._buildPayload(STAKE_CHANNEL, valid);
  venue.sc.stakeRoutes.learn(STAKE_CHANNEL, { ...signed, sig: '0'.repeat(128) }, connection);
  assert.equal(venue.sc.stakeRoutes.routes.size, 0);
  venue.sc.stakeRoutes.learn(STAKE_CHANNEL, signed, connection); assert.equal(venue.sc.stakeRoutes.routes.size, 1);
  const route = venue.sc.stakeRoutes.routes.get(c.publicKey); route.until = 0;
  const reply = await venue.sc._buildPayload(STAKE_CHANNEL, sealStakeMessage({ ...message, to: c.publicKey }, a.secretKey));
  assert.equal(venue.sc.stakeRoutes.allows(STAKE_CHANNEL, reply, connection), false);
});

test('relayed pages addressed to a leaf retain its public send budget', async t => {
  const net = stakeNetwork(), venue = net.node(a, 'service'), leaf = net.node(c, 'trader', { legacy: true });
  t.after(() => net.close()); const [connection] = await net.connect(venue, leaf);
  const at = Math.floor(Date.now() / 1000), base = { kind: 'stakeRequest', to: a.publicKey, id: '1'.repeat(64), at, method: 'status', body: {} };
  const request = await leaf.sc._buildPayload(STAKE_CHANNEL, sealStakeMessage(base, c.secretKey));
  venue.sc.stakeRoutes.learn(STAKE_CHANNEL, request, connection);
  assert.equal(venue.sc.publicLeaves.has(connection), true);
  const record = venue.sc.connections.get(connection).get(STAKE_CHANNEL);
  for (let index = 0; index < 4; index++) {
    const frame = await venue.sc._buildPayload(STAKE_CHANNEL, sealStakeMessage({ ...base, kind: 'stakePage', to: c.publicKey,
      body: { transfer: 'a'.repeat(64), index, data: 'a'.repeat(120000) } }, b.secretKey));
    venue.sc._send(record, STAKE_CHANNEL, frame, 'relayed');
  }
  assert.ok(venue.sc.publicSend.stats().queuedBytes > 0, 'a relayer cannot bypass a trader receive budget with signed page kinds');
});

test('rewrapping another identity cannot replace a live route, and replay never extends signed expiry', async t => {
  const net = stakeNetwork(), venue = net.node(a, 'service'), leaf = net.node(c, 'trader', { legacy: true }), attacker = net.node(b, 'trader', { legacy: true });
  t.after(() => net.close()); const [leafConnection] = await net.connect(venue, leaf), [attackerConnection] = await net.connect(venue, attacker);
  const at = Math.floor(Date.now() / 1000), m = sealStakeMessage({ kind: 'stakeRequest', to: a.publicKey, id: 'f'.repeat(64), at, method: 'status', body: {} }, c.secretKey);
  const genuine = await leaf.sc._buildPayload(STAKE_CHANNEL, m), replay = await attacker.sc._buildPayload(STAKE_CHANNEL, m);
  venue.sc.stakeRoutes.learn(STAKE_CHANNEL, genuine, leafConnection);
  venue.sc.stakeRoutes.learn(STAKE_CHANNEL, replay, attackerConnection);
  const route = venue.sc.stakeRoutes.routes.get(c.publicKey);
  assert.equal(route.peerKey, leaf.peer.publicKey); assert.equal(route.until, (at + 120) * 1000);
  venue.sc._now = () => (at + 90) * 1000;
  venue.sc.stakeRoutes.learn(STAKE_CHANNEL, genuine, leafConnection);
  assert.equal(venue.sc.stakeRoutes.routes.get(c.publicKey).until, route.until);
});

test('a cold venue holds bounded pages until a signed signer heartbeat establishes the route', async t => {
  const net = stakeNetwork(), venue = net.node(a, 'service'), signer = net.node(b, 'signer'), leaf = net.node(c, 'trader', { legacy: true });
  t.after(() => net.close()); await net.connect(venue, signer); await net.connect(venue, leaf);
  const allowPagingPeer = key => [a.publicKey, b.publicKey].includes(key);
  const client = new StakeTransport({ bridge: venue.bridge, identity: a, allowPagingPeer, timeoutMs: 2000 });
  const server = new StakeTransport({ bridge: signer.bridge, identity: b, allowPagingPeer, handle: async (_method, body) => body });
  await client.start(); await server.start(); t.after(() => { client.stop(); server.stop(); });
  const body = { text: randomBytes(200000).toString('base64') }, pending = client.request(b.publicKey, 'rewardVote', body);
  await turn(); await turn();
  assert.ok(venue.sc.stakeWaiting.size > 1); assert.equal(leaf.received.length, 0);
  await signer.sc.broadcast('intercom-dex:signers', seal({ ch: 'intercom-dex:signers', kind: 'heartbeat',
    body: { registryVersion: 1, software: '0.1.48', status: 'online', holdCount: 0 } }, b.secretKey,
    { ts: Math.floor(Date.now() / 1000), nonce: 'd'.repeat(64) }));
  assert.deepEqual(await pending, body);
  assert.equal(venue.sc.stakeWaiting.size, 0); assert.equal(venue.sc.stakeWaitingBytes, 0);
  assert.equal(leaf.received.filter(p => p.channel === STAKE_CHANNEL).length, 0);
});

test('cold-route holds cap count and bytes, reject large relayed pages and expire without a route', async t => {
  const net = stakeNetwork(), venue = net.node(a, 'service'), leaf = net.node(c, 'trader', { legacy: true });
  t.after(() => net.close()); const [connection] = await net.connect(venue, leaf);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const base = { kind: 'stakeRequest', to: b.publicKey, at: Math.floor(Date.now() / 1000), method: 'status', body: {} };
  const relayed = await leaf.sc._buildPayload(STAKE_CHANNEL, sealStakeMessage({ ...base, kind: 'stakePage', id: 'e'.repeat(64), body: { text: 'x'.repeat(10000) } }, c.secretKey));
  venue.sc._send(venue.sc.connections.get(connection).get(STAKE_CHANNEL), STAKE_CHANNEL, relayed, 'relayed');
  assert.equal(venue.sc.stakeWaiting.size, 0);
  for (let n = 0; n < 65; n++) await venue.sc.broadcast(STAKE_CHANNEL, sealStakeMessage({ ...base, id: n.toString(16).padStart(64, '0') }, a.secretKey));
  assert.equal(venue.sc.stakeWaiting.size, 64); assert.ok(venue.sc.stakeWaitingBytes <= 8 * 1024 * 1024);
  t.mock.timers.tick(30000); assert.equal(venue.sc.stakeWaiting.size, 0); assert.equal(venue.sc.stakeWaitingBytes, 0);
  for (let n = 0; n < 55; n++) await venue.sc.broadcast(STAKE_CHANNEL, sealStakeMessage({ ...base, id: n.toString(16).padStart(64, '0'), body: { text: 'x'.repeat(170000) } }, a.secretKey));
  assert.ok(venue.sc.stakeWaiting.size > 0 && venue.sc.stakeWaiting.size < 64); assert.ok(venue.sc.stakeWaitingBytes <= 8 * 1024 * 1024);
  await venue.sc.stop(); assert.equal(venue.sc.stakeWaiting.size, 0); assert.equal(venue.sc.stakeWaitingBytes, 0);
  assert.equal(leaf.received.length, 0);
});
