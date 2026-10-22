import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHandlers } from '../../../peer/src/trac/handlers.js';
import { openResetReader } from '../../../peer/src/trac/reset-reader.js';
import PeerWallet from '../../../peer/node_modules/trac-wallet/index.js';

function fixture() {
  return { config: { addressPrefix: 'trac', bootstrap: Buffer.alloc(32, 1), networkId: 918 },
    state: { getSigned: async () => null, getIndexerSequenceState: async () => Buffer.alloc(32, 2),
      getFee: () => Buffer.from('0000000000000000006a94d74f430000', 'hex') },
    broadcastTransaction: async payload => ({ tx: payload.tro.tx }) };
}

test('bridge handlers return local MSB context and only a broadcast hash', async () => {
  const bus = fixture();
  const handlers = makeHandlers({ bus, peer: {}, config: {} });
  assert.deepEqual(Object.keys(handlers).sort(), ['dex_balances', 'dex_msb_info', 'dex_reset_context', 'dex_tnk_broadcast', 'dex_verify']);
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
  bus.state.getNodeEntry = async actual => { assert.equal(actual, address); return { balance: Buffer.from('0000000000000000006a94d74f430000', 'hex') }; };
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
