import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { generateIdentity, encodeKey } from '../../../src/core/keys.js';
import { seal } from '../../../src/core/envelope.js';
import { MarketChat } from '../../../src/market/chat.js';
import { dexTransport } from '../../../peer/features/dex-transport.js';
import { resolveNetwork } from '../../../src/net/profile.js';
import { startMarketFeed } from '../../../src/market-feed/runtime.js';
import { random32 } from '../../../src/roles/common.js';
import { fixture, hex, SOL, MINT } from '../core/helpers.mjs';
import { setup, FakeBridge } from './helpers.mjs';

const CHAT = 'intercom-dex:chat';

test('relay limits apply at role and peer receivers: one second, 600/hour, name+text duplicate window', () => {
  let now = 200000;
  const key = generateIdentity(), dexKey = encodeKey(key.publicKey), stranger = generateIdentity();
  const chat = new MarketChat({ now: () => now, chatRelays: [dexKey] });
  const wire = (name, text, who = key) => seal({ kind: 'chat', ch: CHAT, body: { name, text, ts: now } }, who.secretKey, { ts: now, nonce: random32() });
  assert.equal(chat.receive(wire('One', 'same')).viewer, true);
  assert.equal(chat.receive(wire('Two', 'same')), null); now++;
  assert.ok(chat.receive(wire('Two', 'same'))); now++;
  assert.equal(chat.receive(wire('One', 'same')), null);
  for (let i = 2; i < 600; i++) { now = 200000 + i; assert.ok(chat.receive(wire('One', `message ${i}`))); }
  now = 200600; assert.equal(chat.receive(wire('Three', 'cap')), null);
  now = 203600; assert.ok(chat.receive(wire('One', 'same')));
  assert.equal(chat.read().length, 100); assert.ok(chat.read().every(m => m.viewer === true));
  assert.equal(chat.receive(wire('Other', 'normal', stranger)).viewer, undefined); now++;
  assert.equal(chat.receive(wire('Other', 'too soon', stranger)), null);
  for (const chatRelays of [null, ['bad'], [dexKey, dexKey], Array(129).fill(dexKey)]) assert.throws(() => new MarketChat({ chatRelays }));
});

test('peer acceptMessage uses the same pinned relay limits, and market-feed cannot serve blind relays', t => {
  let now = 200000; t.mock.method(Date, 'now', () => now * 1000);
  const key = generateIdentity(), dexKey = encodeKey(key.publicKey);
  const config = { role: 'market-feed', servicePeerKey: random32(), chatRelays: [dexKey] }, transport = dexTransport(config);
  assert.equal(transport.relay.serve, false); assert.throws(() => dexTransport({ ...config, serveRelay: true }), /relays/);
  const chat = new MarketChat({ chatRelays: [dexKey] });
  for (let i = 0; i < 600; i++) {
    const message = seal({ kind: 'chat', ch: CHAT, body: { name: 'Viewer', text: `line ${i}`, ts: now } }, key.secretKey, { ts: now, nonce: random32() });
    assert.ok(transport.sidechannel.acceptMessage(CHAT, { message })); assert.ok(chat.receive(message)); now++;
  }
  const extra = seal({ kind: 'chat', ch: CHAT, body: { name: 'Viewer', text: 'over limit', ts: now } }, key.secretKey, { ts: now, nonce: random32() });
  assert.equal(transport.sidechannel.acceptMessage(CHAT, { message: extra }), false); assert.equal(chat.receive(extra), null);
});

test('chatRelays are pinned on mainnet, locally overridable and strictly validated', () => {
  assert.deepEqual(resolveNetwork({ network: 'mainnet' }).chatRelays, ['2331cbf0de3978b6d7b8853e31175e7b8bde1a3e936c3f371c3120a33b0f9c56']);
  assert.throws(() => resolveNetwork({ network: 'mainnet', chatRelays: [hex()] }), /Mainnet pins chatRelays/);
  const config = { network: 'local', mint: MINT, platformCollector: SOL, peer: { msbBootstrap: hex(), msbChannel: 'test', msbNetworkId: 918,
    msbDhtBootstrap: ['127.0.0.1:1'], peerDhtBootstrap: ['127.0.0.1:1'], trac: { reset: { bootstrap: hex(), channel: 'test', dhtBootstrap: ['127.0.0.1:1'] } } } };
  const keys = [hex(), hex()]; assert.deepEqual(resolveNetwork({ ...config, chatRelays: keys }).chatRelays, keys);
  for (const chatRelays of [null, 'bad', ['bad'], [keys[0], keys[0]], [123]]) assert.throws(() => resolveNetwork({ ...config, chatRelays }), /chatRelays/);
});

test('market-feed joins only public channels, accepts only verified venue data and stops its listener', async t => {
  const s = setup(); await s.feed.start(); t.after(() => s.feed.stop());
  assert.deepEqual(s.bridge.joined, ['intercom-dex', 'intercom-dex:offers', CHAT]);
  await s.feed.start(); assert.equal(s.bridge.joined.length, 3);
  assert.equal(s.feed.host, undefined); assert.equal(s.feed.wallet, undefined); assert.equal(s.feed.solana, undefined);
  assert.equal(await s.send('registry', s.f.registry, s.f.buyer), false);
  const raw = s.wire('registry', s.f.registry);
  assert.equal(await s.feed.receive('intercom-dex', { ...raw, sig: '0'.repeat(128) }), false);
  assert.equal(await s.feed.receive('wrong', raw), false);
  assert.equal(await s.feed.receive('intercom-dex', raw), true);
  assert.equal(await s.feed.receive('intercom-dex', raw), false);
  const o = s.offer(); assert.equal(await s.send('offer', o, s.f.buyer, 'intercom-dex:offers'), false);
  assert.equal(await s.send('offer', s.offer({ software: '0.0.1' }), s.f.seller, 'intercom-dex:offers'), false);
  assert.equal(await s.send('offer', s.offer({ registryVersion: 9 }), s.f.seller, 'intercom-dex:offers'), false);
  assert.equal(await s.send('tradeLog', s.trade(), s.f.seller), false);
  assert.equal(await s.send('tradeLog', s.trade({ ts: s.clock.t + 1 })), false);
  s.bridge.emit('message', 'intercom-dex:offers', s.wire('offer', o, s.f.seller, 'intercom-dex:offers')); await s.feed.queue;
  assert.equal(s.view().offers.length, 1);
  await s.send('registry', { ...s.f.registry, fee: { ...s.f.registry.fee, tradeFeeBps: 51 } });
  assert.equal(s.feed.registry.usable, null); assert.deepEqual(s.view().offers, []);
  s.feed.stop(); assert.equal(s.bridge.listenerCount('message'), 0);
  const fail = setup(); fail.bridge.join = async () => { throw new Error('join failed'); };
  await assert.rejects(fail.feed.start(), /join failed/); assert.equal(fail.bridge.listenerCount('message'), 0);
});

test('feed chat bounds and cursors do not replay history after restart; unconfigured relay cannot post', async () => {
  const s = setup();
  for (let i = 0; i < 105; i++) { s.clock.t++; assert.equal((await s.feed.postViewer({ id: String(i), name: 'Guest', text: `line ${i}` })).ok, true); }
  const first = s.feed.readChat(); assert.equal(first.messages.length, 20); assert.equal(first.next, 105); assert.equal(first.oldest, 6);
  const all = s.feed.readChat(0); assert.equal(all.messages.length, 100); assert.equal(all.messages[0].seq, 6);
  assert.throws(() => s.feed.readChat(-1)); assert.throws(() => s.feed.readChat('1'));
  const restart = setup({ store: s.store, f: s.f, key: s.key, clock: s.clock });
  assert.deepEqual(restart.feed.readChat().messages, []); assert.notEqual(restart.feed.epoch, s.feed.epoch);
  assert.equal(restart.feed.readChat(105).next, 0, 'old epoch cursor resets to the new sequence head');
  assert.equal((await restart.feed.postViewer({ id: 'after-restart', name: 'Guest', text: 'New epoch' })).ok, true);
  assert.equal(restart.feed.readChat(0).messages[0].seq, 1);
  assert.deepEqual(await restart.feed.postViewer({ id: '0', name: 'Guest', text: 'line 0' }), { ok: true, duplicate: true });
  const noRelay = setup({ profile: { chatRelays: [] } });
  assert.deepEqual(await noRelay.feed.postViewer({ id: 'a', name: 'A', text: 'Hello' }), { ok: false, error: 'relay_not_configured' });
});

test('wallet-free runtime opens only its identity keyring and public record store and closes HTTP', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-runtime-')), viewerKeyFile = join(dir, 'viewer.token');
  writeFileSync(viewerKeyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const f = fixture(), config = { dataDir: dir, serviceKey: encodeKey(f.service.publicKey), marketFeed: { port: 0, viewerKeyFile } };
  const options = { config, profile: { chatRelays: [] }, bridge: new FakeBridge(), password: randomBytes(32).toString('hex') };
  const runtime = await startMarketFeed(options); t.after(() => runtime.close());
  const identity = runtime.feed.identity.publicKey;
  assert.deepEqual(readdirSync(dir).sort(), ['keyring.json', 'records', 'viewer.token']);
  assert.equal(runtime.feed.wallet, undefined); assert.equal(runtime.server.address().address, '127.0.0.1');
  await runtime.close(); assert.equal(runtime.server.listening, false);
  const restarted = await startMarketFeed({ ...options, bridge: new FakeBridge() }); t.after(() => restarted.close());
  assert.equal(restarted.feed.identity.publicKey, identity); await restarted.close();
  await assert.rejects(startMarketFeed({ ...options, config: { ...config, dataDir: 'relative' } }), /absolute/);
  await assert.rejects(startMarketFeed({ ...options, config: { ...config, marketFeed: { ...config.marketFeed, host: '0.0.0.0' } } }), /Expected marketFeed/);
  await assert.rejects(startMarketFeed({ ...options, config: { ...config, marketFeed: { ...config.marketFeed, port: -1 } } }), /port/);
  assert.equal(options.bridge.listenerCount('message'), 0);
});

test('trader, venue, /chat and dex_chat preserve relay viewer labels', async t => {
  const { Trader } = await import('../../../src/roles/trader.js');
  const { Service } = await import('../../../src/roles/service.js');
  const { controlHandler } = await import('../../../src/roles/control.js');
  const { registerChatTools } = await import('../../../src/mcp/chat-tools.js');
  let now = 200000; t.mock.method(Date, 'now', () => now * 1000);
  const s = setup(), f = s.f, profile = { ...s.profile, chatRelays: [s.identity.publicKey] };
  const options = { bridge: new FakeBridge(), identity: s.identity, store: s.store, profile, trac: null, log: () => {}, solana: { assertFeeConfig: async () => {} } };
  const trader = new Trader({ ...options, solana: null, proof: { zkey: '/unused-test.zkey', pool: 0 }, serviceKey: encodeKey(f.service.publicKey), me: { dexKey: s.identity.publicKey, tracAddr: f.terms.buyer.tracAddr, solAddr: SOL } });
  const service = new Service({ firstLaunch: true, ...options, bridge: new FakeBridge(), registryInput: f.registry });
  for (const role of [trader, service]) {
    t.after(() => role.stop()); await role.start();
    const receive = role.host.hooks.unrouted[0];
    for (let i = 0; i < 2; i++) {
      const message = seal({ kind: 'chat', ch: CHAT, body: { name: 'Guest', text: `Viewer ${i}`, ts: now } }, s.key.secretKey, { ts: now, nonce: random32() });
      await receive(CHAT, message); now++;
    }
    assert.equal(role.readChat().length, 2); assert.ok(role.readChat().every(m => m.viewer === true));
    let output;
    const request = Object.assign(new FakeBridge(), { method: 'GET', url: '/chat', headers: { authorization: 'Bearer unit-feed-test' } });
    controlHandler({ token: 'unit-feed-test', role })(request,
      { writeHead(code) { assert.equal(code, 200); }, end(body) { output = JSON.parse(body); } });
    request.emit('end'); await new Promise(resolve => setImmediate(resolve));
    assert.ok(output.every(m => m.viewer === true));
    let handler;
    registerChatTools({ registerTool(name, schema, callback) { assert.equal(name, 'dex_chat'); handler = callback; } }, async () => output);
    const tagged = JSON.parse((await handler({ action: 'read' })).content[0].text);
    assert.deepEqual(tagged.messages, output.map(({ text, ...m }) => ({ ...m, untrustedText: text })));
    role.stop();
  }
});

test('CLI dispatches market-feed without wallet/proof startup and refuses wallet commands', async () => {
  const { spawnSync } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const dir = mkdtempSync(join(tmpdir(), 'feed-cli-')), tokenFile = join(dir, 'bridge.token');
  writeFileSync(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const config = { role: 'market-feed', network: 'mainnet', dataDir: dir, servicePeerKey: 'ab'.repeat(32), serviceKey: 'cd'.repeat(32),
    bridge: { url: 'ws://127.0.0.1:1', tokenFile }, marketFeed: { port: 0, viewerKeyFile: tokenFile } };
  const file = join(dir, 'role.json'); writeFileSync(file, JSON.stringify(config));
  const profile = resolveNetwork(config);
  const replacements = {
    '/src/net/bridge.js': `export class Bridge { async connect(){return this} async info(){return {info:${JSON.stringify({ role: config.role, servicePeerKey: config.servicePeerKey, networkProfile: profile })}}} on(){} close(){} }`,
    '/src/proof/lockproof.js': `export async function checkProofFiles(){throw Error('unexpected proof startup')} export async function makeLockCertificate(){} export async function verifyLock(){} export async function proveLock(){}`,
    '/src/wallets/setup.js': `export async function ensureWallets(){throw Error('unexpected wallet startup')} export async function setupWallets(){} export async function exportWallets(){} export function walletFile(){throw Error('unexpected wallet file')} export function rpcAdvice(){return {}}`,
    '/src/market-feed/runtime.js': `export async function startMarketFeed({config}){if(config.role!=='market-feed') throw Error('wrong role'); return {feed:{identity:{publicKey:'${'ef'.repeat(32)}'}},close:async()=>{}}}`,
  };
  const loader = join(dir, 'loader.mjs');
  writeFileSync(loader, `import '${new URL('../../../src/roles/keyring.js', import.meta.url).href}'; import {registerHooks} from 'node:module'; const replacements=${JSON.stringify(replacements)}; registerHooks({load(url,context,next){const key=Object.keys(replacements).find(k=>url.endsWith(k));return key?{format:'module',source:replacements[key],shortCircuit:true}:next(url,context)}});`);
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(loader).href, 'bin/dex.mjs', '--config', file],
    { encoding: 'utf8', env: { ...process.env, DEX_KEY_PASSWORD: randomBytes(32).toString('hex') } });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /DEX_ROLE_READY.*market-feed/);
  const forbidden = spawnSync(process.execPath, ['bin/dex.mjs', 'setup', '--config', file], { encoding: 'utf8' });
  assert.equal(forbidden.status, 1); assert.match(forbidden.stderr, /market-feed only supports run/);
});

test('role admits only seller-signed, registry-bound settlement terms before mapping a logged buyer', async () => {
  const { selectCommittee } = await import('../../../src/core/committee.js');
  const { tradeId } = await import('../../../src/core/terms.js');
  const s = setup(); await s.register(); const o = s.offer(); await s.send('offer', o, s.f.seller, 'intercom-dex:offers');
  const terms = { ...s.f.terms, offerId: o.offerId, baseAmount: '120000000000', quoteAmount: '504000000' };
  terms.committee = selectCommittee(s.f.registry, terms.R, { n: s.f.registry.params.n, k: terms.k, quoteAmount: terms.quoteAmount,
    pair: terms.pair, exclude: [terms.buyer.dexKey, terms.seller.dexKey] }).map(({ dexKey, boxKey }) => ({ dexKey, boxKey }));
  const id = tradeId(terms), report = { offerId: o.offerId, tradeId: id, terms, hashHex: hex(), txHash: hex() };
  assert.equal(await s.send('settled', report, s.f.buyer, 'intercom-dex:offers'), false);
  assert.equal(await s.send('settled', { ...report, tradeId: hex() }, s.f.seller, 'intercom-dex:offers'), false);
  assert.equal(await s.send('settled', report, s.f.seller, 'intercom-dex:offers'), true);
  const trade = s.trade({ tradeId: id, termsHash: id }); await s.send('tradeLog', trade);
  assert.equal(s.view().offers[0].left, null);
  assert.equal(s.feed.market.address(terms.buyer.dexKey), terms.buyer.tracAddr);
});
