import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Keypair, Transaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { createTraderLocks, createLocksSubmitter } from '../../../src/wallets/locks.js';
import { createLocksTrac } from '../../../src/wallets/locks-trac.js';
import { WalletManager } from '../../../src/wallets/manager.js';
import { accountBalances, accountLockBalances } from '../../../src/wallets/accounting.js';
import { Trader } from '../../../src/roles/trader.js';
import { scalarSigner } from '../../../src/locks/crypto/scalar-sign.js';
import { address, fundingNonce } from '../../../src/locks/trac-lock.js';
import { seal } from '../../../src/locks/transport.js';
import * as pay from '../../../src/locks/solana-pay.js';
import { hash as escrowHash } from '../../../src/locks/escrow-lock.js';
import { deriveEscrowPda, deriveVaultAta } from '../../../src/solana/escrow.js';
import { PROGRAM_ID } from '../../../src/solana/constants.js';
import { escrowBytes, tokenBytes, wireAccount, key as publicKey } from '../solana/vectors.mjs';
import { fixture, position, terms, identity } from '../locks-products/helpers.mjs';

const rpc = { endpoints: ['http://127.0.0.1:8899', 'http://127.0.0.1:8900'], sendEndpoint: 'http://127.0.0.1:8899', need: 2 };

test('stock trader enables a distinct locks identity on its one bridge only when configured', async () => {
  const f = fixture(), venue = identity(), bridge = new EventEmitter(); bridge.calls = [];
  bridge.request = async body => { bridge.calls.push(body); return {}; };
  bridge.send = async (ch, raw) => { if (raw.kind === 'bookRequest') queueMicrotask(() => bridge.emit('message', ch, seal({ ch, kind: 'book',
    body: { page: raw.body.page, pageSize: 100, total: 0, positions: [], requester: raw.from } }, venue.secretKey))); }; bridge.leave = async () => {};
  bridge.call = async kind => { assert.equal(kind, 'locks_clock'); return { counted: 100 }; };
  const keypair = Keypair.generate(), wallet = { address: f.me.trac };
  const profile = { mint: Keypair.generate().publicKey.toBase58(), programId: Keypair.generate().publicKey.toBase58() };
  const input = { config: {}, bridge, store: f.store, keypair, wallet, profile, rpc };
  assert.equal(createTraderLocks(input), null); assert.equal(f.store.get('locks-keys'), null);
  input.config.locks = { venueKey: venue.publicKey };
  const locks = createTraderLocks(input), again = createTraderLocks(input);
  await assert.rejects(locks.adapters.admit({ registry: f.reg }), /protocol_unavailable/);
  assert.notEqual(locks.identity.publicKey, f.key.publicKey);
  assert.equal(again.identity.publicKey, locks.identity.publicKey);
  const args = { bridge, identity: f.key, store: f.store, me: { dexKey: f.me.lockKey, tracAddr: f.me.trac, solAddr: keypair.publicKey.toBase58() },
    serviceKey: identity().publicKey, mint: profile.mint, platformCollector: Keypair.generate().publicKey.toBase58(), proof: { zkey: '/unit-test-unused.zkey' }, log() {} };
  assert.equal(new Trader(args).locks, undefined);
  const trader = new Trader({ ...args, locks });
  trader.tickers.set('TNK/USDC', { last: '2.5' });
  assert.equal(trader.locks.adapters.lastPrice('TNK'), '2.5');
  await trader.locks.start();
  assert.deepEqual(bridge.calls, [{ type: 'locks_join', channel: 'intercom-locks' }]);
  assert.equal(bridge.listenerCount('message'), 2);
  await trader.locks.stop(); assert.equal(bridge.listenerCount('message'), 0);
});

test('Solana submission journals exact bytes before send and reconciles without signing again', async () => {
  const f = fixture(), keypair = Keypair.generate(), id = 'ab'.repeat(32), blockhash = Keypair.generate().publicKey.toBase58();
  let sends = 0, finalized = false, blockReads = 0;
  const submitter = createLocksSubmitter({ store: f.store, keypair, rpc,
    call: async (_url, method, params) => {
      if (method === 'getLatestBlockhash') { blockReads++; return { value: { blockhash } }; }
      assert.equal(method, 'sendTransaction'); sends++;
      const journal = f.store.get(`locks-sol-${id}`);
      assert.equal(params[0], journal.wire); assert.equal(journal.authorized, true);
      assert.ok(Transaction.from(Buffer.from(journal.wire, 'base64')).verifySignatures());
      return journal.signature;
    },
    read: async (_method, _params, options) => {
      assert.equal(options.need, 2); assert.equal(options.unanimous, true);
      const journal = f.store.get(`locks-sol-${id}`);
      return { value: finalized ? { transaction: [journal.wire, 'base64'], err: null, slot: 7, blockTime: 1000 } : null };
    },
  });
  const transaction = pay.build({ payer: keypair.publicKey, payee: f.me.sol, amount: '123', mint: f.options.adapters.mint, memo: pay.memo('cd'.repeat(32), 'repay') });
  const first = await submitter.submit({ id, transaction }); assert.equal(first.ok, false);
  const signed = f.store.get(`locks-sol-${id}`).wire;
  finalized = true;
  const final = await submitter.reconcile({ id }); assert.equal(final.finalized, true);
  assert.equal(f.store.get(`locks-sol-${id}`).wire, signed); assert.equal(blockReads, 1);
  assert.equal((await submitter.submit({ id, transaction: new Transaction() })).ok, true);
  assert.equal(blockReads, 1); assert.ok(sends >= 1);
});

test('a failed last-moment payment check cannot later broadcast unapproved journal bytes', async () => {
  const f = fixture(), keypair = Keypair.generate(), id = 'ef'.repeat(32); let checks = 0, sends = 0;
  const submitter = createLocksSubmitter({ store: f.store, keypair, rpc,
    call: async (_url, method) => { if (method === 'sendTransaction') sends++; return { value: { blockhash: Keypair.generate().publicKey.toBase58() } }; },
    read: async () => ({ value: null }),
  });
  const transaction = pay.build({ payer: keypair.publicKey, payee: f.me.sol, amount: '1', mint: f.options.adapters.mint, memo: pay.memo('cd'.repeat(32), 'repay') });
  await assert.rejects(submitter.submit({ id, transaction, beforeSend: () => { if (++checks === 2) throw Error('deadline'); } }), /deadline/);
  await submitter.reconcile({ id }); assert.equal(sends, 0);
});

test('TNK funding signs the exact locks nonce and reuses its durable transfer', async () => {
  const f = fixture(), signer = scalarSigner(7n), wallet = { ...signer, address: address(signer.publicKey) };
  const to = f.me.trac, nonce = fundingNonce('aa'.repeat(32), 'TNK'), id = 'bb'.repeat(32);
  let final = false, broadcasts = 0, signed;
  const bridge = { call: async (method, input) => {
    if (method === 'dex_msb_info') return { networkId: 1, addressPrefix: 'trac', txv: 'cc'.repeat(32), msbBootstrap: 'dd'.repeat(32) };
    if (method === 'dex_tnk_broadcast') {
      broadcasts++; assert.equal(input.payload.tro.in, nonce);
      assert.deepEqual(input.payload, f.store.get(`locks-trac-${id}`).payload);
      signed ??= input.payload; assert.deepEqual(input.payload, signed); return { txHash: input.payload.tro.tx };
    }
    assert.equal(method, 'dex_verify'); assert.equal(input.nonce, nonce);
    return { ok: final, final, amount: '123' };
  } };
  const adapter = createLocksTrac({ bridge, wallet, profile: { peer: { msbNetworkId: 1, msbBootstrap: 'dd'.repeat(32) } }, store: f.store });
  assert.equal((await adapter.transfer({ id, asset: 'TNK', amount: '123', to, nonce })).finalized, false);
  final = true;
  assert.equal((await adapter.transfer({ id, asset: 'TNK', amount: '123', to, nonce })).finalized, true);
  assert.equal(broadcasts, 1);
  await assert.rejects(adapter.transfer({ id, asset: 'TNK', amount: '124', to, nonce }), /intent mismatch/);
  // A retry of a transfer that already landed is answered by verification, not reported as a failure.
  final = false; bridge.call = (call => async (method, input) => {
    if (method === 'dex_tnk_broadcast') throw new Error(`Transaction with hash ${input.payload.tro.tx} already exists in the state.`);
    return call(method, input);
  })(bridge.call);
  assert.equal((await adapter.reconcile({ id })).finalized, false);
});

test('wallet admission serializes locks with other wallet admissions', async () => {
  const f = fixture(), role = { locks: f.client, registry: { snapshot: () => f.reg } };
  const balances = { RESET: '200000000', TNK: '1000000000000000000', USDC: '500000000', SOL: '100000000', feeTnk: '30000000000000000' };
  const manager = new WalletManager({ config: { role: 'trader' }, store: f.store, role,
    solana: { walletBalances: async () => balances }, trac: { balances: async () => balances }, addresses: { solana: f.me.sol, trac: f.me.trac } });
  f.client.adapters.exclusive = work => manager.exclusive(work);
  f.client.adapters.freeBalance = async (asset, context) => (await manager.balances(context))[asset].free;
  const first = f.client.post({ product: 'call', terms: { ...terms('call'), amount: '150000000' } });
  await Promise.resolve();
  const admitted = await Promise.allSettled([first,
    manager.exclusive(async () => { const free = (await manager.balances()).RESET.free; if (BigInt(free) < 100000000n) throw Error('spot refused'); }),
    f.client.post({ product: 'call', terms: { ...terms('call'), amount: '100000000' } })]);
  assert.deepEqual(admitted.map(r => r.status), ['fulfilled', 'rejected', 'rejected']);
  assert.equal((await manager.balances()).RESET.free, '50000000');
  assert.equal(f.client.positions.size, 1);
  role.locks = null;
  assert.equal((await manager.balances()).RESET.free, '200000000');
});

test('put wallet commitments include each owned lock, premium and funding transaction fees', () => {
  const f = fixture(), p = position('put', f.me, f.reg); p.taker = { ...p.taker, lockKey: identity().publicKey };
  p.state = 'taking'; p.funded = true; p.takeId = 'cc'.repeat(32);
  const balances = accountBalances({ balances: { RESET: '200000000', TNK: '1000000000000000000', USDC: '500000000', SOL: '100000000' }, registry: () => f.reg });
  const maker = accountLockBalances(balances, [p], f.me.lockKey), taker = accountLockBalances(balances, [p], p.taker.lockKey);
  assert.equal(maker.USDC.breakdown.locked, p.post.terms.strikeTotal);
  assert.equal(maker.USDC.breakdown.locks, '0');
  assert.equal(taker.USDC.breakdown.locks, p.post.terms.premium);
  assert.equal(taker.RESET.breakdown.locks, p.post.terms.amount);
  assert.equal(taker.TNK.breakdown.locks, f.reg.params.tnkReserve);
  assert.equal(taker.TNK.breakdown.fees, '120000000000000000');
  assert.equal(taker.SOL.breakdown.fees, '20000000');
  p.holderFunded = true;
  const funded = accountLockBalances(balances, [p], p.taker.lockKey);
  assert.equal(funded.RESET.breakdown.locks, '0'); assert.equal(funded.RESET.breakdown.locked, p.post.terms.amount);
  assert.equal(funded.TNK.breakdown.fees, balances.TNK.breakdown.fees);
});

test('put refund recovery verifies the funded escrow and its frozen fees without current config', async t => {
  const f = fixture(), keypair = Keypair.generate(), mint = publicKey(4), bridge = new EventEmitter();
  const locks = createTraderLocks({ config: { locks: { venueKey: identity().publicKey } }, bridge, store: f.store, keypair,
    wallet: { address: f.me.trac }, profile: { mint: mint.toBase58(), programId: PROGRAM_ID.toBase58() }, rpc });
  const p = position('put', f.me, f.reg); p.post.escrowPreimage = 'aa'.repeat(32); p.post.terms.strikeTotal = '1234567';
  p.post.maker.sol = keypair.publicKey.toBase58(); p.registry.fee.escrowCollector = publicKey(5).toBase58(); p.lock = { A: publicKey(3).toBuffer().toString('hex') };
  const H = escrowHash(p.post.escrowPreimage), derived = deriveEscrowPda(H), bytes = escrowBytes();
  bytes[1] = 2; Buffer.from(H, 'hex').copy(bytes, 2); keypair.publicKey.toBuffer().copy(bytes, 66);
  bytes.writeBigUInt64LE(0n, 138); bytes.writeBigUInt64LE(0n, 146);
  bytes.writeBigUInt64LE(0n, 188); bytes.writeUInt16LE(0, 196); deriveVaultAta(derived.pda, mint).toBuffer().copy(bytes, 230); bytes[262] = derived.bump;
  const vault = tokenBytes(); derived.pda.toBuffer().copy(vault, 32); vault.writeBigUInt64LE(0n, 64);
  let owner = PROGRAM_ID.toBase58();
  t.mock.method(globalThis, 'fetch', async (_url, request) => {
    const body = JSON.parse(request.body);
    assert.equal(body.method, 'getAccountInfo'); assert.equal(body.params[1].commitment, 'finalized');
    const escrow = body.params[0] === derived.pda.toBase58();
    if (!escrow) assert.equal(body.params[0], deriveVaultAta(derived.pda, mint).toBase58());
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 100 }, value: escrow ? wireAccount(bytes, owner) : wireAccount(vault, TOKEN_PROGRAM_ID.toBase58()) } }));
  });
  assert.equal((await locks.adapters.escrowSettlement(p)).status, 'refunded');
  owner = publicKey(9).toBase58(); assert.equal((await locks.adapters.escrowSettlement(p)).ok, false);
});

test('a missing book reply reports venue availability and removes its temporary listener', async t => {
  const f = fixture(), bridge = new EventEmitter(); bridge.send = async () => {};
  const locks = createTraderLocks({ config: { locks: { venueKey: identity().publicKey } }, bridge, store: f.store,
    keypair: Keypair.generate(), wallet: { address: f.me.trac }, profile: { mint: publicKey(4).toBase58(), programId: PROGRAM_ID.toBase58() }, rpc });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const response = locks.transport.requestBook({ page: 0, limit: 100 });
  const rejected = assert.rejects(response, e => e.reason === 'venue_unavailable');
  t.mock.timers.tick(8000); await rejected; assert.equal(bridge.listenerCount('message'), 0);
});
