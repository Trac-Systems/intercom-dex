import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Corestore from '../../../peer/node_modules/corestore/index.js';
import Hyperbee from '../../../peer/node_modules/hyperbee/index.js';
import { signedBalanceRead } from '../../../peer/src/trac/balances.js';
import { WalletManager } from '../../../src/wallets/manager.js';
import { MakerFunds } from '../../../src/market/funds.js';
import { signedCheckout } from '../../../peer/src/trac/signed-view.js';
import { createTransferVerifier } from '../../../peer/src/trac/verify-transfer.js';
import { buildResetTransfer } from '../../../src/trac/transfers.js';
import { normalizeTransactionOperation } from '../../../peer/node_modules/trac-msb/src/utils/normalizers.js';
import { safeEncodeApplyOperation } from '../../../peer/node_modules/trac-msb/src/utils/protobuf/operationHelpers.js';
import { ed25519 } from '@noble/curves/ed25519.js';

const encoding = { keyEncoding: 'utf-8', valueEncoding: 'json', extension: false };
const turn = () => new Promise(resolve => setImmediate(resolve));

async function replicatedBeforeCommit(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-signed-view-'));
  const writerStore = new Corestore(path.join(directory, 'writer'));
  const store = new Corestore(path.join(directory, 'reader'));
  const original = new Hyperbee(writerStore.get({ name: 'view' }), encoding);
  let view;
  const streams = [];
  t.after(async () => {
    for (const stream of streams) stream.destroy();
    await view?.close(); await original.close();
    await store.close(); await writerStore.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await original.put('genesis', true);
  const core = store.get(original.core.key);
  await core.ready();
  const a = writerStore.replicate(true), b = store.replicate(false);
  streams.push(a, b);
  for (const stream of streams) stream.on('error', () => {});
  a.pipe(b).pipe(a);
  await core.get(1, { timeout: 1000 });
  const batch = core.session({ name: 'batch', writable: true });
  await batch.ready();
  view = new Hyperbee(batch, encoding);
  await view.ready();
  assert.equal(batch.signedLength, 2);

  // Replication authenticates the head before Autobase commits its applied batch.
  await original.put('bal/account', '200000');
  const pendingLength = original.core.length;
  await original.put('height', 1);
  await core.get(original.core.length - 1, { timeout: 1000 });
  while (batch.length < original.core.length) await batch.append(await original.core.get(batch.length));
  assert.equal(core.signedLength, 4);
  assert.equal(batch.length, 4);
  assert.equal(await core.commit(batch, { length: pendingLength }), null, 'the newer replicated head overtakes the pending commit');
  assert.equal(batch.signedLength, 2);
  assert.equal((await view.get('bal/account')).value, '200000');
  return { base: { store, view }, original, core, batch, streams };
}

const fundsRead = (base, samples = []) => signedBalanceRead(base, 'bal/account', 'RESET', 1000,
  { onRead: sample => samples.push(sample) }).then(row => ({ RESET: row?.value ?? '0', TNK: '1000000000000000000000', feeTnk: '30000000000000000' }));

test('replicated signed funds remain spendable when the applied batch has not committed', async t => {
  const { base, core, batch } = await replicatedBeforeCommit(t);
  const samples = [];
  const trac = { balances: () => fundsRead(base, samples) };
  const wallets = new WalletManager({ config: { role: 'trader' }, store: { list: () => [] },
    role: { registry: { snapshot() {} } }, trac, addresses: { trac: 'account', solana: 'account' },
    solana: { walletBalances: async () => ({ USDC: '50000000', SOL: '100000000' }) } });
  wallets.checkClock = async () => {};
  await wallets.requireFunds({ role: 'seller', base: { id: 'RESET' }, baseAmount: '50000' });
  const balances = await wallets.balances();
  assert.equal(balances.RESET.free, '200000');
  assert.equal(balances.RESET.committed, '0');
  assert.equal(samples.at(-1).signedLength, core.signedLength);
  assert.equal(batch.signedLength, 2, 'reads do not rewrite the application batch');
});

test('the venue publishes a funded sell even when its applied batch has not committed', async t => {
  const { base } = await replicatedBeforeCommit(t);
  let reading;
  const trac = { balances: () => reading = fundsRead(base) };
  const funds = new MakerFunds({ trac, now: () => 100, fullSells: () => true });
  const offer = { offerId: 'offer', side: 'sell', baseAmount: '50000', price: '2000', maker: { tracAddr: 'account' } };
  const pair = { base: { id: 'RESET' }, minBaseAmount: '1' };
  funds.refresh([offer]); await reading; await turn();
  assert.equal(funds.allocate([{ offer, pair, firstSeen: 100 }]).get(offer.offerId), '50000');
});

test('RESET transfer verification reads the signed result despite a stale batch and divergent unsigned result', async t => {
  const { base, original, core, batch } = await replicatedBeforeCommit(t);
  const secret = ed25519.utils.randomSecretKey(), from = Buffer.from(ed25519.getPublicKey(secret)).toString('hex');
  const config = { addressPrefix: 'trac', bootstrap: Buffer.alloc(32, 4) };
  base.key = Buffer.alloc(32, 0x33);
  const built = await buildResetTransfer({ networkId: 918, txv: '11'.repeat(32), tradeId: 'ab'.repeat(32),
    from, to: '02'.repeat(32), amount: '42', writer: '22'.repeat(32), subnet: base.key.toString('hex'), msb: config.bootstrap.toString('hex'),
    sign: h => Buffer.from(ed25519.sign(h, secret)).toString('hex') });
  const tx = built.payload.txo;
  const row = { tx: tx.tx, ipk: from, wp: '22'.repeat(32), val: built.submission.prepared_command, err: null };
  await original.put(`tx/${tx.tx}`, 0); await original.put('txi/0', row);
  await core.get(original.core.length - 1, { timeout: 1000 });
  while (batch.length < original.core.length) await batch.append(await original.core.get(batch.length));
  await base.view.put('txi/0', { ...row, err: 'balance' });
  const msb = { config, state: { getSigned: async () => safeEncodeApplyOperation(normalizeTransactionOperation(built.payload, config)) } };
  const verify = createTransferVerifier({ msb, resetPeer: { base }, resetBootstrap: base.key.toString('hex'), exactAmount: true });
  assert.deepEqual(await verify({ asset: 'RESET', txHash: tx.tx, from, to: '02'.repeat(32), minAmount: '42', nonce: tx.in }),
    { ok: true, reason: null, amount: '42', final: true });
  assert.equal(batch.signedLength, 2);
});

test('signed snapshots exclude divergent unsigned balances and keep their captured head', async t => {
  const { base, original, core } = await replicatedBeforeCommit(t);
  await base.view.put('bal/account', '900000000');
  const sessions = core.sessions.length;
  const { view, length } = await signedCheckout(base, 'RESET');
  try {
    assert.equal(length, 4);
    assert.equal((await view.get('bal/account')).value, '200000');
    await original.put('bal/account', '150000');
    await core.get(original.core.length - 1, { timeout: 1000 });
    assert.equal((await view.get('bal/account')).value, '200000');
    assert.equal((await signedBalanceRead(base, 'bal/account', 'RESET', 1000)).value, '150000');
  } finally { await view.close(); }
  await turn();
  assert.equal(core.sessions.length, sessions);
});

test('missing signed blocks fail within the deadline even when the applied batch has the balance', async t => {
  const { base, core, streams } = await replicatedBeforeCommit(t);
  for (const stream of streams) stream.destroy();
  await turn(); await turn();
  await core.clear(2, core.length);
  assert.equal((await base.view.get('bal/account')).value, '200000');
  const sessions = core.sessions.length;
  await assert.rejects(signedBalanceRead(base, 'bal/account', 'RESET', 20), /RESET balance unavailable: read timed out/);
  await turn(); await turn();
  assert.equal(core.sessions.length, sessions);
});

test('repeated named signed reads release Corestore sessions on success and timeout', async t => {
  const { base, core, streams } = await replicatedBeforeCommit(t);
  const retained = () => ({ cores: base.store.cores.size, sessions: base.store.sessions.list().length,
    coreSessions: core.sessions.length,
    appendListeners: core.listenerCount('append'), truncateListeners: core.listenerCount('truncate') });
  const initial = retained();
  for (let i = 0; i < 1000; i++) {
    assert.equal((await signedBalanceRead(base, 'bal/account', 'RESET', 1000)).value, '200000');
    assert.deepEqual(retained(), initial);
  }
  t.diagnostic(JSON.stringify({ successfulReads: 1000, initial, after: retained() }));
  for (const stream of streams) stream.destroy();
  await turn(); await turn();
  await core.clear(2, core.length);
  for (let i = 0; i < 32; i++) {
    await assert.rejects(signedBalanceRead(base, 'bal/account', 'RESET', 10),
      error => ['BALANCE_READ_TIMEOUT', 'REQUEST_TIMEOUT'].includes(error.code));
    await turn(); await turn();
    assert.deepEqual(retained(), initial);
  }
  t.diagnostic(JSON.stringify({ timedOutReads: 32, initial, after: retained() }));
});
