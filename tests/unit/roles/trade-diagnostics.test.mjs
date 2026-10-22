import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TradeHost, tradeChannel } from '../../../src/roles/host.js';
import { WalletManager } from '../../../src/wallets/manager.js';
import { encodeKey } from '../../../src/core/keys.js';
import { seal } from '../../../src/core/envelope.js';
import { simulation } from '../core/simulation.mjs';
import { hex } from '../core/helpers.mjs';

const sim = simulation({ capturePhases: true });
const turn = () => new Promise(resolve => setImmediate(resolve));
function debugOff(t) {
  const before = process.env.DEX_DEBUG; process.env.DEX_DEBUG = '';
  t.after(() => { if (before === undefined) delete process.env.DEX_DEBUG; else process.env.DEX_DEBUG = before; });
}
async function fixture(t, phase = 'awaitAcks') {
  const state = structuredClone(sim.snapshots.get('buyer:' + phase));
  const logs = [], records = new Map(), sent = [], clock = { ms: 0, now: state.now };
  t.mock.method(performance, 'now', () => clock.ms);
  t.mock.method(globalThis, 'setInterval', () => 0);
  t.mock.method(globalThis, 'clearInterval', () => {});
  const bridge = new EventEmitter(); bridge.join = async () => {}; bridge.send = async (ch, m) => sent.push(m);
  const store = { list: prefix => [...records.keys()].filter(k => k.startsWith(prefix)),
    get: k => structuredClone(records.get(k)), put: (k, v) => records.set(k, structuredClone(v)) };
  const identity = { publicKey: encodeKey(sim.f.buyer.publicKey), secretKey: sim.f.buyer.secretKey };
  const host = new TradeHost({ bridge, identity, store, now: () => clock.now, log: (...args) => logs.push(args.join(' ')) });
  await host.start(); t.after(() => host.stop());
  await host.addTrade({ key: 'diagnostic', role: 'buyer', state, lifetimeSec: 86400 }); await turn();
  const trade = host.trades.get('diagnostic'), channel = tradeChannel(state.tradeId ?? state.offerId);
  const signer = sim.nodes.get('signer1').identity;
  const ack = (body = {}, from = signer, ch = channel) => seal({ kind: 'ack', ch,
    body: { tradeId: state.tradeId, H: state.H, holdUntil: state.terms.refundAfter, ...body } }, from.secretKey, { ts: clock.now, nonce: hex() });
  const receive = async (message, ch = channel) => { bridge.emit('message', ch, message); await turn(); await trade.queue; };
  logs.length = 0;
  return { host, trade, store, records, logs, clock, ack, receive, sent, channel, identity };
}

test('awaitAcks timeout releases wallet reservations before restart and invalidates the display cache', async t => {
  const f = await fixture(t);
  const wallet = host => new WalletManager({ config: { role: 'trader' }, role: { host }, store: f.store,
    solana: { walletBalances: async () => ({ USDC: '35647013' }) }, addresses: {} });
  const live = wallet(f.host);
  assert.notEqual((await live.displayBalances()).USDC.committed, '0');
  f.clock.ms += 60000; await f.host.deliver('diagnostic', { type: 'tick' });
  assert.equal(f.trade.state.phase, 'aborted'); assert.equal(f.trade.state.reason, 'Signers did not confirm');
  assert.equal((await live.displayBalances()).USDC.committed, '0');
  assert.deepEqual(f.trade.state, f.store.get('trade-diagnostic').state);
  const restored = new TradeHost({ bridge: f.host.bridge, store: f.store, identity: f.identity, now: () => f.clock.now });
  await restored.start(); t.after(() => restored.stop());
  assert.deepEqual(await wallet(restored).balances(), await live.balances());
});

test('a valid signed committee ack is counted and the dealing hash is present before awaitAcks', async t => {
  const f = await fixture(t), m = f.ack();
  assert.equal(f.trade.state.H, f.trade.state.deal.H);
  assert.match(f.trade.state.H, /^[0-9a-f]{64}$/);
  await f.receive(m);
  assert.deepEqual(f.trade.state.acks, [m.from]);
  assert.deepEqual(f.logs, []);
});

for (const [name, change, reason] of [
  ['wrong hash', f => f.ack({ H: hex() }), /hash mismatch/],
  ['short hold', f => f.ack({ holdUntil: f.trade.state.terms.refundAfter - 1 }), /holdUntil before refundAfter/],
  ['outsider', f => f.ack({}, sim.f.seller), /not a committee member/],
  ['wrong trade', f => f.ack({ tradeId: hex() }), /wrong trade id/],
  ['wrong signed channel', f => f.ack({}, undefined, tradeChannel(hex())), /channel mismatch/],
  ['offer channel', f => f.ack({}, undefined, tradeChannel(f.trade.state.offerId)), /Wrong trade channel/],
  ['bad signature', f => ({ ...f.ack(), sig: '00'.repeat(64) }), /bad-signature/],
  ['bad body', f => ({ ...f.ack(), body: {} }), /schema/],
  ['stale', f => { const m = f.ack(); f.clock.now += 86401; return m; }, /stale/],
  ['sender capacity', f => { const m = f.ack(); f.trade.perSender.set(m.from, 400); return m; }, /sender limit/],
  ['buffer capacity', f => { const m = f.ack(); f.trade.buffer = Array(100).fill(m); return m; }, /buffer limit/],
]) test(`rejected ack logs its reason without DEX_DEBUG: ${name}`, async t => {
  const f = await fixture(t); debugOff(t);
  const m = change(f);
  await f.receive(m, name === 'offer channel' ? m.ch : f.channel);
  assert.deepEqual(f.trade.state.acks, []);
  assert.ok(f.logs.some(line => line.includes('ack rejected') && reason.test(line)), f.logs.join('\n'));
});

test('replayed, duplicate and deferred acks have distinct role diagnostics, each logged once', async t => {
  const f = await fixture(t), m = f.ack(); debugOff(t);
  await f.receive(m); await f.receive(m); await f.receive(m);
  assert.equal(f.logs.filter(line => /ack rejected.*replay/.test(line)).length, 1, f.logs.join('\n'));
  await f.receive(f.ack()); await f.receive(f.ack());
  assert.equal(f.logs.filter(line => /ack rejected.*already counted/.test(line)).length, 1);
  f.trade.state.phase = 'proving';
  await f.receive(f.ack());
  assert.ok(!f.logs.some(line => /ack deferred/.test(line)), 'outside awaitAcks only with DEX_DEBUG');
  process.env.DEX_DEBUG = '1';
  await f.receive(f.ack());
  assert.ok(f.logs.some(line => /ack deferred.*proving/.test(line)));
});

test('acks for a finished trade are logged only with DEX_DEBUG', async t => {
  const f = await fixture(t); debugOff(t);
  f.trade.state.phase = 'aborted';
  await f.receive(f.ack());
  assert.deepEqual(f.logs, []);
  process.env.DEX_DEBUG = '1';
  await f.receive(f.ack());
  assert.ok(f.logs.some(line => /ack rejected.*trade finished/.test(line)), f.logs.join('\n'));
});

test('trade sends and resends have a debug line only with DEX_DEBUG', async t => {
  const f = await fixture(t, 'awaitAccept');
  debugOff(t);
  await f.host.deliver('diagnostic', { type: 'resume' });
  assert.ok(!f.logs.some(line => line.startsWith('send ')));
  process.env.DEX_DEBUG = '1';
  await f.host.deliver('diagnostic', { type: 'resume' });
  assert.ok(f.logs.some(line => /^send diagnostic .* take /.test(line)), f.logs.join('\n'));
});

test('acks for an unknown channel (with DEX_DEBUG) and acks received after the step budget have a role diagnostic', async t => {
  const f = await fixture(t); debugOff(t);
  const channel = tradeChannel(hex());
  await f.receive(f.ack({}, undefined, channel), channel);
  assert.ok(!f.logs.some(line => /no trade on channel/.test(line)));
  process.env.DEX_DEBUG = '1';
  await f.receive(f.ack({}, undefined, channel), channel);
  assert.ok(f.logs.some(line => /ack rejected.*no trade on channel/.test(line)));
  process.env.DEX_DEBUG = '';
  f.clock.ms = 60000;
  await f.receive(f.ack());
  assert.equal(f.trade.state.phase, 'aborted');
  assert.deepEqual(f.trade.state.acks, []);
  assert.ok(f.logs.some(line => /ack rejected.*Signers did not confirm/.test(line)));
});
