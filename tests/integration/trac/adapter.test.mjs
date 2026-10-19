import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { BASES, SOL } from '../../unit/core/helpers.mjs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resetSourceURL } from '../../reset-source.mjs';
import { startLocalDevnet } from './local-devnet.mjs';
import { Bridge } from '../../../src/net/bridge.js';
import { createWallet } from '../../../src/trac/wallet.js';
import { createTracAdapter } from '../../../src/trac/adapter.js';
import { transferNonce } from '../../../src/trac/transfers.js';

const { beaconOptions } = await import(resetSourceURL('tests/helpers/chain.mjs'));

const area = fileURLToPath(new URL('../../../.test-tmp/trac/adapter/', import.meta.url));
const peerDirectory = fileURLToPath(new URL('../../../peer/', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => Math.floor(Date.now() / 1000);
const id = () => randomBytes(32).toString('hex');

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startPeer(configFile, root) {
  // This is the exact Node runner executed by `cd peer && npm start -- --config ...`.
  const child = spawn(process.execPath, ['scripts/pear-runner.mjs', '--config', configFile], {
    cwd: peerDirectory, env: { ...process.env, PEAR_RUNNER_STDIN: '0', DEX_LEGACY_PEAR_RUN: '0',
      XDG_CONFIG_HOME: path.join(root, 'pear-config'), XDG_DATA_HOME: path.join(root, 'pear-data') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '', pending = '', finished = false;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    finished = true; rejectReady(new Error(`Dex peer exited (${code ?? signal}); see peer.log`)); resolve({ code, signal });
  }));
  child.once('error', rejectReady);
  child.stdout.on('data', chunk => {
    log += chunk; pending += chunk;
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      if (line.startsWith('DEX_PEER_READY ')) {
        try { resolveReady(JSON.parse(line.slice(15))); } catch (error) { rejectReady(error); }
      }
    }
  });
  child.stderr.on('data', chunk => { log += chunk; });
  const close = async () => {
    if (!finished) child.kill('SIGTERM');
    const timer = setTimeout(() => { if (!finished) child.kill('SIGKILL'); }, 85000);
    try { await exited; } finally { clearTimeout(timer); await fs.writeFile(path.join(root, 'peer.log'), log, { mode: 0o600 }); }
  };
  const timeout = setTimeout(() => rejectReady(new Error('Dex peer startup timed out; see peer.log')), 120000);
  try { return { info: await ready, close }; }
  catch (error) { await close(); throw error; }
  finally { clearTimeout(timeout); }
}

test('Pear dex bridge and Trac adapter on the local RESET devnet', { timeout: 600000 }, async t => {
  await fs.mkdir(area, { recursive: true, mode: 0o700 });
  const root = await fs.mkdtemp(path.join(area, 'adapter-'));
  const realFetch = globalThis.fetch;
  let network, child, bridge, sender, receiver, trader, signer;
  try {
    await assert.rejects(startLocalDevnet('relative'), /fresh Trac test folder/);
    await availablePort(); // Fail before starting fixture processes when loopback sockets are unavailable.
    network = await startLocalDevnet(root);
    const manifest = network.manifest;
    assert.ok(manifest.localTestOnly && manifest.dhtBootstrap.every(node => node.startsWith('127.0.0.1:')));
    sender = await createWallet(path.join(root, 'sender.json'), randomBytes(24).toString('hex'));
    receiver = await createWallet(path.join(root, 'receiver.json'), randomBytes(24).toString('hex'));
    for (const wallet of [sender, receiver]) {
      await network.local.fund(network.validator, { address: wallet.address });
      await network.gift(wallet.publicKey, '1000');
    }
    const token = randomBytes(32).toString('hex'), tokenFile = path.join(root, 'bridge-token');
    await fs.writeFile(tokenFile, token, { mode: 0o600 });
    const config = {
      role: 'trader', servicePeerKey: randomBytes(32).toString('hex'),
      network: 'local', platformCollector: SOL, msbNetworkId: network.validator.config.networkId, environment: 'development', msbBootstrap: manifest.msbBootstrap, msbChannel: 'local-foundation-msb',
      msbDhtBootstrap: manifest.dhtBootstrap, peerDhtBootstrap: manifest.dhtBootstrap,
      storeDirectory: path.join(root, 'dex-peer'), subnetChannel: 'dex-adapter-local',
      validatorKey: network.validator.wallet.publicKey.toString('hex'),
      bridge: { port: await availablePort(), tokenFile },
      trac: { reset: { bootstrap: manifest.indexer.subnetBootstrap, channel: 'local-foundation-subnet',
        dhtBootstrap: manifest.dhtBootstrap, beaconOptions } }
    };
    const configFile = path.join(root, 'config.json');
    await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
    child = await startPeer(configFile, root);
    bridge = await new Bridge({ url: child.info.bridge, token, timeoutMs: 60000 }).connect();
    const context = await bridge.call('dex_msb_info', {});
    assert.equal(context.msbBootstrap, manifest.msbBootstrap);
    assert.equal(context.feeTnk, '30000000000000000');
    let loseTnkResponse = false, loseResetResponse = false;
    const tnkPackets = [], resetPackets = [];
    const traderBridge = { call: async (type, params) => {
      if (type === 'dex_tnk_broadcast') tnkPackets.push(structuredClone(params.payload));
      const result = await bridge.call(type, params);
      if (type === 'dex_tnk_broadcast' && loseTnkResponse) {
        loseTnkResponse = false;
        throw Error('Test: accepted TNK broadcast response lost');
      }
      return result;
    } };
    globalThis.fetch = async (url, options) => {
      const submitting = new URL(url).pathname === '/v1/tx/submit';
      if (submitting) resetPackets.push(options.body);
      const response = await realFetch(url, options);
      if (submitting && loseResetResponse) {
        loseResetResponse = false;
        assert.equal(response.ok, true);
        assert.equal((await response.json()).ok, true);
        throw Error('Test: accepted RESET submission response lost');
      }
      return response;
    };
    const traderOptions = { bridge: traderBridge, wallet: sender, resetGatewayUrl: manifest.gateways[0].gatewayUrl,
      intentFolder: path.join(root, 'trader-intents') };
    trader = createTracAdapter(traderOptions);
    const usedTxFolder = path.join(root, 'signer-journal');
    signer = createTracAdapter({ bridge, usedTxFolder });
    const transfers = new Map();
    async function balance(asset) {
      if (asset === 'TNK') return BigInt((await network.validator.getBalance(receiver.address)).balance);
      await network.sync();
      return BigInt((await (await fetch(`${manifest.gateways[0].gatewayUrl}/v1/account/${receiver.publicKey}`)).json()).balance);
    }
    async function transfer(asset, amount, loseResponse = false) {
      const tradeId = id();
      const terms = { pair: `${asset}/USDC`, base: BASES[asset], baseAmount: amount, seller: { tracAddr: sender.address }, buyer: { tracAddr: receiver.address }, sendBy: now() + 120 };
      const before = await balance(asset);
      loseTnkResponse = loseResponse && asset === 'TNK';
      loseResetResponse = loseResponse && asset === 'RESET';
      const sent = await trader.sendTransfer({ terms, tradeId });
      assert.equal(sent.ok, !loseResponse, sent.reason);
      if (loseResponse) { assert.equal(sent.unknown, true); assert.match(sent.txHash, /^[0-9a-f]{64}$/); }
      assert.equal(sent.type, 'transferSent');
      assert.ok(sent.sentAt < terms.sendBy && sent.sentAt <= sent.now);
      const request = { asset, txHash: sent.txHash, from: sender.address, to: receiver.address, minAmount: amount, nonce: transferNonce(tradeId), tradeId, finalBefore: now() + 120 };
      const start = Date.now();
      let proof;
      do {
        proof = await signer.verifyTransfer(request);
        if (proof.ok) break;
        assert.ok(['unknown_or_not_final', 'reset_not_final'].includes(proof.reason), proof.reason);
        await sleep(50);
      } while (Date.now() - start < 90000);
      assert.equal(proof.ok, true, proof.reason);
      assert.equal(proof.final, true);
      assert.equal(proof.type, 'transferVerified');
      assert.equal(proof.amount, amount);
      assert.equal(proof.nonce, request.nonce);
      assert.equal(proof.from, sender.address);
      assert.equal(proof.to, receiver.address);
      assert.ok(Number.isSafeInteger(proof.finalizedAt) && proof.finalizedAt <= proof.now);
      const packetCount = tnkPackets.length + resetPackets.length;
      trader.close(); trader = createTracAdapter({ ...traderOptions, wallet: null });
      for (const resume of [false, true]) {
        const repeat = await trader.sendTransfer({ terms, tradeId, resume });
        assert.equal(repeat.ok, true, repeat.reason);
        assert.equal(repeat.txHash, sent.txHash); assert.equal(repeat.sentAt, sent.sentAt);
      }
      assert.equal(tnkPackets.length + resetPackets.length, packetCount, 'final transfer is not broadcast again');
      assert.equal(await balance(asset) - before, BigInt(amount), 'recipient receives exactly one payment');
      trader.close(); trader = createTracAdapter(traderOptions);
      transfers.set(asset, { request, proof });
      t.diagnostic(`${asset}: verified through Pear bridge in ${Date.now() - start} ms after send receipt`);
    }

    await t.test('TNK send and final verification', () => transfer('TNK', '1000000000000000000'));
    await t.test('RESET chosen-nonce prepare, submit and signed applied verification', () => transfer('RESET', '7'));
    await t.test('lost TNK response retains hash, verifies later, and resumes without a second payment', () => transfer('TNK', '2000000000000000000', true));
    await t.test('lost RESET response retains hash, verifies later, and resumes without a second payment', () => transfer('RESET', '9', true));
    await t.test('wrong amount, wrong nonce, replay and deadline fail closed', async () => {
      for (const { request, proof } of transfers.values()) {
        assert.equal((await signer.verifyTransfer({ ...request, minAmount: (BigInt(request.minAmount) + 1n).toString() })).ok, false);
        assert.equal((await signer.verifyTransfer({ ...request, nonce: '00'.repeat(32) })).ok, false);
        assert.equal((await signer.verifyTransfer({ ...request, finalBefore: proof.finalizedAt })).reason, 'finality_deadline');
        assert.deepEqual(signer.reserveTx(request), { ok: true, reservedFor: request.tradeId });
        const second = { ...request, tradeId: id() };
        assert.deepEqual(signer.reserveTx(second), { ok: false, reservedFor: request.tradeId });
        assert.equal((await signer.verifyTransfer(second)).reason, 'tx_already_used');
      }
    });
    await t.test('first-observed time and reservations survive an offline adapter restart after the cutoff', async () => {
      const cutoff = Math.max(...[...transfers.values()].map(({ proof }) => proof.finalizedAt)) + 1;
      while (now() <= cutoff) await sleep(50);
      let reads = 0;
      const offlineBridge = { call: async () => { reads++; throw Error('Test: bridge unavailable after restart'); } };
      signer.close(); signer = createTracAdapter({ bridge: offlineBridge, usedTxFolder });
      for (const { request, proof } of transfers.values()) {
        const reopened = await signer.verifyTransfer({ ...request, finalBefore: cutoff });
        assert.equal(reopened.ok, true, reopened.reason);
        assert.equal(reopened.finalizedAt, proof.finalizedAt);
        assert.equal(reopened.usedBy, request.tradeId);
      }
      assert.equal(reads, 0);
    });
    t.diagnostic(`Artifacts: ${root}`);
  } finally {
    globalThis.fetch = realFetch;
    signer?.close(); trader?.close(); sender?.close(); receiver?.close(); bridge?.close();
    try { await child?.close(); } finally { await network?.close(); }
  }
});
