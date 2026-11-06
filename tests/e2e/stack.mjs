// Full local stack: RESET devnet (local DHT, MSB with local TNK, RESET contract), a local Solana validator running the
// deployed escrow binary, one service, five signers and two traders, each a Pear peer plus its Node role process.
// Usage: node tests/e2e/stack.mjs [scenario ...]
import fs from 'node:fs/promises';
import { writeFileSync, createWriteStream, readFileSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { resetSourceURL } from '../reset-source.mjs';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from '@solana/spl-token';
import { startIsolatedValidator, setupMarket, send, balance } from '../integration/solana/harness.mjs';
import { createWallet } from '../../src/trac/wallet.js';
import PeerWallet from '../../peer/node_modules/trac-wallet/index.js';
import { MIN_SOL, MIN_TNK, MSB_FEE } from '../../src/wallets/accounting.js';
import { resolveNetwork } from '../../src/net/profile.js';
import { secretFile } from '../../src/roles/common.js';
import { prepareDeal, lockStatement } from '../../src/core/dealing.js';
import { proveLock } from '../../src/proof/lockproof.js';
import { generateBox, encodeKey } from '../../src/core/keys.js';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { SOFTWARE, meetsVersion } from '../../src/core/software.js';
import { PAIRS } from '../unit/core/helpers.mjs';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import PeerRuntimeWallet from '../../peer/node_modules/trac-peer/src/wallet.js';
import { Bridge } from '../../src/net/bridge.js';
import { defaultSettings, policyId, publicationBytes } from '../../src/stake/settings.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createKeyring, openKeyring } from '../../src/roles/keyring.js';
import { calculateFees, deriveEscrowPda } from '../../src/solana/escrow.js';
import { waitForControl } from './control-ready.mjs';
import { openStore } from '../../src/roles/store.js';
import { stakeEscrowHistory } from '../../src/solana/stake-history.js';
import { qualifyingLock } from '../../src/stake/proof-clock.js';
import { finalizedStakeClock } from '../../src/stake/chain.js';
import { stakePenaltyCases } from './stake-penalty-cases.mjs';
import { buildInitInstruction } from '../../src/solana/escrow.js';

import { startLocalDevnet } from '../integration/trac/local-devnet.mjs';
const { beaconOptions } = await import(resetSourceURL('tests/helpers/chain.mjs'));

const repo = fileURLToPath(new URL('../../', import.meta.url));
// Mixed versions: DEX_E2E_OLD_REPO names a checkout of an earlier release (with its node_modules), DEX_E2E_OLD lists the
// nodes (service, s1..s5, alice, bob, ...) whose peer and role run that release. The registry then admits both.
const oldRepo = process.env.DEX_E2E_OLD_REPO || null;
const oldNames = new Set((process.env.DEX_E2E_OLD ?? '').split(',').filter(Boolean));
if (oldNames.size && (!oldRepo || !path.isAbsolute(oldRepo))) throw new Error('Set DEX_E2E_OLD_REPO to an absolute checkout path');
const OLD_SOFTWARE = oldNames.size ? JSON.parse(readFileSync(path.join(oldRepo, 'package.json'), 'utf8')).version : null;
const codeMap = env => Object.fromEntries((process.env[env] ?? '').split(',').filter(Boolean).map(x => x.split('=')));
const roleCode = codeMap('DEX_E2E_CODE'), peerCode = { ...roleCode, ...codeMap('DEX_E2E_PEER_CODE') };
const codeOf = n => roleCode[n] ?? (oldNames.has(n) ? oldRepo : repo);
const peerCodeOf = n => peerCode[n] ?? codeOf(n);
const softwareOf = n => oldNames.has(n) ? OLD_SOFTWARE : SOFTWARE;
const scenarios = process.argv.slice(2).length ? process.argv.slice(2) : ['wallets', 'reset-sell', 'tnk-buy', 'cheating-dealer', 'cheating-certificate', 'signers-offline', 'not-enough-signers', 'signers-vanish-before-ack', 'crowd', 'silent-taker', 'refund'];
const relayMode = scenarios.some(n => ['relay', 'relay-none'].includes(n));
const strikeMode = scenarios.includes('seller-strikes');
const stakeReleaseMode = scenarios.includes('stake-release-refusal');
const handoffMode = scenarios.includes('stake-epoch-handoff');
const lateFundingMode = scenarios.some(n => ['stake-late-funding', 'stake-partial-funding'].includes(n));
if (stakeReleaseMode && (scenarios.length !== 1 || OLD_SOFTWARE !== '0.1.47' || !oldNames.has('alice') || !oldNames.has('legacy')))
  throw Error('stake-release-refusal requires only this case and released v0.1.47 on alice,legacy');
const penaltyCasesMode = scenarios.includes('stake-penalty-cases');
const penaltyMode = scenarios.includes('stake-penalty') || penaltyCasesMode || handoffMode;
const rewardMode = scenarios.includes('stake-rewards') || penaltyMode;
const stakeMode = stakeReleaseMode || handoffMode || lateFundingMode || scenarios.some(n => ['stake-withdraw', 'stake-exact-withdraw', 'stake-rewards', 'stake-free-expiry', 'stake-penalty', 'stake-penalty-cases'].includes(n));
if (relayMode && scenarios.length !== 1) throw new Error('Run relay and relay-none separately with fresh peers');
const sleep = ms => new Promise(r => setTimeout(r, ms));
// The RESET seller pays the MSB fee (0.03 TNK) for its transfer.
const MSB_FEE_SPENT = '-30000000000000000';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const PASSWORD = 'local-e2e-only-password';
// refundSec - sendWindowSec - graceSec must leave the 600 s claim buffer the protocol requires.
const zkeyPath = process.env.DEX_PROOF_ZKEY;
if (!zkeyPath || !path.isAbsolute(zkeyPath)) throw new Error('Set DEX_PROOF_ZKEY to an absolute proving key path');
const PARAMS = { n: stakeMode ? 4 : 5, k: 3, sendWindowSec: penaltyMode ? 600 : 300, refundSec: strikeMode ? 1800 : penaltyMode ? 1260 : 960, graceSec: 30 };

async function port() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port; await new Promise(r => s.close(r)); return p;
}

// Spawns a process, resolves when a line starts with `marker`, keeps its output in a log file.
function launch(name, cmd, args, { cwd, env = {}, marker, logDir }) {
  const out = createWriteStream(path.join(logDir, `${name}.log`), { flags: 'a' });
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(out, { end: false }); child.stderr.pipe(out, { end: false });
  let pending = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} did not start`)), 180000);
    child.stdout.on('data', chunk => {
      pending += chunk;
      for (let i; (i = pending.indexOf('\n')) >= 0;) {
        const line = pending.slice(0, i); pending = pending.slice(i + 1);
        if (line.startsWith(marker)) { clearTimeout(timer); resolve(JSON.parse(line.slice(marker.length + 1))); }
      }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`${name} exited ${code}`)); });
  });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(r => child.once('exit', r));
    child.kill('SIGTERM');
    const t = setTimeout(() => child.kill('SIGKILL'), strikeMode ? 5000 : 60000);
    await exited; clearTimeout(t);
  };
  return { child, ready, stop };
}

const testArea = process.env.DEX_E2E_TEST_DIR ?? path.join(repo, scenarios.includes('fee-change') ? '.test-tmp/fee-stack' : '.test-tmp/stack');
if (!path.isAbsolute(testArea)) throw new Error('DEX_E2E_TEST_DIR must be absolute');
await fs.mkdir(testArea, { recursive: true });
const root = await fs.mkdtemp(path.join(testArea, 'e2e-'));
const registrySeed = path.join(root, 'registry-seed.json');
const attackFile = path.join(root, 'attack.json'), certificateFile = path.join(root, 'foreign-certificate.json');
await fs.writeFile(attackFile, '{}');
const setAttack = async value => { await fs.writeFile(attackFile + '.tmp', JSON.stringify(value)); await fs.rename(attackFile + '.tmp', attackFile); };
const logDir = path.join(root, 'logs'); await fs.mkdir(logDir);
log('run folder', root);
const stops = [];
let failed = false;
let stopping = null;
function stopAll() {
  return stopping ??= (async () => {
    if (strikeMode) await Promise.allSettled(stops.reverse().map(stop => Promise.resolve().then(stop)));
    else for (const stop of stops.reverse()) { try { await stop(); } catch (e) { console.error('stop', e.message); } }
    log('stopped everything; logs in', logDir);
  })();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { failed = true; stopAll().then(() => process.exit(1)); });
try {
  if (scenarios.includes('cheating-certificate')) {
    const d = prepareDeal({ k: 1, committeeBoxKeys: [encodeKey(generateBox().publicKey)], tradeId: randomBytes(32).toString('hex') });
    await fs.writeFile(certificateFile, JSON.stringify(await proveLock({ secretHex: d.privateState.secretHex, statement: lockStatement(d.deal) }, { zkeyPath })));
  }
  // Solana: local validator with the mainnet program, a local USDC-like mint, platform (10 bps) and venue (50 bps).
  let validator = await startIsolatedValidator({ maxLifetimeMs: 3 * 3600 * 1000,
    ...(scenarios.some(n => ['stake-free-expiry', 'stake-exact-withdraw'].includes(n)) ? { slotsPerEpoch: 2000000 } : {}) });
  stops.push(() => validator.stop());
  const LOCAL_RPC = validator.rpc;
  const market = await setupMarket(validator);
  let { connection } = market;
  const { mint } = market;
  const stakeHistoryFromSlot = await connection.getSlot('finalized');
  const extraTraders = [...(scenarios.some(n => ['crowd', 'silent-taker'].includes(n)) ? ['charlie', 'dana', 'erin'] : []), ...(scenarios.includes('wallets') ? ['autowallet'] : []),
    ...(scenarios.includes('unfunded-seller') ? ['empty'] : []),
    ...(stakeReleaseMode || scenarios.some(n => ['release-forward', 'release-reverse'].includes(n)) ? ['legacy'] : [])];
  const traders = ['alice', 'bob', ...extraTraders];
  // Bob gets an ordinary funded key: the validator's mint key holds more lamports than a safe integer.
  const solKeys = { bob: Keypair.generate(), alice: market.seller, service: market.venue };
  for (const n of extraTraders.filter(n => n !== 'autowallet')) solKeys[n] = Keypair.generate();
  const usdc = name => getAssociatedTokenAddressSync(mint, solKeys[name].publicKey);
  await send(connection, market.buyer, [createAssociatedTokenAccountIdempotentInstruction(market.buyer.publicKey, usdc('alice'), solKeys.alice.publicKey, mint),
    createMintToInstruction(mint, usdc('alice'), market.buyer.publicKey, 50_000_000n)]);
  await send(connection, market.buyer, [SystemProgram.transfer({ fromPubkey: market.buyer.publicKey, toPubkey: solKeys.bob.publicKey, lamports: 2_000_000_000 }),
    createAssociatedTokenAccountIdempotentInstruction(market.buyer.publicKey, usdc('bob'), solKeys.bob.publicKey, mint),
    createMintToInstruction(mint, usdc('bob'), market.buyer.publicKey, 100_000_000n)]);
  for (const n of extraTraders.filter(n => n !== 'autowallet')) {
    await send(connection, market.buyer, [SystemProgram.transfer({ fromPubkey: market.buyer.publicKey, toPubkey: solKeys[n].publicKey, lamports: 100_000_000 }),
      createAssociatedTokenAccountIdempotentInstruction(market.buyer.publicKey, usdc(n), solKeys[n].publicKey, mint),
      createMintToInstruction(mint, usdc(n), market.buyer.publicKey, 50_000_000n)]);
  }
  const solana = { endpoints: [LOCAL_RPC, LOCAL_RPC.replace('127.0.0.1', 'localhost')], sendEndpoint: LOCAL_RPC, need: 2 };
  log('solana ready; mint', mint.toBase58());

  // RESET devnet.
  const tracArea = process.env.DEX_TRAC_TEST_DIR ?? path.join(repo, '.test-tmp/trac'); await fs.mkdir(tracArea, { recursive: true });
  const network = await startLocalDevnet(await fs.mkdtemp(path.join(tracArea, 'spot-')), { validatorHealth: true });
  stops.push(() => network.close());
  const manifest = network.manifest;
  if (rewardMode) await network.pauseMining();
  log('devnet ready');

  // Identities.
  const names = ['service', 's1', 's2', 's3', 's4', 's5', ...traders, ...(rewardMode ? ['payout'] : [])];
  const dirs = {}, ids = {}, boxes = {}, wallets = {};
  for (const n of names) {
    dirs[n] = path.join(root, n); await fs.mkdir(path.join(dirs[n], 'data'), { recursive: true, mode: 0o700 });
    if (n === 'autowallet') continue; // No wallet or keyring fixture: the real role must create both.
    // Each role's keyring, made here so the registry can list the signers' public keys before anything starts.
    const pub = await createKeyring(path.join(dirs[n], 'data', 'keyring.json'), PASSWORD, { solanaSecret: solKeys[n]?.secretKey ?? null });
    ids[n] = { publicKey: pub.dexKey };
    if (n.startsWith('s') && n !== 'service') boxes[n] = { publicKey: pub.boxKey };
  }
  for (const n of [...traders.filter(n => n !== 'autowallet'), ...(rewardMode ? ['payout'] : [])]) {
    wallets[n] = await createWallet(path.join(dirs[n], 'trac-wallet.json'), PASSWORD);
    if (n === 'empty') continue;
    await network.local.fund(network.validator, { address: wallets[n].address });
    if (n !== 'payout') await network.gift(wallets[n].publicKey, penaltyCasesMode && n === 'alice' ? '600000' : '200000');
    log(n, 'funded', wallets[n].address);
  }

  // Fresh peer wallets let every config pin the service owner before networking starts.
  const peerKeys = {};
  for (const n of names) {
    const w = new PeerRuntimeWallet({ networkPrefix: network.validator.config.addressPrefix, derivationPath: network.validator.config.derivationPath });
    await w.ready; await w.generateKeyPair(null, network.validator.config.derivationPath);
    const file = path.join(dirs[n], 'peer-store/peer/db/keypair.json');
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); w.exportToFile(file, Buffer.alloc(0)); await fs.chmod(file, 0o600);
    peerKeys[n] = w.publicKey;
  }

  // Peers.
  const peerDir = path.join(repo, 'peer'), bridges = {}, networkPins = {};
  for (const n of names) {
    const bridgePort = await port(), tokenFile = path.join(dirs[n], 'bridge.token');
    secretFile(tokenFile);
    const pins = { environment: 'development', msbNetworkId: network.validator.config.networkId, msbBootstrap: manifest.msbBootstrap, msbChannel: 'local-foundation-msb',
      msbDhtBootstrap: manifest.dhtBootstrap, peerDhtBootstrap: manifest.dhtBootstrap,
      trac: { reset: { bootstrap: manifest.indexer.subnetBootstrap, channel: 'local-foundation-subnet', dhtBootstrap: manifest.dhtBootstrap,
        beaconOptions } } };
    networkPins[n] = pins;
    const config = { role: n === 'payout' ? 'payout' : n === 'service' ? 'service' : n.startsWith('s') ? 'signer' : 'trader', servicePeerKey: peerKeys.service, network: 'local', peer: pins, mint: mint.toBase58(), platformCollector: market.platform.publicKey.toBase58(),
      storeDirectory: path.join(dirs[n], 'peer-store'), validatorKey: network.validator.wallet.publicKey.toString('hex'), bridge: { port: bridgePort, tokenFile } };
    assert.ok(!JSON.stringify(resolveNetwork(config)).includes('REQUIRED:'));
    const file = path.join(dirs[n], 'peer.json'); writeFileSync(file, JSON.stringify(config, null, 1));
    const faultFile = path.join(dirs[n], 'relay-faults.json');
    if (relayMode) await fs.writeFile(faultFile, JSON.stringify({ isolatedKey: peerKeys.bob, capture: n === 's1' }));
    const peerArgs = relayMode ? [path.join(repo, 'tests/e2e/relay-runner.mjs'), '--config', file, '--faults', faultFile] : ['scripts/pear-runner.mjs', '--config', file];
    const p = launch(`peer-${n}`, process.execPath, peerArgs, { cwd: path.join(peerCodeOf(n), 'peer'), logDir, marker: 'DEX_PEER_READY',
      env: { PEAR_RUNNER_STDIN: '0', DEX_LEGACY_PEAR_RUN: '0', XDG_CONFIG_HOME: path.join(dirs[n], 'pear-config'), XDG_DATA_HOME: path.join(dirs[n], 'pear-data') } });
    stops.push(p.stop);
    bridges[n] = { url: `ws://127.0.0.1:${bridgePort}`, tokenFile, ready: p.ready };
  }
  await Promise.all(Object.values(bridges).map(b => b.ready));
  log(names.length, 'peers ready');
  if (oldNames.size) log('old version', OLD_SOFTWARE, 'on', [...oldNames].join(','), '| new', SOFTWARE, 'on the rest');

  // Role processes.
  const registry = { minSoftware: OLD_SOFTWARE ?? SOFTWARE, pairs: PAIRS, params: PARAMS, fee: { platformFeeBps: 10, tradeFeeBps: 50, collector: solKeys.service.publicKey.toBase58(), signerShareBps: 5000 },
    signers: ['s1', 's2', 's3', 's4', 's5'].map(n => ({ dexKey: ids[n].publicKey, boxKey: boxes[n].publicKey, label: n, limitUsdc: '1000000000000', status: 'active', assets: ['TNK', 'RESET'], software: softwareOf(n),
      ...(relayMode && !scenarios.includes('relay-none') && n === 's1' ? { relayKey: peerKeys.s1 } : {}) })),
    removed: [] };
  if (stakeMode) {
    const at = Math.floor(Date.now() / 1000), publishedAt = at - 3601, settings = defaultSettings();
    settings.stake.withdrawDelaySec = 3600;
    if (rewardMode) { settings.rewards.dailyReset = '14400'; settings.rewards.payoutMinReset = penaltyMode && !handoffMode ? '10000000' : '100'; }
    const id = randomBytes(32).toString('hex'), scope = { networkId: network.validator.config.networkId, venueKey: ids.service.publicKey, epochId: id };
    const receipts = [];
    for (const n of ['s1', 's2', 's3']) {
      // These encrypted test identities were created in this fresh run folder above.
      const keyring = await openKeyring(path.join(dirs[n], 'data/keyring.json'), PASSWORD);
      receipts.push({ from: ids[n].publicKey, at: publishedAt,
        sig: Buffer.from(ed25519.sign(publicationBytes(policyId(settings), publishedAt, scope), Buffer.from(keyring.identity.secretKey, 'hex'))).toString('hex') });
      keyring.storeKey.fill(0);
    }
    registry.sellerBond = { protocol: 1, networkId: scope.networkId, venueKey: scope.venueKey, enforceAfter: at + (penaltyMode ? 1080 : 86400), acceptNew: true,
      ...(rewardMode ? { rewardService: { dexKey: ids.payout.publicKey, tracAddr: wallets.payout.address } } : {}),
      custody: { lifetimeSec: penaltyMode || scenarios.includes('stake-exact-withdraw') ? 2592000 : 86400,
        fundingWindowSec: 3600, dkgTimeoutSec: 30, tnkReserve: '120000000000000000' },
      epoch: { id, members: ['s1', 's2', 's3', 's4'].map(n => ({ dexKey: ids[n].publicKey, boxKey: boxes[n].publicKey })), n: 4, k: 3, maxFaulty: 1, startAt: publishedAt },
      economics: { active: { policyId: policyId(settings), settings, publishedAt, effectiveAt: publishedAt + 3600, receipts } } };
  }
  // First publish the real legacy registry/offer, then upgrade the maker and
  // activate stake. The released buyer keeps its genuine cached announcement;
  // no released decoder, availability rule or state is patched for this case.
  const releasePolicy = stakeReleaseMode ? registry.sellerBond : null;
  if (stakeReleaseMode) delete registry.sellerBond;
  const roleProc = {}, control = {}, roleOptions = {};
  const auditBridges = {};
  let registryMessage;
  if (relayMode) {
    for (const n of ['alice', 'bob', 's1']) {
      auditBridges[n] = await new Bridge({ url: bridges[n].url, token: secretFile(bridges[n].tokenFile) }).connect();
      stops.push(() => auditBridges[n].close());
    }
    auditBridges.alice.on('message', (ch, m) => { if (ch === 'intercom-dex' && m.kind === 'registry') registryMessage = m; });
  }
  const api = async (n, method, route, body) => {
    const token = secretFile(control[n].tokenFile);
    const res = await fetch(control[n].url + route, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    const value = await res.json(); if (!res.ok) throw new Error(`${n} ${route}: ${value.error}`); return value;
  };
  const started = new Set();
  const startRole = (n, { rescue = '' } = {}) => {
    const { role, file } = roleOptions[n];
    // The venue issues its first registry on its first start only; restarts use the stored one.
    const args = [...(scenarios.includes('stake-exact-withdraw') && role === 'service' ? ['--import', './tests/e2e/stake-price-hook.mjs'] : []), ...(lateFundingMode ? ['--import', './tests/e2e/stake-funding-hook.mjs'] : []), ...(penaltyMode && role !== 'payout' ? ['--import', './tests/e2e/stake-hook.mjs'] : []), ...(role === 'trader' ? ['--import', './tests/e2e/cheating-hook.mjs'] : []),
      ...(role === 'signer' && strikeMode ? ['--import', './tests/e2e/strike-hook.mjs'] : []), 'bin/dex.mjs', '--config', file,
      ...(role === 'service' && !started.has(n) ? ['--first-launch'] : [])];
    started.add(n);
    const p = launch(`role-${n}`, process.execPath, args, { cwd: codeOf(n), logDir, marker: 'DEX_ROLE_READY',
      env: { DEX_WALLET_PASSWORD: PASSWORD, DEX_KEY_PASSWORD: PASSWORD, DEX_E2E_ATTACK_FILE: attackFile, DEX_RESCUE_TRADES: rescue,
        ...(handoffMode ? { DEX_E2E_HANDOFF: '1' } : {}),
        ...(relayMode && n === 'bob' ? { DEX_E2E_REGISTRY_SEED: registrySeed } : {}) } });
    stops.push(p.stop); roleProc[n] = p;
    p.ready = p.ready.then(async ready => { await waitForControl(() => api(n, 'GET', '/status')); return ready; });
    return p.ready;
  };
  for (const n of names) {
    const role = n === 'payout' ? 'payout' : n === 'service' ? 'service' : n.startsWith('s') ? 'signer' : 'trader';
    const config = { role, network: 'local', peer: networkPins[n], dataDir: path.join(dirs[n], 'data'), bridge: { url: bridges[n].url, tokenFile: bridges[n].tokenFile },
      serviceKey: ids.service.publicKey, servicePeerKey: peerKeys.service, mint: mint.toBase58(), platformCollector: market.platform.publicKey.toBase58() };
    control[n] = { url: `http://127.0.0.1:${await port()}`, tokenFile: path.join(dirs[n], 'control.token') };
    config.control = { port: Number(control[n].url.split(':').pop()), tokenFile: control[n].tokenFile };
    if (role === 'service') Object.assign(config, { registry, solana });
    if (role === 'signer') Object.assign(config, { solana, strikes: { enabled: strikeMode },
      trac: { resetGatewayUrl: manifest.gateways[0].gatewayUrl } });
    if (role === 'payout') Object.assign(config, { trac: { walletFile: path.join(dirs[n], 'trac-wallet.json'), passwordEnv: 'DEX_WALLET_PASSWORD', resetGatewayUrl: manifest.gateways[0].gatewayUrl } });
    if (role === 'trader') {
      Object.assign(config, { solana, proof: { zkey: zkeyPath },
        trac: { walletFile: path.join(dirs[n], 'trac-wallet.json'), passwordEnv: 'DEX_WALLET_PASSWORD', resetGatewayUrl: manifest.gateways[0].gatewayUrl } });
    }
    if (n === 'autowallet') {
      config.trac = { resetGatewayUrl: manifest.gateways[0].gatewayUrl };
      config.payout = { trac: wallets.bob.address };
    }
    const file = path.join(dirs[n], 'role.json'); writeFileSync(file, JSON.stringify(config, null, 1));
    roleOptions[n] = { role, file };
    if (!relayMode || n !== 'bob') startRole(n);
  }
  if (relayMode) {
    const end = Date.now() + 90000;
    while (!registryMessage) { if (Date.now() > end) throw Error('No signed registry seed'); await sleep(100); }
    await fs.writeFile(registrySeed, JSON.stringify(registryMessage));
    startRole('bob');
  }
  await Promise.all(Object.values(roleProc).map(p => p.ready));
  log(names.length, 'role processes ready');

  const until = async (label, fn, ms = 300000, everyMs = 1000) => {
    const end = Date.now() + ms;
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`Timed out: ${label}`); await sleep(everyMs); }
  };
  let walletMcp;
  const walletCall = async (name, args = {}) => {
    const result = await walletMcp.callTool({ name, arguments: args });
    if (result.isError) throw new Error(result.content.map(c => c.text ?? '').join(' '));
    return JSON.parse(result.content.find(c => c.type === 'text').text);
  };
  // Balances can be briefly unavailable (balanceError); exact checks wait for a real read.
  const walletInfo = () => until('wallet balances', async () => { const info = await walletCall('dex_wallets'); return info.balances ? info : null; }, 60000);
  const walletWithdraw = args => walletCall('dex_withdraw', args);
  if (scenarios.includes('wallets')) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(repo, 'src/mcp/server.mjs')],
      env: { ...process.env, DEX_CONFIG: '', DEX_CONTROL_URL: control.autowallet.url, DEX_CONTROL_TOKEN_FILE: control.autowallet.tokenFile }, stderr: 'pipe' });
    walletMcp = new Client({ name: 'wallets-e2e', version: '1.0.0' });
    stops.push(() => walletMcp.close());
    await walletMcp.connect(transport);
    const info = await walletInfo();
    assert.equal(info.storage.passwordEnv, 'DEX_KEY_PASSWORD');
    assert.equal(info.storage.tracWalletFile, path.join(dirs.autowallet, 'data', 'trac-wallet.json'));
    assert.equal(info.storage.keyringFile, path.join(dirs.autowallet, 'data', 'keyring.json'));
    assert.ok(!JSON.stringify(info).includes('secretKey'));
    for (const asset of ['USDC', 'SOL', 'TNK', 'RESET']) assert.equal(info.balances[asset].wallet, '0');
    solKeys.autowallet = { publicKey: new PublicKey(info.addresses.solana) };
    wallets.autowallet = { address: info.addresses.trac, publicKey: PeerWallet.decodeBech32m(info.addresses.trac).toString('hex') };
    ids.autowallet = { publicKey: (await roleProc.autowallet.ready).dexKey };
    await send(connection, market.buyer, [SystemProgram.transfer({ fromPubkey: market.buyer.publicKey, toPubkey: solKeys.autowallet.publicKey, lamports: 100000000 }),
      createAssociatedTokenAccountIdempotentInstruction(market.buyer.publicKey, usdc('autowallet'), solKeys.autowallet.publicKey, mint),
      createMintToInstruction(mint, usdc('autowallet'), market.buyer.publicKey, 50000000n)]);
    await network.local.fund(network.validator, { address: info.addresses.trac });
    await network.gift(wallets.autowallet.publicKey, '200000');
    await until('automatic wallet deposits visible', async () => {
      const funds = (await walletInfo()).balances;
      return funds && funds.USDC.wallet === '50000000' && funds.SOL.wallet === '100000000' && funds.RESET.wallet === '200000' && BigInt(funds.TNK.wallet) > 0n;
    });
  }
  await until('registry at traders', async () => (await api('alice', 'GET', '/status')).registryVersion && (await api('bob', 'GET', '/status')).registryVersion);
  log('registry known to traders');
  const waitOnline = count => until(`${count} signers seen online by both traders`, async () => {
    const statuses = await Promise.all(traders.filter(n => !scenarios.includes('relay-none') || n !== 'bob').map(n => api(n, 'GET', '/status')));
    return statuses.every(s => s.signersOnline.length === count);
  }, 120000);
  await waitOnline(5);
  const gateSeen = (n, marker) => until(marker, async () => {
    const text = await fs.readFile(path.join(logDir, `role-${n}.log`), 'utf8');
    const line = text.split('\n').findLast(l => l.startsWith(marker + ' '));
    return line ? JSON.parse(line.slice(marker.length + 1)) : null;
  }, 240000, 100);

  const tnkOf = async n => (await network.validator.getBalance(wallets[n].address))?.balance ?? '0';
  const resetOf = async n => (await (await fetch(`${manifest.gateways[0].gatewayUrl}/v1/account/${wallets[n].publicKey}`)).json()).balance;

  // One trade: maker posts, taker takes; wait until both sides finish and report the result.
  async function trade(label, { maker, taker, pair, side, baseAmount, price, afterTake }) {
    log(`--- ${label}`);
    if (process.env.DEX_E2E_FUNDS_PROBE) {
      const w = (await api(maker, 'GET', '/status')).wallets;
      log('funds probe', maker, JSON.stringify({ RESET: w?.balances?.RESET, TNK: w?.balances?.TNK, readAt: w?.balanceReadAt, error: w?.balanceError, gateway: await resetOf(maker) }));
    }
    const offer = await api(maker, 'POST', '/offer', { pair, side, baseAmount, price, ttlSec: 900 }).catch(async e => {
      if (process.env.DEX_E2E_FUNDS_PROBE) {
        const w = (await api(maker, 'GET', '/status').catch(x => ({ error: x.message }))).wallets;
        log('funds probe refused', maker, JSON.stringify({ balances: w?.balances, readAt: w?.balanceReadAt, error: w?.balanceError, gateway: await resetOf(maker).catch(x => x.message), tnk: await tnkOf(maker).catch(x => x.message) }));
      }
      throw e;
    });
    if (process.env.DEX_E2E_FUNDS_PROBE) log('funds probe offer accepted', maker, JSON.stringify({ offerId: offer.offerId, pair, side, baseAmount }));
    // Full per-offer books repeat every 60 seconds; funding refresh plus wire
    // delivery can straddle that boundary. Still require the actual offer.
    await until('offer visible to taker', async () => (await api(taker, 'GET', '/status')).offers.some(o => o.offerId === offer.offerId), 180000);
    if (process.env.DEX_E2E_FUNDS_PROBE) log('funds probe offer visible', taker, offer.offerId);
    // A new taker keeps a new maker connected before the take (warm); an old maker is never warmed.
    if (!oldNames.has(taker)) {
      const warm = await api(taker, 'POST', '/warm', { pair, offerIds: [offer.offerId] });
      assert.deepEqual(warm.peerKeys, meetsVersion(offer.software, '0.1.14') ? [offer.peerKey] : [], 'warm makers');
      log('warm', taker, '->', maker, warm.peerKeys.length ? 'connected' : 'not warmed (old maker)');
    }
    const taken = await api(taker, 'POST', '/take', { offerId: offer.offerId, price: offer.price });
    log('taken', taken.role, 'quote', taken.quoteAmount);
    if (afterTake) await afterTake(taken);
    const t0 = Date.now();
    const done = await until(label, async () => {
      const [a, b] = await Promise.all([api(maker, 'GET', '/status'), api(taker, 'GET', '/status')]);
      const ta = a.trades.find(t => t.key.startsWith(offer.offerId)), tb = b.trades.find(t => t.key === taken.key);
      if (ta && tb && ['complete', 'refunded', 'aborted'].includes(ta.phase) && ['complete', 'refunded', 'aborted'].includes(tb.phase)) return { ta, tb };
      return null;
    }, (PARAMS.refundSec + 180) * 1000);
    log(label, 'maker', done.ta.role, done.ta.phase, done.ta.reason ?? '', '| taker', done.tb.role, done.tb.phase, done.tb.reason ?? '', `| ${Math.round((Date.now() - t0) / 1000)} s`);
    return { offer, taken, ...done };
  }

  const results = [];
  const usdcOf = async n => (await balance(connection, usdc(n))).toString();
  const feeVault = async (platform = false, collector = null) => {
    const { deriveConfigPda, deriveTradeConfigPda } = await import('../../src/solana/escrow.js');
    if (!platform && !collector) collector = (await api('service', 'GET', '/status')).fee.collector;
    const owner = platform ? deriveConfigPda().pda : deriveTradeConfigPda(collector).pda;
    const address = getAssociatedTokenAddressSync(mint, owner, true);
    return await connection.getAccountInfo(address) ? (await connection.getTokenAccountBalance(address)).value.amount : '0';
  };
  for (const name of scenarios) {
    log('scenario', name);
    if (process.env.DEX_E2E_FUNDS_PROBE) for (const n of ['alice', 'bob']) {
      const w = (await api(n, 'GET', '/status')).wallets;
      log('funds probe', n, JSON.stringify({ RESET: w?.balances?.RESET, readAt: w?.balanceReadAt, error: w?.balanceError, gateway: await resetOf(n) }));
    }
    await setAttack({});
    for (const n of ['s1', 's2', 's3', 's4', 's5', ...traders]) {
      if (roleProc[n].child.exitCode !== null || roleProc[n].child.signalCode !== null) await startRole(n);
    }
    await waitOnline(5);
    await until('ready certificate pools', async () => {
      const statuses = await Promise.all(traders.filter(n => !scenarios.includes('relay-none') || n !== 'bob').map(n => api(n, 'GET', '/status')));
      return statuses.every(s => s.certificatesReady >= (penaltyMode ? 1 : 2));
    }, 360000);
    const before = { alice: await usdcOf('alice'), bob: await usdcOf('bob'), aliceReset: await resetOf('alice'), bobReset: await resetOf('bob'), aliceTnk: await tnkOf('alice'), bobTnk: await tnkOf('bob') };
    let r;
    if (name === 'stake-release-refusal') {
      assert.equal((await api('legacy', 'GET', '/status')).software, '0.1.47');
      const offer = await api('alice', 'POST', '/offer', { pair: 'RESET/USDC', side: 'sell', baseAmount: '50000', price: '2000', ttlSec: 900 });
      await until('released buyer sees genuine legacy offer', async () => (await api('legacy', 'GET', '/status')).offers.some(o => o.offerId === offer.offerId), 60000);
      const funds = async () => Object.fromEntries(await Promise.all(['alice', 'legacy'].map(async n => [n,
        { reset: await resetOf(n), tnk: await tnkOf(n), usdc: await usdcOf(n), sol: await connection.getBalance(solKeys[n].publicKey) }])));
      const initial = await funds();
      await roleProc.alice.stop(); roleCode.alice = repo; await startRole('alice');
      const serviceConfig = JSON.parse(await fs.readFile(roleOptions.service.file, 'utf8'));
      serviceConfig.registry.sellerBond = { ...releasePolicy, enforceAfter: Math.floor(Date.now() / 1000) };
      await roleProc.service.stop(); await fs.writeFile(roleOptions.service.file, JSON.stringify(serviceConfig)); await startRole('service');
      await until('upgraded maker receives armed registry', async () => (await api('alice', 'GET', '/status')).registryVersion > offer.registryVersion, 30000, 500);
      const taken = await api('legacy', 'POST', '/take', { offerId: offer.offerId, price: offer.price });
      const refused = await until('released buyer displays update refusal', async () => {
        const t = (await api('legacy', 'GET', '/status')).trades.find(t => t.key === taken.key);
        return t?.phase === 'aborted' && t;
      }, 60000, 500);
      assert.equal(refused.reason, 'Peer aborted: update the app');
      assert.equal((await api('alice', 'GET', '/status')).trades.length, 0);
      assert.deepEqual(await funds(), initial);
      const ring = await openKeyring(path.join(dirs.service, 'data/keyring.json'), PASSWORD);
      try {
        const current = openStore(path.join(dirs.service, 'data'), ring.storeKey, { readOnly: true }).get('service-registry');
        assert.equal(current.minSoftware, registry.minSoftware);
        assert.deepEqual(current.signers, registry.signers);
      } finally { ring.storeKey.fill(0); }
      results.push({ name, ok: true, releasedVersion: OLD_SOFTWARE, reason: refused.reason, noFundsMoved: true, signerFloorUnchanged: true });
      log('released buyer refusal passed', refused.reason); continue;
    }
    if (['release-forward', 'release-reverse'].includes(name)) {
      const maker = name === 'release-forward' ? 'legacy' : 'bob', taker = maker === 'legacy' ? 'bob' : 'legacy';
      const initial = { maker: await usdcOf(maker), taker: await usdcOf(taker), makerReset: await resetOf(maker), takerReset: await resetOf(taker) };
      r = await trade(name, { maker, taker, pair: 'RESET/USDC', side: 'sell', baseAmount: '10000', price: '1000' });
      assert.equal(r.ta.phase, 'complete'); assert.equal(r.tb.phase, 'complete');
      const fees = calculateFees(r.taken.quoteAmount, 10, 50);
      assert.equal(BigInt(await usdcOf(maker)) - BigInt(initial.maker), fees.netAmount);
      assert.equal(BigInt(await usdcOf(taker)) - BigInt(initial.taker), -fees.totalAmount);
      assert.equal(BigInt(await resetOf(maker)) - BigInt(initial.makerReset), -10000n);
      assert.equal(BigInt(await resetOf(taker)) - BigInt(initial.takerReset), 10000n);
      results.push({ name, ok: true, maker: r.ta.phase, taker: r.tb.phase, oldVersion: OLD_SOFTWARE, newVersion: SOFTWARE });
      continue;
    }
    if (name === 'address-proof') {
      assert.ok(meetsVersion(registry.minSoftware, '0.1.34'), 'address proofs require the activated protocol');
      await setAttack({ kind: 'address-proof-offer', attackerKey: ids.alice.publicKey, foreignAddr: wallets.bob.address });
      const forged = await api('alice', 'POST', '/offer', { pair: 'TNK/USDC', side: 'sell', baseAmount: '1000000000000000000', price: '1', ttlSec: 900 });
      assert.equal(forged.maker.tracAddr, wallets.bob.address);
      assert.equal(forged.maker.tracProof, undefined);
      // Several venue book intervals let both intake paths process the authenticated attack.
      await sleep(15000);
      assert.ok(!(await api('bob', 'GET', '/status')).offers.some(o => o.offerId === forged.offerId));
      assert.equal((await api('service', 'GET', '/status')).book['TNK/USDC'], 0);
      await setAttack({ kind: 'address-proof-take', attackerKey: ids.alice.publicKey, foreignAddr: wallets.bob.address });
      const buy = await api('bob', 'POST', '/offer', { pair: 'TNK/USDC', side: 'buy', baseAmount: '1000000000000000000', price: '1', ttlSec: 900 });
      assert.ok(buy.maker.tracProof, 'honest buy maker proves its receiving address');
      await until('proven buy offer visible', async () => (await api('alice', 'GET', '/status')).offers.some(o => o.offerId === buy.offerId));
      const taken = await api('alice', 'POST', '/take', { offerId: buy.offerId, price: buy.price });
      const refused = await until('foreign-address take declined', async () => {
        const t = (await api('alice', 'GET', '/status')).trades.find(t => t.key === taken.key);
        return t?.phase === 'aborted' ? t : null;
      }, 90000);
      assert.equal(refused.reason, 'invalid');
      assert.ok(!(await api('bob', 'GET', '/status')).trades.some(t => t.key.startsWith(buy.offerId)));
      assert.equal(await usdcOf('alice'), before.alice); assert.equal(await usdcOf('bob'), before.bob);
      assert.equal(await tnkOf('alice'), before.aliceTnk); assert.equal(await tnkOf('bob'), before.bobTnk);
      await setAttack({}); await api('bob', 'POST', '/cancel', { offerId: buy.offerId });
      results.push({ name, ok: true, foreignOffer: 'rejected', foreignTake: 'declined before escrow' });
      continue;
    }
    if (name === 'seller-strikes') {
      const signers = ['s1', 's2', 's3', 's4', 's5'];
      const ledgers = () => Promise.all(signers.map(n => api(n, 'GET', '/seller-strikes')));
      const begin = async () => {
        const offer = await api('bob', 'POST', '/offer', { pair: 'RESET/USDC', side: 'buy', baseAmount: '10000', price: '1000', ttlSec: 900 });
        await until('grief offer visible', async () => (await api('alice', 'GET', '/status')).offers.some(o => o.offerId === offer.offerId));
        await api('alice', 'POST', '/warm', { pair: 'RESET/USDC', offerIds: [offer.offerId] });
        const taken = await api('alice', 'POST', '/take', { offerId: offer.offerId, price: offer.price });
        return { offer, taken, buyer: async () => (await api('bob', 'GET', '/status')).trades.find(t => t.key.startsWith(offer.offerId)) };
      };
      await setAttack({ kind: 'seller-no-send', sellerAddr: wallets.alice.address });
      const griefIds = [];
      for (const count of [1, 2]) {
        const attempt = await begin();
        const buyer = await until('buyer locked for grief ' + count, async () => {
          const b = await attempt.buyer(); return b?.phase === 'locked' && b;
        }, 240000);
        griefIds.push(buyer.tradeId);
        log('grief', count, 'buyer locked', buyer.tradeId);
        await until('all signers record strike ' + count, async () => (await ledgers()).every(l =>
          l.strikes.filter(s => s.tracAddr === wallets.alice.address && s.dexKey === ids.alice.publicKey).length === count), 420000);
        for (const ledger of await ledgers()) assert.equal(ledger.refusals.length, count === 1 ? 0 : 1);
        assert.equal(await resetOf('alice'), before.aliceReset); assert.equal(await tnkOf('alice'), before.aliceTnk);
        log('grief', count, 'all five strike ledgers confirmed');
      }
      await roleProc.s1.stop(); await startRole('s1');
      assert.equal((await api('s1', 'GET', '/seller-strikes')).refusals.length, 1, 'refusal survives a real signer restart');
      const third = await begin();
      const refused = await until('third take refused at ack', async () => {
        const b = await third.buyer(); return b?.phase === 'aborted' && b;
      }, 240000);
      assert.equal(refused.reason, 'The seller is paused after unsent trades; contact the venue');
      const struckSeller = await until('seller sees strike refusal', async () => {
        const s = (await api('alice', 'GET', '/status')).trades.find(t => t.key === third.taken.key);
        return s?.phase === 'aborted' && s;
      });
      assert.equal(struckSeller.reason, 'Signers refused: your wallet is paused after unsent trades; contact the venue');
      const buyerLog = await fs.readFile(path.join(logDir, 'role-bob.log'), 'utf8');
      assert.ok(!buyerLog.includes('DEX_E2E_LOCK_ATTEMPTED ' + refused.tradeId));
      assert.ok((await Promise.all(signers.map(n => fs.readFile(path.join(logDir, `role-${n}.log`), 'utf8'))))
        .some(text => text.includes('seller struck tradeId=' + refused.tradeId)));
      log('third take refused before any buyer lock');

      // Bob is an independent honest seller. All signers see his attempt, but their finality reads arrive late.
      await setAttack({ kind: 'late-rescue', sellerAddr: wallets.bob.address, release: false });
      let rescuedId;
      const rescued = await trade('late-rescue', { maker: 'bob', taker: 'alice', pair: 'RESET/USDC', side: 'sell', baseAmount: '10000', price: '1000',
        afterTake: async taken => {
          const seller = await until('honest transfer announced', async () => {
            const buyer = (await api('alice', 'GET', '/status')).trades.find(t => t.key === taken.key);
            if (!buyer?.tradeId) return null;
            const states = await Promise.all(signers.map(n => api(n, 'GET', '/status')));
            return states.every(s => s.trades.some(t => t.tradeId === buyer.tradeId && t.phase === 'verifyingTransfer')) && buyer;
          }, 240000);
          rescuedId = seller.tradeId;
          await until('late transfer expired on all signers', async () => (await Promise.all(signers.map(n => api(n, 'GET', '/status'))))
            .every(s => s.trades.some(t => t.tradeId === rescuedId && t.phase === 'expired')), 420000);
          for (const ledger of await ledgers()) assert.ok(!ledger.strikes.some(s => s.dexKey === ids.bob.publicKey));
          await setAttack({ kind: 'late-rescue', sellerAddr: wallets.bob.address, release: true });
          await Promise.all(signers.map(n => roleProc[n].stop()));
          await Promise.all(signers.map(n => startRole(n, { rescue: rescuedId })));
        } });
      assert.equal(rescued.ta.phase, 'complete'); assert.equal(rescued.tb.phase, 'complete');
      for (const ledger of await ledgers()) {
        assert.ok(!ledger.strikes.some(s => s.dexKey === ids.bob.publicKey));
        assert.equal(ledger.strikes.length, 2);
      }
      results.push({ name, ok: true, griefIds, refusedTradeId: refused.tradeId, rescuedTradeId: rescuedId,
        strikesPerSigner: 2, honestSellerStrikes: 0, realSignerRestart: true });
      log('seller strike and late rescue scenarios passed');
      continue;
    }
    if (name === 'unfunded-seller') {
      const emptyBefore = { usdc: await usdcOf('empty'), reset: await resetOf('empty'), tnk: await tnkOf('empty') };
      assert.equal(BigInt(emptyBefore.reset), 0n); assert.equal(BigInt(emptyBefore.tnk), 0n);
      await setAttack({ kind: name, sellerAddr: wallets.empty.address });
      r = await trade(name, { maker: 'bob', taker: 'empty', pair: 'RESET/USDC', side: 'buy', baseAmount: '30000', price: '1500' });
      assert.equal(r.ta.phase, 'aborted'); assert.equal(r.tb.phase, 'aborted');
      assert.equal(r.ta.reason, 'The seller cannot deliver this trade right now');
      assert.match(r.tb.reason, /^Signers refused: your wallet does not hold 0\.0003 RESET \+ TNK fee/);
      const buyerLog = await fs.readFile(path.join(logDir, 'role-bob.log'), 'utf8');
      assert.ok(!buyerLog.includes('DEX_E2E_LOCK_ATTEMPTED ' + r.ta.tradeId), 'buyer never attempted a Solana lock');
      const sellerLog = await fs.readFile(path.join(logDir, 'role-empty.log'), 'utf8');
      assert.ok(!sellerLog.includes('DEX_E2E_TRANSFER_AUTHORIZED ' + r.tb.tradeId), 'seller never attempted a transfer');
      assert.deepEqual({ usdc: await usdcOf('empty'), reset: await resetOf('empty'), tnk: await tnkOf('empty') }, emptyBefore);
      assert.ok((await Promise.all(['s1', 's2', 's3', 's4', 's5'].map(n => fs.readFile(path.join(logDir, `role-${n}.log`), 'utf8'))))
        .some(text => text.includes('seller funds refused tradeId=' + r.ta.tradeId)), 'a signer refused before the traders aborted');
    }
    if (['reset-retry', 'tnk-retry'].includes(name)) {
      const asset = name === 'reset-retry' ? 'RESET' : 'TNK';
      const attack = { kind: 'transfer-retry', asset, release: false };
      await setAttack(attack);
      r = await trade(name, { maker: 'alice', taker: 'bob', pair: asset + '/USDC', side: 'sell',
        baseAmount: asset === 'RESET' ? '50000' : '2000000000000000000', price: asset === 'RESET' ? '2000' : '0.75',
        afterTake: async () => {
          await until('unconfirmed seller remains sending across retries', async () => {
            const text = await fs.readFile(path.join(logDir, 'role-alice.log'), 'utf8');
            return text.split('\n').filter(l => l.startsWith('DEX_E2E_TRANSFER_BYTES ') && l.includes('"dropped":true') && l.includes(`"asset":"${asset}"`)).length >= 2;
          });
          const seller = (await api('alice', 'GET', '/status')).trades.find(t => t.phase === 'transferring');
          assert.ok(seller, 'a receipt is not a final transfer');
          assert.equal(await resetOf('bob'), before.bobReset); assert.equal(await tnkOf('bob'), before.bobTnk);
          await roleProc.alice.stop(); await setAttack({ ...attack, release: true }); await startRole('alice');
        } });
      const text = await fs.readFile(path.join(logDir, 'role-alice.log'), 'utf8');
      const bytes = text.split('\n').filter(l => l.startsWith('DEX_E2E_TRANSFER_BYTES ')).map(l => JSON.parse(l.slice('DEX_E2E_TRANSFER_BYTES '.length))).filter(x => x.asset === asset);
      assert.ok(bytes.some(x => x.dropped) && bytes.some(x => !x.dropped));
      assert.equal(new Set(bytes.map(x => x.txHash)).size, 1, 'every retry and the restart use one transaction');
      await setAttack({});
    }
    if (name === 'fee-change') {
      const oldRegistry = await api('service', 'GET', '/status'), oldCollector = oldRegistry.fee.collector;
      const oldVaultBefore = BigInt(await feeVault(false, oldCollector)), platformBefore = BigInt(await feeVault(true));
      const gate = { kind: name, buyerKey: ids.bob.publicKey, release: false }; await setAttack(gate);
      let next;
      const oldTrade = await trade('fee-change old terms', { maker: 'alice', taker: 'bob', pair: 'RESET/USDC', side: 'sell', baseAmount: '50000', price: '2000',
        afterTake: async () => {
          const signed = await gateSeen('bob', 'DEX_E2E_FEE_TERMS_SIGNED');
          assert.equal(signed.fees.collector, oldCollector);
          next = await api('service', 'POST', '/fee/set', { tradeFee: '0.75' });
          assert.notEqual(next.fee.collector, oldCollector); assert.equal(next.fee.tradeFeeBps, 75);
          const buyerLog = await fs.readFile(path.join(logDir, 'role-bob.log'), 'utf8');
          assert.ok(!buyerLog.includes('DEX_E2E_LOCK_ATTEMPTED ' + signed.tradeId), 'rotation finalized before old trade lock');
          await setAttack({ ...gate, release: true });
        } });
      assert.equal(oldTrade.ta.phase, 'complete'); assert.equal(oldTrade.tb.phase, 'complete');
      const oldFees = calculateFees(oldTrade.taken.quoteAmount, oldRegistry.fee.platformFeeBps, oldRegistry.fee.tradeFeeBps);
      assert.equal(BigInt(await feeVault(false, oldCollector)) - oldVaultBefore, oldFees.tradeFeeAmount);
      assert.equal(await feeVault(false, next.fee.collector), '0');
      await until('new fee registry at both traders', async () => (await api('alice', 'GET', '/status')).registryVersion === next.version && (await api('bob', 'GET', '/status')).registryVersion === next.version);
      await setAttack({});
      const newTrade = await trade('fee-change new terms', { maker: 'alice', taker: 'bob', pair: 'RESET/USDC', side: 'sell', baseAmount: '50000', price: '2000' });
      assert.equal(newTrade.ta.phase, 'complete'); assert.equal(newTrade.tb.phase, 'complete');
      const newFees = calculateFees(newTrade.taken.quoteAmount, next.fee.platformFeeBps, next.fee.tradeFeeBps);
      assert.equal(BigInt(await usdcOf('alice')) - BigInt(before.alice), oldFees.netAmount + newFees.netAmount);
      assert.equal(BigInt(await usdcOf('bob')) - BigInt(before.bob), -oldFees.totalAmount - newFees.totalAmount);
      assert.equal(BigInt(await resetOf('alice')) - BigInt(before.aliceReset), -100000n);
      assert.equal(BigInt(await resetOf('bob')) - BigInt(before.bobReset), 100000n);
      assert.equal(BigInt(await tnkOf('alice')) - BigInt(before.aliceTnk), 2n * BigInt(MSB_FEE_SPENT));
      assert.equal(BigInt(await tnkOf('bob')) - BigInt(before.bobTnk), 0n);
      assert.equal(BigInt(await feeVault(false, oldCollector)) - oldVaultBefore, oldFees.tradeFeeAmount);
      assert.equal(BigInt(await feeVault(false, next.fee.collector)), newFees.tradeFeeAmount);
      assert.equal(BigInt(await feeVault(true)) - platformBefore, oldFees.platformFeeAmount + newFees.platformFeeAmount);
      results.push({ name, ok: true, oldCollector, newCollector: next.fee.collector, oldFee: oldFees.tradeFeeAmount.toString(), newFee: newFees.tradeFeeAmount.toString() });
      // Restore the advertised rate for later scenarios, while retaining both collectors and their vaults.
      await api('service', 'POST', '/fee/set', { tradeFee: '0.50' });
      continue;
    }
    if (name === 'wallets') {
      const original = (await walletInfo()).balances;
      r = await trade(name, { maker: 'alice', taker: 'autowallet', pair: 'RESET/USDC', side: 'sell', baseAmount: '50000', price: '2000' });
      assert.equal(r.ta.phase, 'complete'); assert.equal(r.tb.phase, 'complete');
      const traded = (await walletInfo()).balances;
      const cost = calculateFees(r.taken.quoteAmount, 10, 50).totalAmount;
      assert.equal(BigInt(traded.USDC.wallet), BigInt(original.USDC.wallet) - cost);
      assert.equal(BigInt(traded.RESET.wallet), BigInt(original.RESET.wallet) + 50000n);
      assert.equal(traded.TNK.wallet, original.TNK.wallet);
      await assert.rejects(walletWithdraw({ asset: 'RESET', amount: '0.00000001', to: wallets.alice.address }), /payout lock/);
      const external = Keypair.generate().publicKey;
      const externalAta = getAssociatedTokenAddressSync(mint, external);
      // Both destination accounts start absent; USDC must create the owner's ATA idempotently.
      const targets = { USDC: external.toBase58(), SOL: external.toBase58(), TNK: wallets.bob.address, RESET: wallets.bob.address };
      for (const asset of ['USDC', 'RESET', 'TNK', 'SOL']) {
        const current = (await walletInfo()).balances;
        const amount = current[asset].free;
        const recipientBefore = asset === 'USDC' ? 0n : asset === 'SOL' ? BigInt(await connection.getBalance(external, 'finalized')) : BigInt(asset === 'TNK' ? await tnkOf('bob') : await resetOf('bob'));
        const result = await walletWithdraw({ asset, amount: 'all', ...(asset === 'RESET' ? {} : { to: targets[asset] }) });
        assert.notEqual(result.status, 'failed');
        assert.equal(result.amount, amount);
        await until(asset + ' withdrawal confirmed', async () => !(await walletInfo()).withdrawals.some(w => w.id === result.id));
        const received = asset === 'USDC' ? await balance(connection, externalAta) : asset === 'SOL' ? BigInt(await connection.getBalance(external, 'finalized')) : BigInt(asset === 'TNK' ? await tnkOf('bob') : await resetOf('bob'));
        assert.equal(received - recipientBefore, BigInt(amount), asset + ' exact recipient balance');
        const after = (await walletInfo()).balances;
        if (asset === 'SOL') {
          const tx = await connection.getTransaction(result.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
          assert.ok(tx?.meta && tx.meta.err === null);
          assert.equal(BigInt(after.SOL.wallet), BigInt(MIN_SOL) - BigInt(tx.meta.fee));
        } else if (asset === 'TNK') assert.equal(BigInt(after.TNK.wallet), BigInt(MIN_TNK) - BigInt(MSB_FEE));
        else assert.equal(after[asset].wallet, '0');
        if (asset === 'RESET') assert.equal(BigInt(after.TNK.wallet), BigInt(current.TNK.wallet) - BigInt(MSB_FEE));
      }
      results.push({ name, ok: true, automaticSetup: true, exactBalances: true });
      continue;
    }
    if (name === 'crowd' || name === 'silent-taker') {
      const takers = ['bob', 'charlie', 'dana', 'erin'];
      const balances = async () => Object.fromEntries(await Promise.all(traders.map(async n => [n, { usdc: await usdcOf(n), reset: await resetOf(n), tnk: await tnkOf(n) }])));
      const fundsBefore = await balances(), vaultBefore = BigInt(await feeVault()), platformBefore = BigInt(await feeVault(true));
      const amount = '5000', price = '2000';
      const offer = await api('alice', 'POST', '/offer', { pair: 'RESET/USDC', side: 'sell', baseAmount: name === 'crowd' ? '10000' : amount, price, ttlSec: 900 });
      await until('offer visible to all takers', async () => (await Promise.all(takers.map(n => api(n, 'GET', '/status')))).every(s => s.offers.some(o => o.offerId === offer.offerId)));
      const start = Date.now(), selected = name === 'crowd' ? takers : ['bob'];
      if (name === 'silent-taker') await setAttack({ kind: name, takerKey: ids.bob.publicKey });
      const requests = selected.map(n => ({ n, at: Date.now(), promise: api(n, 'POST', '/take', { offerId: offer.offerId, baseAmount: amount, price }) }));
      assert.ok(Math.max(...requests.map(x => x.at)) - Math.min(...requests.map(x => x.at)) < 1000);
      const taken = await Promise.all(requests.map(async x => ({ n: x.n, ...await x.promise })));
      if (name === 'silent-taker') {
        await gateSeen('bob', 'DEX_E2E_SILENT_AFTER_ACCEPT');
        await roleProc.bob.stop();
        await until('silent taker reservation released', async () => {
          const s = await api('alice', 'GET', '/status'), mine = s.mine.find(o => o.offerId === offer.offerId);
          return s.trades.some(t => t.key.startsWith(offer.offerId) && t.phase === 'aborted') && mine?.available === amount && mine.reserved === '0';
        }, Math.max(1, 60000 - (Date.now() - start)), 100);
        assert.ok(Date.now() - start < 60000);
        await setAttack({});
        taken.push({ n: 'charlie', ...await api('charlie', 'POST', '/take', { offerId: offer.offerId, baseAmount: amount, price }) });
      } else {
        const refused = await until('two prompt declines', async () => {
          const states = await Promise.all(taken.map(async t => ({ n: t.n, trade: (await api(t.n, 'GET', '/status')).trades.find(x => x.key === t.key) })));
          const declined = states.filter(x => x.trade?.phase === 'aborted');
          return declined.length === 2 ? declined : null;
        }, Math.max(1, 15000 - (Date.now() - start)), 50);
        // Each decline carries proof-of-work, so allow 15 s instead of 5 s.
        assert.ok(Date.now() - start < 15000);
        assert.ok(refused.every(x => ['insufficient', 'busy'].includes(x.trade.reason)));
      }
      const expectedCount = name === 'crowd' ? 2 : 1;
      const finished = await until(name + ' settlements', async () => {
        const maker = (await api('alice', 'GET', '/status')).trades.filter(t => t.key.startsWith(offer.offerId));
        const states = await Promise.all(taken.filter(t => name !== 'silent-taker' || t.n !== 'bob').map(async t => ({ n: t.n, trade: (await api(t.n, 'GET', '/status')).trades.find(x => x.key === t.key) })));
        return maker.filter(t => t.phase === 'complete').length === expectedCount && states.every(x => ['complete', 'aborted'].includes(x.trade?.phase)) ? states : null;
      });
      await until('crowd fee accounting', async () => BigInt(await feeVault()) > vaultBefore);
      const winners = finished.filter(x => x.trade.phase === 'complete');
      assert.equal(winners.length, expectedCount);
      const fees = calculateFees('100000', 10, 50), fundsAfter = await balances();
      for (const n of traders) {
        const winner = winners.some(x => x.n === n), count = BigInt(expectedCount);
        assert.equal(BigInt(fundsAfter[n].usdc) - BigInt(fundsBefore[n].usdc), n === 'alice' ? fees.netAmount * count : winner ? -fees.totalAmount : 0n, n + ' exact USDC');
        assert.equal(BigInt(fundsAfter[n].reset) - BigInt(fundsBefore[n].reset), n === 'alice' ? -BigInt(amount) * count : winner ? BigInt(amount) : 0n, n + ' exact RESET');
        // The RESET seller pays the MSB fee for each of its transfers.
        assert.equal(BigInt(fundsAfter[n].tnk) - BigInt(fundsBefore[n].tnk), n === 'alice' ? BigInt(MSB_FEE_SPENT) * count : 0n, n + ' exact TNK');
      }
      assert.equal(BigInt(await feeVault()) - vaultBefore, fees.tradeFeeAmount * BigInt(expectedCount));
      assert.equal(BigInt(await feeVault(true)) - platformBefore, fees.platformFeeAmount * BigInt(expectedCount));
      results.push({ name, ok: true, completed: expectedCount, declined: name === 'crowd' ? 2 : 0, exactBalances: true });
      continue;
    }
    if (name === 'relay-none') {
      const offer = await api('alice', 'POST', '/offer', { pair: 'RESET/USDC', side: 'sell', baseAmount: '50000', price: '2000', ttlSec: 900 });
      await assert.rejects(api('bob', 'POST', '/take', { offerId: offer.offerId, price: offer.price }), /Unknown offer|Not enough signers online/);
      await sleep(65000);
      const states = await Promise.all(['alice', 'bob'].map(n => api(n, 'GET', '/status')));
      assert.ok(states.every(s => s.trades.length === 0), 'no lock or transfer can start');
      const after = { alice: await usdcOf('alice'), bob: await usdcOf('bob'), aliceReset: await resetOf('alice'), bobReset: await resetOf('bob'), aliceTnk: await tnkOf('alice'), bobTnk: await tnkOf('bob') };
      assert.deepEqual(after, before);
      const audit = await auditBridges.bob.call('relay_audit', {});
      assert.deepEqual(audit.direct, []); assert.deepEqual(audit.relayed, []);
      assert.deepEqual(audit.relay.configured_relays, []);
      results.push({ name, ok: true, noFundsMoved: true, audit }); continue;
    }
    if (['stake-withdraw', 'stake-exact-withdraw', 'stake-late-funding', 'stake-partial-funding', 'stake-rewards', 'stake-free-expiry', 'stake-penalty', 'stake-penalty-cases', 'stake-epoch-handoff'].includes(name)) {
      const seed = await trade('stake-price-seed', { maker: 'alice', taker: 'bob', pair: 'RESET/USDC', side: 'sell', baseAmount: '50000', price: '2000' });
      assert.equal(seed.ta.phase, 'complete'); assert.equal(seed.tb.phase, 'complete');
      const historyKeys = await openKeyring(path.join(dirs.alice, 'data/keyring.json'), PASSWORD);
      try {
        const store = openStore(path.join(dirs.alice, 'data'), historyKeys.storeKey, { readOnly: true });
        const state = store.list('trade-').map(n => store.get(n)).find(t => t.role === 'seller' && t.state.tradeId === seed.ta.tradeId).state;
        // A completed trader can still be waiting for finalized settlement.
        // Any later warp must start from a bank that includes the real claim.
        const history = await until('seed settlement finalized before stake recovery', async () => {
          const h = await stakeEscrowHistory({ terms: state.terms, hashHex: state.H, fromSlot: stakeHistoryFromSlot,
            throughSlot: await connection.getSlot('finalized'), endpoints: solana.endpoints });
          return h.status === 'complete' && h.escrowState === 'claimed' && h.settlements.some(s => s.state === 'claimed') && h;
        }, 120000, 2000);
        assert.equal(history.status, 'complete'); assert.equal(history.escrowState, 'claimed');
        assert.equal(history.locks.length, 1); assert.equal(history.settlements.length, 1);
        assert.equal(qualifyingLock({ ...history.locks[0], finalized: true, historyComplete: true }, state.terms.sendBy, 120), true);
        log('exact historical timely lock and claimed settlement verified');
      } finally { historyKeys.storeKey.fill(0); historyKeys.solanaSecret?.fill(0); }
      const beforeStake = await resetOf('alice');
      if (lateFundingMode) {
        const full = name === 'stake-late-funding', beforeTnk = BigInt(await tnkOf('alice'));
        await setAttack({ stakeFunding: full ? 'late-full' : 'late-tnk' });
        // The venue certifies the seed completion a few seconds after it
        // completes. Only that refusal is retried, and only while nothing moved.
        await until('funding attempt reaches the chain', async () => {
          try { await api('alice', 'POST', '/stake/deposit', { amount: '0.00025' }); return true; }
          catch (e) {
            if (!e.message.includes('A certified completed RESET trade is required')) { log('interrupted funding', e.message); return true; }
            assert.equal(BigInt(await tnkOf('alice')), beforeTnk); assert.equal(BigInt(await resetOf('alice')), BigInt(beforeStake));
            log('funding waits for the certified price', e.message); return false;
          }
        }, 120000, 3000);
        await until('unadmitted funding moved', async () => {
          const stake = (await api('alice', 'GET', '/stake')).stake;
          return stake.operationPending && stake.free === '0' && BigInt(await tnkOf('alice')) < beforeTnk &&
            BigInt(await resetOf('alice')) === BigInt(beforeStake) - (full ? 25000n : 0n);
        }, 240000, 5000);
        await roleProc.alice.stop(); validator = await validator.warp(3700); connection = validator.connection;
        await setAttack({}); await startRole('alice');
        await until('late unadmitted funding refunded', async () => {
          const stake = (await api('alice', 'GET', '/stake')).stake; return !stake.operationPending && stake.locked === '0';
        }, 240000, 5000);
        assert.equal(await resetOf('alice'), beforeStake);
        await roleProc.alice.stop(); await startRole('alice'); await sleep(10000);
        assert.equal(await resetOf('alice'), beforeStake);
        results.push({ name, ok: true, refundedReset: full ? '25000' : '0', tnkOnly: !full, noAdmission: true, restarted: true });
        await fs.writeFile(path.join(root, 'stake-results.json'), JSON.stringify(results, null, 2));
        continue;
      }
      let depositStarted = false;
      await until('stake deposit certified', async () => {
        const current = (await api('alice', 'GET', '/stake')).stake;
        if (current.free === '25000' && !current.operationPending) return true;
        try { if (!depositStarted) { await api('alice', 'POST', '/stake/deposit', { amount: '0.00025' }); depositStarted = true; } }
        catch (e) { log('deposit waiting', e.message); }
        const stake = (await api('alice', 'GET', '/stake')).stake;
        if (stake.operationPending) depositStarted = true;
        return stake.free === '25000' && !stake.operationPending;
      }, 240000, 5000);
      assert.equal(BigInt(await resetOf('alice')), BigInt(beforeStake) - 25000n);
      log('stake principal funded and certified');
      if (name === 'stake-penalty' || name === 'stake-penalty-cases' || handoffMode) {
        await until('stake admission armed', async () => Math.floor(Date.now() / 1000) + PARAMS.sendWindowSec + 120 >= registry.sellerBond.enforceAfter, 600000, 1000);
        const readLocal = async (n, select) => {
          const ring = await openKeyring(path.join(dirs[n], 'data/keyring.json'), PASSWORD);
          try { return select(openStore(path.join(dirs[n], 'data'), ring.storeKey, { readOnly: true })); }
          finally { ring.storeKey.fill(0); ring.solanaSecret?.fill(0); }
        };
        let successor;
        // A trade's own escrow vault: other cases' refunds reach the buyer's wallet at any time.
        const escrowHeld = async state => {
          const { deriveEscrowPda, deriveVaultAta } = await import('../../src/solana/escrow.js');
          const vault = deriveVaultAta(deriveEscrowPda(state.H).pda, mint);
          return await connection.getAccountInfo(vault, 'finalized') ? (await connection.getTokenAccountBalance(vault, 'finalized')).value.amount : '0';
        };
        const escrowTotal = async state => {
          const { calculateFees } = await import('../../src/solana/escrow.js');
          return String(calculateFees(state.terms.quoteAmount, state.terms.fees.platformFeeBps, state.terms.fees.tradeFeeBps).totalAmount);
        };
        const rows = await stakePenaltyCases({ api, until, setAttack, resetOf, usdcOf, escrowHeld, escrowTotal, network, wallets, log,
          cases: process.env.DEX_E2E_STAKE_CASES?.split(',') ?? (handoffMode ? ['epoch-handoff'] : penaltyCasesMode ? undefined : ['no-show']),
          saveResults: rows => fs.writeFile(path.join(root, 'stake-results.json'), JSON.stringify(rows, null, 2)),
          readJob: tradeId => readLocal('service', store => store.list('stake-penalty-job-').map(n => store.get(n)).find(j => j.reservation.body.tradeId === tradeId)),
          readBuyer: key => readLocal('bob', store => store.get(`trade-${key}`)?.state),
          clock: () => finalizedStakeClock(solana), restart: async n => { await roleProc[n].stop(); await startRole(n); },
          finishDeferred: async expected => {
            const availableAt = await until('certified deferred withdrawal maturity', async () => {
              const s = (await api('alice', 'GET', '/stake')).stake;
              return s.withdrawing === '25000' && Number.isSafeInteger(s.withdrawingUntil) && s.withdrawingUntil;
            }, 180000, 2000);
            const remaining = Math.max(1, availableAt - (await finalizedStakeClock(solana)).at + 60);
            await roleProc.alice.stop(); validator = await validator.warp(remaining); connection = validator.connection;
            assert.ok((await finalizedStakeClock(solana)).at >= availableAt, 'certified full cooldown elapsed');
            await startRole('alice');
            await until('deferred stake returned after closure and wait', async () => {
              const s = (await api('alice', 'GET', '/stake')).stake; return s.locked === '0' && !s.operationPending;
            }, 240000, 5000);
            assert.equal(BigInt(await resetOf('alice')), expected);
          },
          handoff: async state => {
            const quiesced = await api('service', 'POST', '/stake/quiesce', {});
            successor = structuredClone(registry.sellerBond); successor.acceptNew = false;
            successor.epoch = { ...successor.epoch, id: randomBytes(32).toString('hex'), startAt: quiesced.stopNewAt,
              members: ['s2', 's3', 's4', 's5'].map(n => ({ dexKey: ids[n].publicKey, boxKey: boxes[n].publicKey })) };
            const active = successor.economics.active; active.receipts = [];
            for (const n of ['s2', 's3', 's4']) {
              const ring = await openKeyring(path.join(dirs[n], 'data/keyring.json'), PASSWORD);
              try { active.receipts.push({ from: ids[n].publicKey, at: active.publishedAt,
                sig: Buffer.from(ed25519.sign(publicationBytes(active.policyId, active.publishedAt,
                  { networkId: successor.networkId, venueKey: successor.venueKey, epochId: successor.epoch.id }), Buffer.from(ring.identity.secretKey, 'hex'))).toString('hex') }); }
              finally { ring.storeKey.fill(0); }
            }
            await until('announced original epoch stop', async () => (await finalizedStakeClock(solana)).at >= quiesced.stopNewAt, 90000, 1000);
            const moved = await until('successor capacity adoption', async () => {
              try { return await api('service', 'POST', '/stake/handoff', { nextPolicy: successor }); }
              catch (e) { log('handoff waiting', e.message); return false; }
            }, 180000, 3000);
            assert.equal(moved.state, 'draining'); assert.equal(moved.previousEpochId, state.terms.bond.epochId);
            assert.ok(moved.adopted >= 3); assert.equal(moved.acceptNew, false);
            for (const n of ['service', 's1', 's5']) { await roleProc[n].stop(); await startRole(n); }
            await until('successor registry reaches seller', async () => (await api('alice', 'GET', '/status')).registryVersion === (await api('service', 'GET', '/status')).registryVersion, 60000);
            const replay = await api('service', 'POST', '/stake/handoff', { nextPolicy: successor });
            assert.deepEqual(replay, moved);
            const resumed = await until('successor history and liability reconciliation', async () => {
              try { return await api('service', 'POST', '/stake/resume', {}); }
              catch (e) { log('resume waiting', e.message); return false; }
            }, 180000, 5000);
            assert.equal(resumed.state, 'active'); assert.equal(resumed.acceptNew, true);
            await until('active successor registry reaches seller', async () => (await api('alice', 'GET', '/status')).registryVersion === (await api('service', 'GET', '/status')).registryVersion, 60000);
            log('quiesced A to B capacity handoff survived venue/original/new signer restart');
          },
          lateLock: async state => {
            const t = state.terms;
            await send(connection, solKeys.bob, [buildInitInstruction({ payer: solKeys.bob.publicKey, payerTokenAccount: usdc('bob'),
              paymentHashHex: state.H, recipient: t.seller.solRecipient, refund: t.buyer.solPayer, refundAfter: t.refundAfter,
              amount: t.quoteAmount, mint, expectedPlatformFeeBps: t.fees.platformFeeBps,
              expectedTradeFeeBps: t.fees.tradeFeeBps, tradeFeeCollector: t.fees.collector })]);
            const history = await until('exact finalized late lock', async () => {
              const h = await stakeEscrowHistory({ terms: t, hashHex: state.H, fromSlot: t.bond.historyFromSlot,
                throughSlot: (await finalizedStakeClock(solana)).slot, endpoints: solana.endpoints });
              if (h.status !== 'complete' && await connection.getFirstAvailableBlock() > t.bond.historyFromSlot)
                throw new Error(`Test validator pruned the escrow history from slot ${t.bond.historyFromSlot}`);
              return h.status === 'complete' && h.locks.length === 1 && h;
            }, 60000);
            assert.equal(qualifyingLock({ ...history.locks[0], finalized: true, historyComplete: true }, t.sendBy, 120), false);
          } });
        results.push(...rows); if (rows.some(r => !r.ok)) failed = true;
        if (handoffMode && rows.every(r => r.ok)) {
          await until('old reservation released locally', async () => (await api('alice', 'GET', '/stake')).stake.free === '25000', 120000);
          let successorDeposit = false;
          await until('new successor stake certified', async () => {
            const s = (await api('alice', 'GET', '/stake')).stake;
            if (s.free === '50000' && !s.operationPending) return true;
            if (!successorDeposit && !s.operationPending) { await api('alice', 'POST', '/stake/deposit', { amount: '0.00025' }); successorDeposit = true; }
            return false;
          }, 240000, 5000);
          await sleep(20000);
          const fresh = await trade('stake-successor-bonded-trade', { maker: 'alice', taker: 'bob', pair: 'RESET/USDC', side: 'sell', baseAmount: '50000', price: '2000' });
          assert.equal(fresh.ta.phase, 'complete'); assert.equal(fresh.tb.phase, 'complete');
          const freshState = await readLocal('bob', store => store.get(`trade-${fresh.taken.key}`)?.state);
          assert.equal(freshState.terms.bond.epochId, successor.epoch.id);
          await until('successor reservation released', async () => (await api('alice', 'GET', '/stake')).stake.free === '50000', 120000);
          const beforeReward = BigInt(await resetOf('alice'));
          await network.gift(wallets.payout.publicKey, '100'); await network.sync(); await sleep(15000); await network.mineOne();
          const height = (await network.admin.protocol.instance.api.coinState()).counted;
          await until('successor reward accrued and paid', async () => {
            const s = await api('payout', 'GET', '/status');
            return s.height === height && s.accounts.some(a => a.address === wallets.alice.address && a.paidTotal === '100');
          }, 180000, 3000);
          assert.equal(BigInt(await resetOf('alice')), beforeReward + 100n);
          const rewardEpoch = await readLocal('payout', store => store.get('stake-payout-cursor')?.epochId);
          assert.equal(rewardEpoch, successor.epoch.id);
          results.push({ name: 'epoch-handoff-new-trade-and-reward', ok: true, epochId: successor.epoch.id, paidReset: '100', newBondedTrade: freshState.tradeId });
          const beforeReturn = BigInt(await resetOf('alice'));
          const freeze = await api('alice', 'POST', '/stake/withdraw', { amount: 'all' });
          assert.equal(freeze.pending, true); assert.ok(freeze.availableAt);
          await roleProc.alice.stop(); validator = await validator.warp(3700); connection = validator.connection;
          await startRole('alice');
          await until('original stake returned under successor registry', async () => (await api('alice', 'GET', '/stake')).stake.locked === '0', 240000, 5000);
          const expected = (beforeReturn + 50000n).toString(); assert.equal(await resetOf('alice'), expected);
          for (const n of ['s1', 's2', 's3', 's4', 's5']) await readLocal(n, store => {
            const capacity = store.list('stake-capacity-').map(name => store.get(name)).find(s => s?.tokens);
            assert.ok(Object.values(capacity.pieces).every(p => p.retired)); assert.equal(capacity.tokens[1].generation, 1);
            if (n !== 's1') assert.equal(capacity.epochId, successor.epoch.id);
          });
          await roleProc.alice.stop(); await startRole('alice'); await sleep(20000);
          assert.equal(await resetOf('alice'), expected);
          results.push({ name: 'mixed-epoch-return', ok: true, originalReservationSettled: true, changedMember: true,
            principalReturned: '50000', admissionState: 'active', restarted: true, noDoubleRetirement: true });
          await fs.writeFile(path.join(root, 'stake-results.json'), JSON.stringify(results, null, 2));
          log('A reservation settled; original principal returned under B exactly once');
        }
        continue;
      }
      if (name === 'stake-free-expiry') {
        const expiryUpperBound = (await finalizedStakeClock(solana)).at + registry.sellerBond.custody.lifetimeSec;
        // Keep the long warp before epoch snapshot boundaries in this fixture,
        // and independently check Unix time instead of inferring it from slots.
        await roleProc.alice.stop(); validator = await validator.warp(60000); connection = validator.connection;
        assert.ok((await finalizedStakeClock(solana)).at >= expiryUpperBound, 'local finalized clock passes the original expiry');
        await startRole('alice');
        await until('free expiry returns without renewal after restart', async () => (await api('alice', 'GET', '/stake')).stake.locked === '0', 240000, 5000);
        assert.equal(await resetOf('alice'), beforeStake);
        results.push({ name, ok: true, depositReset: '25000', freeExpiry: true, restarted: true, principalReturned: true, historicalLockVerified: true });
        log('free stake expiry passed'); continue;
      }
      if (name === 'stake-rewards') {
        await until('payout starts at current counted height', async () => (await api('payout', 'GET', '/status')).observedHeight !== null);
        const mineRewardBlock = async () => {
          await network.mineOne();
          const target = (await network.admin.protocol.instance.api.coinState()).counted;
          return until('payout checkpoint ' + target, async () => {
            const status = await api('payout', 'GET', '/status'); return status.height === target && status;
          }, 180000, 3000);
        };
        const empty = await mineRewardBlock(); assert.equal(empty.summary.body.state, 'empty'); assert.equal(empty.summary.body.accrued, '0');
        const beforeReward = await resetOf('alice');
        await network.gift(wallets.payout.publicKey, '100'); await network.sync();
        const active = await mineRewardBlock(); assert.equal(active.summary.body.accrued, '100');
        await until('ordinary pool payout confirmed', async () => {
          const status = await api('payout', 'GET', '/status'); return status.accounts.some(a => a.address === wallets.alice.address && a.paidTotal === '100');
        }, 120000);
        assert.equal(BigInt(await resetOf('alice')) - BigInt(beforeReward), 100n);
        assert.equal(await resetOf('payout'), '0');
        await roleProc.payout.stop(); await startRole('payout');
        const emptyAgain = await mineRewardBlock(); assert.equal(emptyAgain.summary.body.accrued, '0');
        assert.equal(BigInt(await resetOf('alice')) - BigInt(beforeReward), 100n, 'restart never pays twice');
        await network.gift(wallets.payout.publicKey, '100'); await network.sync();
        await mineRewardBlock();
        await until('reward refill pays only the next block', async () => (await api('payout', 'GET', '/status')).accounts.some(a => a.paidTotal === '200'), 120000);
        await until('trader receives authenticated reward status', async () => (await api('alice', 'GET', '/stake')).rewards.paidTotal === '200', 60000);
        assert.equal(BigInt(await resetOf('alice')) - BigInt(beforeReward), 200n);
        results.push({ name, ok: true, depositReset: '25000', paidReset: '200', emptyPaused: true, refillResumed: true, restarted: true, noDoublePay: true });
        log('stake reward payout passed'); continue;
      }
      const exact = name === 'stake-exact-withdraw';
      const freeze = await api('alice', 'POST', '/stake/withdraw', { amount: exact ? '0.0001' : 'all' });
      assert.equal(freeze.pending, true); assert.ok(freeze.availableAt);
      assert.equal((await api('alice', 'GET', '/stake')).stake.free, '0');
      assert.equal((await api('alice', 'GET', '/stake')).stake.withdrawing, '25000');
      assert.equal(BigInt(await resetOf('alice')), BigInt(beforeStake) - 25000n, 'wait cannot release principal early');
      let originalPrice;
      const priceDiagnostics = async kind => (await fs.readFile(path.join(logDir, 'role-service.log'), 'utf8'))
        .split('\n').slice(0, -1).filter(line => line.startsWith('DEX_E2E_PRICE_' + kind + ' '))
        .map(line => JSON.parse(line.slice(('DEX_E2E_PRICE_' + kind + ' ').length)));
      if (exact) {
        originalPrice = await until('original seed price certificate', async () =>
          (await priceDiagnostics('CERTIFIED')).find(p => p.entry.tradeId === seed.ta.tradeId), 60000);
      }
      const beforeWarp = (await finalizedStakeClock(solana)).at;
      const nextDay = (Math.floor(beforeWarp / 86400) + 1) * 86400;
      const targetTime = Math.max(freeze.availableAt + 60, exact ? nextDay + 60 : 0);
      await roleProc.alice.stop();
      validator = await validator.warp(Math.max(1, targetTime - beforeWarp)); connection = validator.connection;
      const afterWarp = (await finalizedStakeClock(solana)).at;
      assert.ok(afterWarp >= targetTime, 'finalized time passes certified maturity and the requested boundary');
      if (exact) {
        assert.ok(afterWarp >= nextDay, 'fixture crosses an actual UTC day');
        assert.ok(afterWarp - originalPrice.entry.completedAt <= registry.sellerBond.economics.active.settings.priceLookbackSec);
        log('exact withdrawal crossed UTC midnight using unchanged certified history', JSON.stringify({
          completedAt: originalPrice.entry.completedAt, beforeWarp, afterWarp, availableAt: freeze.availableAt }));
      }
      await startRole('alice');
      await until('stake collection after wait and restart', async () => {
        const stake = (await api('alice', 'GET', '/stake')).stake;
        return stake.locked === (exact ? '15000' : '0') && !stake.operationPending;
      }, 240000, 5000);
      assert.equal(await resetOf('alice'), (BigInt(beforeStake) - (exact ? 15000n : 0n)).toString(), 'principal returns exactly to original seller');
      if (exact) {
        await roleProc.alice.stop(); await startRole('alice'); await sleep(10000);
        assert.equal(await resetOf('alice'), (BigInt(beforeStake) - 15000n).toString(), 'replacement restart cannot duplicate the return');
        const ring = await openKeyring(path.join(dirs.alice, 'data/keyring.json'), PASSWORD);
        try {
          const store = openStore(path.join(dirs.alice, 'data'), ring.storeKey, { readOnly: true });
          const pieces = store.list('stake-ledger-').flatMap(n => Object.values(store.get(n).pieces));
          const original = pieces.find(p => p.state === 'retired'), replacement = pieces.find(p => p.state === 'free');
          assert.equal(replacement.descriptor.expiresAt, original.descriptor.expiresAt);
          assert.equal(replacement.descriptor.principalReset, '15000');
        } finally { ring.storeKey.fill(0); }
        const reference = (await priceDiagnostics('REFERENCE')).find(p => p.cutoffAt >= nextDay);
        assert.ok(reference, 'new-day head is freshly certified');
        assert.equal(reference.lastTradeId, seed.ta.tradeId);
        assert.equal(reference.lastEntryHash, originalPrice.hash);
        assert.equal(reference.headPosition, 1, 'no auxiliary trade is needed to unblock exact withdrawal');
        assert.equal(reference.utcDay, new Date(originalPrice.entry.completedAt * 1000).toISOString().slice(0, 10));
        assert.notEqual(reference.utcDay, new Date(reference.cutoffAt * 1000).toISOString().slice(0, 10));
      }
      results.push({ name, ok: true, depositReset: '25000', waited: true, restarted: true, principalReturned: true,
        ...(exact ? { exactReturn: '10000', surplus: '15000', originalExpiry: true, crossedMidnight: true,
          historicalPrice: true, originalCompletionAt: originalPrice.entry.completedAt, beforeWarp, afterWarp } : {}) });
      await fs.writeFile(path.join(root, 'stake-results.json'), JSON.stringify(results, null, 2));
      log('stake withdrawal passed'); continue;
    }
    if (name === 'reset-sell' || name === 'relay') r = await trade(name, { maker: 'alice', taker: 'bob', pair: 'RESET/USDC', side: 'sell', baseAmount: '50000', price: '2000' });
    if (name === 'tnk-buy') r = await trade(name, { maker: 'alice', taker: 'bob', pair: 'TNK/USDC', side: 'buy', baseAmount: '2000000000000000000', price: '0.75' });
    if (name === 'signers-offline') {
      await roleProc.s5.stop(); await waitOnline(4);
      const gate = { kind: name, sellerKey: ids.alice.publicKey, release: false }; await setAttack(gate);
      r = await trade(name, { maker: 'bob', taker: 'alice', pair: 'RESET/USDC', side: 'buy', baseAmount: '30000', price: '1500',
        afterTake: async () => { await gateSeen('alice', 'DEX_E2E_TRANSFER_SENT'); await roleProc.s4.stop(); await setAttack({ ...gate, release: true }); } });
    }
    if (name === 'not-enough-signers') {
      await roleProc.s4.stop(); await roleProc.s5.stop(); await waitOnline(3);
      const offer = await api('alice', 'POST', '/offer', { pair: 'RESET/USDC', side: 'sell', baseAmount: '30000', price: '1500', ttlSec: 900 });
      await until('offer visible', async () => (await api('bob', 'GET', '/status')).offers.some(o => o.offerId === offer.offerId));
      await assert.rejects(api('bob', 'POST', '/take', { offerId: offer.offerId, price: offer.price }), /Not enough signers online/);
      for (const who of ['alice', 'bob']) assert.ok(!(await api(who, 'GET', '/status')).trades.some(t => t.key.startsWith(offer.offerId)));
      r = { ta: { phase: 'refused' }, tb: { phase: 'refused', reason: 'Not enough signers online' } };
      await api('alice', 'POST', '/cancel', { offerId: offer.offerId });
    }
    if (name === 'signers-vanish-before-ack') {
      const gate = { kind: name, buyerKey: ids.bob.publicKey, release: false }; await setAttack(gate);
      r = await trade(name, { maker: 'alice', taker: 'bob', pair: 'RESET/USDC', side: 'sell', baseAmount: '30000', price: '1500',
        afterTake: async () => {
          const signed = await gateSeen('bob', 'DEX_E2E_TERMS_SIGNED');
          for (const key of signed.committee.slice(0, 3)) {
            const signer = ['s1', 's2', 's3', 's4', 's5'].find(n => ids[n].publicKey === key);
            assert.ok(signer); await roleProc[signer].stop();
          }
          await setAttack({ ...gate, release: true });
        } });
      assert.equal(r.ta.phase, 'aborted'); assert.equal(r.tb.phase, 'aborted'); assert.ok(r.tb.H);
      assert.equal(await connection.getAccountInfo(deriveEscrowPda(r.tb.H).pda, 'finalized'), null, 'no escrow exists');
      const buyerLog = await fs.readFile(path.join(logDir, 'role-bob.log'), 'utf8');
      const sellerLog = await fs.readFile(path.join(logDir, 'role-alice.log'), 'utf8');
      assert.ok(!buyerLog.includes('DEX_E2E_LOCK_ATTEMPTED ' + r.tb.tradeId));
      assert.ok(!sellerLog.includes('DEX_E2E_TRANSFER_AUTHORIZED ' + r.ta.tradeId));
    }
    if (['cheating-dealer', 'cheating-certificate'].includes(name)) {
      for (const n of ['s1', 's2', 's3', 's4', 's5', ...traders]) {
        if (roleProc[n].child.exitCode !== null || roleProc[n].child.signalCode !== null) await startRole(n);
      }
      await setAttack({ kind: name, buyerKey: ids.bob.publicKey, certificateFile });
      r = await trade(name, { maker: 'alice', taker: 'bob', pair: name === 'cheating-dealer' ? 'RESET/USDC' : 'TNK/USDC', side: 'sell',
        baseAmount: name === 'cheating-dealer' ? '10000' : '1000000000000000000', price: name === 'cheating-dealer' ? '1000' : '1' });
      await setAttack({});
      const buyerLog = await fs.readFile(path.join(logDir, 'role-bob.log'), 'utf8');
      const sellerLog = await fs.readFile(path.join(logDir, 'role-alice.log'), 'utf8');
      assert.ok(buyerLog.includes('DEX_E2E_ATTACK_APPLIED ' + JSON.stringify({ kind: name, tradeId: r.tb.tradeId })), 'attack was actually injected');
      assert.ok(!sellerLog.includes('DEX_E2E_TRANSFER_AUTHORIZED ' + r.ta.tradeId), 'seller never authorized a transfer');
      // The seller checks the certificate itself, but the buyer's abort (after the signers refused) can arrive first.
      if (name === 'cheating-certificate') assert.ok(['Invalid lock certificate', 'Peer aborted: Signers did not confirm'].includes(r.ta.reason), r.ta.reason);
      for (const signer of ['s1', 's2', 's3', 's4', 's5']) {
        const refused = (await api(signer, 'GET', '/status')).trades.find(t => t.tradeId === r.ta.tradeId);
        assert.equal(refused?.phase, 'aborted', signer + ' refused before acking');
        assert.equal(refused.reason, name === 'cheating-dealer' ? 'Invalid dealing' : 'Invalid lock certificate');
      }
    }
    if (name === 'unsent-refund') {
      await setAttack({ kind: 'seller-no-send-refund', sellerAddr: wallets.alice.address });
      const offer = await api('alice', 'POST', '/offer', { pair: 'RESET/USDC', side: 'sell', baseAmount: '10000', price: '1000', ttlSec: 3600 });
      await until('unsent offer visible', async () => (await api('bob', 'GET', '/status')).offers.some(o => o.offerId === offer.offerId));
      const taken = await api('bob', 'POST', '/take', { offerId: offer.offerId, price: offer.price });
      await until('buyer locked without seller transfer', async () => {
        const buyer = (await api('bob', 'GET', '/status')).trades.find(t => t.key === taken.key);
        const seller = (await api('alice', 'GET', '/status')).trades.find(t => t.key.startsWith(offer.offerId));
        return buyer?.phase === 'locked' && seller?.phase === 'transferring';
      }, 240000);
      const reserved = (await api('alice', 'GET', '/status')).mine.find(o => o.offerId === offer.offerId);
      assert.deepEqual([reserved.available, reserved.reserved, reserved.filled], ['0', '10000', '0']);
      log('buyer locked; seller sent nothing; waiting for refund');
      await until('buyer refunded and seller reconciled', async () => {
        const buyer = (await api('bob', 'GET', '/status')).trades.find(t => t.key === taken.key);
        const seller = (await api('alice', 'GET', '/status')).trades.find(t => t.key.startsWith(offer.offerId));
        return buyer?.phase === 'refunded' && seller?.phase === 'lost';
      }, (PARAMS.refundSec + 240) * 1000);
      const restored = async () => {
        const o = (await api('alice', 'GET', '/status')).mine.find(o => o.offerId === offer.offerId);
        assert.ok(o, 'the unexpired offer remains open');
        assert.deepEqual([o.available, o.reserved, o.filled], ['10000', '0', '0']);
      };
      await restored();
      await until('restored offer announced', async () => (await api('bob', 'GET', '/status')).offers.some(o => o.offerId === offer.offerId && o.baseAmount === '10000'), 60000);
      await roleProc.alice.stop(); await startRole('alice');
      await restored();
      for (const n of ['alice', 'bob']) {
        assert.equal(await usdcOf(n), before[n], n + ' USDC returned or unchanged');
        assert.equal(await resetOf(n), before[n + 'Reset'], n + ' RESET never moved');
        assert.equal(await tnkOf(n), before[n + 'Tnk'], n + ' TNK never moved');
      }
      results.push({ name, ok: true, seller: 'lost', buyer: 'refunded', available: '10000', filled: '0', restart: true });
      continue;
    }
    if (name === 'refund') {
      // Gate the buyer after signed terms, then stop the seller before the deal can authorize sending.
      const gate = { kind: name, buyerKey: ids.alice.publicKey, release: false }; await setAttack(gate);
      const offer = api('bob', 'POST', '/offer', { pair: 'RESET/USDC', side: 'sell', baseAmount: '10000', price: '1000', ttlSec: 900 });
      const o = await offer;
      await until('offer visible', async () => (await api('alice', 'GET', '/status')).offers.some(x => x.offerId === o.offerId), 60000);
      const taken = await api('alice', 'POST', '/take', { offerId: o.offerId, price: o.price });
      await gateSeen('alice', 'DEX_E2E_TERMS_SIGNED');
      await roleProc.bob.stop();
      await setAttack({ ...gate, release: true });
      log('seller stopped before sending');
      await until('buyer locked', async () => ['locked'].includes((await api('alice', 'GET', '/status')).trades.find(t => t.key === taken.key)?.phase), 240000);
      log('buyer locked; waiting for the refund');
      const end = await until('refund', async () => {
        const t = (await api('alice', 'GET', '/status')).trades.find(x => x.key === taken.key);
        return ['refunded', 'complete'].includes(t?.phase) ? t : null;
      }, (PARAMS.refundSec + 240) * 1000);
      r = { ta: end, tb: end };
      log('refund', end.phase);
    }
    const after = { alice: await usdcOf('alice'), bob: await usdcOf('bob'), aliceReset: await resetOf('alice'), bobReset: await resetOf('bob'), aliceTnk: await tnkOf('alice'), bobTnk: await tnkOf('bob') };
    const delta = k => (BigInt(after[k]) - BigInt(before[k])).toString();
    if (['reset-retry', 'tnk-retry'].includes(name)) {
      const fees = calculateFees(r.taken.quoteAmount, 10, 50);
      assert.equal(delta('alice'), fees.netAmount.toString()); assert.equal(delta('bob'), (-fees.totalAmount).toString());
      assert.equal(delta('aliceReset'), name === 'reset-retry' ? '-50000' : '0');
      assert.equal(delta('bobReset'), name === 'reset-retry' ? '50000' : '0');
      assert.equal(delta('aliceTnk'), (BigInt(MSB_FEE_SPENT) - (name === 'tnk-retry' ? 2000000000000000000n : 0n)).toString());
      assert.equal(delta('bobTnk'), name === 'tnk-retry' ? '2000000000000000000' : '0');
    }
    if (name === 'relay') {
      const bob = await auditBridges.bob.call('relay_audit', {}), alice = await auditBridges.alice.call('relay_audit', {}), relay = await auditBridges.s1.call('relay_audit', {});
      assert.deepEqual(bob.direct, []); assert.ok(!alice.direct.includes(peerKeys.bob));
      assert.ok(bob.relayed.includes(peerKeys.alice)); assert.ok(bob.blocked + alice.blocked > 0);
      assert.ok(relay.ciphertextBytes > 0); assert.equal(relay.plaintextMatches, 0);
      assert.ok(relay.relay.pairs_relayed > 0); assert.deepEqual(bob.relay.configured_relays, [peerKeys.s1]);
      const fees = calculateFees(r.taken.quoteAmount, 10, 50);
      assert.equal(delta('alice'), fees.netAmount.toString()); assert.equal(delta('bob'), (-fees.totalAmount).toString());
      assert.equal(delta('aliceReset'), '-50000'); assert.equal(delta('bobReset'), '50000');
      assert.equal(delta('aliceTnk'), MSB_FEE_SPENT); assert.equal(delta('bobTnk'), '0');
      log('forced relay audit', JSON.stringify({ bob, alice, relay }));
    }
    const cheating = ['cheating-dealer', 'cheating-certificate'].includes(name);
    const noFundsMoved = Object.keys(before).every(k => BigInt(after[k]) === BigInt(before[k]));
    if (['not-enough-signers', 'signers-vanish-before-ack', 'unfunded-seller'].includes(name)) assert.ok(noFundsMoved, 'USDC, TNK and RESET balances unchanged');
    if (name === 'signers-offline') {
      const fees = calculateFees(r.taken.quoteAmount, 10, 50);
      assert.equal(delta('alice'), fees.netAmount.toString()); assert.equal(delta('bob'), (-fees.totalAmount).toString());
      assert.equal(delta('aliceReset'), '-30000'); assert.equal(delta('bobReset'), '30000');
      assert.equal(delta('aliceTnk'), MSB_FEE_SPENT); assert.equal(delta('bobTnk'), '0');
    }
    const ok = cheating ? r.ta.phase === 'aborted' && ['aborted', 'refunded'].includes(r.tb.phase) && noFundsMoved
      : name === 'not-enough-signers' ? noFundsMoved && r.tb.phase === 'refused'
      : name === 'signers-vanish-before-ack' ? noFundsMoved && r.ta.phase === 'aborted' && r.tb.phase === 'aborted'
      : name === 'unfunded-seller' ? noFundsMoved && r.ta.phase === 'aborted' && r.tb.phase === 'aborted'
      : name === 'refund' ? r.ta.phase === 'refunded' && delta('aliceReset') === '0' && delta('alice') === '0'
      : r.ta.phase === 'complete' && r.tb.phase === 'complete';
    results.push({ name, ok, maker: r.ta.phase, taker: r.tb.phase, reason: r.ta.reason ?? r.tb.reason ?? null,
      usdcAlice: delta('alice'), usdcBob: delta('bob'), resetAlice: delta('aliceReset'), resetBob: delta('bobReset'), tnkAlice: delta('aliceTnk'), tnkBob: delta('bobTnk'), ...(cheating ? { noFundsMoved } : {}) });
    if (!ok) failed = true;
  }
  log('venue fee vault', await feeVault().catch(e => e.message));
  console.log('RESULTS ' + JSON.stringify(results, null, 1));
} catch (error) {
  failed = true; console.error('E2E FAILED', error.stack ?? error.message);
} finally {
  await stopAll();
  process.exit(failed ? 1 : 0);
}
