import test from 'node:test';
import assert from 'node:assert/strict';
import Sidechannel from '../../../peer/features/sidechannel/index.js';
import c from '../../../peer/node_modules/compact-encoding/index.js';

function receiver(config = {}) {
  const sidechannel = new Sidechannel({}, { maxMessageBytes: 10000, welcomeRequired: false, ...config });
  sidechannel._now = () => 1000;
  let message;
  const channel = { addMessage(value) { message = value; return value; }, open() {}, fullyOpened: () => new Promise(() => {}) };
  const connection = { userData: { createChannel: () => channel } };
  sidechannel._openChannelForConnection(connection, { name: 'test', protocol: 'sidechannel/test' });
  return { sidechannel, connection, message };
}

const wire = text => {
  const body = Buffer.from(text), prefix = c.encode(c.uint, body.length);
  return Buffer.concat([prefix, body]);
};
const decode = (message, bytes) => message.encoding.decode({ buffer: bytes, start: 0, end: bytes.length });

test('every frame is charged before decoding, including oversized, malformed and blocked frames', t => {
  const { sidechannel, connection, message } = receiver({ maxMessageBytes: 64, rateBurstBytes: 80, maxStrikes: 3 });
  const charge = t.mock.method(sidechannel, '_checkRate', sidechannel._checkRate.bind(sidechannel));
  const parse = t.mock.method(JSON, 'parse', JSON.parse);
  const oversized = wire(JSON.stringify({ text: 'x'.repeat(100) }));
  for (let i = 0; i < 4; i++) assert.equal(decode(message, oversized), null);
  assert.equal(charge.mock.callCount(), 4);
  for (const call of charge.mock.calls) assert.equal(call.arguments[1], oversized.length);
  assert.equal(sidechannel._isBlocked(connection), true);
  assert.equal(decode(message, wire('{}')), null);
  assert.equal(parse.mock.callCount(), 0);
  const clean = receiver({ rateBurstBytes: 10000 });
  const malformed = wire('{');
  assert.throws(() => decode(clean.message, malformed), SyntaxError);
  assert.equal(clean.sidechannel.rateLimits.get(clean.connection).tokens, 10000 - malformed.length);
  const truncated = c.encode(c.uint, 10);
  assert.throws(() => decode(clean.message, truncated), /Truncated/);
  assert.equal(clean.sidechannel.rateLimits.get(clean.connection).tokens, 10000 - malformed.length - truncated.length);
});

test('JSON depth 32 is accepted, depth 33 is refused before parsing, respecting strings and escapes', t => {
  const { sidechannel, connection, message } = receiver();
  const parse = t.mock.method(JSON, 'parse', JSON.parse);
  const nested = n => '['.repeat(n) + '0' + ']'.repeat(n);
  assert.ok(Array.isArray(decode(message, wire(nested(32)))));
  assert.equal(parse.mock.callCount(), 1);
  const before = sidechannel.rateLimits.get(connection).tokens, deep = wire(nested(33));
  assert.equal(decode(message, deep), null);
  assert.equal(parse.mock.callCount(), 1);
  assert.equal(sidechannel.rateLimits.get(connection).tokens, before - deep.length);
  const object = n => '{"a":'.repeat(n) + '0' + '}'.repeat(n);
  assert.ok(decode(message, wire(object(32))));
  assert.equal(decode(message, wire(object(33))), null);
  const value = { text: '[[{{'.repeat(40) + '\\"quoted\\\\\"' + '}}]]'.repeat(40), nested: [1] };
  assert.deepEqual(decode(message, c.encode(c.json, value)), value);
  // A final escaped backslash does not hide the following real closing quote or nesting.
  const tricky = '{"text":"\\\\","deep":' + nested(32) + '}';
  assert.equal(decode(message, wire(tricky)), null);
});

test('rate admission is shared by channels on one connection and isolated from other connections', () => {
  const { sidechannel, connection, message } = receiver({ rateBurstBytes: 5 });
  assert.deepEqual(decode(message, wire('{}')), {});
  let second;
  connection.userData.createChannel = () => ({ addMessage(value) { second = value; return value; }, open() {}, fullyOpened: () => new Promise(() => {}) });
  sidechannel._openChannelForConnection(connection, { name: 'other', protocol: 'sidechannel/other' });
  assert.equal(decode(second, wire('{}')), null);
  const other = receiver({ rateBurstBytes: 5 });
  assert.deepEqual(decode(other.message, wire('{}')), {});
});

test('a message limit above the rate burst is lowered to the burst, so every accepted size can pass', () => {
  assert.equal(new Sidechannel({}, { maxMessageBytes: 1_000_000, rateBurstBytes: 256_000 }).maxMessageBytes, 256_000);
  assert.equal(new Sidechannel({}, { maxMessageBytes: 1_000_000, rateBytesPerSecond: 0 }).maxMessageBytes, 1_000_000);
  assert.equal(new Sidechannel({}, {}).maxMessageBytes, 256_000);
});
