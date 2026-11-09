import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHandlers } from '../../../peer/src/trac/handlers.js';
import { openResetReader } from '../../../peer/src/trac/reset-reader.js';
import PeerWallet from '../../../peer/node_modules/trac-wallet/index.js';
import nodeEntry from '../../../peer/node_modules/trac-msb/src/core/state/utils/nodeEntry.js';
import { HYPERCORE_STALLFIX_MARKER } from '../../../peer/node_modules/trac-msb/src/utils/hypercoreStallfix.js';
import { SignerReaderHealth } from '../../../src/stake/reader-health.js';

function fixture() {
  return { config: { addressPrefix: 'trac', bootstrap: Buffer.alloc(32, 1), networkId: 918 },
    state: { getSigned: async () => null, getIndexerSequenceState: async () => Buffer.alloc(32, 2),
      getFee: () => Buffer.from('0000000000000000006a94d74f430000', 'hex') },
    broadcastTransaction: async payload => ({ tx: payload.tro.tx }) };
}

test('bridge handlers return local MSB context and only a broadcast hash', async () => {
  const bus = fixture();
  const handlers = makeHandlers({ bus, peer: {}, config: {} });
  assert.deepEqual(Object.keys(handlers).sort(), ['dex_balances', 'dex_msb_info', 'dex_reader_health', 'dex_reset_context', 'dex_stake_delivery', 'dex_stake_position', 'dex_tnk_broadcast', 'dex_verify']);
  assert.deepEqual(await handlers.dex_msb_info(), { networkId: 918, txv: '02'.repeat(32), addressPrefix: 'trac', msbBootstrap: '01'.repeat(32), feeTnk: '30000000000000000' });
  assert.deepEqual(await handlers.dex_tnk_broadcast({ payload: { type: 13, tro: { tx: '03'.repeat(32) } } }), { txHash: '03'.repeat(32) });
  await assert.rejects(handlers.dex_tnk_broadcast({}));
  await assert.rejects(handlers.dex_reset_context(), /not configured/);
  assert.equal((await handlers.dex_verify({})).ok, false);
  bus.state.getIndexerSequenceState = async () => { throw new Error('offline'); };
  await assert.rejects(handlers.dex_msb_info(), /offline/);
  assert.throws(() => makeHandlers({ bus: {} }));
});

test('RESET context uses only the pinned local reader', async () => {
  const bus = fixture();
  const resetPeer = { base: { key: Buffer.alloc(32, 3), view: { checkout() {} } } };
  const config = { trac: { reset: { bootstrap: '03'.repeat(32) } } };
  const handlers = makeHandlers({ bus, resetPeer, config });
  assert.deepEqual(await handlers.dex_reset_context(), { networkId: 918, txv: '02'.repeat(32), addressPrefix: 'trac', subnet: '03'.repeat(32), msb: '01'.repeat(32) });
  assert.throws(() => makeHandlers({ bus, resetPeer, config: { trac: { reset: { bootstrap: '04'.repeat(32) } } } }));
});

test('reader health warns about an unpatched loaded Hypercore even while its signed view advances', async () => {
  class PatchedReplicator { static STALLFIX = HYPERCORE_STALLFIX_MARKER; }
  class OriginalReplicator {}
  const systemCore = Replicator => ({ core: { replicator: new Replicator() } });
  const bus = fixture();
  bus.state.base = { core: systemCore(PatchedReplicator), view: { core: { signedLength: 8 } } };
  const resetPeer = { base: { key: Buffer.alloc(32, 3), core: systemCore(OriginalReplicator),
    view: { core: { signedLength: 12 }, checkout() {} } } };
  const handlers = makeHandlers({ bus, resetPeer, config: { trac: { reset: { bootstrap: '03'.repeat(32) } } } });
  const poller = new SignerReaderHealth({ bridge: { call: async method => handlers[method]() } });
  await poller.poll();
  const warning = poller.status();
  assert.equal(warning.status, 'degraded');
  assert.match(warning.message, /WARNING: RESET Hypercore replication stall fix is not active/);
  assert.match(warning.message, /npm run postinstall --prefix peer/);
  assert.equal(warning.readers.MSB.hypercoreStallfix.patched, true);
  assert.equal(warning.readers.RESET.hypercoreStallfix.patched, false);
  assert.equal(warning.readers.RESET.hypercoreStallfix.marker, null);
  resetPeer.base.view.core.signedLength++;
  await poller.poll();
  assert.equal(poller.status().readers.RESET.status, 'advancing');
  assert.equal(poller.status().status, 'degraded', 'progress alone does not clear a missing patch');
  resetPeer.base.core = systemCore(PatchedReplicator);
  await poller.poll();
  assert.equal(poller.status().status, 'online');
  assert.equal(poller.status().message, '');
  assert.equal(resetPeer.base.view.core.signedLength, 13, 'health does not mutate the reader');
});

test('a RESET reader still opening answers not ready, TNK checks work at once, and a wrong reader is refused when it opens', async () => {
  const bus = fixture(), config = { trac: { reset: { bootstrap: '03'.repeat(32) } } };
  let open, fail;
  const handlers = makeHandlers({ bus, config, resetPeer: new Promise((resolve, reject) => { open = resolve; fail = reject; }) });
  await assert.rejects(handlers.dex_reset_context(), /not ready/);
  await assert.rejects(handlers.dex_balances({ address: PeerWallet.encodeBech32m('trac', Buffer.alloc(32, 7)) }), /not ready/);
  const hash = 'aa'.repeat(32), request = { asset: 'RESET', txHash: hash, from: 'bb'.repeat(32), to: 'cc'.repeat(32), minAmount: '1', nonce: hash };
  bus.state.getSigned = async () => null;
  assert.equal((await handlers.dex_verify(request)).final, false);
  open({ base: { key: Buffer.alloc(32, 3), view: { checkout() {} } } }); await new Promise(r => setImmediate(r));
  assert.equal((await handlers.dex_reset_context()).subnet, '03'.repeat(32));
  const wrong = makeHandlers({ bus, config, resetPeer: Promise.resolve({ base: { key: Buffer.alloc(32, 4), view: { checkout() {} } } }) });
  await new Promise(r => setImmediate(r));
  await assert.rejects(wrong.dex_reset_context(), /RESET reader failed/);
  const failed = makeHandlers({ bus, config, resetPeer: new Promise((resolve, reject) => { fail = reject; }) });
  fail(new Error('disk')); await new Promise(r => setImmediate(r));
  await assert.rejects(failed.dex_reset_context(), /RESET reader failed: disk/);
});

test('balances read signed MSB and RESET views and reject invalid address checksums', async () => {
  const bus = fixture(), address = PeerWallet.encodeBech32m('trac', Buffer.alloc(32, 7));
  let closed = 0, balanceKey;
  bus.state.base = { view: { core: { signedLength: 8 }, checkout(length) {
    assert.equal(length, 8);
    return { get: async (actual, options) => {
      assert.equal(actual, address); assert.equal(options.timeout, 5000); assert.equal(options.update, false);
      return { value: nodeEntry.init(Buffer.alloc(32), 0, Buffer.from('0000000000000000006a94d74f430000', 'hex')) };
    }, close: async () => {} };
  } } };
  const resetPeer = { base: { key: Buffer.alloc(32, 3), view: { core: { signedLength: 12 }, checkout(length) {
    assert.equal(length, 12); return { get: async key => { balanceKey = key; return { value: '123' }; }, close: async () => { closed++; } };
  } } } };
  const handlers = makeHandlers({ bus, resetPeer, config: { trac: { reset: { bootstrap: '03'.repeat(32) } } } });
  assert.deepEqual(await handlers.dex_balances({ address }), { TNK: '30000000000000000', RESET: '123', feeTnk: '30000000000000000' });
  assert.equal(balanceKey, 'bal/' + '07'.repeat(32)); assert.equal(closed, 1);
  await assert.rejects(handlers.dex_balances({ address: 'trac1bad' }), /Invalid/);
  await assert.rejects(makeHandlers({ bus, config: {} }).dex_balances({ address }), /not configured/);
});

test('RESET reader validates its optional configuration before opening stores', async () => {
  assert.equal(await openResetReader({ config: {} }), null);
  for (const trac of [null, {}, { reset: {} }, { reset: [], extra: true }, { reset: { bootstrap: 'ff'.repeat(32) } }]) await assert.rejects(openResetReader({ config: { trac } }), /configuration/);
  const reset = { bootstrap: 'ff'.repeat(32), channel: 'local-test', dhtBootstrap: ['127.0.0.1:49999'],
    source: { commit: 'ff'.repeat(20), manifestSha256: 'ff'.repeat(32) } };
  await assert.rejects(openResetReader({ config: { environment: 'mainnet', trac: { reset: { ...reset, beaconOptions: {} } } } }), /development/);
  await assert.rejects(openResetReader({ config: { environment: 'development', trac: { reset } } }), /SOURCE.json differs/);
});
