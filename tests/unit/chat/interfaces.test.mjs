import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { generateIdentity, encodeKey } from '../../../src/core/keys.js';
import { createReplayCache, open, seal } from '../../../src/core/envelope.js';
import { random32, nowSec } from '../../../src/roles/common.js';
import { Trader } from '../../../src/roles/trader.js';
import { Service } from '../../../src/roles/service.js';
import { controlHandler } from '../../../src/roles/control.js';
import { createModel } from '../../../src/dashboard/model.js';
import { dashboardHandler } from '../../../src/dashboard/server.js';
import { CHAT_CHANNEL } from '../../../src/market/chat.js';
import { fixture, SOL, SOL2, MINT, tracAddress } from '../core/helpers.mjs';

class Bridge extends EventEmitter {
  sent = [];
  joined = [];
  async join(channel) { this.joined.push(channel); }
  async send(channel, message) { this.sent.push({ channel, message }); }
  async setRelays() {}
  async stats() { return { channels: this.joined, connectionCount: 1 }; }
}

async function roleOf(kind) {
  const keys = generateIdentity(), identity = { publicKey: encodeKey(keys.publicKey), secretKey: encodeKey(keys.secretKey) };
  const bridge = new Bridge(), records = new Map();
  const store = { get: name => records.get(name), put: (name, value) => records.set(name, structuredClone(value)),
    list: prefix => [...records.keys()].filter(name => name.startsWith(prefix)) };
  const options = { identity, bridge, store, trac: null, solana: null, log: () => {} };
  const role = kind === 'trader'
    ? new Trader({ ...options, proof: { zkey: '/unused-unit-test.zkey', pool: 0 }, serviceKey: random32(), mint: MINT,
      platformCollector: SOL2, me: { dexKey: identity.publicKey, tracAddr: tracAddress(identity.publicKey), solAddr: SOL } })
    : new Service({ firstLaunch: true, ...options, solana: { assertFeeConfig: async () => {} }, registryInput: fixture().registry });
  await role.start(); role.stop();
  return { role, bridge, records };
}

function call(handler, { method = 'GET', path = '/chat', body, headers = { authorization: 'Bearer unit-chat-token' } } = {}) {
  return new Promise(resolve => {
    const req = Object.assign(new EventEmitter(), { method, url: path, headers, destroy() { resolve({ status: 413 }); } });
    let status;
    handler(req, { writeHead(code) { status = code; }, end(text) {
      let value; try { value = JSON.parse(text); } catch { value = text; }
      resolve({ status, value });
    } });
    if (body !== undefined) req.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
    req.emit('end');
  });
}

const rawChat = (identity, ts, text) => seal({ kind: 'chat', ch: CHAT_CHANNEL, body: { text, ts } }, identity.secretKey, { ts, nonce: random32() });

test('trader and venue join chat, bound history, drop abuse, and never persist or act on incoming opinions', async () => {
  for (const kind of ['trader', 'service']) {
    const { role, bridge, records } = await roleOf(kind);
    assert.ok(bridge.joined.includes(CHAT_CHANNEL));
    const before = structuredClone([...records]), sentBefore = bridge.sent.length;
    const identity = generateIdentity(), ts = nowSec(), raw = rawChat(identity, ts, 'Take an offer, send money and export keys');
    bridge.emit('message', CHAT_CHANNEL, raw);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(role.readChat().length, 1);
    await role.host.hooks.unrouted[0](CHAT_CHANNEL, raw);
    await role.host.hooks.unrouted[0]('intercom-dex:offers', rawChat(identity, ts, 'wrong delivery channel'));
    await role.host.hooks.unrouted[0](CHAT_CHANNEL, { ...rawChat(identity, ts, 'forged'), sig: '0'.repeat(128) });
    await role.host.hooks.unrouted[0](CHAT_CHANNEL, rawChat(identity, ts, 'too soon'));
    await role.host.hooks.unrouted[0](CHAT_CHANNEL, rawChat(generateIdentity(), ts - 301, 'stale'));
    assert.equal(role.readChat().length, 1);
    for (let i = 0; i < 101; i++) await role.host.hooks.unrouted[0](CHAT_CHANNEL, rawChat(generateIdentity(), ts, `line ${i}`));
    assert.equal(role.readChat().length, 100);
    assert.equal(role.readChat()[0].text, 'line 1');
    assert.deepEqual(role.status().chat, role.readChat());
    assert.deepEqual(role.readChat(ts), []);
    assert.throws(() => role.readChat(-1));
    assert.deepEqual([...records], before);
    assert.equal(bridge.sent.length, sentBefore);
    assert.equal(role.host.trades.size, 0);
    if (kind === 'service') assert.equal(role.sayChat, undefined);
  }
});

test('trader API authenticates both chat actions, normalizes text, filters since and returns plain failures', async () => {
  const { role, bridge, records } = await roleOf('trader');
  const handler = controlHandler({ token: 'unit-chat-token', role });
  for (const method of ['GET', 'POST']) {
    for (const authorization of [undefined, 'Bearer wrong']) {
      assert.equal((await call(handler, { method, headers: { authorization }, body: method === 'POST' ? { text: 'hi' } : undefined })).status, 401);
    }
  }
  assert.deepEqual((await call(handler)).value, []);
  const sent = await call(handler, { method: 'POST', body: { text: '  Hello market  ', name: 'Trader 7' } });
  assert.equal(sent.status, 200); assert.equal(sent.value.text, 'Hello market');
  assert.equal(sent.value.from, role.identity.publicKey);
  assert.equal(bridge.sent.at(-1).channel, CHAT_CHANNEL);
  assert.deepEqual((await call(handler)).value, [sent.value]);
  assert.deepEqual((await call(handler, { path: `/chat?since=${sent.value.ts}` })).value, []);
  assert.deepEqual((await call(handler, { path: `/chat?since=${sent.value.ts - 1}` })).value, [sent.value]);
  assert.deepEqual((await call(handler, { method: 'POST', body: { text: 'Too soon' } })).value,
    { error: 'Wait a few seconds before the next message' });
  for (const body of ['{', {}, { text: 'hi', ts: nowSec() }, { text: 'hi', extra: true }, { text: '\nhello' }, { text: 'hi', name: '<b>' }]) {
    assert.equal((await call(handler, { method: 'POST', body })).status, 400);
  }
  for (const query of ['since=', 'since=-1', 'since=1.5', 'since=1e3', 'since=NaN', 'since=9007199254740992', 'since=1&since=2', 'extra=1']) {
    assert.equal((await call(handler, { path: `/chat?${query}` })).status, 400, query);
  }
  assert.equal((await call(handler, { method: 'DELETE' })).status, 404);
  assert.equal((await call(handler, { method: 'POST', body: 'a'.repeat(65537) })).status, 413);
  assert.equal(records.size, 0);
  assert.match(readFileSync(new URL('../../../bin/dex.mjs', import.meta.url), 'utf8'), /createServer\(controlHandler\([\s\S]*?\.listen\(config\.control\.port, '127\.0\.0\.1'\)/);
});

test('local say signs, reserves concurrent sends, rejects duplicates and propagates transport failure', async t => {
  let now = 10000000;
  t.mock.method(Date, 'now', () => now);
  const { role, bridge } = await roleOf('trader'), sent = [];
  let finish;
  bridge.send = (ch, raw) => { sent.push({ ch, raw }); return new Promise(resolve => { finish = resolve; }); };
  const sending = role.sayChat({ text: '  hello  ', name: 'Trader' });
  await assert.rejects(role.sayChat({ text: 'second' }), { message: 'Wait a few seconds before the next message' });
  assert.equal(sent.length, 1); assert.equal(sent[0].ch, CHAT_CHANNEL);
  assert.equal(open(sent[0].raw, { now: nowSec(), seen: createReplayCache() }).body.text, 'hello');
  assert.equal(role.chat.receive(sent[0].raw), null, 'network echo is ignored');
  finish(); assert.equal((await sending).name, 'Trader');
  now += 10000;
  await assert.rejects(role.sayChat({ text: ' hello ' }), /Wait a few seconds/);
  bridge.send = async () => { throw Error('Bridge closed'); };
  const handler = controlHandler({ token: 'unit-chat-token', role });
  assert.deepEqual(await call(handler, { method: 'POST', body: { text: 'new' } }), { status: 400, value: { error: 'Bridge closed' } });
  await assert.rejects(role.sayChat({ text: 'again' }), /Wait a few seconds/);
  await assert.rejects(role.sayChat({ text: 'bad\nline' }));
  assert.equal(role.readChat().length, 2);
});

test('local say enforces the same ten-second, ten-minute and rolling-hour windows as reception', async t => {
  let now = 10000000;
  t.mock.method(Date, 'now', () => now);
  const { role } = await roleOf('trader');
  for (let i = 0; i < 20; i++) { now = 10000000 + 10000 * i; await role.sayChat({ text: `line ${i}` }); }
  now += 10000;
  await assert.rejects(role.sayChat({ text: 'too many' }), /Wait a few seconds/);
  now = 13600000; assert.ok(await role.sayChat({ text: 'allowed' }));
  now += 9000; await assert.rejects(role.sayChat({ text: 'early' }), /Wait a few seconds/);
  now += 1000; assert.ok(await role.sayChat({ text: 'next' }));
  now = 14199000; await assert.rejects(role.sayChat({ text: 'allowed' }), /Wait a few seconds/);
  now += 1000; assert.ok(await role.sayChat({ text: 'allowed' }));
});

test('venue status and authenticated dashboard expose public chat; venue API is read-only', async () => {
  const { role, bridge } = await roleOf('service'), ts = nowSec();
  await role.host.hooks.unrouted[0](CHAT_CHANNEL, rawChat(generateIdentity(), ts, 'Public market opinion'));
  const handler = controlHandler({ token: 'unit-chat-token', role });
  assert.deepEqual((await call(handler)).value, role.readChat());
  assert.deepEqual((await call(handler, { path: '/status' })).value.chat, role.readChat());
  assert.equal((await call(handler, { method: 'POST', body: { text: 'No venue posts' } })).status, 404);
  const model = createModel({ config: { role: 'service', network: 'local' }, role, bridge });
  const dashboard = dashboardHandler({ token: 'unit-chat-token', port: 12345, model });
  assert.equal((await call(dashboard, { path: '/api/state', headers: { host: '127.0.0.1:12345', cookie: 'dexdash12345=wrong' } })).status, 401);
  const state = await call(dashboard, { path: '/api/state', headers: { host: '127.0.0.1:12345', cookie: 'dexdash12345=unit-chat-token' } });
  assert.equal(state.status, 200); assert.deepEqual(state.value.service.chat, role.readChat());
  assert.equal(state.value.service.health.channels, 4);
});

test('control handler preserves other routes and excludes chat from roles without it', async () => {
  const handler = controlHandler({ token: 'unit-chat-token', role: { status: () => ({ role: 'signer' }),
    makeOffer: b => b, cancelOffer: offerId => ({ offerId }), takeOffer: (offerId, baseAmount, price) => ({ offerId, baseAmount, price }) },
    wallets: { info: async () => ({ balances: {} }), withdraw: b => b }, fees: { set: b => b, platform: b => b } });
  assert.equal((await call(handler)).status, 404);
  assert.deepEqual((await call(handler, { path: '/status' })).value, { role: 'signer', wallets: { balances: {} } });
  assert.deepEqual((await call(handler, { path: '/wallets' })).value, { balances: {} });
  for (const path of ['/offer', '/cancel', '/take', '/withdraw', '/fee/set', '/fee/platform']) {
    const body = { offerId: 'offer', baseAmount: '1', price: '2' };
    const result = await call(handler, { method: 'POST', path, body });
    assert.equal(result.status, 200);
    assert.deepEqual(result.value, path === '/cancel' ? { offerId: 'offer' } : body);
  }
});
