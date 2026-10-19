import test from 'node:test';
import assert from 'node:assert/strict';
import { rpcCall, readAccount, RpcError } from '../../../src/solana/rpc.js';
import { readAccountQuorum, QuorumError } from '../../../src/solana/quorum.js';
import { readRpcQuorum } from '../../../src/solana/read-quorum.js';
import { checkEscrow } from '../../../src/solana/check.js';
import { key, wireAccount } from './vectors.mjs';

const address = key(1).toBase58();
const endpoints = ['http://127.0.0.1:18060/a', 'http://127.0.0.1:18060/b', 'http://127.0.0.1:18060/c'];
const reply = result => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));

test('RPC requests, account decoding and missing accounts', async t => {
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(url.href, endpoints[0]); assert.equal(request.method, 'POST');
    assert.deepEqual(JSON.parse(request.body), { jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [address, { encoding: 'base64', commitment: 'confirmed', minContextSlot: 10 }] });
    return reply({ context: { slot: 12 }, value: wireAccount() });
  });
  const actual = await readAccount(endpoints[0], address, { minContextSlot: 10 });
  assert.equal(actual.slot, 12); assert.ok(Buffer.isBuffer(actual.value.data)); assert.equal(actual.value.lamports, 2000000);
  t.mock.method(globalThis, 'fetch', async () => reply({ context: { slot: 12 }, value: null }));
  assert.equal((await readAccount(endpoints[0], address)).value, null);
  assert.equal(new RpcError('rpc', 'bad', { code: 17 }).code, 17);
});

test('RPC errors are typed, including timeout while reading a body', async t => {
  for (const [handler, kind] of [
    [async () => new Response('down', { status: 503 }), 'http'],
    [async () => new Response('{'), 'protocol'],
    [async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: 1 })), 'protocol'],
    [async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'bad' } })), 'rpc'],
    [async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: null })), 'protocol'],
    [async () => { throw new Error('offline'); }, 'network'],
    [async (_url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('abort')), { once: true })), 'timeout'],
    [async (_url, { signal }) => ({ ok: true, json: () => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('abort')), { once: true })) }), 'timeout'],
  ]) {
    t.mock.method(globalThis, 'fetch', handler);
    await assert.rejects(rpcCall(endpoints[0], 'getHealth', [], { timeoutMs: 20 }), e => e instanceof RpcError && e.kind === kind);
  }
  await assert.rejects(rpcCall('file:///tmp/rpc', 'getHealth'), TypeError);
  await assert.rejects(rpcCall(endpoints[0], 'getHealth', [], { timeoutMs: 0 }), RangeError);
});

test('malformed and stale account responses fail closed', async t => {
  const account = wireAccount();
  const cases = [
    {}, { context: { slot: -1 }, value: null }, { context: { slot: 1.1 }, value: null },
    { context: { slot: 20 } },
    ...[{ data: ['!', 'base64'] }, { data: ['AA==', 'base58'] }, { data: ['AB==', 'base64'] },
      { owner: 'bad' }, { lamports: Number.MAX_SAFE_INTEGER + 1 }, { executable: 0 }, { lamports: -1 }]
      .map(change => ({ context: { slot: 20 }, value: { ...account, ...change } })),
  ];
  for (const result of cases) {
    t.mock.method(globalThis, 'fetch', async () => reply(result));
    await assert.rejects(readAccount(endpoints[0], address), e => e instanceof RpcError && e.kind === 'protocol');
  }
  t.mock.method(globalThis, 'fetch', async () => reply({ context: { slot: 10 }, value: null }));
  await assert.rejects(readAccount(endpoints[0], address, { minContextSlot: 11 }), e => e.kind === 'stale');
  await assert.rejects(readAccount(endpoints[0], 'bad'));
  await assert.rejects(readAccount(endpoints[0], address, { minContextSlot: -1 }));
});

test('quorum reads in parallel; compares data, owner, lamports, executable', async t => {
  let entered = 0;
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  t.mock.method(globalThis, 'fetch', async url => {
    entered++; if (entered === 3) release(); await barrier;
    const value = wireAccount(); if (url.pathname === '/c') value.data = ['AAAA', 'base64'];
    return reply({ context: { slot: 100 }, value });
  });
  const result = await readAccountQuorum(address, { endpoints });
  assert.equal(entered, 3); assert.equal(result.agreeing.length, 2); assert.equal(result.reports[2].status, 'disagreed');
  for (const change of [{ owner: key(9).toBase58() }, { lamports: 1 }, { executable: true }]) {
    t.mock.method(globalThis, 'fetch', async url => reply({ context: { slot: 100 }, value: { ...wireAccount(), ...(url.pathname === '/c' ? change : {}) } }));
    assert.equal((await readAccountQuorum(address, { endpoints })).reports[2].status, 'disagreed');
  }
});

test('quorum failures include stale votes, split votes, network errors, ambiguity and duplicates', async t => {
  t.mock.method(globalThis, 'fetch', async url => reply({ context: { slot: url.pathname === '/c' ? 100 : 60 }, value: wireAccount() }));
  assert.equal((await readAccountQuorum(address, { endpoints })).slot, 60);
  const four = [...endpoints, 'http://127.0.0.1:18060/d'];
  t.mock.method(globalThis, 'fetch', async url => reply({ context: { slot: ['/b', '/c', '/d'].includes(url.pathname) ? 100 : 60 }, value: { ...wireAccount(), lamports: url.pathname === '/a' ? 2000000 : url.pathname.charCodeAt(1) } }));
  await assert.rejects(readAccountQuorum(address, { endpoints: four }), e => e instanceof QuorumError && e.reports.filter(r => r.status === 'stale').length === 1);
  t.mock.method(globalThis, 'fetch', async url => reply({ context: { slot: 100 }, value: { ...wireAccount(), lamports: url.pathname.charCodeAt(1) } }));
  await assert.rejects(readAccountQuorum(address, { endpoints }), QuorumError);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  await assert.rejects(readAccountQuorum(address, { endpoints }), e => e.reports.every(r => r.kind === 'network'));
  t.mock.method(globalThis, 'fetch', async url => reply({ context: { slot: 100 }, value: url.pathname === '/a' ? null : wireAccount() }));
  await assert.rejects(readAccountQuorum(address, { endpoints, need: 1 }), /Ambiguous/);
  assert.equal((await readAccountQuorum(address, { endpoints })).value.lamports, 2000000);
  t.mock.method(globalThis, 'fetch', async () => reply({ context: { slot: 100 }, value: null }));
  assert.equal((await readAccountQuorum(address, { endpoints })).value, null);
  for (const config of [{ endpoints: [] }, { endpoints: [endpoints[0], endpoints[0]] }, { endpoints: ['http://localhost', 'http://localhost/'] }, { endpoints: ['file:///tmp'] }, { need: 0 }, { need: 4 }, { slotTolerance: -1 }]) await assert.rejects(readAccountQuorum(address, { endpoints, ...config }));
});

test('two identical dishonest votes are indistinguishable from an honest majority', async t => {
  t.mock.method(globalThis, 'fetch', async url => reply({ context: { slot: 100 }, value: { ...wireAccount(), lamports: url.pathname === '/a' ? 2000000 : 1 } }));
  assert.equal((await readAccountQuorum(address, { endpoints })).value.lamports, 1);
});


test('one far-ahead slot cannot veto or advance a two-reader quorum', async t => {
  for (const sameBytes of [true, false]) {
    t.mock.method(globalThis, 'fetch', async url => reply({ context: { slot: url.pathname === '/c' ? 100000 : 100 }, value: { ...wireAccount(), lamports: url.pathname === '/c' && !sameBytes ? 1 : 2000000 } }));
    const result = await readAccountQuorum(address, { endpoints });
    assert.equal(result.slot, 100); assert.equal(result.newestSlot, 100); assert.equal(result.value.lamports, 2000000);
  }
  t.mock.method(globalThis, 'fetch', async () => reply({ context: { slot: 100 }, value: wireAccount() }));
  await assert.rejects(readAccountQuorum(address, { endpoints, minContextSlot: 101 }));
});

test('two readers reporting a far-ahead slot cannot make the honest majority stale; safety reads fail closed', async t => {
  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map(p => `http://127.0.0.1:18060/${p}`), liars = ['/e', '/f'];
  let lag = null;
  // Four honest readers see no account at slot 1000; two liars claim a forged account 1000 slots ahead.
  t.mock.method(globalThis, 'fetch', async url => liars.includes(url.pathname)
    ? reply({ context: { slot: 2000 }, value: { ...wireAccount(), lamports: 1 } })
    : reply({ context: { slot: url.pathname === lag ? 900 : 1000 }, value: null }));
  for (const unanimous of [false, true]) {
    await assert.rejects(readAccountQuorum(address, { endpoints: six, unanimous }), e => e instanceof QuorumError &&
      !e.reports.some(r => r.status === 'stale') && /Ambiguous/.test(e.message));
  }
  const terms = { seller: { solRecipient: key(2).toBase58() }, buyer: { solPayer: key(3).toBase58() }, mint: key(4).toBase58(), quoteAmount: '1000000',
    refundAfter: 100, fees: { platformFeeBps: 10, tradeFeeBps: 50, platformCollector: key(5).toBase58(), collector: key(6).toBase58() } };
  const checked = await checkEscrow({ terms, hashHex: 'ab'.repeat(32), endpoints: six });
  assert.equal(checked.ok, false); assert.deepEqual(checked.reasons.map(r => r.code), ['ESCROW_QUORUM']);
  // With only one honest reader left the liars hold the majority slot: the lenient read cannot tell, a safety read refuses.
  const three = [six[0], six[4], six[5]];
  assert.equal((await readAccountQuorum(address, { endpoints: three })).value.lamports, 1);
  await assert.rejects(readAccountQuorum(address, { endpoints: three, unanimous: true }), /disagree/);
  // Honest readers alone: all agree, also when one lags behind the others.
  liars.length = 0; lag = '/a';
  for (const unanimous of [false, true]) {
    const result = await readAccountQuorum(address, { endpoints: six, unanimous });
    assert.equal(result.value, null); assert.equal(result.newestSlot, 1000); assert.equal(result.agreeing.length, 5);
    assert.equal(result.reports.find(r => r.endpoint === six[0]).status, 'stale');
  }
});

test('a safety read refuses one reader that answers differently, including a stale one; the lenient read keeps the majority', async t => {
  t.mock.method(globalThis, 'fetch', async url => reply({ context: { slot: url.pathname === '/c' ? 10 : 100 }, value: { ...wireAccount(), lamports: url.pathname === '/c' ? 1 : 2000000 } }));
  assert.equal((await readAccountQuorum(address, { endpoints })).value.lamports, 2000000);
  await assert.rejects(readAccountQuorum(address, { endpoints, unanimous: true }), e => e instanceof QuorumError && /disagree/.test(e.message));
  t.mock.method(globalThis, 'fetch', async url => { if (url.pathname === '/c') throw Error('offline'); return reply({ context: { slot: 100 }, value: wireAccount() }); });
  assert.equal((await readAccountQuorum(address, { endpoints, unanimous: true })).value.lamports, 2000000, 'errors are not disagreement');
});

test('RPC quorum: unanimous reads refuse any differing answer', async t => {
  t.mock.method(globalThis, 'fetch', async url => reply({ value: [url.pathname === '/c' ? { slot: 5, err: null, confirmationStatus: 'finalized' } : null] }));
  assert.deepEqual((await readRpcQuorum('getSignatureStatuses', [['x']], { endpoints })).value, { value: [null] });
  await assert.rejects(readRpcQuorum('getSignatureStatuses', [['x']], { endpoints, unanimous: true }), /disagree/);
  t.mock.method(globalThis, 'fetch', async () => reply({ value: [null] }));
  assert.deepEqual((await readRpcQuorum('getSignatureStatuses', [['x']], { endpoints, unanimous: true })).value, { value: [null] });
});
