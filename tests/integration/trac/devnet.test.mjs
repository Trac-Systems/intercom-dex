import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetSourceURL } from '../../reset-source.mjs';
import { MainSettlementBus } from '../../../peer/node_modules/trac-msb/src/index.js';
import { Config as MsbConfig } from '../../../peer/node_modules/trac-msb/src/config/config.js';
import { createConfig as msbConfig, ENV as MSB_ENV } from '../../../peer/node_modules/trac-msb/src/config/env.js';
import { Peer, Wallet, createConfig, ENV } from '../../../peer/node_modules/trac-peer/src/index.js';
import PeerWallet from '../../../peer/node_modules/trac-wallet/index.js';
import { startLocalDevnet } from './local-devnet.mjs';
import { buildTnkTransfer, buildResetTransfer } from '../../../src/trac/transfers.js';
import { broadcastTnkTransfer } from '../../../peer/src/trac/broadcast.js';
import { createTransferVerifier } from '../../../peer/src/trac/verify-transfer.js';
import { openUsedTxStore } from '../../../peer/src/trac/used-tx.js';

const { default: CoinProtocol } = await import(resetSourceURL('contract/protocol.js'));
const { default: CoinContract } = await import(resetSourceURL('contract/contract.js'));
const { beaconOptions } = await import(resetSourceURL('tests/helpers/chain.mjs'));

const temporary = fileURLToPath(new URL('../../../.test-tmp/trac/', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 90000) {
  const end = Date.now() + timeout;
  do { const result = await fn(); if (result) return result; await pause(20); } while (Date.now() < end);
  throw Error(`Timed out: ${label}`);
}

test('Pear RESET devnet: independent signed readers, bound TNK/RESET, rejection and replay', { timeout: 600000 }, async t => {
  await fs.mkdir(temporary, { recursive: true, mode: 0o700 });
  const root = await fs.mkdtemp(path.join(temporary, 'integration-'));
  let network, msb, reader, journal;
  try {
    // Same fixture as scripts/devnet.mjs --pear. Its private control pipe lets
    // the operator fund fresh test identities without opening player keystores.
    network = await startLocalDevnet(root);
    const manifest = network.manifest;
    assert.equal(manifest.localTestOnly, true);
    assert.equal(manifest.runtime, 'pear');
    assert.ok(manifest.dhtBootstrap.every(host => /^127\.0\.0\.1:[0-9]+$/.test(host)));
    await fs.writeFile(path.join(root, 'network.json'), JSON.stringify({ msbBootstrap: manifest.msbBootstrap, dhtBootstrap: manifest.dhtBootstrap, resetBootstrap: manifest.indexer.subnetBootstrap }), { mode: 0o600 });
    async function wallet(name, raw = false) {
      const value = raw ? new PeerWallet() : new Wallet();
      await value.ready;
      await value.generateKeyPair();
      const filename = path.join(root, name, 'db/keypair.json');
      await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      value.exportToFile(filename, Buffer.alloc(0));
      await fs.chmod(filename, 0o600);
      return value;
    }
    const sender = await wallet('sender');
    const receiver = await wallet('receiver');
    const busWallet = await wallet('msb-reader', true);
    const config = new MsbConfig({ storeName: 'msb-reader', storesDirectory: path.join(root, 'bus'), bootstrap: manifest.msbBootstrap,
      channel: 'local-foundation-msb', dhtBootstrap: manifest.dhtBootstrap, enableInteractiveMode: false,
      enableWallet: true, enableValidatorObserver: false, enableRoleRequester: false }, msbConfig(MSB_ENV.DEVELOPMENT));
    msb = new MainSettlementBus(config, busWallet);
    await msb.ready();
    await msb.network.tryConnect(network.validator.wallet.publicKey.toString('hex'), 'validator');
    await until(() => msb.state.getAdminEntry(), 'own MSB reader synchronized');
    await until(() => msb.network.validatorConnectionManager.connectionCount() > 0, 'validator connection');
    await network.local.fund(network.validator, { address: sender.address });
    await until(() => msb.state.getNodeEntry(sender.address), 'fresh sender funded');
    await network.gift(sender.publicKey, '1000');
    const readerWallet = await wallet('reset-reader');
    const subnetConfig = createConfig(ENV.DEVELOPMENT, { txContentHash: 'utf8-strict', storeName: 'reset-reader', storesDirectory: root,
      bootstrap: manifest.indexer.subnetBootstrap, channel: 'local-foundation-subnet', dhtBootstrap: manifest.dhtBootstrap,
      replicate: true, enableUpdater: true, enableBackgroundTasks: false, apiTxExposed: false, enableTxlogs: false });
    subnetConfig.beaconOptions = beaconOptions;
    reader = new Peer({ config: subnetConfig, msb, wallet: readerWallet, protocol: CoinProtocol, contract: CoinContract });
    await reader.ready();
    await until(async () => (await reader.protocol.instance.getSigned(`bal/${sender.publicKey}`)) === '1000', 'own signed RESET balance');
    assert.equal(reader.base.writable, false, 'RESET verification peer is not an admitted writer');
    const verify = createTransferVerifier({ msb, resetPeer: reader, resetBootstrap: manifest.indexer.subnetBootstrap });
    journal = openUsedTxStore(path.join(root, 'used-tx'));
    const timings = {};

    await t.test('TNK: bound nonce, pending/final, mismatches, durable replay protection', async () => {
      const tradeId = '11'.repeat(32);
      const payload = await buildTnkTransfer({ networkId: config.networkId, txv: (await msb.state.getIndexerSequenceState()).toString('hex'),
        from: sender.address, to: receiver.address, amount: '1000000000000000000', tradeId, sign: bytes => sender.sign(bytes) });
      const request = { asset: 'TNK', txHash: payload.tro.tx, from: sender.address, to: receiver.address, minAmount: '1000000000000000000', nonce: payload.tro.in };
      assert.deepEqual(await verify(request), { ok: false, reason: 'unknown_or_not_final', amount: null, final: false });
      const before = await msb.getBalance(sender.address);
      const started = Date.now();
      const receipt = await broadcastTnkTransfer(msb, payload);
      assert.equal(receipt.final, false);
      await until(async () => (await verify(request)).ok, 'TNK signed finality');
      timings.tnkFinalMs = Date.now() - started;
      assert.ok(await msb.state.getTransactionConfirmedLength(request.txHash));
      const after = await msb.getBalance(sender.address);
      assert.equal(BigInt(before.balance) - BigInt(after.balance), 1030000000000000000n, '1 TNK plus 0.03 TNK fee');
      for (const [field, value, reason] of [['minAmount', '1000000000000000001', 'wrong_amount'], ['to', sender.address, 'wrong_to'], ['from', receiver.address, 'wrong_from'], ['nonce', '00'.repeat(32), 'wrong_nonce']]) assert.equal((await verify({ ...request, [field]: value })).reason, reason);
      assert.equal(journal.claim(request.txHash, tradeId).ok, true);
      journal.close(); journal = openUsedTxStore(path.join(root, 'used-tx'));
      assert.deepEqual(journal.claim(request.txHash, '22'.repeat(32)), { ok: false, reason: 'tx_already_used' });
    });

    async function resetTransfer(amount, tradeId) {
      const gateway = manifest.gateways[0];
      const origin = new URL(gateway.gatewayUrl);
      assert.equal(origin.hostname, '127.0.0.1');
      const built = await buildResetTransfer({ networkId: config.networkId, txv: (await msb.state.getIndexerSequenceState()).toString('hex'),
        writer: gateway.writerKey, subnet: manifest.indexer.subnetBootstrap, msb: manifest.msbBootstrap,
        from: sender.publicKey, to: receiver.publicKey, amount, tradeId, sign: bytes => sender.sign(bytes) });
      const request = { asset: 'RESET', txHash: built.payload.txo.tx, from: sender.publicKey, to: receiver.publicKey, minAmount: amount, nonce: built.payload.txo.in };
      assert.equal((await verify(request)).final, false);
      const started = Date.now();
      const response = await fetch(new URL('/v1/tx/submit', origin), { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(built.submission), redirect: 'error', signal: AbortSignal.timeout(30000) });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).ok, true);
      await until(() => msb.state.getSigned(request.txHash), 'RESET MSB signed inclusion');
      const msbMs = Date.now() - started;
      const result = await until(async () => { const r = await verify(request); return r.final ? r : null; }, 'RESET signed contract result');
      return { request, result, msbMs, finalMs: Date.now() - started };
    }

    await t.test('RESET: transfer accepted by MSB and applied by signed contract', async () => {
      const { request, result, msbMs, finalMs } = await resetTransfer('7', '33'.repeat(32));
      timings.resetMsbMs = msbMs; timings.resetFinalMs = finalMs;
      assert.deepEqual(result, { ok: true, reason: null, amount: '7', final: true });
      for (const [field, value, reason] of [['minAmount', '8', 'wrong_amount'], ['to', sender.publicKey, 'wrong_to'], ['nonce', '00'.repeat(32), 'wrong_nonce']]) assert.equal((await verify({ ...request, [field]: value })).reason, reason);
      assert.equal(await reader.protocol.instance.getSigned(`bal/${receiver.publicKey}`), '7');
    });

    await t.test('RESET: MSB accepts an overspend, signed contract rejects it', async () => {
      const { request, result, finalMs } = await resetTransfer('1001', '44'.repeat(32));
      timings.resetRejectedFinalMs = finalMs;
      assert.ok(await msb.state.getSigned(request.txHash));
      assert.deepEqual(result, { ok: false, reason: 'contract_rejected', amount: '1001', final: true });
      assert.equal(await reader.protocol.instance.getSigned(`bal/${receiver.publicKey}`), '7');
      assert.equal(await reader.protocol.instance.getSigned(`bal/${sender.publicKey}`), '993');
    });
    await fs.writeFile(path.join(root, 'timings.json'), JSON.stringify(timings, null, 2) + '\n');
    t.diagnostic(JSON.stringify({ timings, artifacts: root }));
  } finally {
    journal?.close();
    if (reader) { await reader.close(); await reader.store.close(); }
    if (msb) await msb.close();
    if (network) await network.close();
  }
});
