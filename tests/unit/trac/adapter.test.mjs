import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519.js';
import PeerWallet from '../../../peer/node_modules/trac-wallet/index.js';
import { blake3 } from '@noble/hashes/blake3.js';
import { createTracAdapter } from '../../../src/trac/adapter.js';
import { buildTnkTransfer, buildResetTransfer, transferNonce } from '../../../src/trac/transfers.js';
import { openIntentStore } from '../../../src/trac/intents.js';
import { validAddressProof } from '../../../src/core/address-proof.js';
import { RESET_PAUSED_MESSAGE } from '../../../src/market/gateway-status.js';
import { stepFinalized } from '../../../src/core/trade-seller.js';
import { simulation } from '../core/simulation.mjs';
import { accountBalances } from '../../../src/wallets/accounting.js';

const root = process.env.TMPDIR ?? fileURLToPath(new URL('../../../.test-tmp/trac/', import.meta.url));
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const folder = () => fs.mkdtempSync(path.join(root, 'adapter-unit-'));
const BASES = { TNK: { kind: 'trac-native', id: 'TNK', decimals: 18 }, RESET: { kind: 'trac-contract-token', id: 'RESET', decimals: 8 } };
const now = () => Math.floor(Date.now() / 1000);

function fixture() {
  const secret = ed25519.utils.randomSecretKey();
  const publicKey = Buffer.from(ed25519.getPublicKey(secret)).toString('hex');
  const address = PeerWallet.encodeBech32m('trac', Buffer.from(publicKey, 'hex'));
  const toKey = '02'.repeat(32), to = PeerWallet.encodeBech32m('trac', Buffer.from(toKey, 'hex'));
  const wallet = { publicKey, address, sign: bytes => Buffer.from(ed25519.sign(bytes, secret)).toString('hex') };
  const context = { networkId: 918, txv: '11'.repeat(32), addressPrefix: 'trac', msbBootstrap: '22'.repeat(32), feeTnk: '30000000000000000' };
  const resetContext = { networkId: 918, txv: context.txv, addressPrefix: 'trac', msb: context.msbBootstrap, subnet: '33'.repeat(32) };
  const calls = [];
  const bridge = { call: async (type, params) => {
    calls.push({ type, params });
    if (type === 'dex_msb_info') return context;
    if (type === 'dex_reset_context') return resetContext;
    if (type === 'dex_tnk_broadcast') return { txHash: params.payload.tro.tx };
    if (type === 'dex_verify') return { ok: true, final: true, amount: '42', reason: null };
    throw Error('Unexpected bridge command');
  } };
  const tradeId = '44'.repeat(32);
  const terms = { pair: 'TNK/USDC', base: BASES.TNK, baseAmount: '42', seller: { tracAddr: address }, buyer: { tracAddr: to }, sendBy: now() + 1000 };
  const request = { asset: 'TNK', txHash: '55'.repeat(32), from: address, to, minAmount: '42', nonce: transferNonce(tradeId), tradeId, finalBefore: now() + 1000 };
  return { wallet, bridge, context, resetContext, calls, tradeId, terms, request, toKey, intentFolder: folder() };
}

for (const asset of ['RESET', 'TNK']) test(`${asset} explorer candidates use one newest page, seller/time/type filters, reservations and a five-hash cap`, async t => {
  const f = fixture(), adapter = createTracAdapter({ ...f, usedTxFolder: folder(), explorerUrl: 'https://explorer.example' });
  t.after(() => adapter.close());
  const since = now() - 120, hash = n => n.toString(16).padStart(64, '0');
  const row = (n, patch = {}) => ({ tx: hash(n), address: f.request.from, to: f.request.to, type: asset === 'RESET' ? '12' : '13',
    am: '42', createdAt: new Date(since * 1000).toISOString(), ...patch });
  adapter.reserveTx({ txHash: hash(1), tradeId: '99'.repeat(32) });
  adapter.reserveTx({ txHash: hash(2), tradeId: f.tradeId });
  const rows = [null, row(10, { tx: 'bad' }), row(11, { address: f.request.to }), row(12, { type: '99' }),
    row(13, { createdAt: new Date((since - 1) * 1000).toISOString() }), row(14, { createdAt: 'not a date' }),
    row(15, { type: asset === 'RESET' ? '13' : '12' }), row(1), row(2), row(2),
    row(3, { to: f.request.from }), ...Array.from({ length: 8 }, (_, i) => row(i + 4))];
  const requests = [], timeouts = [], timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', ms => { timeouts.push(ms); return timeout(ms); });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), options });
    return Response.json({ transactions: JSON.stringify(rows), nextOffset: 20, count: 1000 });
  });
  const result = await adapter.recentTransferCandidates({ ...f.request, asset, since });
  assert.deepEqual(result, (asset === 'RESET' ? [2, 3, 4, 5, 6] : [2, 4, 5, 6, 7]).map(hash));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://explorer.example/api/transactions?address=' + f.request.from);
  assert.equal(requests[0].options.redirect, 'error'); assert.deepEqual(timeouts, [5000]);
  assert.deepEqual(f.calls, [], 'listing candidates never asks the peer to verify or trusts explorer amount');
});

test('explorer defaults, invalid origins, HTTP/parse/timeout errors and closed adapter', async t => {
  const f = fixture();
  for (const explorerUrl of ['file:///tmp', 'https://user:password@gateway.example', 'https://gateway.example/path', 'https://gateway.example/?x=1', 'https://gateway.example/#x']) {
    assert.throws(() => createTracAdapter({ ...f, explorerUrl }), /explorer origin/);
  }
  const adapter = createTracAdapter({ ...f, usedTxFolder: folder() }); t.after(() => adapter.close());
  const request = { ...f.request, since: now() - 120 };
  let response = () => Response.json({ transactions: '[]', nextOffset: 5, count: 100 });
  t.mock.method(globalThis, 'fetch', async url => { assert.equal(new URL(url).origin, 'https://explorer.trac.network'); return response(); });
  assert.deepEqual(await adapter.recentTransferCandidates(request), []);
  for (const fail of [() => new Response('', { status: 503 }), () => Response.json({ transactions: '{' }),
    () => Response.json({ transactions: '{}' }), () => { throw new DOMException('timed out', 'TimeoutError'); }]) {
    response = fail; await assert.rejects(adapter.recentTransferCandidates(request));
  }
  response = () => Response.json({ transactions: '[]' });
  assert.deepEqual(await adapter.recentTransferCandidates(request), []);
  adapter.close(); await assert.rejects(adapter.recentTransferCandidates(request), /adapter_closed/);
});

test('adapter sends TNK with bound nonce and runner result fields', async () => {
  const f = fixture();
  const adapter = createTracAdapter(f);
  const sent = await adapter.sendTransfer(f);
  assert.equal(sent.ok, true);
  assert.equal(sent.type, 'transferSent');
  assert.equal(sent.tradeId, f.tradeId);
  assert.ok(sent.sentAt < f.terms.sendBy && sent.sentAt <= sent.now);
  const payload = f.calls.find(call => call.type === 'dex_tnk_broadcast').params.payload;
  assert.equal(payload.tro.in, transferNonce(f.tradeId));
  assert.equal(sent.txHash, payload.tro.tx);
  adapter.close(); adapter.close();
  assert.equal((await adapter.sendTransfer(f)).reason, 'adapter_closed');
  assert.equal((await adapter.verifyTransfer(f.request)).reason, 'adapter_closed');
  assert.equal(adapter.reserveTx(f.request).ok, false);
});

test('adapter signs address ownership with its existing wallet and pinned network without a transaction', () => {
  const f = fixture(), networkId = 918, dexKey = 'ab'.repeat(32);
  const adapter = createTracAdapter({ ...f, profile: { peer: { msbNetworkId: networkId } } });
  const proof = adapter.proveAddress({ dexKey, expiresAt: 1000 });
  assert.equal(validAddressProof({ dexKey, tracAddr: f.wallet.address, tracProof: proof }, { networkId, now: 100 }), true);
  assert.deepEqual(f.calls, []);
  adapter.close(); assert.throws(() => adapter.proveAddress({ dexKey, expiresAt: 1000 }));
  const noWallet = createTracAdapter({ bridge: f.bridge, profile: { peer: { msbNetworkId: networkId } } });
  assert.throws(() => noWallet.proveAddress({ dexKey, expiresAt: 1000 })); noWallet.close();
});

test('adapter refuses invalid sends, wrong wallet, deadlines, context and receipts', async () => {
  assert.throws(() => createTracAdapter({ bridge: {} }));
  const f = fixture();
  for (const resetGatewayUrl of ['file:///tmp/a', 'http://user:pass@127.0.0.1', 'http://127.0.0.1/path']) assert.throws(() => createTracAdapter({ ...f, resetGatewayUrl }));
  const adapter = createTracAdapter(f);
  try {
    for (const [patch, reason] of [[{ tradeId: 'bad' }, 'invalid_terms'], [{ terms: { ...f.terms, baseAmount: '0' } }, 'invalid_terms'], [{ terms: { ...f.terms, base: { kind: 'unsupported', id: 'OTHER', decimals: 18 } } }, 'invalid_terms'], [{ terms: { ...f.terms, sendBy: now() } }, 'send_deadline'], [{ terms: { ...f.terms, seller: { tracAddr: f.terms.buyer.tracAddr } } }, 'wrong_wallet'], [{ terms: { ...f.terms, buyer: { tracAddr: 'bad' } } }, 'invalid_address'], [{ terms: { ...f.terms, pair: 'RESET/USDC', base: BASES.RESET } }, 'reset_gateway_required']]) assert.equal((await adapter.sendTransfer({ ...f, ...patch })).reason, reason);
    f.context.addressPrefix = 'other';
    assert.equal((await adapter.sendTransfer(f)).reason, 'wrong_network');
    f.context.addressPrefix = 'trac';
    const original = f.bridge.call;
    f.bridge.call = (type, params) => type === 'dex_tnk_broadcast' ? {} : original(type, params);
    assert.equal((await adapter.sendTransfer(f)).reason, 'invalid_broadcast_receipt');
    f.bridge.call = () => { throw Error('offline'); };
    assert.equal((await adapter.sendTransfer(f)).reason, 'send_failed');
  } finally { adapter.close(); }
  const noWallet = createTracAdapter({ bridge: f.bridge, intentFolder: folder() });
  try { assert.equal((await noWallet.sendTransfer(f)).reason, 'wallet_required'); } finally { noWallet.close(); }
});

test('verified observations and reservations persist across restart with exact runner fields', async () => {
  const f = fixture(), usedTxFolder = folder();
  let adapter = createTracAdapter({ ...f, usedTxFolder });
  const first = await adapter.verifyTransfer(f.request);
  assert.deepEqual(first, { type: 'transferVerified', now: first.now, tradeId: f.tradeId, txHash: f.request.txHash,
    asset: 'TNK', from: f.request.from, to: f.request.to, nonce: f.request.nonce,
    ok: true, final: true, amount: '42', finalizedAt: first.finalizedAt });
  assert.ok(Number.isSafeInteger(first.finalizedAt) && first.finalizedAt <= first.now);
  const observation = fs.readFileSync(path.join(usedTxFolder, 'finality.jsonl'), 'utf8');
  assert.equal(observation.split('\n').filter(Boolean).length, 1);
  assert.deepEqual(adapter.reserveTx(f.request), { ok: true, reservedFor: f.tradeId });
  assert.deepEqual(adapter.reserveTx(f.request), { ok: true, reservedFor: f.tradeId }, 'a repeated notice reserves for the same trade');
  assert.deepEqual(adapter.reserveTx({ ...f.request, tradeId: '66'.repeat(32) }), { ok: false, reservedFor: f.tradeId });
  assert.equal((await adapter.verifyTransfer({ ...f.request, tradeId: '66'.repeat(32) })).reason, 'tx_already_used');
  adapter.close(); adapter = createTracAdapter({ ...f, usedTxFolder });
  try {
    const again = await adapter.verifyTransfer(f.request);
    assert.equal(again.finalizedAt, first.finalizedAt);
    assert.equal(again.usedBy, f.tradeId);
    assert.deepEqual(adapter.reserveTx(f.request), { ok: true, reservedFor: f.tradeId }, 'same-trade reservation survives restart');
    assert.equal(fs.readFileSync(path.join(usedTxFolder, 'finality.jsonl'), 'utf8'), observation);
    assert.equal(fs.statSync(path.join(usedTxFolder, 'finality.jsonl')).mode & 0o777, 0o600);
  } finally { adapter.close(); }
});

test('RESET verification converts addresses for the peer and restores terms addresses', async () => {
  const f = fixture();
  const adapter = createTracAdapter({ ...f, usedTxFolder: folder() });
  try {
    const verified = await adapter.verifyTransfer({ ...f.request, asset: 'RESET' });
    assert.equal(verified.ok, true);
    assert.equal(verified.from, f.wallet.address);
    assert.equal(verified.to, f.request.to);
    const { params } = f.calls.find(call => call.type === 'dex_verify');
    assert.equal(params.from, f.wallet.publicKey);
    assert.equal(params.to, f.toKey);
  } finally { adapter.close(); }
});

test('verification fails on missing journal, bad inputs, pending/failure, wrong exact amount and read errors', async () => {
  const f = fixture();
  const noStore = createTracAdapter(f);
  assert.equal((await noStore.verifyTransfer(f.request)).reason, 'used_tx_store_required');
  assert.equal(noStore.reserveTx(f.request).ok, false); noStore.close();
  const adapter = createTracAdapter({ ...f, usedTxFolder: folder() });
  try {
    for (const patch of [{ asset: 'OTHER' }, { txHash: 'bad' }, { finalBefore: -1 }, { finalBefore: 1.5 }, { minAmount: 42 }, { from: 'bad' }, { tradeId: 'bad' }]) assert.equal((await adapter.verifyTransfer({ ...f.request, ...patch })).ok, false);
    assert.equal((await adapter.verifyTransfer({ ...f.request, nonce: '00'.repeat(32) })).reason, 'wrong_nonce');
    assert.equal(adapter.reserveTx({ txHash: 'bad', tradeId: f.tradeId }).ok, false);
    f.bridge.call = async () => ({ ok: false, final: false, reason: 'unknown_or_not_final', amount: null });
    assert.equal((await adapter.verifyTransfer(f.request)).reason, 'unknown_or_not_final');
    f.bridge.call = async () => ({ ok: false, final: true, reason: 'contract_rejected', amount: '42' });
    assert.equal((await adapter.verifyTransfer(f.request)).reason, 'contract_rejected');
    f.bridge.call = async () => ({ ok: true, final: false, amount: '42' });
    assert.equal((await adapter.verifyTransfer(f.request)).ok, false);
    f.bridge.call = async () => ({ ok: true, final: true, amount: '43' });
    assert.equal((await adapter.verifyTransfer(f.request)).reason, 'wrong_amount');
    f.bridge.call = async () => { throw Error('offline'); };
    assert.equal((await adapter.verifyTransfer(f.request)).reason, 'verification_failed');
  } finally { adapter.close(); }
});

test('finality deadline is strict and clocks cannot move before a persisted observation', async () => {
  const clock = Date.now;
  let milliseconds = 1800000000000;
  Date.now = () => milliseconds;
  const f = fixture();
  const adapter = createTracAdapter({ ...f, usedTxFolder: folder() });
  try {
    const late = await adapter.verifyTransfer({ ...f.request, finalBefore: now() });
    assert.equal(late.reason, 'finality_deadline');
    assert.equal(late.finalizedAt, now());
    milliseconds -= 1000;
    assert.equal((await adapter.verifyTransfer(f.request)).reason, 'clock_regressed');
    milliseconds += 2000;
    assert.equal((await adapter.verifyTransfer(f.request)).finalizedAt, late.finalizedAt);
  } finally { adapter.close(); Date.now = clock; }
});

test('a concurrent reservation during verification wins before success is returned', async () => {
  const f = fixture();
  const adapter = createTracAdapter({ ...f, usedTxFolder: folder() });
  f.bridge.call = async () => {
    adapter.reserveTx({ txHash: f.request.txHash, tradeId: '66'.repeat(32) });
    return { ok: true, final: true, amount: '42' };
  };
  try { assert.equal((await adapter.verifyTransfer(f.request)).reason, 'tx_already_used'); } finally { adapter.close(); }
});

test('finality journal rejects corruption and never acknowledges failed flushes', async () => {
  const f = fixture();
  const usedTxFolder = folder();
  fs.writeFileSync(path.join(usedTxFolder, 'finality.jsonl'), '{');
  assert.throws(() => createTracAdapter({ ...f, usedTxFolder }), /Incomplete/);
  fs.writeFileSync(path.join(usedTxFolder, 'finality.jsonl'), '{}\n');
  assert.throws(() => createTracAdapter({ ...f, usedTxFolder }), /Invalid/);
  fs.writeFileSync(path.join(usedTxFolder, 'finality.jsonl'), '');
  const adapter = createTracAdapter({ ...f, usedTxFolder });
  const sync = fs.fsyncSync;
  try {
    fs.fsyncSync = () => { throw Error('disk full'); };
    assert.equal((await adapter.verifyTransfer(f.request)).reason, 'finality_store_unavailable');
    assert.equal((await adapter.verifyTransfer(f.request)).ok, false);
  } finally { fs.fsyncSync = sync; adapter.close(); }
});

test('RESET gateway preparation is verified before signing and submitting the chosen nonce', async () => {
  const originalFetch = globalThis.fetch;
  const f = fixture();
  const request = { ...f, terms: { ...f.terms, pair: 'RESET/USDC', base: BASES.RESET } };
  const built = await buildResetTransfer({ ...f.resetContext, writer: '77'.repeat(32), from: f.wallet.publicKey, to: f.toKey,
    amount: '42', tradeId: f.tradeId, sign: bytes => f.wallet.sign(bytes) });
  const command = { type: 'transfer', value: { to: f.toKey, amount: '42' } };
  const prepared = { address: f.wallet.publicKey, to: f.toKey, amount: '42', prepared_command: command,
    tx: built.submission.tx, nonce: transferNonce(f.tradeId), context: { network_id: 918, txv: f.context.txv,
      writer: '77'.repeat(32), subnet: f.resetContext.subnet, msb: f.resetContext.msb,
      content_hash: Buffer.from(blake3(Buffer.from(JSON.stringify(command)))).toString('hex') } };
  let packet = prepared, submitted = 0, signed = 0;
  const sign = f.wallet.sign;
  f.wallet.sign = bytes => { signed++; return sign(bytes); };
  const gateway = async (url, options) => {
    assert.equal(new URL(url).origin, 'http://127.0.0.1:47103');
    assert.equal(options.redirect, 'error');
    if (new URL(url).pathname === '/v1/state') return Response.json({ validators: { eligible: 3 } });
    const body = JSON.parse(options.body);
    if (new URL(url).pathname === '/v1/tx/prepare') {
      assert.deepEqual(body, { address: f.wallet.publicKey, to: f.toKey, amount: '42', nonce: prepared.nonce });
      return Response.json(packet);
    }
    assert.deepEqual(body, built.submission); submitted++;
    return Response.json({ ok: true, result: built.payload });
  };
  globalThis.fetch = gateway;
  const adapter = createTracAdapter({ ...f, resetGatewayUrl: 'http://127.0.0.1:47103' });
  try {
    for (const patch of [{ nonce: '00'.repeat(32) }, { amount: '43' }, { tx: '00'.repeat(32) }, { context: { ...prepared.context, subnet: '00'.repeat(32) } }, { context: { ...prepared.context, txv: '00'.repeat(32) } }, { context: { ...prepared.context, content_hash: '00'.repeat(32) } }]) {
      packet = { ...prepared, ...patch };
      assert.equal((await adapter.sendTransfer(request)).ok, false);
      assert.equal(signed, 0); assert.equal(submitted, 0);
    }
    const healthy = response => async url => new URL(url).pathname === '/v1/state' ? Response.json({ validators: { eligible: 3 } }) : response();
    globalThis.fetch = healthy(() => new Response('rejected', { status: 400 }));
    assert.equal((await adapter.sendTransfer(request)).reason, 'gateway_rejected');
    globalThis.fetch = healthy(() => new Response('{'));
    assert.equal((await adapter.sendTransfer(request)).reason, 'invalid_gateway_response');
    globalThis.fetch = healthy(() => { throw Error('offline'); });
    assert.equal((await adapter.sendTransfer(request)).reason, 'send_failed');
    packet = prepared; globalThis.fetch = gateway;
    assert.equal((await adapter.sendTransfer(request)).ok, true);
    assert.equal(signed, 1); assert.equal(submitted, 1);
  } finally { adapter.close(); globalThis.fetch = originalFetch; }
});

test('RESET health refusal leaves no signature, prepare, submission or intent; retries and deadline abort release the reservation', async t => {
  const sim = simulation({ capturePhases: true, pair: 'RESET/USDC' });
  let state = structuredClone(sim.snapshots.get('seller:transferring')), clock = state.now * 1000;
  t.mock.method(Date, 'now', () => clock);
  const f = fixture();
  state.terms.seller.tracAddr = f.wallet.address; state.terms.buyer.tracAddr = f.terms.buyer.tracAddr;
  state.terms.baseAmount = '42'; state.draft = structuredClone(state.terms);
  const request = { terms: state.terms, tradeId: state.tradeId };
  let signatures = 0, reads = 0, eligible = 3;
  f.wallet.sign = () => { signatures++; throw Error('must not sign'); };
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(new URL(url).pathname, '/v1/state', 'no prepare or submission'); reads++;
    return Response.json({ validators: { eligible } });
  });
  let adapter = createTracAdapter({ ...f, resetGatewayUrl: 'https://reset.example' });
  t.after(() => adapter.close());
  assert.equal((await adapter.gatewayHealth()).ok, true);
  eligible = 2;
  const failure = await adapter.sendTransfer(request);
  assert.equal(reads, 2, 'pre-send bypasses the healthy admission cache');
  assert.deepEqual([failure.ok, failure.unknown, failure.txHash, failure.reason], [false, undefined, undefined, RESET_PAUSED_MESSAGE]);
  state = stepFinalized(state, failure).state;
  assert.equal(state.gatewayPaused, true); assert.equal(state.phase, 'transferring');
  const trade = () => ({ role: 'seller', state });
  const reserved = () => accountBalances({ balances: { RESET: '100' }, trades: [trade()], registry: () => sim.f.registry }).RESET.breakdown.trades;
  assert.equal(reserved(), '42');
  assert.deepEqual(stepFinalized(state, { type: 'tick', now: state.now + 9 }).actions, []);
  clock += 10000;
  const retry = stepFinalized(state, { type: 'tick', now: clock / 1000 }); state = retry.state;
  assert.equal(retry.actions[0].type, 'sendTransfer'); assert.equal(retry.actions[0].resume, true);
  assert.equal(state.gatewayPaused, undefined, 'clear the no-intent evidence durably before starting a new attempt');
  state = stepFinalized(state, await adapter.sendTransfer({ ...request, resume: true })).state;
  assert.equal(reads, 3, 'each retry samples again');
  assert.equal(signatures, 0); assert.deepEqual(f.calls, []);
  adapter.close();
  const journal = openIntentStore(f.intentFolder);
  assert.equal(journal.get(state.tradeId), null, 'no intent exists even after reopening the durable store'); journal.close();
  adapter = createTracAdapter({ ...f, resetGatewayUrl: 'https://reset.example' });
  const restored = stepFinalized(structuredClone(state), { type: 'resume', now: state.terms.refundAfter });
  assert.equal(restored.state.phase, 'aborted', 'restart after the refund time still never becomes lost');
  assert.ok(restored.actions.every(a => a.type !== 'checkEscrow' && a.type !== 'sendTransfer'));
  clock = state.terms.sendBy * 1000;
  const ended = stepFinalized(state, { type: 'tick', now: clock / 1000 }); state = ended.state;
  assert.equal(state.phase, 'aborted'); assert.match(state.reason, /^Transfer not sent before the deadline/);
  assert.equal(reserved(), '0'); assert.equal(ended.actions[0].type, 'abort');
  assert.equal((await adapter.sendTransfer({ ...request, resume: true })).reason, 'send_deadline');
  assert.equal(signatures, 0); assert.equal(reads, 3);
});

for (const failure of ['health', 'deadline']) test(`slow RESET preparation rechecks ${failure} before signing`, async t => {
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const f = fixture(); f.terms.pair = 'RESET/USDC'; f.terms.base = BASES.RESET;
  const built = await buildResetTransfer({ ...f.resetContext, writer: '77'.repeat(32), from: f.wallet.publicKey, to: f.toKey,
    amount: '42', tradeId: f.tradeId, sign: bytes => f.wallet.sign(bytes) });
  const op = built.payload.txo;
  const prepared = { address: f.wallet.publicKey, to: f.toKey, amount: '42', prepared_command: built.submission.prepared_command,
    tx: op.tx, nonce: op.in, context: { network_id: 918, txv: op.txv, writer: op.iw, content_hash: op.ch, subnet: op.bs, msb: op.mbs } };
  let signatures = 0, reads = 0;
  f.wallet.sign = () => { signatures++; throw Error('must not sign'); };
  t.mock.method(globalThis, 'fetch', async url => {
    if (new URL(url).pathname === '/v1/state') return Response.json({ validators: { eligible: ++reads === 1 || failure === 'deadline' ? 3 : 2 } });
    assert.equal(new URL(url).pathname, '/v1/tx/prepare');
    clock = failure === 'health' ? clock + 15000 : f.terms.sendBy * 1000;
    return Response.json(prepared);
  });
  const adapter = createTracAdapter({ ...f, resetGatewayUrl: 'https://reset.example' });
  const result = await adapter.sendTransfer(f); adapter.close();
  assert.equal(result.reason, failure === 'health' ? RESET_PAUSED_MESSAGE : 'send_deadline');
  assert.equal(result.unknown, undefined); assert.equal(signatures, 0); assert.equal(reads, failure === 'health' ? 2 : 1);
  const journal = openIntentStore(f.intentFolder); assert.equal(journal.get(f.tradeId), null); journal.close();
});

test('lost TNK response preserves a flushed intent; restart and expired txv never sign another transfer', async () => {
  const f = fixture(), signed = f.wallet.sign;
  let signatures = 0, final = false, offline = false, broadcasts = [];
  f.wallet.sign = bytes => { signatures++; return signed(bytes); };
  const call = f.bridge.call;
  f.bridge.call = async (type, params) => {
    if (offline) throw Error('peer offline');
    if (type === 'dex_verify') return { ok: final, final, amount: final ? '42' : null, reason: final ? null : 'unknown_or_not_final' };
    if (type !== 'dex_tnk_broadcast') return call(type, params);
    const row = JSON.parse(fs.readFileSync(path.join(f.intentFolder, 'intents.jsonl'), 'utf8'));
    assert.deepEqual(row.intent.payload, params.payload);
    assert.equal(row.intent.tradeId, f.tradeId);
    assert.ok(row.intent.createdAt <= row.intent.sentAt);
    broadcasts.push(structuredClone(params.payload));
    throw Error(broadcasts.length === 1 ? 'receipt lost after acceptance' : 'expired txv');
  };
  let adapter = createTracAdapter(f);
  try {
    const first = await adapter.sendTransfer(f);
    assert.equal(first.ok, false); assert.equal(first.unknown, true);
    assert.equal(first.txHash, broadcasts[0].tro.tx);
    assert.ok(first.sentAt <= first.now);
    adapter.close();
    // Recovery needs only the signed journal, even when a new txv would change the hash.
    f.context.txv = '99'.repeat(32);
    adapter = createTracAdapter({ ...f, wallet: null });
    const repeat = await adapter.sendTransfer({ ...f, resume: true });
    assert.equal(repeat.unknown, true);
    assert.equal(repeat.txHash, first.txHash); assert.equal(repeat.sentAt, first.sentAt);
    assert.deepEqual(broadcasts[1], broadcasts[0]); assert.equal(signatures, 1);
    offline = true;
    const unavailable = await adapter.sendTransfer(f);
    assert.equal(unavailable.unknown, true); assert.equal(unavailable.txHash, first.txHash);
    offline = false; final = true;
    const recovered = await adapter.sendTransfer(f);
    assert.equal(recovered.ok, true); assert.equal(recovered.txHash, first.txHash);
    assert.equal(recovered.sentAt, first.sentAt); assert.equal(broadcasts.length, 2);
    assert.equal(signatures, 1);
  } finally { adapter.close(); }
});

test('concurrent repeats serialize signing and reject changed intent terms without losing the hash', async () => {
  const f = fixture(), sign = f.wallet.sign, call = f.bridge.call;
  let signatures = 0;
  f.wallet.sign = async bytes => { signatures++; await new Promise(resolve => setImmediate(resolve)); return sign(bytes); };
  f.bridge.call = (type, params) => type === 'dex_verify' ? { ok: false, final: false, reason: 'unknown_or_not_final' } : call(type, params);
  const adapter = createTracAdapter(f);
  try {
    const results = await Promise.all([adapter.sendTransfer(f), adapter.sendTransfer({ ...f, resume: true }), adapter.sendTransfer(f)]);
    assert.ok(results.every(result => result.ok && result.txHash === results[0].txHash && result.sentAt === results[0].sentAt));
    assert.equal(signatures, 1);
    const payloads = f.calls.filter(call => call.type === 'dex_tnk_broadcast').map(call => call.params.payload);
    assert.equal(payloads.length, 3); assert.deepEqual(payloads[0], payloads[1]); assert.deepEqual(payloads[0], payloads[2]);
    for (const patch of [{ baseAmount: '43' }, { pair: 'RESET/USDC', base: BASES.RESET }, { sendBy: f.terms.sendBy + 1 }, { buyer: f.terms.seller }]) {
      const conflict = await adapter.sendTransfer({ ...f, terms: { ...f.terms, ...patch } });
      assert.equal(conflict.reason, 'intent_terms_mismatch');
      assert.equal(conflict.unknown, true); assert.equal(conflict.txHash, results[0].txHash);
    }
    const invalid = await adapter.sendTransfer({ tradeId: f.tradeId });
    assert.equal(invalid.unknown, true); assert.equal(invalid.txHash, results[0].txHash);
    assert.equal(signatures, 1);
  } finally { adapter.close(); }
});

test('missing intent store and failed intent flush never broadcast or claim an unknown submission', async () => {
  const f = fixture();
  let adapter = createTracAdapter({ ...f, intentFolder: null });
  assert.equal((await adapter.sendTransfer(f)).reason, 'intent_store_required');
  adapter.close(); adapter = createTracAdapter(f);
  const sync = fs.fsyncSync;
  try {
    fs.fsyncSync = () => { throw Error('disk full'); };
    const failed = await adapter.sendTransfer(f);
    assert.equal(failed.reason, 'intent_store_unavailable');
    assert.equal(failed.unknown, undefined); assert.equal(failed.txHash, undefined);
    assert.equal((await adapter.sendTransfer(f)).ok, false);
    assert.equal(f.calls.filter(call => call.type === 'dex_tnk_broadcast').length, 0);
  } finally { fs.fsyncSync = sync; adapter.close(); }
});

test('RESET submission retries reuse the durable gateway packet without another prepare or wallet', async () => {
  const savedFetch = globalThis.fetch, f = fixture();
  f.terms.pair = 'RESET/USDC'; f.terms.base = BASES.RESET;
  const built = await buildResetTransfer({ ...f.resetContext, writer: '77'.repeat(32), from: f.wallet.publicKey, to: f.toKey,
    amount: '42', tradeId: f.tradeId, sign: bytes => f.wallet.sign(bytes) });
  const op = built.payload.txo;
  const prepared = { address: f.wallet.publicKey, to: f.toKey, amount: '42', prepared_command: built.submission.prepared_command,
    tx: op.tx, nonce: op.in, context: { network_id: 918, txv: op.txv, writer: op.iw, content_hash: op.ch, subnet: op.bs, msb: op.mbs } };
  let preparations = 0, submissions = 0, final = false, healthy = false, healthReads = 0;
  const call = f.bridge.call;
  f.bridge.call = (type, params) => type === 'dex_verify' ? { ok: final, final, amount: final ? '42' : null } : call(type, params);
  globalThis.fetch = async (url, options) => {
    if (new URL(url).pathname === '/v1/state') { healthReads++; return Response.json({ validators: { eligible: healthy ? 3 : 2 } }); }
    if (new URL(url).pathname === '/v1/tx/prepare') { preparations++; return Response.json(prepared); }
    submissions++;
    const row = JSON.parse(fs.readFileSync(path.join(f.intentFolder, 'intents.jsonl'), 'utf8'));
    assert.deepEqual(row.intent.submission, built.submission);
    assert.equal(options.body, JSON.stringify(built.submission));
    if (submissions === 1) throw Error('lost response');
    if (submissions === 2) return Response.json({ ok: true, result: { txo: { tx: '00'.repeat(32) } } });
    return Response.json({ ok: true, result: built.payload });
  };
  let adapter = createTracAdapter({ ...f, resetGatewayUrl: 'http://127.0.0.1:47103' });
  try {
    assert.equal((await adapter.sendTransfer(f)).reason, RESET_PAUSED_MESSAGE);
    assert.equal(preparations, 0); assert.equal(submissions, 0);
    healthy = true;
    const first = await adapter.sendTransfer(f);
    assert.equal(first.unknown, true); assert.equal(first.txHash, op.tx);
    healthy = false;
    adapter.close();
    adapter = createTracAdapter({ ...f, wallet: null, resetGatewayUrl: 'http://127.0.0.1:47103' });
    const badReceipt = await adapter.sendTransfer({ ...f, resume: true });
    assert.equal(badReceipt.unknown, true); assert.equal(badReceipt.reason, 'invalid_broadcast_receipt');
    const accepted = await adapter.sendTransfer(f);
    assert.equal(accepted.ok, true); assert.equal(accepted.txHash, first.txHash); assert.equal(accepted.sentAt, first.sentAt);
    final = true;
    assert.equal((await adapter.sendTransfer(f)).ok, true);
    assert.equal(preparations, 1); assert.equal(submissions, 3);
    assert.equal(healthReads, 2, 'an existing signed intent is always reconciled, even during an outage');
  } finally { adapter.close(); globalThis.fetch = savedFetch; }
});

test('a timely observation stays eligible at and after the cutoff across restart; late first observations fail', async () => {
  const clock = Date.now;
  let milliseconds = 1800000000000;
  Date.now = () => milliseconds;
  const f = fixture(), usedTxFolder = folder(), finalBefore = now() + 1;
  let adapter = createTracAdapter({ ...f, usedTxFolder });
  try {
    const first = await adapter.verifyTransfer({ ...f.request, finalBefore });
    assert.equal(first.ok, true);
    milliseconds += 1000;
    assert.equal((await adapter.verifyTransfer({ ...f.request, finalBefore })).ok, true);
    milliseconds += 2000;
    adapter.close(); adapter = createTracAdapter({ ...f, usedTxFolder });
    const later = await adapter.verifyTransfer({ ...f.request, finalBefore });
    assert.equal(later.ok, true); assert.equal(later.finalizedAt, first.finalizedAt);
    const late = await adapter.verifyTransfer({ ...f.request, txHash: '66'.repeat(32), finalBefore });
    assert.equal(late.reason, 'finality_deadline'); assert.equal(late.finalizedAt, now());
    assert.equal((await adapter.verifyTransfer({ ...f.request, finalBefore: first.finalizedAt })).reason, 'finality_deadline');
  } finally { adapter.close(); Date.now = clock; }
});

for (const asset of ['TNK', 'RESET']) {
  test(`${asset} saved intents only reconcile at or after sendBy, including lookup failures and mismatches`, async () => {
    const clock = Date.now, savedFetch = globalThis.fetch;
    let milliseconds = 1800000000000;
    Date.now = () => milliseconds;
    const f = fixture();
    f.terms.pair = `${asset}/USDC`; f.terms.base = BASES[asset];
    const signed = asset === 'TNK'
      ? { payload: await buildTnkTransfer({ ...f.context, from: f.wallet.address, to: f.request.to,
        amount: '42', tradeId: f.tradeId, sign: f.wallet.sign }), submission: null }
      : await buildResetTransfer({ ...f.resetContext, writer: '77'.repeat(32), from: f.wallet.publicKey, to: f.toKey,
        amount: '42', tradeId: f.tradeId, sign: f.wallet.sign });
    const txHash = (asset === 'TNK' ? signed.payload.tro : signed.payload.txo).tx;
    const intent = { tradeId: f.tradeId, asset, from: f.wallet.address, to: f.request.to, amount: '42',
      sendBy: f.terms.sendBy, createdAt: now(), sentAt: now(), txHash, ...signed };
    const store = openIntentStore(f.intentFolder);
    store.save(intent); store.close(); // Simulate a crash before the first broadcast.
    const journalFile = path.join(f.intentFolder, 'intents.jsonl');
    const journal = fs.readFileSync(journalFile, 'utf8');
    let proof, reads = 0, submissions = 0, crossDeadline = false;
    f.bridge.call = async (type, params) => {
      if (type !== 'dex_verify') { submissions++; throw Error('Unexpected submission or preparation'); }
      reads++;
      assert.deepEqual(params, { asset, txHash, from: asset === 'TNK' ? f.wallet.address : f.wallet.publicKey,
        to: asset === 'TNK' ? f.request.to : f.toKey, minAmount: '42', nonce: transferNonce(f.tradeId) });
      if (crossDeadline) milliseconds = intent.sendBy * 1000;
      if (proof instanceof Error) throw proof;
      return proof;
    };
    globalThis.fetch = async () => { submissions++; throw Error('Unexpected gateway call'); };
    const adapter = createTracAdapter({ ...f, wallet: null, resetGatewayUrl: 'http://127.0.0.1:47103' });
    try {
      for (const offset of [0, 1000]) {
        milliseconds = (intent.sendBy + offset) * 1000;
        for (proof of [undefined, { ok: false, final: false, reason: 'unknown_or_not_final' },
          { ok: false, final: true, reason: 'wrong_to', amount: '42' },
          { ok: true, final: true, amount: '43' }, new Error('offline')]) {
          const result = await adapter.sendTransfer({ ...f, resume: true });
          assert.deepEqual(result, { type: 'transferSent', now: now(), tradeId: f.tradeId, ok: false,
            unknown: true, txHash, sentAt: intent.sentAt, reason: 'past_send_deadline' });
        }
        proof = { ok: true, final: true, amount: '42' };
        assert.deepEqual(await adapter.sendTransfer(f), { type: 'transferSent', now: now(), tradeId: f.tradeId,
          ok: true, txHash, sentAt: intent.sentAt });
      }
      // A lookup started before the deadline may finish after it.
      crossDeadline = true;
      for (proof of [{ ok: false, final: false }, new Error('offline')]) {
        milliseconds = (intent.sendBy - 1) * 1000;
        assert.equal((await adapter.sendTransfer(f)).reason, 'past_send_deadline');
      }
      assert.equal(reads, 14);
      assert.equal(submissions, 0);
      assert.equal(fs.readFileSync(journalFile, 'utf8'), journal);
    } finally { adapter.close(); Date.now = clock; globalThis.fetch = savedFetch; }
  });

  test(`${asset} timely durable finality verifies offline after restart and still checks reservations`, async () => {
    const clock = Date.now;
    let milliseconds = 1800000000000;
    Date.now = () => milliseconds;
    const f = fixture(), usedTxFolder = folder();
    const request = { ...f.request, asset, finalBefore: now() + 1 };
    let adapter = createTracAdapter({ ...f, usedTxFolder });
    try {
      const first = await adapter.verifyTransfer(request);
      assert.equal(first.ok, true);
      const journalFile = path.join(usedTxFolder, 'finality.jsonl');
      const journal = fs.readFileSync(journalFile, 'utf8');
      let reads = 0;
      f.bridge.call = async () => { reads++; throw Error('offline'); };
      for (const offset of [0, 1000]) {
        milliseconds = (request.finalBefore + offset) * 1000;
        adapter.close(); adapter = createTracAdapter({ ...f, usedTxFolder });
        assert.deepEqual(await adapter.verifyTransfer(request), { ...first, now: now() });
      }
      assert.deepEqual(adapter.reserveTx(request), { ok: true, reservedFor: f.tradeId });
      adapter.close(); adapter = createTracAdapter({ ...f, usedTxFolder });
      assert.deepEqual(await adapter.verifyTransfer(request), { ...first, now: now(), usedBy: f.tradeId });
      const conflict = await adapter.verifyTransfer({ ...request, tradeId: '66'.repeat(32) });
      assert.equal(conflict.ok, false);
      assert.equal(conflict.reason, 'tx_already_used');
      assert.equal(conflict.usedBy, f.tradeId);
      assert.equal(reads, 0);
      assert.equal(fs.readFileSync(journalFile, 'utf8'), journal);
    } finally { adapter.close(); Date.now = clock; }
  });
}

test('finality cache requires the exact asset, hash, addresses, amount and trade-bound nonce', async () => {
  const f = fixture(), usedTxFolder = folder();
  const adapter = createTracAdapter({ ...f, usedTxFolder });
  try {
    assert.equal((await adapter.verifyTransfer(f.request)).ok, true);
    let reads = 0;
    f.bridge.call = async () => { reads++; throw Error('offline'); };
    for (const patch of [{ asset: 'RESET' }, { txHash: '66'.repeat(32) }, { from: f.request.to },
      { to: f.request.from }, { minAmount: '43' }, { tradeId: '66'.repeat(32), nonce: transferNonce('66'.repeat(32)) }]) {
      const result = await adapter.verifyTransfer({ ...f.request, ...patch });
      assert.equal(result.ok, false);
      assert.equal(result.final, false);
      assert.equal(result.reason, 'verification_failed');
    }
    assert.equal(reads, 6);
    assert.equal((await adapter.verifyTransfer({ ...f.request, nonce: '00'.repeat(32) })).reason, 'wrong_nonce');
    assert.equal(reads, 6);
  } finally { adapter.close(); }
});

test('known late observations are final failures offline; unreadable proofs remain nonfinal', async () => {
  const clock = Date.now;
  Date.now = () => 1800000000000;
  const f = fixture(), usedTxFolder = folder();
  const request = { ...f.request, finalBefore: now() };
  let adapter = createTracAdapter({ ...f, usedTxFolder });
  try {
    const late = await adapter.verifyTransfer(request);
    assert.equal(late.ok, false); assert.equal(late.final, true);
    assert.equal(late.reason, 'finality_deadline');
    let reads = 0;
    f.bridge.call = async () => { reads++; throw Error('offline'); };
    adapter.close(); adapter = createTracAdapter({ ...f, usedTxFolder });
    assert.deepEqual(await adapter.verifyTransfer(request), late);
    assert.equal(reads, 0);
    const unseen = { ...request, txHash: '66'.repeat(32) };
    for (const finalBefore of [now() - 1, now(), now() + 1]) {
      const failed = await adapter.verifyTransfer({ ...unseen, finalBefore });
      assert.equal(failed.ok, false); assert.equal(failed.final, false);
      assert.equal(failed.reason, 'verification_failed');
    }
    for (const final of [false, true]) {
      f.bridge.call = async () => ({ ok: false, final, reason: 'read_failed' });
      const failed = await adapter.verifyTransfer(unseen);
      assert.equal(failed.ok, false); assert.equal(failed.final, false);
      assert.equal(failed.reason, 'read_failed');
    }
  } finally { adapter.close(); Date.now = clock; }
});

test('wallet balance reads and withdrawal reconciliation reuse the durable signed transfer without broadcasting', async () => {
  const f = fixture(), call = f.bridge.call;
  f.bridge.call = async (type, args) => type === 'dex_balances' ? { TNK: '99', RESET: '0', feeTnk: '30000000000000000' } : call(type, args);
  let adapter = createTracAdapter(f);
  assert.deepEqual(await adapter.balances(), { TNK: '99', RESET: '0', feeTnk: '30000000000000000' });
  await assert.rejects(adapter.balances('bad'));
  const request = { id: f.tradeId, asset: 'TNK', to: f.terms.buyer.tracAddr, amount: '42' };
  assert.deepEqual(await adapter.withdrawalStatus(request), { ok: false, unknown: false, reason: 'Not sent: no signed transfer was recorded' });
  const sent = await adapter.sendTransfer(f); assert.equal(sent.ok, true);
  adapter.close(); adapter = createTracAdapter(f);
  const count = f.calls.length;
  const result = await adapter.withdrawalStatus(request); assert.equal(result.ok, true); assert.equal(result.txHash, sent.txHash);
  assert.ok(f.calls.slice(count).every(c => c.type === 'dex_verify'));
  await assert.rejects(adapter.withdrawalStatus({ ...request, amount: '43' }), /differs/);
  f.bridge.call = async () => ({ TNK: 'invalid' }); await assert.rejects(adapter.balances(), /Invalid Trac balances/);
  adapter.close(); await assert.rejects(adapter.balances(), /closed/);
});

test('a withdrawal that is not final is broadcast again with the same bytes after its send window; a final mismatch is definite', async () => {
  const f = fixture(), call = f.bridge.call, clock = Date.now;
  let proof = { ok: false, final: false, amount: null, reason: 'unknown_or_not_final' };
  f.bridge.call = async (type, args) => type === 'dex_verify' ? (f.calls.push({ type, params: args }), proof) : call(type, args);
  const adapter = createTracAdapter(f), request = { id: f.tradeId, asset: 'TNK', to: f.terms.buyer.tracAddr, amount: '42' };
  try {
    assert.equal((await adapter.sendTransfer(f)).ok, true);
    const broadcasts = () => f.calls.filter(c => c.type === 'dex_tnk_broadcast').map(c => JSON.stringify(c.params.payload));
    const first = broadcasts();
    assert.equal(first.length, 1);
    assert.equal((await adapter.withdrawalStatus(request)).unknown, true); assert.equal(broadcasts().length, 1, 'not again inside the send window');
    Date.now = () => f.terms.sendBy * 1000;
    const late = await adapter.withdrawalStatus(request);
    assert.equal(late.unknown, true); assert.deepEqual(broadcasts(), [first[0], first[0]]);
    f.bridge.call = async (type, args) => { if (type === 'dex_tnk_broadcast') throw Error('known hash'); return type === 'dex_verify' ? proof : call(type, args); };
    assert.equal((await adapter.withdrawalStatus(request)).unknown, true, 'a refused broadcast changes nothing');
    proof = { ok: false, final: true, amount: '41', reason: 'wrong_amount' };
    assert.deepEqual(await adapter.withdrawalStatus(request), { ok: false, unknown: false, txHash: late.txHash, reason: 'wrong_amount' });
    proof = { ok: true, final: true, amount: '42', reason: null };
    assert.deepEqual(await adapter.withdrawalStatus(request), { ok: true, unknown: false, txHash: late.txHash, reason: null });
  } finally { adapter.close(); Date.now = clock; }
});

for (const asset of ['TNK', 'RESET']) test(`${asset} trade waits for finality, retries identical bytes across restart and txv changes, and stops broadcasting at sendBy`, async t => {
  const { sendFinalTransfer } = await import('../../../src/trac/adapter.js');
  const f = fixture(); f.terms.base = BASES[asset]; f.terms.pair = asset + '/USDC';
  const broadcasts = [], signed = asset === 'TNK'
    ? { payload: await buildTnkTransfer({ ...f.context, from: f.wallet.address, to: f.terms.buyer.tracAddr, amount: '42', tradeId: f.tradeId, sign: f.wallet.sign }), submission: null }
    : await buildResetTransfer({ ...f.resetContext, writer: '66'.repeat(32), from: f.wallet.publicKey, to: f.toKey, amount: '42', tradeId: f.tradeId, sign: f.wallet.sign });
  const txHash = (signed.payload.tro ?? signed.payload.txo).tx, sentAt = now();
  const store = openIntentStore(f.intentFolder);
  store.save({ ...signed, tradeId: f.tradeId, asset, from: f.wallet.address, to: f.terms.buyer.tracAddr, amount: '42',
    sendBy: f.terms.sendBy, txHash, createdAt: sentAt, sentAt }); store.close();
  let milliseconds = Date.now(), proof = { ok: false, final: false, reason: 'unknown_or_not_final' };
  t.mock.method(Date, 'now', () => milliseconds);
  f.bridge.call = async (type, params) => {
    if (type === 'dex_verify') return proof;
    if (type === 'dex_tnk_broadcast') { broadcasts.push(structuredClone(params.payload)); return { txHash }; }
    throw Error('Must not prepare or refresh txv');
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(new URL(url).pathname, '/v1/tx/submit');
    broadcasts.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ ok: true, result: { txo: { tx: txHash } } }));
  });
  const opts = { ...f, usedTxFolder: folder(), resetGatewayUrl: 'http://127.0.0.1:47103' };
  let adapter = createTracAdapter(opts);
  try {
    for (let i = 0; i < 3; i++) {
      const r = await sendFinalTransfer(adapter, f);
      assert.equal(r.ok, false); assert.equal(r.final, false); assert.equal(r.unknown, true); assert.equal(r.txHash, txHash);
      adapter.close(); f.context.txv = '99'.repeat(32); adapter = createTracAdapter(opts);
      milliseconds += 10000;
    }
    assert.equal(broadcasts.length, 3);
    assert.ok(broadcasts.every(x => JSON.stringify(x) === JSON.stringify(broadcasts[0])));
    milliseconds = f.terms.sendBy * 1000;
    assert.equal((await sendFinalTransfer(adapter, f)).final, false);
    assert.equal(broadcasts.length, 3, 'no broadcast at the deadline');
    proof = { ok: true, final: true, amount: '43' };
    assert.equal((await sendFinalTransfer(adapter, f)).ok, false, 'wrong amount is never sent');
    proof = { ok: true, final: true, amount: '42' };
    const final = await sendFinalTransfer(adapter, f);
    assert.equal(final.ok, true); assert.equal(final.final, true); assert.equal(final.txHash, txHash);
    assert.equal(broadcasts.length, 3);
    assert.equal(fs.readFileSync(path.join(f.intentFolder, 'intents.jsonl'), 'utf8').trim().split('\n').length, 1);
  } finally { adapter.close(); }
});
