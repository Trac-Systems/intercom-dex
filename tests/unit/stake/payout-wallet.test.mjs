import test from 'node:test';
import assert from 'node:assert/strict';
import { blake3 } from '@noble/hashes/blake3.js';
import { createPayoutWallet } from '../../../src/stake/payout-wallet.js';
import { scalarSigner } from '../../../src/locks/crypto/scalar-sign.js';
import { address } from '../../../src/locks/trac-lock.js';
import { memoryStore } from './helpers.mjs';
const h = n => n.toString(16).padStart(64, '0');
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
test('ordinary payout wallet prepares without sending, binds its journal, checks gateway and reconciles exact finality', async () => {
  const signer = scalarSigner(7n), wallet = { ...signer, address: address(signer.publicKey) }, toKey = scalarSigner(8n).publicKey, to = address(toKey), store = memoryStore();
  const context = { networkId: 1, addressPrefix: 'trac', txv: h(10), subnet: h(11), msb: h(12) };
  let submitted = 0, prepared = 0, final = false, amount = '123', healthy = true, fee = '3';
  const bridge = { call: async method => {
    if (method === 'dex_reset_context') return context;
    assert.equal(method, 'dex_verify'); return { ok: final, final, amount };
  } };
  const request = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.pathname === '/v1/tx/submit') { submitted++; return Response.json({ ok: true, result: { txo: { tx: body.tx } } }); }
    assert.equal(url.pathname, '/v1/tx/prepare'); prepared++;
    const command = { type: 'transfer', value: { to: toKey, amount: '123' } }, ch = Buffer.from(blake3(Buffer.from(JSON.stringify(command)))).toString('hex');
    const tx = Buffer.from(blake3(Buffer.concat([u32(1), ...[context.txv, h(13), ch, context.subnet, context.msb, body.nonce].map(s => Buffer.from(s, 'hex')), u32(12)]))).toString('hex');
    return Response.json({ ...body, prepared_command: command, tx,
      context: { network_id: 1, txv: context.txv, writer: h(13), subnet: context.subnet, msb: context.msb, content_hash: ch } });
  };
  const args = { operationId: h(20), nonce: h(20), asset: 'RESET', amount: '123', to };
  const make = () => createPayoutWallet({ bridge, wallet, store, request, resetGatewayUrl: 'http://127.0.0.1:40000',
    profile: { peer: { msbNetworkId: 1, msbBootstrap: context.msb, trac: { reset: { bootstrap: context.subnet } } } },
    trac: { balances: async () => ({ RESET: '123', TNK: '9', feeTnk: fee }), gatewayHealth: async () => ({ ok: healthy }) } });
  const adapter = make(), transfer = await adapter.prepare(args);
  assert.equal(submitted, 0); assert.equal(transfer.feeTnk, '3');
  fee = '4'; assert.deepEqual(await make().prepare(args), transfer); assert.equal(prepared, 1);
  await assert.rejects(adapter.prepare({ ...args, asset: 'TNK' }), /Invalid payout/);
  await assert.rejects(adapter.sendPrepared({ ...transfer, amount: '124' }), /bytes differ/);
  healthy = false; await assert.rejects(adapter.sendPrepared(transfer), /paused/); assert.equal(submitted, 0);
  healthy = true; await adapter.sendPrepared(transfer); assert.equal(submitted, 1);
  assert.equal((await adapter.outcome(transfer)).confirmed, false);
  final = true; amount = '124'; assert.equal((await adapter.outcome(transfer)).confirmed, false);
  amount = '123'; assert.equal((await make().outcome(transfer)).confirmed, true);
  assert.equal((await adapter.pool()).confirmed, true);
  const altered = { ...JSON.parse(transfer.bytes), payload: {} };
  await assert.rejects(adapter.sendPrepared({ ...transfer, bytes: JSON.stringify(altered) }), /journal mismatch/);
});
