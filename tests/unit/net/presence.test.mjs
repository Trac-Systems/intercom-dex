import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../../../src/net/bridge.js';
import { peerPresent } from '../../../peer/features/dex-presence.js';

const peerKey = 'a'.repeat(64), channel = 'intercom-dex:t:' + 'b'.repeat(64);

test('bridge presence requires the named peer with an open protocol on exactly that trade channel', () => {
  const protocol = { opened: false };
  const sidechannel = { connections: new Map([[{ remotePublicKey: Buffer.from(peerKey, 'hex') }, new Map([[channel, { channel: protocol }]])]]) };
  const query = (patch = {}) => { const p = { channel, peerKey, ...patch }; return peerPresent(sidechannel, p.channel, p.peerKey); };
  assert.equal(query(), false);
  protocol.opened = true; assert.equal(query(), true);
  protocol.closed = true; assert.equal(query(), false); protocol.closed = false;
  protocol.destroyed = true; assert.equal(query(), false); protocol.destroyed = false;
  const connection = [...sidechannel.connections.keys()][0];
  connection.destroyed = true; assert.equal(query(), false); connection.destroyed = false;
  assert.equal(query({ peerKey: 'c'.repeat(64) }), false);
  assert.equal(query({ channel: 'intercom-dex:t:' + 'd'.repeat(64) }), false);
  assert.throws(() => query({ channel: 'intercom-dex' }), /Invalid/);
  assert.throws(() => query({ peerKey: 'bad' }), /Invalid/);
});

test('client presence passes the channel and maker peer key and requires an affirmative response', async () => {
  const bridge = new Bridge({ url: 'ws://127.0.0.1:1', token: 'unit' });
  const calls = []; let result = { connected: true };
  bridge.request = async body => { calls.push(body); return result; };
  assert.equal(await bridge.peerPresent(channel, peerKey), true);
  assert.deepEqual(calls[0], { type: 'dex_presence', channel, peerKey });
  result = { connected: 1 }; assert.equal(await bridge.peerPresent(channel, peerKey), false);
});

test('client join carries an optional maker hint or its release only on trade channels', async () => {
  const bridge = new Bridge({ url: 'ws://127.0.0.1:1', token: 'unit' }), calls = [];
  bridge.request = async (body, timeout) => { calls.push({ body, timeout }); };
  await bridge.join(channel, peerKey); await bridge.join(channel, null); await bridge.join(channel); await bridge.join('intercom-dex', peerKey);
  assert.deepEqual(calls.map(x => x.body), [
    { type: 'dex_join', channel, makerPeer: peerKey }, { type: 'dex_join', channel, makerPeer: null },
    { type: 'dex_join', channel }, { type: 'join', channel: 'intercom-dex' },
  ]);
  assert.ok(calls.every(x => x.timeout === 120000));
});
