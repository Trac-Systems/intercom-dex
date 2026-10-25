import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Keypair, Transaction, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { createSolanaAdapter } from '../../../src/solana/adapter.js';
import { LOCK_START_MARGIN_SEC } from '../../../src/core/trade-buyer.js';
import { deriveEscrowPda, deriveVaultAta, deriveConfigPda, deriveTradeConfigPda } from '../../../src/solana/escrow.js';
import { key, escrowBytes, tokenBytes, configBytes, wireAccount, terms as baseTerms } from './vectors.mjs';

const endpoints = ['http://127.0.0.1:18899', 'http://localhost:18899'];
const reply = result => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));

function fixture(t, kind = 'claim') {
  const buyer = Keypair.generate(), seller = Keypair.generate();
  const preimageHex = '23'.repeat(32), hashHex = createHash('sha256').update(Buffer.from(preimageHex, 'hex')).digest('hex');
  const terms = { ...baseTerms, seller: { solRecipient: seller.publicKey.toBase58() }, buyer: { solPayer: buyer.publicKey.toBase58() } };
  const escrow = deriveEscrowPda(hashHex), vault = deriveVaultAta(escrow.pda, terms.mint);
  const records = new Map();
  const store = {
    async get(id) { return records.has(id) ? JSON.parse(records.get(id)) : undefined; },
    async put(id, value) { records.set(id, JSON.stringify(value)); },
    async delete(id) { records.delete(id); },
  };
  const chain = { height: 10, generation: 0, mode: 'unknown', escrow: kind === 'lock' ? 'missing' : 'active',
    latestCalls: 0, statuses: new Map(), wires: [], reads: [], rejectFinalized: false, submitCalls: 0,
    failMethods: new Set(), accountSlot: 100, blockhashValid: false };
  const stateData = () => {
    const b = escrowBytes();
    Buffer.from(hashHex, 'hex').copy(b, 2); seller.publicKey.toBuffer().copy(b, 34); buyer.publicKey.toBuffer().copy(b, 66);
    vault.toBuffer().copy(b, 230); b[262] = escrow.bump;
    return b;
  };
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    const { method, params } = JSON.parse(request.body);
    chain.reads.push({ method, params });
    if (chain.failMethods.has(method)) throw new Error('RPC unavailable');
    if (method === 'getLatestBlockhash') { chain.latestCalls++; return reply({ value: { blockhash: key(chain.generation ? 9 : 8).toBase58(), lastValidBlockHeight: chain.generation ? 200 : 20 } }); }
    if (method === 'getBlockHeight') { assert.equal(params[0].commitment, 'finalized'); return reply(chain.height); }
    if (method === 'getSlot') return reply(100);
    if (method === 'isBlockhashValid') { assert.equal(params[1].commitment, 'finalized'); return reply({ value: chain.blockhashValid }); }
    if (method === 'getSignatureStatuses') return reply({ value: [chain.statuses.get(params[0][0]) ?? null] });
    if (method === 'getAccountInfo') {
      const [address, config] = params;
      let value;
      if (address === escrow.pda.toBase58()) {
        value = chain.escrow === 'missing' ? null : wireAccount(stateData());
        if (chain.rejectFinalized && config.commitment === 'finalized' && String(url).includes('localhost')) value = null;
      } else if (address === vault.toBase58()) {
        const b = tokenBytes(); escrow.pda.toBuffer().copy(b, 32); value = wireAccount(b, TOKEN_PROGRAM_ID.toBase58());
      } else if (address === deriveVaultAta(buyer.publicKey, terms.mint).toBase58()) {
        const b = tokenBytes(); buyer.publicKey.toBuffer().copy(b, 32); b.writeBigUInt64LE(100000000n, 64); value = wireAccount(b, TOKEN_PROGRAM_ID.toBase58());
      } else if (address === SYSVAR_CLOCK_PUBKEY.toBase58()) {
        const b = Buffer.alloc(40); b.writeBigInt64LE(2000000000n, 32); value = wireAccount(b, 'Sysvar1111111111111111111111111111111111111');
      } else {
        const platform = address === deriveConfigPda().pda.toBase58();
        const b = configBytes(), collector = key(platform ? 6 : 5);
        collector.toBuffer().copy(b, 1); collector.toBuffer().copy(b, 33); b.writeUInt16LE(platform ? 10 : 50, 65);
        b[67] = platform ? deriveConfigPda().bump : deriveTradeConfigPda(collector).bump;
        value = wireAccount(b);
      }
      return reply({ context: { slot: chain.accountSlot }, value });
    }
    if (method === 'sendTransaction') {
      chain.submitCalls++;
      const tx = Transaction.from(Buffer.from(params[0], 'base64')), signature = bs58.encode(tx.signature);
      const durable = [...records.values()].flatMap(value => JSON.parse(value).entries);
      assert.ok(durable.some(entry => entry.signature === signature && entry.wire === params[0] && entry.sent), 'signed bytes and submission marker must be durable before broadcast');
      const entry = durable.find(entry => entry.signature === signature);
      assert.equal(entry.lastValidBlockHeight, entry.height);
      assert.ok(Number.isSafeInteger(entry.lastBroadcastAt) && entry.lastBroadcastAt <= Date.now(), 'each broadcast is dated before dispatch');
      chain.wires.push(params[0]);
      if (chain.mode === 'confirmed') {
        chain.statuses.set(signature, { slot: 100, err: null, confirmationStatus: 'confirmed' });
        return reply(signature);
      }
      if (chain.mode === 'accepted_unknown') chain.escrow = 'active';
      if (chain.mode === 'rejected') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'definite simulation rejection' } }));
      throw new Error('response lost after broadcast');
    }
    assert.fail(`Unexpected method ${method}`);
  });
  const create = extra => createSolanaAdapter({ endpoints, sendEndpoint: endpoints[0], keypair: kind === 'claim' ? seller : buyer,
    intents: store, confirmationTimeoutMs: 60, ...extra });
  const input = { terms, hashHex, preimageHex };
  const invoke = async adapter => {
    // Under CPU load signing can use the tiny confirmation budget before the first send. The host retries
    // that prepared attempt; do the same here without changing its bytes or obscuring a broadcast result.
    let result;
    for (let attempt = 0; attempt < 4; attempt++) {
      result = await adapter[kind === 'lock' ? 'lockEscrow' : kind](input);
      if (result.ok || result.unknown || !/^Pending transaction .*: Transaction confirmation timed out$/.test(result.reason ?? '')) break;
    }
    return result;
  };
  return { chain, store, records, create, input, invoke };
}

test('unknown lock preserves its signature, is durable before broadcast, and a later finalized check finds it', async t => {
  const f = fixture(t, 'lock'); f.chain.mode = 'accepted_unknown';
  const adapter = f.create();
  const result = await f.invoke(adapter);
  assert.equal(result.ok, false); assert.equal(result.unknown, true); assert.equal(result.hashHex, f.input.hashHex); assert.ok(result.signature);
  const pending = await adapter.pendingIntents();
  assert.equal(pending.length, 1); assert.equal(pending[0].id, `lock:${f.input.hashHex}`); assert.equal(pending[0].signature, result.signature);
  assert.ok(pending[0].ageMs >= 0); assert.equal(pending[0].attempt, 1); assert.equal(pending[0].wire, undefined);
  const checked = await adapter.checkEscrow(f.input);
  assert.deepEqual(checked, { ok: true, hashHex: f.input.hashHex, purpose: 'lock', status: 'active' });
  assert.ok(f.chain.reads.filter(row => row.method === 'getAccountInfo').some(row => row.params[1].commitment === 'finalized'));
});

for (const kind of ['lock', 'claim', 'refund']) {
  test(`${kind}: durable restart resends identical live bytes, then replaces an expired nonexecuted attempt`, async t => {
    const f = fixture(t, kind);
    const first = await f.invoke(f.create()); assert.equal(first.unknown, true); assert.equal(first.hashHex, f.input.hashHex);
    const restarted = f.create();
    assert.equal((await restarted.pendingIntents())[0].signature, first.signature);
    const second = await f.invoke(restarted); assert.equal(second.signature, first.signature); assert.equal(second.unknown, true);
    assert.equal(new Set(f.chain.wires).size, 1); assert.equal(f.chain.latestCalls, 2);
    f.chain.height = 30; f.chain.generation = 1; f.chain.mode = 'confirmed';
    const recovered = f.create({ confirmationTimeoutMs: 800 });
    const result = await f.invoke(recovered); assert.equal(result.ok, true, result.reason);
    assert.notEqual(result[kind === 'lock' ? 'signature' : kind === 'claim' ? 'claimSignature' : 'refundSignature'], first.signature);
    assert.equal(new Set(f.chain.wires).size, 2); assert.equal(f.chain.latestCalls, 4);
    assert.equal((await recovered.pendingIntents()).length, 0); assert.equal(f.records.size, 0);
    assert.ok(f.chain.reads.some(row => row.method === 'getAccountInfo' && row.params[1].commitment === 'finalized' && row.params[1].minContextSlot === 100));
  });
}

test('restart reconciles a confirmed attempt before submissions and returns its original result', async t => {
  const f = fixture(t, 'claim');
  const first = await f.invoke(f.create());
  f.chain.statuses.set(first.signature, { slot: 100, err: null, confirmationStatus: 'confirmed' });
  f.chain.height = 30; f.chain.generation = 1;
  const restarted = f.create();
  assert.deepEqual(await restarted.pendingIntents(), []);
  const result = await f.invoke(restarted);
  assert.deepEqual(result, { ok: true, claimSignature: first.signature });
  assert.equal(f.chain.latestCalls, 2); assert.equal(f.chain.submitCalls, 1);
});

test('an expired ambiguous claim recovers within the same running adapter', async t => {
  const f = fixture(t, 'claim'), adapter = f.create({ confirmationTimeoutMs: 500 });
  const first = await f.invoke(adapter); assert.equal(first.unknown, true);
  f.chain.height = 30; f.chain.generation = 1; f.chain.mode = 'confirmed';
  const recovered = await f.invoke(adapter);
  assert.equal(recovered.ok, true, recovered.reason); assert.notEqual(recovered.claimSignature, first.signature);
  assert.equal(new Set(f.chain.wires).size, 2); assert.equal(f.chain.latestCalls, 4);
  assert.deepEqual(await adapter.pendingIntents(), []);
});

test('a confirmed signature awaiting finalized confirmation cannot be replaced after expiry', async t => {
  const f = fixture(t, 'claim');
  const first = await f.invoke(f.create());
  f.chain.statuses.set(first.signature, { slot: 100, err: null, confirmationStatus: 'confirmed' });
  f.chain.height = 30; f.chain.generation = 1;
  const restarted = f.create({ commitment: 'finalized' });
  assert.equal((await restarted.pendingIntents())[0].signature, first.signature);
  const waiting = await f.invoke(restarted);
  assert.equal(waiting.unknown, true); assert.equal(waiting.signature, first.signature);
  assert.equal(f.chain.latestCalls, 2); assert.equal(f.chain.submitCalls, 1);
  f.chain.statuses.set(first.signature, { slot: 100, err: null, confirmationStatus: 'finalized' });
  assert.deepEqual(await f.invoke(restarted), { ok: true, claimSignature: first.signature });
  assert.deepEqual(await restarted.pendingIntents(), []);
});

test('expiry with unavailable finalized account quorum preserves ambiguity and never signs a second live attempt', async t => {
  const f = fixture(t, 'claim');
  const first = await f.invoke(f.create());
  f.chain.height = 30; f.chain.generation = 1; f.chain.rejectFinalized = true;
  const result = await f.invoke(f.create());
  assert.equal(result.unknown, true); assert.equal(result.signature, first.signature);
  assert.equal(f.chain.latestCalls, 2); assert.equal(new Set(f.chain.wires).size, 1);
});

test('concurrent calls for one intent are serialized and reuse a single signed attempt', async t => {
  const f = fixture(t, 'claim');
  const adapter = f.create();
  const results = await Promise.all([f.invoke(adapter), f.invoke(adapter)]);
  assert.equal(results[0].signature, results[1].signature); assert.ok(results.every(result => result.unknown));
  assert.equal(f.chain.latestCalls, 2); assert.equal(new Set(f.chain.wires).size, 1);
});

test('definite preflight rejection and durable-store failures do not claim an unknown broadcast', async t => {
  const f = fixture(t, 'claim'); f.chain.mode = 'rejected';
  const rejected = await f.invoke(f.create());
  assert.equal(rejected.ok, false); assert.equal(rejected.unknown, undefined); assert.match(rejected.reason, /definite simulation/); assert.equal(f.records.size, 0);
  f.store.put = async () => { throw new Error('durable write failed'); };
  const failed = await f.invoke(f.create());
  assert.equal(failed.unknown, undefined); assert.match(failed.reason, /durable write failed/); assert.equal(f.chain.submitCalls, 1);
  f.store.get = async () => { throw new Error('journal unavailable'); };
  const unreadable = f.create();
  assert.match((await f.invoke(unreadable)).reason, /journal unavailable/);
  await assert.rejects(unreadable.pendingIntents(), /journal unavailable/);
  assert.equal(f.chain.submitCalls, 1);
});

test('invalid or conflicting durable journal is rejected before any new submission', async t => {
  const f = fixture(t, 'claim');
  await f.invoke(f.create());
  const [id, encoded] = [...f.records][0];
  const data = JSON.parse(encoded); data.entries[0].signature = 'invalid'; f.records.set(id, JSON.stringify(data));
  const restarted = f.create();
  await assert.rejects(restarted.pendingIntents(), /signature/);
  assert.match((await f.invoke(restarted)).reason, /signature/); assert.equal(f.chain.submitCalls, 1);
});

test('a crash between the durable preparation and submission marker resumes the same unsent bytes', async t => {
  const f = fixture(t, 'claim');
  const put = f.store.put; let writes = 0;
  f.store.put = async (...args) => { if (++writes === 2) throw new Error('crash before submission marker'); return put(...args); };
  const first = await f.invoke(f.create());
  assert.equal(first.ok, false); assert.equal(first.unknown, undefined); assert.equal(f.chain.submitCalls, 0);
  const prepared = JSON.parse([...f.records.values()][0]).entries[0]; assert.equal(prepared.sent, false);
  f.store.put = put; f.chain.mode = 'confirmed';
  const result = await f.invoke(f.create({ confirmationTimeoutMs: 800 }));
  assert.equal(result.ok, true, result.reason); assert.equal(result.claimSignature, prepared.signature); assert.equal(f.chain.latestCalls, 2);
});

for (const failRetirement of [false, true]) {
  test(`sent-marker latency crosses first-dispatch deadline, retirement ${failRetirement ? 'fails conservatively' : 'survives restart'}`, async t => {
    const f = fixture(t, 'lock'); let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);
    f.input.terms.sendBy = 1001 + LOCK_START_MARGIN_SEC;
    const put = f.store.put;
    f.store.put = async (id, value) => {
      const entry = value.entries[0];
      if (entry.phase === 'retired-unsent' && failRetirement) throw Error('retirement write failed');
      await put(id, value);
      if (entry.sent) now = 1_002_000 + LOCK_START_MARGIN_SEC * 1000;
    };
    const adapter = f.create(), result = await f.invoke(adapter);
    assert.equal(result.ok, false); assert.equal(f.chain.submitCalls, 0);
    assert.equal(result.unknown, failRetirement ? true : undefined);
    const saved = JSON.parse([...f.records.values()][0]).entries[0];
    assert.equal(saved.phase, failRetirement ? 'pending' : 'retired-unsent');
    assert.equal(saved.sent, failRetirement);
    f.store.put = put;
    const again = f.create();
    assert.deepEqual(await again.lockOutcome({ hashHex: f.input.hashHex }), { ok: true, outcome: failRetirement ? 'unknown' : 'none' });
    assert.equal((await again.pendingIntents()).length, failRetirement ? 1 : 0);
    if (!failRetirement) {
      assert.match((await f.invoke(again)).reason, /Lock did not go through/);
      assert.equal(f.chain.submitCalls, 0);
    }
  });
}

test('blockhash latency crossing the deadline signs and sends nothing', async t => {
  const f = fixture(t, 'lock'); let now = 1_000_000;
  t.mock.method(Date, 'now', () => now); f.input.terms.sendBy = 1001 + LOCK_START_MARGIN_SEC;
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (...args) => {
    const response = await fetch(...args);
    if (JSON.parse(args[1].body).method === 'getLatestBlockhash') now = 1_002_000;
    return response;
  });
  const result = await f.invoke(f.create());
  assert.match(result.reason, /Signing window closed/); assert.equal(result.unknown, undefined);
  assert.equal(f.records.size, 0); assert.equal(f.chain.submitCalls, 0);
});

test('an overdue prepared attempt is discarded before its first dispatch', async t => {
  const f = fixture(t, 'lock'); let now = 1_000_000;
  t.mock.method(Date, 'now', () => now); f.input.terms.sendBy = 1001 + LOCK_START_MARGIN_SEC;
  const put = f.store.put;
  f.store.put = async (id, value) => { if (value.entries[0].sent) throw Error('crash before marker'); return put(id, value); };
  assert.equal((await f.invoke(f.create())).unknown, undefined);
  assert.equal(JSON.parse([...f.records.values()][0]).entries[0].sent, false);
  f.store.put = put; now = 1_002_000 + LOCK_START_MARGIN_SEC * 1000;
  assert.match((await f.invoke(f.create())).reason, /Signing window closed/);
  assert.equal(f.chain.submitCalls, 0); assert.equal(f.records.size, 0);
});

test('a new lock is signed only before sendBy minus the lock-start margin; journaled bytes still go out until sendBy', async t => {
  const f = fixture(t, 'lock'); let now = 1_000_000;
  t.mock.method(Date, 'now', () => now); f.input.terms.sendBy = 1000 + LOCK_START_MARGIN_SEC;
  assert.match((await f.invoke(f.create())).reason, /Signing window closed/);
  assert.equal(f.chain.latestCalls, 0); assert.equal(f.records.size, 0);
  f.input.terms.sendBy = 1001 + LOCK_START_MARGIN_SEC;
  const put = f.store.put;
  f.store.put = async (id, value) => { if (value.entries[0].sent) throw Error('crash before marker'); return put(id, value); };
  assert.equal((await f.invoke(f.create())).unknown, undefined);
  const prepared = JSON.parse([...f.records.values()][0]).entries[0];
  f.store.put = put; now = 1_060_000; f.chain.mode = 'confirmed';
  const result = await f.invoke(f.create());
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.signature, prepared.signature, 'the journaled bytes, not a new signature'); assert.equal(f.chain.submitCalls, 1);
  assert.deepEqual(f.chain.wires, [prepared.wire]);
});

test('a genuinely dispatched attempt still reconciles after its deadline', async t => {
  const f = fixture(t, 'lock'); let now = 1_000_000;
  t.mock.method(Date, 'now', () => now); f.input.terms.sendBy = 1001 + LOCK_START_MARGIN_SEC; f.chain.mode = 'confirmed';
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (...args) => {
    const response = await fetch(...args);
    if (JSON.parse(args[1].body).method === 'sendTransaction') now = 1_002_000 + LOCK_START_MARGIN_SEC * 1000;
    return response;
  });
  const first = await f.invoke(f.create());
  assert.equal(first.unknown, true); assert.equal(f.chain.submitCalls, 1);
  const result = await f.invoke(f.create());
  assert.equal(result.ok, true); assert.equal(result.signature, first.signature);
  assert.equal(f.chain.submitCalls, 1);
});

function editLockRecord(f, edit) {
  const [id, encoded] = [...f.records][0], saved = JSON.parse(encoded);
  edit(saved.entries[0]);
  f.records.set(id, JSON.stringify(saved));
  return saved.entries[0];
}

test('a dropped lock ends only past its finalized expiry, with no signature status and fenced finalized absence', async t => {
  const f = fixture(t, 'lock'), adapter = f.create({ finality: 'confirmed' });
  const sent = await f.invoke(adapter);
  const record = JSON.parse([...f.records.values()][0]).entries[0];
  assert.equal(record.signature, sent.signature); assert.equal(record.lastValidBlockHeight, 20);
  for (const height of [10, 20]) {
    f.chain.height = height;
    assert.deepEqual(await adapter.lockOutcome(f.input), { ok: true, outcome: 'unknown' });
  }
  f.chain.height = 21; f.chain.reads.length = 0;
  assert.deepEqual(await adapter.lockOutcome(f.input), { ok: true, outcome: 'none' });
  const methods = f.chain.reads.map(r => r.method);
  assert.ok(methods.indexOf('getBlockHeight') < methods.indexOf('getSlot'));
  assert.ok(methods.indexOf('getSlot') < methods.indexOf('getSignatureStatuses'));
  assert.ok(methods.indexOf('getSignatureStatuses') < methods.indexOf('getAccountInfo'));
  const accounts = f.chain.reads.filter(r => r.method === 'getAccountInfo');
  assert.ok(accounts.length > 0 && accounts.every(r => r.params[1].commitment === 'finalized' && r.params[1].minContextSlot === 100));
  assert.equal(f.chain.latestCalls, 2); assert.equal(f.chain.submitCalls, 1);
});

test('the absence verdict retires the lock before a queued host retry, including after restart', async t => {
  const f = fixture(t, 'lock'), adapter = f.create(); await f.invoke(adapter);
  f.chain.height = 21; f.chain.generation = 1;
  const [outcome, retry] = await Promise.all([adapter.lockOutcome(f.input), f.invoke(adapter)]);
  assert.deepEqual(outcome, { ok: true, outcome: 'none' });
  assert.equal(retry.ok, false); assert.equal(retry.unknown, undefined); assert.match(retry.reason, /Lock did not go through/);
  assert.equal(JSON.parse([...f.records.values()][0]).entries[0].phase, 'not-executed');
  const restarted = f.create();
  assert.deepEqual(await restarted.pendingIntents(), []);
  assert.match((await f.invoke(restarted)).reason, /Lock did not go through/);
  assert.deepEqual(await restarted.lockOutcome(f.input), outcome);
  assert.equal(f.chain.latestCalls, 2); assert.equal(f.chain.submitCalls, 1);
});

test('failure to persist a terminal absence verdict never releases the buyer commitment', async t => {
  const f = fixture(t, 'lock'), adapter = f.create(); await f.invoke(adapter); f.chain.height = 21;
  const put = f.store.put;
  f.store.put = async (id, record) => {
    if (record.entries.some(entry => entry.phase === 'not-executed')) throw new Error('terminal journal write failed');
    return put(id, record);
  };
  const result = await adapter.lockOutcome(f.input);
  assert.equal(result.ok, false); assert.match(result.reason, /terminal journal write failed/);
  assert.equal(JSON.parse([...f.records.values()][0]).entries[0].phase, 'pending');
  f.store.put = put;
  assert.deepEqual(await adapter.lockOutcome(f.input), { ok: true, outcome: 'none' });
});

test('a lock found in the finalized escrow follows the landed path even with a lost signature response', async t => {
  const f = fixture(t, 'lock'); f.chain.mode = 'accepted_unknown';
  const adapter = f.create(); await f.invoke(adapter);
  for (const height of [10, 21]) {
    f.chain.height = height;
    assert.deepEqual(await adapter.lockOutcome(f.input), { ok: true, outcome: 'landed' });
  }
  assert.equal(f.chain.submitCalls, 1);
});

test('any extant signature status keeps an absent escrow unresolved; only a finalized failure is definitive', async t => {
  const f = fixture(t, 'lock'), adapter = f.create(), sent = await f.invoke(adapter);
  f.chain.height = 21;
  for (const confirmationStatus of ['processed', 'confirmed', 'finalized']) {
    f.chain.statuses.set(sent.signature, { slot: 100, err: null, confirmationStatus });
    assert.deepEqual(await adapter.lockOutcome(f.input), { ok: true, outcome: 'unknown' });
  }
  f.chain.statuses.set(sent.signature, { slot: 100, err: { InstructionError: [0, 'InvalidArgument'] }, confirmationStatus: 'confirmed' });
  assert.deepEqual(await adapter.lockOutcome(f.input), { ok: true, outcome: 'unknown' });
  f.chain.statuses.get(sent.signature).confirmationStatus = 'finalized';
  assert.deepEqual(await adapter.lockOutcome(f.input), { ok: true, outcome: 'none' });
});

test('a confirmed lock failure cannot become a definite abort through the submission retry path', async t => {
  const f = fixture(t, 'lock'), first = await f.invoke(f.create());
  f.chain.statuses.set(first.signature, { slot: 100, err: { InstructionError: [0, 'InvalidArgument'] }, confirmationStatus: 'confirmed' });
  f.chain.height = 21;
  const restarted = f.create(), waiting = await f.invoke(restarted);
  assert.equal(waiting.unknown, true); assert.equal(waiting.signature, first.signature);
  assert.equal(f.chain.submitCalls, 1); assert.equal(f.chain.latestCalls, 2);
  assert.deepEqual(await restarted.lockOutcome(f.input), { ok: true, outcome: 'unknown' });
  f.chain.statuses.get(first.signature).confirmationStatus = 'finalized';
  assert.deepEqual(await restarted.lockOutcome(f.input), { ok: true, outcome: 'none' });
});

test('unavailable RPC evidence and account reads below the expiry fence never free a lock', async t => {
  const f = fixture(t, 'lock'), adapter = f.create(); await f.invoke(adapter); f.chain.height = 21;
  for (const method of ['getBlockHeight', 'getSlot', 'getSignatureStatuses', 'getAccountInfo']) {
    f.chain.failMethods.add(method);
    const result = await adapter.lockOutcome(f.input);
    assert.ok(!result.ok || result.outcome === 'unknown', `${method}: ${JSON.stringify(result)}`);
    f.chain.failMethods.clear();
  }
  f.chain.accountSlot = 99;
  assert.deepEqual(await adapter.lockOutcome(f.input), { ok: true, outcome: 'unknown' });
  f.chain.accountSlot = 100;
  assert.deepEqual(await adapter.lockOutcome(f.input), { ok: true, outcome: 'none' });
  assert.equal(f.chain.submitCalls, 1);
});

test('a dissenting processed status prevents both restart replacement and absence recovery', async t => {
  const f = fixture(t, 'lock'); await f.invoke(f.create()); f.chain.height = 21;
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    if (String(url).includes('127.0.0.2') && JSON.parse(request.body).method === 'getSignatureStatuses') {
      return reply({ value: [{ slot: 100, err: null, confirmationStatus: 'processed' }] });
    }
    return fetch(url, request);
  });
  const adapter = f.create({ endpoints: [...endpoints, 'http://127.0.0.2:18899'] });
  assert.equal((await adapter.lockOutcome(f.input)).ok, false);
  assert.equal((await adapter.pendingIntents())[0].attempt, 1);
  assert.equal(f.chain.submitCalls, 1);
});

test('restart retains the exact expiry and releases a dead lock without broadcasting again', async t => {
  const f = fixture(t, 'lock'), sent = await f.invoke(f.create());
  const restarted = f.create();
  assert.equal((await restarted.pendingIntents())[0].signature, sent.signature);
  assert.deepEqual(await restarted.lockOutcome(f.input), { ok: true, outcome: 'unknown' });
  f.chain.height = 21;
  assert.deepEqual(await f.create().lockOutcome(f.input), { ok: true, outcome: 'none' });
  assert.equal(f.chain.submitCalls, 1); assert.equal(f.chain.latestCalls, 2);
});

test('older journals retain their height alias as exact expiry evidence without waiting ten minutes', async t => {
  const f = fixture(t, 'lock'); await f.invoke(f.create());
  editLockRecord(f, entry => { delete entry.lastValidBlockHeight; delete entry.lastBroadcastAt; });
  f.chain.height = 21;
  assert.deepEqual(await f.create().lockOutcome(f.input), { ok: true, outcome: 'none' });
  assert.ok(!f.chain.reads.some(read => read.method === 'isBlockhashValid'));
  assert.equal(f.chain.submitCalls, 1);
});

test('legacy locks wait ten minutes since the last broadcast and require an expired blockhash', async t => {
  const f = fixture(t, 'lock'); await f.invoke(f.create());
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  editLockRecord(f, entry => {
    delete entry.height; delete entry.lastValidBlockHeight;
    entry.createdAt = now - 86400000; entry.lastBroadcastAt = now - 599999;
  });
  const restarted = f.create();
  assert.deepEqual(await restarted.lockOutcome(f.input), { ok: true, outcome: 'unknown' });
  now++;
  f.chain.blockhashValid = true;
  assert.deepEqual(await restarted.lockOutcome(f.input), { ok: true, outcome: 'unknown' }, 'a stalled chain cannot expire bytes by wall time alone');
  f.chain.blockhashValid = false;
  f.chain.failMethods.add('isBlockhashValid');
  assert.equal((await restarted.lockOutcome(f.input)).ok, false);
  f.chain.failMethods.clear();
  assert.deepEqual(await restarted.lockOutcome(f.input), { ok: true, outcome: 'none' });
  assert.equal(f.chain.submitCalls, 1);
});

test('legacy records without a broadcast date start a durable safe window that survives another restart', async t => {
  const f = fixture(t, 'lock'); await f.invoke(f.create());
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  editLockRecord(f, entry => {
    delete entry.height; delete entry.lastValidBlockHeight; delete entry.lastBroadcastAt;
    entry.createdAt = now - 86400000;
  });
  assert.deepEqual(await f.create().lockOutcome(f.input), { ok: true, outcome: 'unknown' });
  const observed = JSON.parse([...f.records.values()][0]).entries[0].legacyObservedAt;
  assert.equal(observed, now);
  now += 599999;
  assert.deepEqual(await f.create().lockOutcome(f.input), { ok: true, outcome: 'unknown' });
  now++;
  assert.deepEqual(await f.create().lockOutcome(f.input), { ok: true, outcome: 'none' });
  assert.equal(JSON.parse([...f.records.values()][0]).entries[0].legacyObservedAt, observed);
  assert.equal(f.chain.submitCalls, 1);
});

test('expired lock bytes are never replaced at the lock-start cutoff', async t => {
  const f = fixture(t, 'lock'); await f.invoke(f.create()); f.chain.height = 21;
  f.input.terms.sendBy = Math.floor(Date.now() / 1000) + LOCK_START_MARGIN_SEC;
  const result = await f.invoke(f.create());
  assert.equal(result.ok, false); assert.match(result.reason, /Signing window closed/);
  assert.equal(f.chain.submitCalls, 1); assert.equal(f.chain.latestCalls, 2);
});
