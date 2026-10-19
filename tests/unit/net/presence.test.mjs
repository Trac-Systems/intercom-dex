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
