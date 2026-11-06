import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ed25519 } from '@noble/curves/ed25519.js';
import { StakeTransport, STAKE_CHANNEL, sealStakeMessage, openStakeMessage } from '../../../src/stake/transport.js';

const identity = n => { const secretKey = new Uint8Array(32).fill(n); return { secretKey, publicKey: Buffer.from(ed25519.getPublicKey(secretKey)).toString('hex') }; };
const a = identity(1), b = identity(2), c = identity(3);
const input = { kind: 'stakeRequest', to: b.publicKey, id: '0'.repeat(64), at: 100, method: 'status', body: {} };
test('stake envelopes bind domain, sender, recipient, method, identity and bounded freshness', () => {
  const m = sealStakeMessage(input, a.secretKey);
  assert.equal(openStakeMessage(m, 220).from, a.publicKey);
  assert.throws(() => openStakeMessage(m, 221), /stale/);
  for (const patch of [{ to: c.publicKey }, { method: 'release' }, { body: { amount: '1' } }, { ch: 'intercom-dex' }, { extra: true }])
    assert.throws(() => openStakeMessage({ ...m, ...patch }, 100));
  assert.throws(() => sealStakeMessage({ ...input, body: { text: 'x'.repeat(180000) } }, a.secretKey), /limit/);
});
test('stake transport correlates signed replies and propagates handler refusal and stop', async () => {
  const bridge = new EventEmitter(); bridge.join = async ch => assert.equal(ch, STAKE_CHANNEL);
  bridge.send = async (ch, m) => { bridge.emit('message', ch, m); };
  const client = new StakeTransport({ bridge, identity: a, now: () => 100 });
  const server = new StakeTransport({ bridge, identity: b, now: () => 100, handle: async (method, body, from) => {
    assert.equal(from, a.publicKey); if (method === 'fail') throw new Error('Withdrawal is still waiting'); return { amount: body.amount };
  } });
  await client.start(); await server.start();
  assert.deepEqual(await client.request(b.publicKey, 'status', { amount: '9007199254740993' }), { amount: '9007199254740993' });
  await assert.rejects(client.request(b.publicKey, 'fail'), /still waiting/);
  const waiting = client.request(c.publicKey, 'status'); client.stop();
  await assert.rejects(waiting, /stopped/); server.stop();
  assert.equal(bridge.listenerCount('message'), 0);
});
test('stake transport ignores a correctly signed response from the wrong signer', async () => {
  const bridge = new EventEmitter(); bridge.join = async () => {};
  bridge.send = async (ch, m) => bridge.emit('message', ch, sealStakeMessage({ ...input, kind: 'stakeReply',
    id: m.id, to: a.publicKey, body: { ok: true, value: { stolen: true } } }, c.secretKey));
  const client = new StakeTransport({ bridge, identity: a, now: () => 100, timeoutMs: 10 }); await client.start();
  await assert.rejects(client.request(b.publicKey, 'status'), /timed out/); client.stop();
});

const randomBody = () => ({ text: randomBytes(300000).toString('base64'), unicode: '🦦é漢' });
import { randomBytes } from 'node:crypto';
import { stableJSON, sha256Hex } from '../../../src/core/canonical.js';
import { STAKE_BODY_BYTES, STAKE_PAGE_BYTES, STAKE_BUFFER_BYTES } from '../../../src/stake/paging.js';
import * as legacy from '../../fixtures/released-v0.1.48-stake-transport.mjs';

async function paging(t, options = {}) {
  const frames = [], bridge = new EventEmitter(); bridge.join = async () => {};
  bridge.send = async (ch, m) => { frames.push(m); if (!options.capture) bridge.emit('message', ch, m); };
  const allowPagingPeer = key => [a.publicKey, b.publicKey].includes(key);
  const client = new StakeTransport({ bridge, identity: a, now: () => 100, allowPagingPeer, ...options.client });
  let handled = 0;
  const server = new StakeTransport({ bridge, identity: b, now: () => 100, allowPagingPeer,
    handle: async (_method, body) => { handled++; return body; }, ...options.server });
  await client.start(); await server.start(); t.after(() => { client.stop(); server.stop(); });
  return { client, server, frames, bridge, handled: () => handled };
}
const resign = (m, patch, who = a) => { const { sig, ...body } = m; return sealStakeMessage({ ...body, ...patch }, who.secretKey); };
async function captured(t) {
  const f = await paging(t, { capture: true });
  f.client.pending.set(input.id, { reject() {} });
  const body = randomBody();
  await f.client.send({ ...input, body });
  return { ...f, body, request: f.frames.slice() };
}

test('large requests and replies reassemble byte-identical canonical UTF-8, within both wire limits', async t => {
  const f = await paging(t), body = randomBody();
  assert.equal(stableJSON(await f.client.request(b.publicKey, 'rewardVote', body)), stableJSON(body));
  assert.equal(f.handled(), 1);
  assert.ok(f.frames.filter(m => m.kind === 'stakeManifest').length === 2);
  assert.ok(f.frames.filter(m => m.kind === 'stakePage').length > 2);
  for (const m of f.frames) {
    assert.ok(Buffer.byteLength(stableJSON(m)) <= 180000);
    assert.ok(Buffer.byteLength(JSON.stringify({ message: m, sig: 'f'.repeat(128), from: 'f'.repeat(64), pow: { nonce: 123456789 } })) < 200000);
    openStakeMessage(m, 100);
  }
  assert.equal(f.client.bufferBytes, 0); assert.equal(f.server.bufferBytes, 0);
});

test('manifest binds all pages; missing, duplicate, reordered, foreign and unsigned pages never expose a partial body', async t => {
  const f = await captured(t), [manifest, ...pages] = f.request;
  await f.server.receive(pages[0]); assert.equal(f.server.transfers.size, 0);
  await f.server.receive(manifest); await f.server.receive(manifest);
  assert.equal(f.server.transfers.size, 1);
  await assert.rejects(f.server.receive({ ...pages[0], body: { ...pages[0].body, data: 'AAAA' } }), /signature/);
  await f.server.receive(resign(pages[0], {}, c));
  await f.server.receive(resign(pages[0], { id: 'e'.repeat(64) }));
  assert.equal(f.server.transfers.values().next().value.count, 0);
  await f.server.receive(pages[0]); await f.server.receive(pages[0]);
  assert.equal(f.server.transfers.values().next().value.count, 1); assert.equal(f.handled(), 0);
  for (const page of pages.slice(1).reverse()) await f.server.receive(page);
  assert.equal(f.handled(), 1);
  for (const page of f.request) await f.server.receive(page);
  assert.equal(f.handled(), 1, 'completed transfer replay is suppressed');
});

test('signed digest tampering and inflated byte lies are rejected before handling', async t => {
  for (const patch of [{ digest: 'f'.repeat(64) }, { rawBytes: 100 }]) {
    const f = await captured(t), [manifest, ...pages] = f.request;
    await f.server.receive(resign(manifest, { body: { ...manifest.body, ...patch } }));
    for (const page of pages.slice(0, -1)) await f.server.receive(page);
    await assert.rejects(f.server.receive(pages.at(-1)));
    assert.equal(f.handled(), 0); assert.equal(f.server.bufferBytes, 0);
  }
});

test('unconfigured senders and unsolicited replies allocate nothing; manifest count and byte bounds hold', async t => {
  const f = await captured(t), manifest = f.request[0];
  await f.server.receive(resign(manifest, {}, c));
  await f.server.receive(resign(manifest, { body: { ...manifest.body, kind: 'stakeReply' } }));
  for (const patch of [{ bytes: STAKE_BODY_BYTES + 1 }, { rawBytes: STAKE_BODY_BYTES + 1 }, { pages: 99999 }, { pages: -1 }, { encoding: 'gzip' }])
    await f.server.receive(resign(manifest, { body: { ...manifest.body, ...patch } }));
  assert.equal(f.server.transfers.size, 0);
  for (let i = 0; i < 20; i++) await f.server.receive(resign(manifest, { body: { ...manifest.body, transfer: i.toString(16).padStart(64, '0') } }));
  assert.equal(f.server.transfers.size, 4); assert.ok(f.server.bufferBytes <= STAKE_BUFFER_BYTES);
  await assert.rejects(f.client.send({ ...input, to: c.publicKey, body: randomBody() }), /not configured/);
  await assert.rejects(f.client.send({ ...input, body: { text: 'x'.repeat(STAKE_BODY_BYTES) } }), /paging limit/);
});

test('timeouts, request cancellation and stop release all incomplete transfer buffers', async t => {
  const source = await captured(t), f = await paging(t, { capture: true, server: { transferMs: 10 } });
  await f.server.receive(source.request[0]); assert.ok(f.server.bufferBytes > 0);
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(f.server.bufferBytes, 0);
  await f.server.receive(source.request[1]); assert.equal(f.handled(), 0);
  await f.server.receive(source.request[0]); f.server.stop(); assert.equal(f.server.bufferBytes, 0);
  assert.equal(f.server.transfers.size, 0);
  const lost = await paging(t, { capture: true, client: { timeoutMs: 20 } });
  const request = lost.client.request(b.publicKey, 'rewardBlock');
  const id = lost.frames[0].id;
  await lost.client.receive(resign(source.request[0], { id, method: 'rewardBlock', to: a.publicKey, body: { ...source.request[0].body, kind: 'stakeReply' } }, b));
  assert.ok(lost.client.bufferBytes > 0);
  await assert.rejects(request, /timed out/); assert.equal(lost.client.bufferBytes, 0);
});

test('released v0.1.48 accepts unchanged small bodies in both directions and silently ignores new kinds', async t => {
  const f = await paging(t);
  f.server.stop();
  const old = new legacy.StakeTransport({ bridge: f.bridge, identity: b, now: () => 100, handle: async (_method, body) => body });
  await old.start(); t.after(() => old.stop());
  const body = { text: 'x'.repeat(170000) };
  assert.deepEqual(await f.client.request(b.publicKey, 'rewardVote', body), body);
  assert.ok(f.frames.every(m => ['stakeRequest', 'stakeReply'].includes(m.kind)));
  const newServer = new StakeTransport({ bridge: f.bridge, identity: c, now: () => 100, handle: async (_method, body) => body });
  await newServer.start(); t.after(() => newServer.stop());
  assert.deepEqual(await old.request(c.publicKey, 'admissionInventory', { account: 'old-trader' }), { account: 'old-trader' });
  const pages = await captured(t);
  for (const m of pages.request) { assert.throws(() => legacy.openStakeMessage(m, 100)); f.bridge.emit('message', STAKE_CHANNEL, m); }
  assert.deepEqual(await old.request(c.publicKey, 'status', {}), {});
});

test('one old server times out only an oversized exchange and remains usable for the next legacy-sized request', async t => {
  const f = await paging(t, { client: { timeoutMs: 60 } }); f.server.stop();
  const old = new legacy.StakeTransport({ bridge: f.bridge, identity: b, now: () => 100, handle: async (_method, body) => body });
  await old.start(); t.after(() => old.stop());
  await assert.rejects(f.client.request(b.publicKey, 'rewardVote', { text: 'x'.repeat(200000) }), /timed out/);
  assert.deepEqual(await f.client.request(b.publicKey, 'status', { healthy: true }), { healthy: true });
  assert.equal(f.client.pending.size, 0);
});

test('aggregate reserved bytes, transfer slots, invalid page lengths and signed page corruption are bounded', async t => {
  const f = await captured(t), manifest = f.request[0];
  for (let n = 0; n < 5; n++) await f.server.receive(resign(manifest, { body: { ...manifest.body, transfer: n.toString(16).padStart(64, '0'),
    rawBytes: STAKE_BODY_BYTES, bytes: STAKE_BODY_BYTES, pages: Math.ceil(STAKE_BODY_BYTES / STAKE_PAGE_BYTES), encoding: 'json' } }));
  assert.equal(f.server.bufferBytes, STAKE_BUFFER_BYTES); assert.equal(f.server.transfers.size, 2);
  const broken = await captured(t), [header, ...pages] = broken.request;
  await broken.server.receive(header);
  await broken.server.receive(resign(pages[0], { body: { ...pages[0].body, data: 'AA==' } }));
  assert.equal(broken.server.transfers.values().next().value.count, 0);
  const bytes = Buffer.from(pages[0].body.data, 'base64'); bytes[10] ^= 1;
  await broken.server.receive(resign(pages[0], { body: { ...pages[0].body, data: bytes.toString('base64') } }));
  for (const page of pages.slice(1, -1)) await broken.server.receive(page);
  await assert.rejects(broken.server.receive(pages.at(-1)));
  assert.equal(broken.handled(), 0); assert.equal(broken.server.bufferBytes, 0);
});

test('signed noncanonical and invalid UTF-8 bodies cannot change bytes during reassembly', async t => {
  const f = await paging(t, { capture: true });
  const bodies = [Buffer.from('{ "a":1}'), Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xff]), Buffer.from('"}')])];
  for (const [index, raw] of bodies.entries()) {
    const transfer = index.toString().padStart(64, '0'), manifest = { kind: 'stakeRequest', transfer, bytes: raw.length, rawBytes: raw.length,
      encoding: 'json', pages: 1, digest: sha256Hex(raw) };
    await f.server.receive(sealStakeMessage({ ...input, kind: 'stakeManifest', body: manifest }, a.secretKey));
    await assert.rejects(f.server.receive(sealStakeMessage({ ...input, kind: 'stakePage', body: { transfer, index: 0, data: raw.toString('base64') } }, a.secretKey)), /Noncanonical/);
    assert.equal(f.handled(), 0); assert.equal(f.server.bufferBytes, 0);
  }
});

test('stop cancels paced outbound pages without leaving timers or retained transfers', async t => {
  const f = await paging(t, { capture: true, client: { pageRate: () => 1000 } });
  const request = f.client.request(b.publicKey, 'rewardVote', { text: 'x'.repeat(200000) });
  assert.equal(f.client.pacing.size, 1); assert.equal(f.frames.length, 0, 'the manifest is charged before sending');
  f.client.stop(); await assert.rejects(request, /stopped/);
  assert.equal(f.client.pacing.size, 0); assert.equal(f.client.outbound.size, 0); assert.equal(f.frames.length, 0);
});

test('the complete signed envelope fits the exact legacy 180000-byte boundary', () => {
  const base = sealStakeMessage({ ...input, body: { text: '' } }, a.secretKey);
  const length = 180000 - Buffer.byteLength(stableJSON(base));
  const m = sealStakeMessage({ ...input, body: { text: 'x'.repeat(length) } }, a.secretKey);
  assert.equal(Buffer.byteLength(stableJSON(m)), 180000);
  assert.equal(legacy.openStakeMessage(m, 100).kind, 'stakeRequest');
  assert.throws(() => sealStakeMessage({ ...input, body: { text: 'x'.repeat(length + 1) } }, a.secretKey), /transport limit/);
});

test('global transfer slots stay bounded even across many configured historical members', async t => {
  const source = await captured(t), peers = Array.from({ length: 18 }, (_, n) => identity(n + 20));
  const f = await paging(t, { capture: true, server: { allowPagingPeer: key => peers.some(p => p.publicKey === key) } });
  for (const peer of peers) await f.server.receive(resign(source.request[0], {}, peer));
  assert.equal(f.server.transfers.size, 16); assert.ok(f.server.bufferBytes <= STAKE_BUFFER_BYTES);
  f.server.stop(); assert.equal(f.server.transfers.size, 0); assert.equal(f.server.bufferBytes, 0);
});
