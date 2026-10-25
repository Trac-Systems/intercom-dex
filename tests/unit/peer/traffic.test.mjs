import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { powWorker } from '../../../peer/features/sidechannel/pow-client.js';
import Sidechannel from '../../../peer/features/sidechannel/index.js';
import { registerHooks } from 'node:module';
const loader = registerHooks({ resolve(specifier, context, next) {
  return next(specifier === 'bare-ws' ? 'ws' : specifier, context);
} });
const { default: DexBridge } = await import('../../../peer/features/dex-bridge.js');
loader.deregister();
import { dexTransport, DEX_POW_BITS, DEX_POW_CLASSES, DEX_POW_LOW, SERVER_RATE, TRADER_RATE } from '../../../peer/features/dex-transport.js';
import { generateIdentity, encodeKey } from '../../../src/core/keys.js';
import { ed25519 } from '@noble/curves/ed25519.js';

const wallet = () => { const id = generateIdentity(); return { publicKey: encodeKey(id.publicKey), sign: b => Buffer.from(ed25519.sign(b, id.secretKey)) }; };
function receiver(config = {}, peer = {}) {
  const delivered = [], relayed = [], sc = new Sidechannel(peer, { welcomeRequired: false, onMessage: (...args) => delivered.push(args), ...config });
  let handle;
  const ch = { opened: true, addMessage(h) { handle = h; return h; }, open() {}, fullyOpened: () => new Promise(() => {}) };
  sc._openChannelForConnection({ userData: { createChannel: () => ch } }, sc._registerChannel('test'));
  sc.connections.set({}, new Map([['test', { channel: { opened: true }, message: { send: p => relayed.push(p) } }]]));
  return { sc, delivered, relayed, receive: p => handle.onmessage(p) };
}

test('required exact and prefix channels enforce PoW even when open; missing, weak, stale and cross-channel proofs never relay', async () => {
  const config = { powEnabled: true, powDifficulty: 9, openChannels: ['test'], powRequiredChannels: ['test'], powRequiredPrefixes: ['private:'] };
  const { sc, delivered, relayed, receive } = receiver(config);
  assert.equal(sc._inviteRequired('test'), false); assert.equal(sc._welcomeRequired('test'), false);
  assert.equal(sc._powRequired('private:abc'), true); assert.equal(sc._powRequired('private'), false); assert.equal(sc._powRequired('other'), false);
  const good = await sc._buildPayload('test', { content: 'hello' });
  const [prefix, suffix] = sc._powParts(good);
  assert.equal(prefix + 123 + suffix, sc._powBase(good, 123));
  receive({ ...good, pow: undefined });
  let nonce = 0;
  while (sc._checkPow({ ...good, pow: { nonce } }, 'test')) nonce++;
  receive({ ...good, pow: { nonce, difficulty: 99 } });
  receive({ ...good, channel: 'other' }); receive({ ...good, ts: Date.now() - 60000 });
  receive({ ...good, pow: { nonce: NaN } });
  assert.equal(delivered.length, 0); assert.equal(relayed.length, 0);
  receive(good); receive(good);
  assert.equal(delivered.length, 1); assert.equal(relayed.length, 1);
});

test('a handler error drops only that message: protomux would rethrow it and end the process', async t => {
  const { sc, delivered, receive } = receiver({ openChannels: ['test'] });
  const check = sc._checkInvite.bind(sc);
  let fail = true;
  t.mock.method(sc, '_checkInvite', (...args) => { if (fail) { fail = false; throw new TypeError('bad payload'); } return check(...args); });
  const first = await sc._buildPayload('test', { content: 'one' }), second = await sc._buildPayload('test', { content: 'two' });
  assert.doesNotThrow(() => receive(first));
  assert.equal(delivered.length, 0);
  receive(second);
  assert.equal(delivered.length, 1);
});

test('owner-only enforcement applies to open channels, verifies the original signature and never relays strangers', async () => {
  const owner = wallet(), stranger = wallet();
  const { sc, receive, delivered, relayed } = receiver({ openChannels: ['test'], ownerWriteChannels: ['test'], ownerKeys: { test: owner.publicKey } }, { wallet: owner });
  const evil = new Sidechannel({ wallet: stranger });
  receive(await evil._buildPayload('test', { text: 'stranger' }));
  receive({ ...await evil._buildPayload('test', { text: 'forged' }), from: owner.publicKey });
  receive(await evil._buildPayload('test', { control: 'auth', content: 'smuggled' }));
  assert.equal(delivered.length, 0); assert.equal(relayed.length, 0);
  receive(await sc._buildPayload('test', { text: 'owner' }));
  assert.equal(delivered.length, 1); assert.equal(relayed.length, 1);
  evil.ownerWriteChannels = new Set(['test']); evil.ownerKeys.set('test', owner.publicKey);
  assert.equal(await evil.broadcast('test', {}), false);
});

test('stamps survive bridge JSON copies for less than sixty seconds, share pending work, and bind every payload field', async t => {
  const sc = new Sidechannel({ wallet: wallet() }, { powEnabled: true, powDifficulty: 4 });
  let now = 100000; sc._now = () => now;
  const work = t.mock.method(sc, '_attachPow', sc._attachPow.bind(sc));
  const a = { text: 'hi' }, [first, same] = await Promise.all([sc._stampedPayload('test', a), sc._stampedPayload('test', { ...a })]);
  assert.equal(first, same); assert.equal(work.mock.callCount(), 1);
  now += 59999; assert.equal(await sc._stampedPayload('test', a), first);
  now++; assert.notEqual((await sc._stampedPayload('test', a)).id, first.id);
  assert.equal(work.mock.callCount(), 2);
  assert.notEqual(await sc._stampedPayload('elsewhere', a), first);
  assert.notEqual(await sc._stampedPayload('test', { text: 'different' }), first);
  await assert.rejects(sc._stampedPayload('test', { text: 'x'.repeat(1_000_000) }), /large/);
});

test('peer answers another bridge request while nonce search is running', async t => {
  const peer = { wallet: wallet() }, sc = new Sidechannel(peer, { powEnabled: true, powDifficulty: 18 });
  const bridge = new DexBridge(peer, { requireAuth: true, token: 'unit-token' }); bridge.attachSidechannel(sc);
  const replies = []; bridge._broadcastToClient = (_client, reply) => replies.push(reply);
  const client = { authed: true };
  // Force two chunks without relying on a lucky/unlucky random proof.
  let answered = false;
  const slice = powWorker.slice.bind(powWorker);
  t.mock.method(powWorker, 'slice', job => answered ? slice(job) : Promise.resolve({ nonce: -1 }));
  const payload = { channel: 'test', id: 'test', from: null, origin: null, ts: Date.now(), message: {} };
  let working = true;
  const promise = sc._attachPow(payload).finally(() => { working = false; });
  await new Promise(resolve => setTimeout(() => {
    bridge._handleClientMessage(client, { type: 'ping', id: 1 }); answered = true; resolve();
  }, 0));
  assert.equal(answered, true); assert.equal(replies[0].type, 'pong');
  assert.equal(working, true, 'search yielded before completing');
  await promise; assert.equal(payload.pow.difficulty, 18);
});

test('prefix-state hashing preserves the canonical proof across UTF-8 and SHA-256 block boundaries', async () => {
  const sc = new Sidechannel({ wallet: wallet() }, { powEnabled: true, powDifficulty: 9 });
  for (const length of [0, 1, 55, 56, 63, 64, 65, 1000, 15000]) {
    const payload = await sc._buildPayload('test', { text: 'é\\"'.repeat(length), nested: { z: 1, a: null } });
    const expected = crypto.createHash('sha256').update(sc._powBase(payload, payload.pow.nonce)).digest();
    assert.equal(expected[0], 0);
    assert.equal(expected[1] & 128, 0);
    assert.equal(sc._checkPow(payload, 'test'), true);
    assert.equal(sc._verifySig(payload, payload.from), true);
    const changed = crypto.createHash('sha256').update(sc._powBase({ ...payload, message: { text: 'changed' } }, payload.pow.nonce)).digest();
    assert.notDeepEqual(changed, expected);
  }
});

test('safety and negotiation stamps interrupt running background work, overtake queued announcements and declines, and retain valid proofs', async t => {
  const policy = dexTransport({ role: 'trader', servicePeerKey: 'a'.repeat(64) }).sidechannel;
  const sc = new Sidechannel({ wallet: wallet() }, { ...policy, powDifficulty: 4 });
  const slice = powWorker.slice.bind(powWorker);
  let held = true, attempts = 0, now = 100000;
  sc._now = () => now;
  t.mock.method(powWorker, 'slice', job => {
    attempts++;
    return held ? Promise.resolve({ nonce: -1 }) : slice(job);
  });
  const order = [], stamp = (ch, kind) => sc._stampedPayload(ch, { kind }).then(p => { order.push(kind); return p; });
  const background = stamp('intercom-dex:offers', 'offer');
  await new Promise(r => setTimeout(r, 0));
  assert.ok(attempts > 0, 'background work was already running');
  const queued = stamp('intercom-dex:signers', 'heartbeat');
  const ch = 'intercom-dex:t:' + 'b'.repeat(64);
  const decline = stamp(ch, 'decline');
  const more = [2, 3, 4].map(n => sc._stampedPayload(ch, { kind: 'decline', n }).then(p => { order.push('decline'); return p; }));
  await assert.rejects(sc._stampedPayload(ch, { kind: 'decline', n: 5 }), /busy/, 'a fifth waiting decline is dropped, not queued');
  const take = stamp(ch, 'take'), accept = stamp(ch, 'accept'), transfer = stamp(ch, 'transferSent');
  const direct = await stamp('intercom-dex', 'book');
  assert.equal(direct.pow, undefined, 'unprotected traffic never waits for a stamp');
  // A preempted stamp must refresh its timestamp and hash input before it resumes.
  now += 60000; held = false;
  const payloads = await Promise.all([transfer, take, accept, background, queued, decline]);
  await Promise.all(more);
  // Heartbeats share the first class: a signer whose heartbeat waited behind trade traffic looked offline to traders.
  assert.deepEqual(order, ['book', 'heartbeat', 'transferSent', 'take', 'accept', 'offer', 'decline', 'decline', 'decline', 'decline']);
  for (const p of payloads) {
    assert.equal(p.ts, now);
    assert.equal(sc._checkPow(p, p.channel), true);
    assert.equal(sc._verifySig(p, p.from), true);
  }
  assert.deepEqual(sc.powPending, [0, 0, 0, 0, 0]);
});

test('accept and reveal interrupt a running deal stamp and overtake queued deal repeats', async t => {
  const policy = dexTransport({ role: 'trader', servicePeerKey: 'a'.repeat(64) }).sidechannel;
  const sc = new Sidechannel({ wallet: wallet() }, { ...policy, powDifficulty: 4 });
  const ch = 'intercom-dex:t:' + 'b'.repeat(64), order = [];
  const slice = powWorker.slice.bind(powWorker);
  let held = true, started;
  const running = new Promise(resolve => { started = resolve; });
  t.mock.method(powWorker, 'slice', job => {
    started();
    return held ? Promise.resolve({ nonce: -1 }) : slice(job);
  });
  const stamp = (kind, n = 0) => sc._stampedPayload(ch, { kind, n }).then(p => { order.push(kind); return p; });
  const first = stamp('deal');
  await running;
  const repeats = [1, 2, 3, 4, 5].map(n => stamp('deal', n));
  const accept = stamp('accept'), reveal = stamp('reveal'), heartbeat = stamp('heartbeat');
  held = false;
  const payloads = await Promise.all([first, ...repeats, accept, reveal, heartbeat]);
  assert.deepEqual(order, ['heartbeat', 'accept', 'reveal', ...Array(6).fill('deal')]);
  for (const payload of payloads) {
    assert.equal(sc._checkPow(payload, ch), true);
    assert.equal(sc._verifySig(payload, payload.from), true);
  }
  assert.ok(sc.powPending.every(n => n === 0));
});

test('a stranger take flood above the stamping rate does not delay transferSent past a small bound', async () => {
  const policy = dexTransport({ role: 'trader', servicePeerKey: 'a'.repeat(64) }).sidechannel;
  const sc = new Sidechannel({ wallet: wallet() }, { ...policy, powDifficulty: 12 });
  const ch = 'intercom-dex:t:' + 'b'.repeat(64), work = [];
  let flooding = true, n = 0, refused = 0;
  // Each stranger take asks for a decline; takes that are admitted add negotiation replies and the book keeps moving.
  const flood = (async () => {
    while (flooding) {
      for (let i = 0; i < 20; i++) {
        n++;
        work.push(sc._stampedPayload(ch, { kind: 'decline', n }).catch(() => { refused++; }), sc._stampedPayload(ch, { kind: 'accept', n }));
      }
      work.push(sc._stampedPayload('intercom-dex:offers', { kind: 'offer', n }));
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  })();
  let sent, elapsed, behind;
  try {
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.ok(sc.powPending[1] > 20, `negotiation stamps are far behind the flood: ${sc.powPending}`);
    const started = performance.now();
    sent = await sc._stampedPayload(ch, { kind: 'transferSent', body: { tradeId: 'c'.repeat(64) } });
    elapsed = performance.now() - started; behind = sc.powPending[1];
  } finally { flooding = false; await flood; }
  assert.ok(elapsed < 1000, `transferSent took ${Math.round(elapsed)} ms`);
  assert.ok(behind > 0, 'transferSent overtook the waiting flood');
  assert.equal(sc._checkPow(sent, ch), true);
  assert.ok(refused > 0); assert.ok(sc.powPending.at(-1) <= sc.powLowPending, 'at most a few declines wait');
  await Promise.all(work);
  assert.deepEqual(sc.powPending, [0, 0, 0, 0, 0]);
});

test('the stamp cache never drops a pending stamp; re-sends share it and expire only after it finished', async t => {
  const sc = new Sidechannel({ wallet: wallet() }, { powEnabled: true, powDifficulty: 4 });
  const channel = 'intercom-dex:t:' + 'b'.repeat(64);
  const slice = powWorker.slice.bind(powWorker);
  let held = true, now = 100000;
  sc._now = () => now;
  t.mock.method(powWorker, 'slice', job => held ? Promise.resolve({ nonce: -1 }) : slice(job));
  const work = t.mock.method(sc, '_attachPow', sc._attachPow.bind(sc));
  const first = sc._stampedPayload(channel, { kind: 'transferSent' });
  await new Promise(resolve => setTimeout(resolve, 0));
  now += 120000;
  assert.equal(sc._stampedPayload(channel, { kind: 'transferSent' }), first);
  held = false;
  const payload = await first;
  now = payload.ts + 9999; assert.equal(await sc._stampedPayload(channel, { kind: 'transferSent' }), payload);
  now++; assert.notEqual(await sc._stampedPayload(channel, { kind: 'transferSent' }), payload);
  assert.equal(work.mock.callCount(), 2);
});

test('a failed priority stamp releases background work, permits retries and never poisons the next negotiation', async t => {
  const sc = new Sidechannel({}, { powEnabled: true, powDifficulty: 4, powClasses: [['accept', 'take']] });
  const build = sc._buildPayload.bind(sc);
  let fail = true;
  t.mock.method(sc, '_buildPayload', (ch, message, invite) => {
    if (fail && message.kind === 'accept') throw Error('stamp failed');
    return build(ch, message, invite);
  });
  const rejected = assert.rejects(sc._stampedPayload('test', { kind: 'accept' }), /stamp failed/);
  const [take, offer] = await Promise.all([sc._stampedPayload('test', { kind: 'take' }), sc._stampedPayload('test', { kind: 'offer' })]);
  await rejected;
  assert.equal(sc._checkPow(take, 'test'), true); assert.equal(sc._checkPow(offer, 'test'), true);
  assert.deepEqual(sc.powPending, [0, 0, 0]);
  fail = false;
  assert.equal(sc._checkPow(await sc._stampedPayload('test', { kind: 'accept' }), 'test'), true);
});

test('dex config pins the owner operationally, enables one difficulty, defaults server relays and rejects trader serving', () => {
  const key = 'a'.repeat(64);
  for (const role of ['service', 'signer', 'trader']) {
    const policy = dexTransport({ role, servicePeerKey: key });
    assert.equal(policy.relay.serve, role !== 'trader');
    assert.equal(policy.sidechannel.ownerKeys['intercom-dex'], key);
    assert.equal(policy.sidechannel.powDifficulty, DEX_POW_BITS);
    assert.deepEqual(policy.sidechannel.powClasses, DEX_POW_CLASSES); assert.deepEqual(policy.sidechannel.powLowKinds, DEX_POW_LOW);
    for (const kind of ['heartbeat', 'transferSent', 'ack', 'sharePublish', 'claimed', 'refunded', 'summon']) assert.ok(DEX_POW_CLASSES[0].includes(kind), kind);
    assert.ok(DEX_POW_CLASSES[1].includes('accept')); assert.ok(DEX_POW_CLASSES[1].includes('reveal'));
    assert.deepEqual(DEX_POW_CLASSES[2], ['deal']);
    assert.deepEqual(DEX_POW_LOW, ['decline']);
    assert.deepEqual(policy.sidechannel.powRequiredPrefixes, ['intercom-dex:t:']);
    // Servers carry the whole network's traffic per connection; traders keep the strict limit.
    const rate = role === 'trader' ? TRADER_RATE : SERVER_RATE;
    assert.equal(policy.sidechannel.rateBytesPerSecond, rate.rateBytesPerSecond); assert.equal(policy.sidechannel.rateBurstBytes, rate.rateBurstBytes);
  }
  assert.throws(() => dexTransport({ role: 'trader', servicePeerKey: key, serveRelay: true }), /Traders/);
  assert.throws(() => dexTransport({ role: 'signer' }), /servicePeerKey/);
  assert.throws(() => dexTransport({ servicePeerKey: key }), /role/);
  assert.equal(dexTransport({ role: 'signer', servicePeerKey: key, serveRelay: false }).relay.serve, false);
});
