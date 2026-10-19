import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash as sha } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import PeerWallet from '../../../peer/node_modules/trac-wallet/index.js';
import { createMessage } from '../../../peer/node_modules/trac-msb/src/utils/buffer.js';
import { bigIntTo16ByteBuffer } from '../../../peer/node_modules/trac-msb/src/utils/amountSerialization.js';
import { createHash } from '../../../peer/node_modules/trac-peer/src/utils/types.js';
import { transferNonce, buildTnkTransfer, buildResetTransfer } from '../../../src/trac/transfers.js';
import { broadcastTnkTransfer, broadcastResetTransfer } from '../../../peer/src/trac/broadcast.js';

const tradeId = 'ab'.repeat(32);
const secret = ed25519.utils.randomSecretKey();
const publicKey = ed25519.getPublicKey(secret);
const from = PeerWallet.encodeBech32m('trac', Buffer.from(publicKey));
const toKey = '02'.repeat(32);
const to = PeerWallet.encodeBech32m('trac', Buffer.from(toKey, 'hex'));
const sign = bytes => Buffer.from(ed25519.sign(bytes, secret)).toString('hex');
const common = { networkId: 918, txv: '11'.repeat(32), tradeId, sign };
const tnk = { ...common, from, to, amount: '12345678901234567890' };
const reset = { ...common, from: Buffer.from(publicKey).toString('hex'), to: toKey, amount: '123456789', writer: '22'.repeat(32), subnet: '33'.repeat(32), msb: '44'.repeat(32) };

test('nonce hashes domain UTF-8 plus raw 32-byte trade ID', () => {
  const expected = sha('sha256').update(Buffer.concat([Buffer.from('intercom-dex/v1/transfer'), Buffer.from(tradeId, 'hex')])).digest('hex');
  assert.equal(transferNonce(tradeId), expected);
  assert.equal(expected, '687ee1eb766152173ce6391977aa8f525e4926b1063f30956bb7051e951590e0');
  assert.notEqual(expected, sha('sha256').update('intercom-dex/v1/transfer' + tradeId).digest('hex'));
  for (const bad of ['', 'x'.repeat(64), 'AB'.repeat(32), 'ab', undefined, Buffer.alloc(32)]) assert.throws(() => transferNonce(bad), /tradeId/);
});

test('TNK wire hash agrees with trac-msb createMessage and uint128 serialization', async () => {
  const payload = await buildTnkTransfer(tnk);
  const msg = createMessage(918, Buffer.from(common.txv, 'hex'), Buffer.from(to, 'ascii'), bigIntTo16ByteBuffer(BigInt(tnk.amount)), Buffer.from(transferNonce(tradeId), 'hex'), 13);
  assert.equal(payload.tro.tx, await createHash(msg));
  assert.equal(payload.tro.tx, '24e1b5d578732641a0ac3b128e6049e6390cb3c95a7cf07ecf4aef407588e79d');
  assert.equal(payload.tro.am, '0000000000000000ab54a98ceb1f0ad2');
  assert.equal(payload.tro.in, transferNonce(tradeId));
  assert.equal(payload.address, from);
  assert.ok(ed25519.verify(Buffer.from(payload.tro.is, 'hex'), Buffer.from(payload.tro.tx, 'hex'), publicKey));
  assert.equal((await buildTnkTransfer({ ...tnk, amount: ((1n << 128n) - 1n).toString() })).tro.am, 'ff'.repeat(16));
});

test('TNK rejects invalid units, addresses, context and signer', async () => {
  for (const amount of ['0', '-1', '01', '1.0', 1, (1n << 128n).toString(), '9'.repeat(79)]) await assert.rejects(buildTnkTransfer({ ...tnk, amount }));
  for (const patch of [{ networkId: 0 }, { networkId: '918' }, { networkId: 2 ** 32 }, { networkId: 1.5 }, { txv: '00' }, { from: toKey }, { to: toKey }, { addressPrefix: 'other' }, { sign: null }, { sign: () => '00'.repeat(64) }, { sign: () => { throw Error('offline'); } }]) await assert.rejects(buildTnkTransfer({ ...tnk, ...patch }));
});

test('RESET dispatch and TX hash agree with trac-peer and MSB message layout', async () => {
  const { payload, submission } = await buildResetTransfer(reset);
  const ch = await createHash(JSON.stringify({ type: 'transfer', value: { to: reset.to, amount: reset.amount } }));
  const msg = createMessage(918, Buffer.from(reset.txv, 'hex'), Buffer.from(reset.writer, 'hex'), Buffer.from(ch, 'hex'), Buffer.from(reset.subnet, 'hex'), Buffer.from(reset.msb, 'hex'), Buffer.from(transferNonce(tradeId), 'hex'), 12);
  assert.equal(payload.txo.ch, ch);
  assert.equal(payload.txo.tx, await createHash(msg));
  assert.equal(payload.txo.tx, '4f5a43c8b399b9fae7e02aa15577477df23997b36b4a772cc4ad33736f2f84da');
  assert.equal(payload.txo.in, transferNonce(tradeId));
  assert.equal(submission.tx, payload.txo.tx);
  assert.equal(submission.address, reset.from);
  assert.equal(submission.signature, payload.txo.is);
  assert.equal(payload.address, from);
  assert.equal((await buildResetTransfer({ ...reset, amount: '9'.repeat(78) })).submission.prepared_command.value.amount.length, 78);
});

test('RESET rejects invalid transfer fields and wrong signing identity', async () => {
  for (const patch of [{ amount: '0' }, { amount: '1.1' }, { amount: '9'.repeat(79) }, { to }, { from }, { writer: '' }, { subnet: '' }, { msb: '' }, { networkId: 0 }, { txv: '' }, { sign: () => 'ff'.repeat(64) }, { addressPrefix: '' }]) await assert.rejects(buildResetTransfer({ ...reset, ...patch }));
});

test('broadcast helpers propagate errors and never call an unsigned receipt final', async () => {
  const payload = await buildTnkTransfer(tnk);
  assert.deepEqual(await broadcastTnkTransfer({ broadcastTransaction: async p => { assert.deepEqual(p, payload); return { tx: p.tro.tx }; } }, payload), { txHash: payload.tro.tx, final: false });
  await assert.rejects(broadcastTnkTransfer({}, payload));
  await assert.rejects(broadcastTnkTransfer({ broadcastTransaction() {} }, { type: 12 }));
  await assert.rejects(broadcastTnkTransfer({ broadcastTransaction: async () => ({}) }, { type: 13, tro: {} }));
  await assert.rejects(broadcastTnkTransfer({ broadcastTransaction: async () => false }, payload));
  await assert.rejects(broadcastTnkTransfer({ broadcastTransaction: async () => { throw Error('offline'); } }, payload), /offline/);
  const { submission } = await buildResetTransfer(reset);
  const peer = { protocol: { instance: { api: { tx: async (...args) => {
    assert.deepEqual(args, [submission.tx, submission.prepared_command, submission.address, submission.signature, submission.nonce]);
    return { txo: { tx: submission.tx } };
  } } } } };
  assert.deepEqual(await broadcastResetTransfer(peer, submission), { txHash: submission.tx, final: false });
  await assert.rejects(broadcastResetTransfer({}, submission));
  await assert.rejects(broadcastResetTransfer(peer, {}));
  peer.protocol.instance.api.tx = async () => false;
  await assert.rejects(broadcastResetTransfer(peer, submission));
  peer.protocol.instance.api.tx = async () => { throw Error('rejected'); };
  await assert.rejects(broadcastResetTransfer(peer, submission), /rejected/);
});
