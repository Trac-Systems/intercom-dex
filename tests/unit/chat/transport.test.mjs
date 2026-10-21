import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { generateIdentity } from '../../../src/core/keys.js';
import { seal } from '../../../src/core/envelope.js';
import { random32 } from '../../../src/roles/common.js';
import { CHAT_CHANNEL } from '../../../src/market/chat.js';
import { dexTransport, DEX_POW_BITS } from '../../../peer/features/dex-transport.js';
import Sidechannel from '../../../peer/features/sidechannel/index.js';
import { Bridge } from '../../../src/net/bridge.js';

const loader = registerHooks({ resolve(specifier, context, next) { return next(specifier === 'bare-ws' ? 'ws' : specifier, context); } });
const { DEX_CHANNELS } = await import('../../../peer/features/dex-bridge.js');
loader.deregister();

test('chat is open to every peer role, uses offers PoW and the normal bridge join/send path', async () => {
  assert.ok(DEX_CHANNELS.includes(CHAT_CHANNEL));
  for (const role of ['trader', 'service', 'signer']) {
    const { sidechannel: policy } = dexTransport({ role, servicePeerKey: random32() });
    assert.ok(policy.channels.includes(CHAT_CHANNEL)); assert.ok(policy.openChannels.includes(CHAT_CHANNEL));
    assert.ok(policy.powRequiredChannels.includes(CHAT_CHANNEL)); assert.equal(policy.powDifficulty, DEX_POW_BITS);
    assert.ok(!policy.ownerWriteChannels.includes(CHAT_CHANNEL)); assert.equal(policy.welcomeRequired, false);
    assert.equal(policy.acceptMessage('intercom-dex:offers', {}), true);
  }
  const bridge = new Bridge({ url: 'ws://127.0.0.1:12345', token: 'unused-unit-token' }), calls = [];
  bridge.request = async body => { calls.push(body); return {}; };
  await bridge.join(CHAT_CHANNEL); await bridge.send(CHAT_CHANNEL, { text: 'wire placeholder' });
  assert.deepEqual(calls, [{ type: 'join', channel: CHAT_CHANNEL }, { type: 'send', channel: CHAT_CHANNEL, message: { text: 'wire placeholder' } }]);
});

test('peer validates PoW and signed chat before delivery or relay, including limits, skew and dedupe', async t => {
  let now = 10000000;
  t.mock.method(Date, 'now', () => now);
  const policy = dexTransport({ role: 'service', servicePeerKey: random32() }).sidechannel;
  const delivered = [], relayed = [], sc = new Sidechannel({}, { ...policy, powDifficulty: 4,
    onMessage: (_, payload) => delivered.push(payload) });
  let handle;
  const channel = { addMessage(h) { handle = h; return h; }, open() {}, fullyOpened: () => new Promise(() => {}) };
  sc._openChannelForConnection({ userData: { createChannel: () => channel } }, sc._registerChannel(CHAT_CHANNEL));
  sc.connections.set({}, new Map([[CHAT_CHANNEL, { channel: { opened: true }, message: { send: payload => relayed.push(payload) } }]]));
  const key = generateIdentity();
  const raw = (text, identity = key, ts = now / 1000) => seal({ kind: 'chat', ch: CHAT_CHANNEL, body: { text, ts } }, identity.secretKey, { ts, nonce: random32() });
  const deliver = async message => { const payload = await sc._buildPayload(CHAT_CHANNEL, message); handle.onmessage(payload); return payload; };
  const good = await sc._buildPayload(CHAT_CHANNEL, raw('hello'));
  handle.onmessage({ ...good, pow: undefined });
  await deliver({ ...raw('forged'), sig: '0'.repeat(128) });
  await deliver(raw('stale', key, now / 1000 - 301));
  await deliver(raw('future', key, now / 1000 + 301));
  await deliver({ control: 'open_channel', channel: 'unwanted' });
  assert.equal(delivered.length, 0); assert.equal(relayed.length, 0);
  handle.onmessage(good);
  handle.onmessage(good);
  await deliver(good.message); // Same signed message inside a fresh transport payload.
  await deliver(raw('too soon'));
  assert.equal(delivered.length, 1); assert.equal(relayed.length, 1);
  now += 10000;
  await deliver(raw('hello')); // Fresh nonce is still duplicate text.
  assert.equal(relayed.length, 1);
  await deliver(raw('second'));
  assert.equal(relayed.length, 2);
  for (let i = 2; i < 20; i++) { now += 10000; await deliver(raw(`line ${i}`)); }
  now += 10000; await deliver(raw('over hourly limit'));
  assert.equal(relayed.length, 20); assert.equal(delivered.length, 20);
  await deliver(raw('hello', generateIdentity()));
  assert.equal(relayed.length, 21, 'limits key on the signed author, not the shared relay/transport author');
  assert.equal(delivered.length, 21);
});
