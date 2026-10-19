import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import PeerWallet from '../../../peer/node_modules/trac-wallet/index.js';
import { safeEncodeApplyOperation } from '../../../peer/node_modules/trac-msb/src/utils/protobuf/operationHelpers.js';
import { normalizeTransferOperation, normalizeTransactionOperation } from '../../../peer/node_modules/trac-msb/src/utils/normalizers.js';
import { buildTnkTransfer, buildResetTransfer } from '../../../src/trac/transfers.js';
import { createTransferVerifier } from '../../../peer/src/trac/verify-transfer.js';

async function fixture(asset = 'TNK') {
  const secret = ed25519.utils.randomSecretKey();
  const fromKey = Buffer.from(ed25519.getPublicKey(secret)).toString('hex');
  const toKey = '02'.repeat(32);
  const config = { addressPrefix: 'trac', bootstrap: Buffer.alloc(32, 4) };
  const from = asset === 'TNK' ? PeerWallet.encodeBech32m('trac', Buffer.from(fromKey, 'hex')) : fromKey;
  const to = asset === 'TNK' ? PeerWallet.encodeBech32m('trac', Buffer.from(toKey, 'hex')) : toKey;
  const input = { networkId: 918, txv: '11'.repeat(32), tradeId: 'ab'.repeat(32), from, to, amount: '42', sign: h => Buffer.from(ed25519.sign(h, secret)).toString('hex') };
  const built = asset === 'TNK' ? await buildTnkTransfer(input) : await buildResetTransfer({ ...input, writer: '22'.repeat(32), subnet: '33'.repeat(32), msb: config.bootstrap.toString('hex') });
  const payload = asset === 'TNK' ? built : built.payload;
  const op = asset === 'TNK' ? normalizeTransferOperation(payload, config) : normalizeTransactionOperation(payload, config);
  const data = asset === 'TNK' ? payload.tro : payload.txo;
  const signed = new Map([[data.tx, safeEncodeApplyOperation(op)]]);
  const msb = { config, state: { getSigned: async k => signed.get(k) ?? null, get() { throw Error('UNSIGNED READ'); } } };
  const rows = new Map();
  if (asset === 'RESET') {
    rows.set(`tx/${data.tx}`, 0);
    rows.set('txi/0', { tx: data.tx, ipk: from, wp: '55'.repeat(32), val: built.submission.prepared_command, err: null });
  }
  let closes = 0;
  const resetPeer = { base: { key: Buffer.alloc(32, 0x33), view: { core: { signedLength: 9 }, checkout(length) {
    assert.equal(length, 9);
    const snapshot = new Map(rows);
    return { get: async key => snapshot.has(key) ? { value: snapshot.get(key) } : null, close: async () => { closes++; } };
  }, get() { throw Error('UNSIGNED READ'); } } } };
  const options = { msb, resetPeer, resetBootstrap: '33'.repeat(32) };
  return { options, verify: createTransferVerifier(options), op, signed, rows, request: { asset, txHash: data.tx, from, to, minAmount: '42', nonce: data.in }, closes: () => closes };
}

test('constructor pins the RESET bootstrap and requires local MSB state', async () => {
  assert.throws(() => createTransferVerifier({}));
  const { options } = await fixture('RESET');
  assert.throws(() => createTransferVerifier({ ...options, resetBootstrap: '00'.repeat(32) }), /bootstrap/);
});

test('TNK verifies only signed data and compares base-unit amounts without rounding', async () => {
  const f = await fixture();
  assert.deepEqual(await f.verify(f.request), { ok: true, reason: null, amount: '42', final: true });
  assert.equal((await f.verify({ ...f.request, minAmount: '41' })).ok, true);
  for (const [field, value, reason] of [['from', f.request.to, 'wrong_from'], ['to', f.request.from, 'wrong_to'], ['nonce', '00'.repeat(32), 'wrong_nonce'], ['minAmount', '43', 'wrong_amount'], ['asset', 'RESET', 'invalid_request']]) assert.equal((await f.verify({ ...f.request, [field]: value })).reason, reason);
  f.signed.clear();
  assert.deepEqual(await f.verify(f.request), { ok: false, reason: 'unknown_or_not_final', amount: null, final: false });
});

test('malformed requests, protobuf and read errors fail closed', async () => {
  const f = await fixture();
  for (const patch of [{ asset: 'OTHER' }, { minAmount: '0' }, { minAmount: '-1' }, { minAmount: '1.0' }, { txHash: 'bad' }, { nonce: '' }, { from: 'invalid' }]) assert.equal((await f.verify({ ...f.request, ...patch })).ok, false);
  assert.equal((await f.verify()).ok, false);
  f.signed.set(f.request.txHash, Buffer.from([255]));
  assert.equal((await f.verify(f.request)).reason, 'invalid_msb_record');
  f.op.tro.am = Buffer.alloc(1);
  f.signed.set(f.request.txHash, safeEncodeApplyOperation(f.op));
  assert.equal((await f.verify(f.request)).reason, 'invalid_msb_record');
  f.options.msb.state.getSigned = async () => { throw Error('closed'); };
  assert.equal((await f.verify(f.request)).reason, 'read_failed');
});

test('RESET requires signed applied result, matches contents, and closes its snapshot', async () => {
  const f = await fixture('RESET');
  assert.deepEqual(await f.verify(f.request), { ok: true, reason: null, amount: '42', final: true });
  assert.equal(f.closes(), 1);
  for (const [field, value, reason] of [['from', f.request.to, 'wrong_from'], ['to', f.request.from, 'wrong_to'], ['nonce', '00'.repeat(32), 'wrong_nonce'], ['minAmount', '43', 'wrong_amount']]) assert.equal((await f.verify({ ...f.request, [field]: value })).reason, reason);
  f.rows.get('txi/0').err = 'balance';
  assert.deepEqual(await f.verify(f.request), { ok: false, reason: 'contract_rejected', amount: '42', final: true });
  f.rows.clear();
  assert.equal((await f.verify(f.request)).reason, 'reset_not_final');
  assert.equal(f.closes(), 7);
  assert.equal((await createTransferVerifier({ msb: f.options.msb })(f.request)).reason, 'reset_reader_required');
});

test('RESET rejects wrong MSB operation type, contract, hash, sender, or content', async () => {
  for (const [change, expected] of [
    [f => { f.op.type = 13; }, 'wrong_asset'],
    [f => { f.op.txo.bs = Buffer.alloc(32); }, 'wrong_contract'],
    [f => { f.op.txo.mbs = Buffer.alloc(32); }, 'wrong_contract'],
    [f => { f.op.txo.tx = Buffer.alloc(32); }, 'invalid_msb_record'],
    [f => { f.rows.get('txi/0').ipk = '00'.repeat(32); }, 'invalid_reset_record'],
    [f => { f.rows.get('txi/0').tx = '00'.repeat(32); }, 'invalid_reset_record'],
    [f => { delete f.rows.get('txi/0').err; }, 'invalid_reset_record'],
    [f => { f.rows.get('txi/0').val.value.amount = '43'; }, 'wrong_content'],
    [f => { f.rows.get('txi/0').val.value.extra = true; }, 'invalid_reset_record'],
    [f => { f.rows.set(`tx/${f.request.txHash}`, -1); }, 'invalid_reset_record'],
    [f => { f.rows.delete('txi/0'); }, 'invalid_reset_record']
  ]) {
    const f = await fixture('RESET'); change(f);
    f.signed.set(f.request.txHash, safeEncodeApplyOperation(f.op));
    assert.equal((await f.verify(f.request)).reason, expected);
  }
});
