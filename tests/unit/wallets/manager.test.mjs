import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { WalletManager, MAX_CLOCK_SKEW_SEC } from '../../../src/wallets/manager.js';
import { deriveVaultAta } from '../../../src/solana/escrow.js';
import { USDC_MINT } from '../../../src/solana/constants.js';
import { openStore } from '../../../src/roles/store.js';
import { registerWalletTools } from '../../../src/mcp/wallet-tools.js';
import { fixture } from '../core/helpers.mjs';

function setup() {
  const f = fixture(), dir = mkdtempSync(join(tmpdir(), 'withdraw-')), key = randomBytes(32);
  const addresses = { solana: Keypair.generate().publicKey.toBase58(), trac: f.terms.seller.tracAddr };
  const target = { solana: Keypair.generate().publicKey.toBase58(), trac: f.terms.buyer.tracAddr };
  const own = { USDC: '10000000', SOL: '100000000', TNK: '1000000000000000000', RESET: '1000000000', feeTnk: '30000000000000000' };
  const receiver = { USDC: '0', SOL: '0', TNK: '0', RESET: '0', feeTnk: own.feeTnk };
  const journal = new Map(), chain = { sends: 0, final: true, loseResponse: false, balances: true, moveBalances: true, statusError: false,
    owners: new Map(), clock: () => Math.floor(Date.now() / 1000), clockReads: 0 };
  const transfer = async w => {
    chain.sends++;
    assert.ok(store.get('withdraw-' + w.id), 'outer request must be durable before any send');
    journal.set(w.id, { ...w });
    if (chain.moveBalances) { own[w.asset] = (BigInt(own[w.asset]) - BigInt(w.amount)).toString(); receiver[w.asset] = (BigInt(receiver[w.asset]) + BigInt(w.amount)).toString(); }
    return chain.loseResponse ? { ok: false, unknown: true } : { ok: true, signature: 'synthetic-signature', txHash: 'aa'.repeat(32) };
  };
  const status = async id => {
    if (chain.statusError) throw Error('history offline');
    return journal.has(id) ? { ok: chain.final, unknown: !chain.final, signature: 'synthetic-signature' } : { ok: false, unknown: false, reason: 'Not sent: no signed withdrawal was recorded' };
  };
  const solana = { walletBalances: async address => {
    if (!chain.balances) throw Error('offline');
    return { ...(address === addresses.solana ? own : receiver) };
  }, walletWithdraw: transfer, walletWithdrawalStatus: status,
  accountOwner: async address => chain.owners.get(address) ?? null,
  chainTime: async () => { chain.clockReads++; return chain.clock(); } };
  const trac = { balances: async address => ({ ...(address === addresses.trac ? own : receiver) }),
    sendTransfer: ({ tradeId, terms }) => transfer({ id: tradeId, asset: terms.base.id, amount: terms.baseAmount }),
    withdrawalStatus: w => status(w.id) };
  const role = { mine: new Map(), host: { trades: new Map() }, registry: { snapshot: () => f.registry } };
  const config = { dataDir: dir, role: 'trader', keyPasswordEnv: 'OWNER_PASSWORD' };
  const store = openStore(dir, key);
  const create = () => new WalletManager({ config, configFile: join(dir, 'role.json'), store: openStore(dir, key), role, solana, trac, addresses });
  return { create, config, target, addresses, own, receiver, role, chain, store };
}

test('all four assets obey free limits, decimal amounts, all and optional payout locks', async () => {
  for (const asset of ['USDC', 'SOL', 'TNK', 'RESET']) {
    const f = setup(), manager = f.create(), chain = ['SOL', 'USDC'].includes(asset) ? 'solana' : 'trac', to = f.target[chain];
    await assert.rejects(manager.withdraw({ asset, amount: '1000', to }), /free balance/);
    const free = (await manager.balances())[asset].free;
    if (asset === 'USDC') {
      f.config.payout = { solana: to };
      await assert.rejects(manager.withdraw({ asset, amount: '1', to: f.addresses.solana }), /payout lock/);
    }
    const out = await manager.withdraw({ asset, amount: 'all', ...(asset === 'USDC' ? {} : { to }) });
    assert.equal(out.status, 'confirmed'); assert.equal(out.amount, free); assert.equal(f.receiver[asset], free); assert.equal(f.chain.sends, 1);
    await assert.rejects(manager.withdraw({ asset, amount: '1', to }), /free balance/);
  }
});

test('unknown withdrawal survives real encrypted-store restart without a second send', async () => {
  const f = setup(); f.chain.final = false; f.chain.loseResponse = true;
  const first = await f.create().withdraw({ asset: 'USDC', amount: '1.25', to: f.target.solana });
  assert.equal(first.status, 'unconfirmed'); assert.equal(first.amount, '1250000');
  const restarted = f.create(); await restarted.recover();
  assert.equal((await restarted.info()).withdrawals[0].id, first.id);
  const again = await restarted.withdraw({ asset: 'USDC', amount: 'all', to: f.target.solana });
  assert.equal(again.id, first.id); assert.equal(again.existing, true); assert.equal(f.chain.sends, 1);
  f.chain.final = true; await restarted.recover();
  assert.equal(f.store.get('withdraw-' + first.id).status, 'confirmed'); assert.equal(f.chain.sends, 1);
  assert.equal((await restarted.info()).withdrawals.length, 0);
});

test('a request that crashed before signing fails and frees its amount; unavailable history stays unconfirmed; per-asset concurrency refuses another send', async () => {
  const f = setup(), manager = f.create();
  const first = manager.withdraw({ asset: 'RESET', amount: '1', to: f.target.trac });
  await assert.rejects(manager.withdraw({ asset: 'RESET', amount: '2', to: f.target.trac }), /already in progress/);
  assert.equal((await first).status, 'confirmed');
  const id = 'bb'.repeat(32), freeSol = (await manager.balances()).SOL.free;
  f.store.put('withdraw-' + id, { id, asset: 'SOL', amount: '1', status: 'unconfirmed', to: f.target.solana });
  assert.equal((await manager.balances()).SOL.free, (BigInt(freeSol) - 1n).toString());
  f.chain.statusError = true; await manager.recover();
  assert.equal(f.store.get('withdraw-' + id).status, 'unconfirmed'); assert.match(f.store.get('withdraw-' + id).reason, /history unavailable/);
  f.chain.statusError = false; await manager.recover();
  assert.deepEqual([f.store.get('withdraw-' + id).status, f.store.get('withdraw-' + id).reason], ['failed', 'Not sent: no signed withdrawal was recorded']);
  assert.equal((await manager.balances()).SOL.free, freeSol); assert.equal(f.chain.sends, 1);
});

test('a withdrawal confirms on transaction evidence even when other payments move both balances', async () => {
  const f = setup(), manager = f.create(); f.chain.moveBalances = false;
  for (const [asset, to] of [['USDC', f.target.solana], ['TNK', f.target.trac]]) {
    const out = await manager.withdraw({ asset, amount: '0.5', to });
    assert.equal(out.status, 'confirmed'); assert.equal(out.reason, undefined);
  }
  f.chain.final = false; f.chain.loseResponse = true;
  const pending = await manager.withdraw({ asset: 'SOL', amount: '0.01', to: f.target.solana });
  assert.equal(pending.status, 'unconfirmed');
});

test('withdrawals and payouts refuse token accounts and other addresses no one can sign for, before anything is saved', async () => {
  const f = setup(), manager = f.create(), ata = deriveVaultAta(f.target.solana, USDC_MINT).toBase58();
  for (const asset of ['SOL', 'USDC']) await assert.rejects(manager.withdraw({ asset, amount: '0.001', to: ata }), /not a wallet address/);
  for (const owner of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    f.chain.owners.set(f.target.solana, owner.toBase58());
    for (const asset of ['SOL', 'USDC']) await assert.rejects(manager.withdraw({ asset, amount: '0.001', to: f.target.solana }), /^Error: This is a token account, give the wallet address$/);
  }
  f.chain.owners.set(f.target.solana, Keypair.generate().publicKey.toBase58());
  await assert.rejects(manager.withdraw({ asset: 'SOL', amount: '0.001', to: f.target.solana }), /belongs to a program, give the wallet address/);
  assert.deepEqual(f.store.list('withdraw-'), []); assert.equal(f.chain.sends, 0);
  assert.equal((await manager.withdraw({ asset: 'USDC', amount: '0.001', to: f.target.solana })).status, 'confirmed', 'USDC only refuses token accounts');
  f.chain.owners.set(f.target.solana, SystemProgram.programId.toBase58());
  assert.equal((await manager.withdraw({ asset: 'SOL', amount: '0.001', to: f.target.solana })).status, 'confirmed');
  assert.throws(() => new WalletManager({ ...f, config: { ...f.config, payout: { solana: ata } }, store: f.store }), /not a wallet address/);
  f.config.payout = { solana: f.target.solana }; f.chain.owners.set(f.target.solana, TOKEN_PROGRAM_ID.toBase58());
  await assert.rejects(f.create().checkPayout(), /token account/);
  f.chain.owners.delete(f.target.solana); await f.create().checkPayout();
});

test('new offers and takes need a local clock within 30 s of the Solana Clock; a good comparison is reused for a minute', async () => {
  const f = setup(), terms = { role: 'seller', base: { id: 'RESET' }, baseAmount: '1' };
  for (const [offset, ok] of [[MAX_CLOCK_SKEW_SEC, true], [-MAX_CLOCK_SKEW_SEC, true], [MAX_CLOCK_SKEW_SEC + 2, false], [-MAX_CLOCK_SKEW_SEC - 2, false]]) {
    f.chain.clock = () => Math.floor(Date.now() / 1000) + offset;
    const attempt = f.create().requireFunds(terms);
    if (ok) await attempt;
    else await assert.rejects(attempt, new RegExp(`clock is \\d+ s ${offset > 0 ? 'behind' : 'ahead of'} Solana's clock \\(at most 30 s allowed\\)`));
  }
  const manager = f.create(); f.chain.clock = () => Math.floor(Date.now() / 1000); f.chain.clockReads = 0;
  await manager.requireFunds(terms); await manager.requireFunds(terms); assert.equal(f.chain.clockReads, 1);
  manager.clockAt -= 61_000; f.chain.clock = () => { throw Error('rpc down'); };
  await assert.rejects(manager.requireFunds(terms), /Cannot compare this computer's clock with Solana's right now \(rpc down\)/);
});

test('wallet details are safe for MCP and give exact files, environment names, commands and balances', async () => {
  const f = setup(), manager = f.create(), info = await manager.info();
  assert.equal(info.storage.dataDir, f.config.dataDir); assert.equal(info.storage.passwordEnv, 'OWNER_PASSWORD');
  assert.equal(info.storage.keyringFile, join(f.config.dataDir, 'keyring.json')); assert.equal(info.storage.tracWalletFile, join(f.config.dataDir, 'trac-wallet.json'));
  assert.match(info.backup.exportCommand, / export --config '/); assert.match(info.backup.exportCommand, / --out '/);
  assert.ok(!JSON.stringify(info).includes('secretKey')); assert.ok(!JSON.stringify(info).includes('ciphertext'));
  assert.equal((await manager.info({ short: true })).storage, undefined);
  const tools = new Map(), calls = [];
  registerWalletTools({ registerTool: (name, schema, handler) => tools.set(name, { schema, handler }) }, async (...args) => { calls.push(args); return info; });
  assert.deepEqual([...tools.keys()], ['dex_wallets', 'dex_withdraw']);
  assert.match(tools.get('dex_wallets').schema.description, /owner asks how to trade/);
  assert.match(tools.get('dex_wallets').schema.description, /no payout lock, propose one to the owner/);
  assert.deepEqual(JSON.parse((await tools.get('dex_wallets').handler()).content[0].text), info);
  await tools.get('dex_withdraw').handler({ asset: 'SOL', amount: 'all', to: f.target.solana });
  assert.deepEqual(calls[0], ['GET', '/wallets']); assert.equal(calls[1][1], '/withdraw');
  await manager.requireFunds({ role: 'seller', base: { id: 'RESET' }, baseAmount: '1' });
  await assert.rejects(manager.requireFunds({ role: 'seller', base: { id: 'RESET' }, baseAmount: '999999999999999' }), /Insufficient/);
});

test('service requires its payout address and exposes only the fee collector assets', async () => {
  const f = setup(); f.config.role = 'service';
  const manager = f.create();
  await assert.rejects(manager.withdraw({ asset: 'USDC', amount: '1', to: f.target.solana }), /payout.solana/);
  f.config.payout = { solana: f.target.solana };
  assert.equal((await manager.withdraw({ asset: 'USDC', amount: '1' })).status, 'confirmed');
  await assert.rejects(manager.withdraw({ asset: 'RESET', amount: '1', to: f.target.trac }), /no Trac wallet/);
});

test('wallet details stay available when balances cannot be read, and display reads are cached while trading reads are fresh', async () => {
  const f = setup(), manager = f.create();
  let reads = 0; const read = manager.raw.bind(manager); manager.raw = async () => { reads++; return read(); };
  assert.ok((await manager.info({ short: true })).balances);
  await manager.info({ short: true }); assert.equal(reads, 1, 'second display read uses the cache');
  await manager.requireFunds({ role: 'seller', base: { id: 'RESET' }, baseAmount: '1' }); assert.equal(reads, 2, 'trading reads fresh');
  f.role.mine.set('x', { offerId: 'x' }); await manager.info({ short: true }); assert.equal(reads, 3, 'a changed offer list reads fresh');
  f.role.mine.clear(); await manager.info({ short: true }); const r0 = reads;
  // A withdrawal that confirms at once is never pending, yet the next display read must be fresh.
  await manager.withdraw({ asset: 'SOL', amount: '0.001', to: f.target.solana });
  const shown = await manager.info({ short: true }); assert.ok(reads > r0 + 0);
  assert.equal(shown.balances.SOL.wallet, f.own.SOL);
  manager.shown = null; f.chain.balances = false;
  const info = await manager.info({ short: true });
  assert.deepEqual(info.addresses, f.addresses); assert.equal(info.balances, null); assert.match(info.balanceError, /Balances unavailable right now: offline/);
  await assert.rejects(manager.requireFunds({ role: 'seller', base: { id: 'RESET' }, baseAmount: '1' }), /offline/);
});

test('a buy offer or take needs at least MIN_SOL in the wallet, a sell does not', async () => {
  const f = setup(), buy = { role: 'buyer', base: { id: 'RESET' }, baseAmount: '1', quoteAmount: '1000', fees: { platformFeeBps: 10, tradeFeeBps: 10 } };
  await f.create().requireFunds(buy);
  f.own.SOL = '2601400';
  await assert.rejects(f.create().requireFunds(buy), /Keep at least 0\.01 SOL in the wallet/);
  await f.create().requireFunds({ role: 'seller', base: { id: 'RESET' }, baseAmount: '1' });
});
