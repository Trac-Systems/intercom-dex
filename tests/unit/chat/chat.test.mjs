import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generateIdentity } from '../../../src/core/keys.js';
import { chatInputSchema, chatSinceSchema, parseBody } from '../../../src/core/schemas.js';
import { createReplayCache, open, seal } from '../../../src/core/envelope.js';
import { CHAT_CHANNEL, MarketChat } from '../../../src/market/chat.js';

const nonce = () => randomBytes(32).toString('hex');
const message = (key, ts, text = 'Hello market', extra = {}) => seal({ kind: 'chat', ch: CHAT_CHANNEL,
  body: { text, ts, ...extra } }, key.secretKey, { ts, nonce: nonce() });
const setup = options => {
  const clock = { t: 10000 }, key = generateIdentity();
  const chat = new MarketChat({ now: () => clock.t, ...options });
  return { clock, key, chat, post: (text, keyOverride = key) => chat.receive(message(keyOverride, clock.t, text)) };
};

test('chat input trims text, counts Unicode characters, validates names and rejects every extra field', () => {
  assert.deepEqual(chatInputSchema.parse({ text: '  Hello 🌎  ', name: 'Trader 42._-' }), { text: 'Hello 🌎', name: 'Trader 42._-' });
  for (const text of ['x', 'x'.repeat(280), '🌎'.repeat(280)]) assert.ok(chatInputSchema.safeParse({ text }).success);
  for (const text of ['', '   ', 'x'.repeat(281), '🌎'.repeat(281), '\nhello', 'hello\r', '\thello', 'a\u0000b', 'a\u007fb', 'a\u0085b', 'a\u2028b', 'a\u2029b', 12, null]) {
    assert.equal(chatInputSchema.safeParse({ text }).success, false);
  }
  for (const name of ['', 'x'.repeat(25), 'x\n', 'é', '<b>', 'x@y', null, 3]) assert.equal(chatInputSchema.safeParse({ text: 'hi', name }).success, false);
  assert.ok(chatInputSchema.safeParse({ text: 'hi', name: 'x'.repeat(24) }).success);
  for (const extra of [{ ts: 10 }, { from: nonce() }, { action: 'say' }, { html: true }]) {
    assert.equal(chatInputSchema.safeParse({ text: 'hi', ...extra }).success, false);
  }
  for (const since of [0, 1, Number.MAX_SAFE_INTEGER]) assert.equal(chatSinceSchema.parse(since), since);
  for (const since of [-1, 1.5, Infinity, NaN, '1', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => chatSinceSchema.parse(since));
});

test('signed chat body is strict, timestamped and already trimmed', () => {
  const body = { text: 'hi', name: 'Market', ts: 10000 };
  assert.deepEqual(parseBody('chat', body), body);
  for (const invalid of [{ text: 'hi' }, { ...body, ts: -1 }, { ...body, ts: 1.5 }, { ...body, ts: '10000' },
    { ...body, text: ' hi ' }, { ...body, extra: 1 }, { ...body, text: '\nhi' }]) assert.throws(() => parseBody('chat', invalid));
  const key = generateIdentity(), raw = message(key, 10000);
  assert.equal(open(raw, { now: 10000, seen: createReplayCache() }).kind, 'chat');
  for (const maxFutureSec of [-1, NaN, 0.5, '300']) assert.throws(() => open(raw, { now: 10000, seen: createReplayCache(), maxFutureSec }), /Invalid maxFutureSec/);
  assert.throws(() => open(message(key, 10121), { now: 10000, seen: createReplayCache() }), /timestamp outside window/);
});

test('receive drops malformed, forged, misrouted and mismatched timestamps without charging the sender', () => {
  const { chat, key, clock } = setup(), raw = message(key, clock.t);
  for (const bad of [null, {}, { ...raw, kind: 'cancel' }, { ...raw, ch: 'intercom-dex:offers' },
    { ...raw, sig: '0'.repeat(128) }, { ...raw, from: nonce() }, { ...raw, body: { ...raw.body, extra: true } },
    { ...raw, body: { ...raw.body, text: 'other' } }, message(key, clock.t, 'hi', { ts: clock.t - 1 })]) {
    assert.equal(chat.receive(bad), null);
  }
  assert.equal(chat.read().length, 0);
  assert.ok(chat.receive(raw));
  clock.t += 10;
  assert.equal(chat.receive(raw), null, 'same nonce cannot replay after the short limit');
});

test('chat accepts exactly five minutes of skew in either direction, checking envelope and body clocks', () => {
  for (const delta of [-301, -300, 300, 301]) {
    const { chat, key, clock } = setup();
    assert.equal(chat.receive(message(key, clock.t + delta)) !== null, Math.abs(delta) <= 300);
  }
  const { chat, key, clock } = setup();
  assert.equal(chat.receive(message(key, clock.t - 301, 'hi', { ts: clock.t })), null);
  assert.equal(chat.receive(message(key, clock.t, 'hi', { ts: clock.t + 301 })), null);
});

test('ten-second limit uses receipt time and signing key, independent of name and sender timestamps', () => {
  const { chat, post, clock, key } = setup(), other = generateIdentity();
  assert.ok(chat.receive(message(key, clock.t - 300, 'one', { name: 'one' })));
  clock.t += 9;
  assert.equal(chat.receive(message(key, clock.t + 300, 'two', { name: 'two' })), null);
  assert.ok(post('one', other));
  clock.t++;
  assert.ok(post('three'));
  assert.equal(chat.read().length, 3);
});

test('twenty messages per rolling hour, with exact expiry and rejected attempts not moving the window', () => {
  const { chat, post, clock } = setup();
  for (let i = 0; i < 20; i++) { clock.t = 10000 + i * 10; assert.ok(post(`message ${i}`)); }
  clock.t = 10200; assert.equal(post('too many'), null);
  clock.t = 13599; assert.equal(post('still too many'), null);
  clock.t = 13600; assert.ok(post('new hour'));
  clock.t = 13610; assert.ok(post('next slot'));
  assert.equal(chat.read().length, 22);
});

test('duplicate text has a ten-minute window per sender, independent of fresh nonce or name', () => {
  const { chat, post, clock, key } = setup();
  assert.ok(post('same'));
  clock.t += 599;
  assert.equal(chat.receive(message(key, clock.t, 'same', { name: 'new name' })), null);
  assert.ok(post('same', generateIdentity()));
  clock.t++;
  assert.ok(post('same'));
});

test('bounded history returns copies and filters since; evicting history does not evict sender limits', () => {
  const { chat, post, clock, key } = setup();
  const first = post('first');
  for (let i = 0; i < 100; i++) assert.ok(post(`message ${i}`, generateIdentity()));
  const history = chat.read();
  assert.equal(history.length, 100);
  assert.equal(history[0].text, 'message 0');
  assert.equal(history.at(-1).text, 'message 99');
  history[0].text = 'changed'; history.pop();
  assert.equal(chat.read()[0].text, 'message 0');
  assert.equal(chat.read().length, 100);
  assert.equal(chat.read(first.ts).length, 0);
  assert.equal(chat.read(first.ts - 1).length, 100);
  assert.throws(() => chat.read(-1)); assert.throws(() => chat.read('10000'));
  clock.t += 10;
  assert.equal(post('first'), null);
  assert.ok(post('new'));
  assert.deepEqual(chat.read(first.ts).map(m => m.from), [Buffer.from(key.publicKey).toString('hex')]);
  assert.deepEqual(new MarketChat().read(), []);
});

test('sender and replay caches fail closed at capacity, and inactive senders expire', () => {
  for (const maxSenders of [0, -1, NaN, 1.5]) assert.throws(() => new MarketChat({ maxSenders }), /bound/);
  assert.throws(() => new MarketChat({ maxReplayEntries: 0 }), /bound/);
  const { post, clock } = setup({ maxSenders: 1 });
  assert.ok(post('first')); assert.equal(post('other', generateIdentity()), null);
  clock.t += 3600; assert.ok(post('expired slot', generateIdentity()));
  const limited = setup({ maxReplayEntries: 1 });
  assert.ok(limited.post('first')); limited.clock.t += 10;
  assert.equal(limited.post('next'), null);
  limited.clock.t += 291; assert.ok(limited.post('cache expired'));
});

test('names that pass a message off as the venue or the software are reserved, also inside words or split up', () => {
  for (const name of ['Venue', 'SYSTEM', 'the admin', 'Ex.change', 'intercom-dex', 'Official', 'Mod_erator', 'support 1', 'Sys tem', 'myVenue2'])
    assert.equal(chatInputSchema.safeParse({ text: 'hi', name }).success, false, name);
  for (const name of ['Trader 42', 'Guest', 'Market', 'Ven'])
    assert.ok(chatInputSchema.safeParse({ text: 'hi', name }).success, name);
  // The signed wire body uses the same rule: it cannot be sealed, and a receiver refuses it.
  assert.throws(() => message(generateIdentity(), 10000, 'migration notice', { name: 'Venue' }));
  assert.throws(() => parseBody('chat', { text: 'migration notice', name: 'Venue', ts: 10000 }), /reserved/);
});

test('bidirectional controls and zero-width characters are removed from received text', () => {
  const f = setup();
  const record = f.post('send USDC to ‮KCOLB‬ now​‍﻿ ⁦x⁩');
  assert.equal(record.text, 'send USDC to KCOLB now x');
  assert.equal(f.chat.read()[0].text, 'send USDC to KCOLB now x');
  f.clock.t += 20;
  assert.equal(f.post('​‮⁠'), null, 'nothing visible is left');
  f.clock.t += 20;
  assert.equal(f.post('send USDC to KCOLB now x'), null, 'the cleaned text counts as a repeat');
});
