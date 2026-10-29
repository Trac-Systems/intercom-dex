import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Trader } from '../../../src/roles/trader.js';
import { tradeChannel } from '../../../src/roles/host.js';
import { encodeKey } from '../../../src/core/keys.js';
import { seal } from '../../../src/core/envelope.js';
import { NETWORK_SILENCE_MS, NETWORK_RETRY_MS, NETWORK_RECONNECTING } from '../../../src/net/network-watchdog.js';
import { simulation } from '../core/simulation.mjs';
import { hex } from '../core/helpers.mjs';

const sim = simulation({ capturePhases: true });
const turn = () => new Promise(resolve => setImmediate(resolve));

class Bridge extends EventEmitter {
  constructor() { super(); this.joins = []; this.sent = []; this.reconnections = 0; }
  async join(channel, makerPeer) { this.joins.push({ channel, makerPeer }); }
  async leave() {}
  async setRelays() {}
  async send(channel, envelope) { this.sent.push({ channel, envelope }); }
  async subscribe() { return { channels: [] }; }
  async request() { return {}; }
  async stats() { return { connectionCount: 0, channels: [] }; }
  async reconnect() { this.reconnections++; this.emit('close'); }
  close() { this.emit('close'); }
}

async function trader(t, { role = 'seller', phase } = {}) {
  let ms = 0, sends = 0, finish;
  t.mock.method(performance, 'now', () => ms);
  t.mock.method(globalThis, 'setInterval', () => ({ unref() {} }));
  t.mock.method(globalThis, 'clearInterval', () => {});
  const state = phase && structuredClone(sim.snapshots.get(`${role}:${phase}`));
  const pending = new Promise(resolve => { finish = resolve; });
  const action = async () => { sends++; return pending; };
  const records = new Map([['registry-current', sim.f.registry]]);
  if (state) records.set('trade-running', { key: 'running', role, state, lifetimeSec: 176400, outbox: {}, buffer: [], raw: [] });
  const store = { get: key => structuredClone(records.get(key) ?? null), put: (key, value) => records.set(key, structuredClone(value)),
    list: prefix => [...records.keys()].filter(key => key.startsWith(prefix)), delete: key => records.delete(key) };
  const bridge = new Bridge(), identity = { publicKey: encodeKey(sim.f[role].publicKey), secretKey: sim.f[role].secretKey };
  const app = new Trader({ bridge, identity, store, serviceKey: encodeKey(sim.f.service.publicKey), me: sim.f.terms[role],
    proof: { zkey: '/unit-test-unused.zkey', pool: 0 }, log: () => {},
    solana: { finalizedSlot: async () => 100, tipSlot: async () => 132, lockEscrow: action, claim: action,
      checkEscrow: async () => ({ ok: true, status: 'active' }), lockOutcome: async () => ({ ok: false, outcome: 'unknown' }) },
    trac: { sendTransfer: action, verifyTransfer: async () => ({ ok: true, final: true, amount: state.terms.baseAmount, finalizedAt: state.now }) } });
  app.host.now = () => state?.now ?? 100;
  t.after(() => app.stop()); await app.start(); await turn();
  return { app, bridge, records, sends: () => sends, finish,
    time: async value => { ms = value; app.network.check(); await turn(); } };
}

for (const [role, phase, expected, result] of [
  ['seller', 'transferring', 'awaitShares', state => ({ ok: true, txHash: hex(), sentAt: state.now })],
  ['buyer', 'locking', 'locked', state => ({ ok: true, hashHex: state.H })],
  ['seller', 'claiming', 'complete', () => ({ ok: true, claimSignature: 'S'.repeat(88) })],
]) test(`bridge reconnect retains an in-flight ${role} ${phase} action and advances it once without duplicate sends`, async t => {
  const f = await trader(t, { role, phase }), trade = f.app.host.trades.get('running');
  assert.equal(f.sends(), 1);
  const before = structuredClone(f.records.get('trade-running')), busy = trade.busy, queue = trade.queue, seen = trade.seen;
  const messages = f.bridge.sent.length, listenerCount = f.bridge.listenerCount('message');
  const makerPeer = hex(); trade.makerPeer = makerPeer;
  const offer = { offerId: hex(), expiresAt: Math.floor(Date.now() / 1000) + 1000 }; f.app.mine.set(offer.offerId, offer);
  await f.time(NETWORK_SILENCE_MS); await f.time(NETWORK_SILENCE_MS + NETWORK_RETRY_MS);
  assert.equal(f.bridge.reconnections, 1); assert.equal(f.sends(), 1); assert.equal(f.bridge.sent.length, messages);
  assert.equal(f.app.host.trades.get('running'), trade); assert.equal(trade.busy, busy); assert.equal(trade.queue, queue); assert.equal(trade.seen, seen);
  assert.deepEqual(f.records.get('trade-running'), before, 'reattachment does not rewrite or rewind the durable trade');
  assert.equal(f.bridge.listenerCount('message'), listenerCount, 'no second router');
  assert.ok(f.bridge.joins.some(j => j.channel === tradeChannel(offer.offerId)));
  assert.ok(f.bridge.joins.some(j => j.channel === tradeChannel(trade.state.tradeId)));
  if (trade.state.mode === 'taker') assert.ok(f.bridge.joins.some(j => j.channel === tradeChannel(trade.state.offerId) && j.makerPeer === makerPeer));
  f.app.mine.delete(offer.offerId);
  f.finish(result(trade.state)); await turn(); await trade.queue; await turn();
  assert.equal(trade.state.phase, expected); assert.equal(f.sends(), 1);
  assert.equal(f.records.get('trade-running').state.phase, expected);
});

test('a stalled trade-channel join does not delay the other channel and a late completion cannot resurrect membership', async t => {
  const f = await trader(t, { role: 'seller', phase: 'transferring' }), trade = f.app.host.trades.get('running');
  let resolve, current = true;
  const waiting = new Promise(yes => { resolve = yes; }), joined = [];
  f.bridge.join = async channel => { joined.push(channel); if (channel === tradeChannel(trade.state.offerId)) await waiting; };
  const restoring = f.app.host.restoreTransport(() => current);
  await turn();
  assert.ok(joined.includes(tradeChannel(trade.state.tradeId)), 'other channel joined before the first one acknowledges');
  assert.ok(f.app.host.joined.has(tradeChannel(trade.state.tradeId)));
  current = false; resolve(); await restoring;
  assert.ok(!f.app.host.joined.has(tradeChannel(trade.state.offerId)), 'obsolete recovery cannot set membership');
  assert.equal(f.sends(), 1);
});

test('trader accepts only registered signer heartbeats for recovery and clears its reconnecting status', async t => {
  const f = await trader(t);
  await f.time(NETWORK_SILENCE_MS);
  assert.equal(f.app.status().signersOnline.length, 0); assert.equal(f.app.status().network.message, NETWORK_RECONNECTING);
  const channel = 'intercom-dex:signers', heartbeat = secretKey => seal({ kind: 'heartbeat', ch: channel,
    body: { registryVersion: 1, software: '0.1.32', status: 'online', holdCount: 0 } }, secretKey, { ts: Math.floor(Date.now() / 1000), nonce: hex() });
  f.bridge.emit('message', channel, heartbeat(sim.f.buyer.secretKey)); await turn(); f.app.network.check();
  assert.equal(f.app.status().network.reconnecting, true, 'unregistered signer is ignored');
  f.bridge.emit('message', channel, heartbeat(sim.f.signers[0].identity.secretKey)); await turn(); f.app.network.check();
  assert.equal(f.app.status().network.reconnecting, false); assert.equal(f.app.onlineSigners().length, 1);
  assert.equal(f.app.status().network.message, '');
});
