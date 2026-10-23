// Stock traders, dedicated lock signers and venue over real local Pear peers and both chains.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from '@solana/spl-token';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startIsolatedValidator, setupMarket, send, balance, chainTime } from '../integration/solana/harness.mjs';
import { startLocalDevnet } from '../integration/trac/local-devnet.mjs';
import { resetSourceURL } from '../reset-source.mjs';
import { createKeyring } from '../../src/roles/keyring.js';
import { createWallet } from '../../src/trac/wallet.js';
import PeerRuntimeWallet from '../../peer/node_modules/trac-peer/src/wallet.js';
import { Bridge } from '../../src/net/bridge.js';
import { Clock } from '../../src/locks/clock.js';
import { secretFile } from '../../src/roles/common.js';
import { buildInitTradeConfigInstruction, deriveConfigPda, deriveVaultAta } from '../../src/solana/escrow.js';
import { within } from './deadline.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url)), password = 'locks-stack-test-password';
if (process.env.LOCKS_STACK_SUPERVISED !== '1') {
  const child = spawn(process.execPath, [path.join(repo, 'tests/e2e/bounded.mjs'), '75', process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { env: { ...process.env, LOCKS_STACK_SUPERVISED: '1' }, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  process.exit(await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); }));
}
const requested = process.argv.slice(2), cases = ['loan-repaid', 'loan-defaulted', 'call-exercised', 'call-expired', 'put-claimed', 'put-expired', 'put-refunded', 'cancel-race', 'loan-repaid-dkg-offline', 'call-expired-offline', 'call-exercised-venue'];
const scenarios = requested.length ? requested : cases.filter(name => name !== 'put-refunded').concat('put-refunded').flatMap(name => ['RESET', 'TNK'].map(asset => `${name}:${asset}`));
for (const value of scenarios) if (!cases.some(name => ['RESET', 'TNK'].some(asset => value === `${name}:${asset}`))) throw Error('Unknown locks scenario: ' + value);
if (!path.isAbsolute(process.env.DEX_PROOF_ZKEY ?? '')) throw Error('DEX_PROOF_ZKEY is required');
// A refund warps Solana time. Start a fresh stack for each such case so subsequent payments retain real-time timestamps.
if (scenarios.length > 1 && scenarios.some(s => s.startsWith('put-refunded:'))) {
  const groups = [scenarios.filter(s => !s.startsWith('put-refunded:')), ...scenarios.filter(s => s.startsWith('put-refunded:')).map(s => [s])].filter(g => g.length);
  let child, interrupted = false;
  const stop = () => { interrupted = true; child?.kill('SIGTERM'); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
  for (const group of groups) {
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...group], { env: process.env, stdio: 'inherit' });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    if (code !== 0 || interrupted) process.exit(code || 1);
  }
  process.exit(0);
}
const area = path.join(repo, '.test-tmp/trac'); await fs.mkdir(area, { recursive: true });
const root = await fs.mkdtemp(path.join(area, 'locks-stack-')), logs = path.join(root, 'logs'); await fs.mkdir(logs);
const log = (...args) => console.log(new Date().toISOString(), ...args);
log('ARTIFACTS', root);
const stops = [], results = []; let closing, currentScenario = 'setup', stage = 'setup', scenarioTimer, forcedExit;
const timings = createWriteStream(path.join(root, 'requests.jsonl'));
const measured = async (surface, name, route, fn) => {
  if (closing) throw Error('Stack is stopping');
  const start = performance.now(); let error;
  try { return await fn(); } catch (e) { error = e.message; throw e; }
  finally { timings.write(JSON.stringify({ at: Date.now(), scenario: currentScenario, surface, name, route: route.split('?')[0], ms: performance.now() - start, ...(error ? { error } : {}) }) + '\n'); }
};
const close = () => closing ??= Promise.allSettled(stops.toReversed().map(stop => Promise.resolve().then(stop))).then(results => {
  for (const result of results) if (result.status === 'rejected') console.error('Cleanup:', result.reason?.message ?? result.reason);
});
const stop = message => {
  console.error('LOCKS_STACK_FAILED', message, `scenario=${currentScenario} stage=${stage}`);
  forcedExit ??= setTimeout(() => process.exit(124), 60000);
  void close().then(() => process.exit(1));
};
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(signal));
const until = async (label, fn, timeout = 300000) => {
  stage = label; const start = Date.now();
  const value = await within(`${currentScenario}: ${label}`, timeout, async () => {
    while (!closing) { const value = await fn(); if (value) return value; await delay(1000); }
    throw Error('Stack is stopping');
  });
  if (currentScenario !== 'setup' && label !== 'counted header application') log('STEP', currentScenario, label, Date.now() - start);
  return value;
};
async function port() { const s = net.createServer(); await new Promise((r, j) => { s.once('error', j); s.listen(0, '127.0.0.1', r); }); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
function launch(name, args, cwd, env, marker) {
  const output = createWriteStream(path.join(logs, name + '.log'), { flags: 'a' });
  const metrics = name.startsWith('role-');
  const child = spawn(process.execPath, metrics ? ['--import', path.join(repo, 'tests/e2e/locks-metrics.mjs'), ...args] : args, { cwd, env: { ...process.env, ...env, ...(metrics ? { LOCKS_METRICS_FILE: path.join(logs, name + '-metrics.jsonl') } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
  let ended = false, readyValue, error, buffer = '';
  const exited = new Promise(r => { child.once('exit', (code, signal) => { ended = true; error = Error(`${name} exited ${code ?? signal}`); r(); }); child.once('error', e => { ended = true; error = e; r(); }); });
  child.stdout.on('data', chunk => { buffer += chunk; let at; while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (line.startsWith(marker + ' ')) readyValue = JSON.parse(line.slice(marker.length + 1)); } });
  const ready = until(name, () => { if (error) throw error; return readyValue; }, 180000); ready.catch(() => {});
  const stop = async () => { if (!ended) child.kill('SIGTERM'); const timer = setTimeout(() => { if (!ended) child.kill('SIGKILL'); }, 10000); await exited; clearTimeout(timer); await new Promise(r => output.end(r)); };
  stops.push(stop); return { child, ready, stop };
}
try {
  const network = await startLocalDevnet(root); stops.push(() => network.close()); await network.pauseMining();
  const { beaconOptions, mine, parseHeader } = await import(resetSourceURL('tests/helpers/chain.mjs'));
  const gateway = network.manifest.gateways[0].gatewayUrl;
  assert.ok(network.manifest.dhtBootstrap.every(p => p.startsWith('127.0.0.1:'))); assert.ok(gateway.startsWith('http://127.0.0.1:'));
  async function mineAt(time) {
    const state = await (await fetch(gateway + '/v1/state')).json(), hx = mine(state.tip.hash, time);
    const packet = await network.writers[0].rpc('header', { hx });
    const response = await fetch(gateway + '/v1/move', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(packet) });
    assert.ok(response.ok, 'header submission');
    await until('counted header application', async () => (await network.admin.rpc('status')).state.tip.hash === parseHeader(hx).hash, 60000); await network.sync();
  }
  let headerTime = Math.floor(Date.now() / 1000) - 120;
  for (let i = 0; i < 18; i++) await mineAt(headerTime++);
  log('RESET ready');
  let validator = await startIsolatedValidator({ maxLifetimeMs: 75 * 60000 }); stops.push(validator.stop);
  const market = await setupMarket(validator), { mint } = market; let { connection } = market;
  const rpc = { endpoints: [validator.rpc, validator.rpc.replace('127.0.0.1', 'localhost')], sendEndpoint: validator.rpc, need: 2 };
  await send(connection, market.stranger, [buildInitTradeConfigInstruction({ payer: market.stranger.publicKey, feeCollector: market.stranger.publicKey, feeBps: 0 })]);
  log('Solana ready', validator.rpc);

  const names = ['venue', 's1', 's2', 's3', 's4', 's5', 'alice', 'bob'], traders = ['alice', 'bob'];
  const dirs = {}, ids = {}, wallets = {}, peerKeys = {}, bridges = {}, pins = {}, control = {}, roleFiles = {}, roles = {}, mcps = {}, dashboards = {};
  const sol = { alice: market.seller, bob: Keypair.generate() };
  const ata = n => getAssociatedTokenAddressSync(mint, sol[n].publicKey);
  for (const n of names) {
    dirs[n] = path.join(root, n); await fs.mkdir(path.join(dirs[n], 'data'), { recursive: true });
    const isTrader = traders.includes(n);
    ids[n] = await createKeyring(path.join(dirs[n], 'data', isTrader ? 'keyring.json' : 'locks-keyring.json'), password, { solanaSecret: sol[n]?.secretKey ?? null });
    const w = new PeerRuntimeWallet({ networkPrefix: network.validator.config.addressPrefix, derivationPath: network.validator.config.derivationPath });
    await w.ready; await w.generateKeyPair(null, network.validator.config.derivationPath);
    const file = path.join(dirs[n], 'peer-store/peer/db/keypair.json'); await fs.mkdir(path.dirname(file), { recursive: true }); w.exportToFile(file, Buffer.alloc(0)); await fs.chmod(file, 0o600); peerKeys[n] = w.publicKey;
    if (isTrader) {
      wallets[n] = await createWallet(path.join(dirs[n], 'trac-wallet.json'), password);
      await network.local.fund(network.validator, { address: wallets[n].address }, 100000000000000000000n);
      await network.gift(wallets[n].publicKey, '200000');
      await send(connection, market.buyer, [SystemProgram.transfer({ fromPubkey: market.buyer.publicKey, toPubkey: sol[n].publicKey, lamports: 3000000000 }),
        createAssociatedTokenAccountIdempotentInstruction(market.buyer.publicKey, ata(n), sol[n].publicKey, mint), createMintToInstruction(mint, ata(n), market.buyer.publicKey, 10000000000n)]);
    }
  }
  const peerProcesses = {};
  for (const n of names) {
    const role = traders.includes(n) ? 'trader' : n === 'venue' ? 'lock-venue' : 'lock-signer';
    pins[n] = { environment: 'development', msbNetworkId: network.validator.config.networkId, msbBootstrap: network.manifest.msbBootstrap,
      msbChannel: 'local-foundation-msb', msbDhtBootstrap: network.manifest.dhtBootstrap, peerDhtBootstrap: network.manifest.dhtBootstrap,
      trac: { reset: { bootstrap: network.manifest.indexer.subnetBootstrap, channel: 'local-foundation-subnet', dhtBootstrap: network.manifest.dhtBootstrap, beaconOptions } } };
    const bridgePort = await port(), tokenFile = path.join(dirs[n], 'bridge.token'); secretFile(tokenFile);
    const config = { role, ...(traders.includes(n) ? { locks: true } : {}), servicePeerKey: peerKeys.venue, network: 'local', peer: pins[n], mint: mint.toBase58(),
      platformCollector: market.platform.publicKey.toBase58(), storeDirectory: path.join(dirs[n], 'peer-store'), validatorKey: network.validator.wallet.publicKey.toString('hex'), bridge: { port: bridgePort, tokenFile } };
    const file = path.join(dirs[n], 'peer.json'); await fs.writeFile(file, JSON.stringify(config));
    bridges[n] = { url: `ws://127.0.0.1:${bridgePort}`, tokenFile };
    peerProcesses[n] = launch('peer-' + n, ['scripts/pear-runner.mjs', '--config', file], path.join(repo, 'peer'),
      { PEAR_RUNNER_STDIN: '0', DEX_LEGACY_PEAR_RUN: '0', XDG_CONFIG_HOME: path.join(dirs[n], 'pear-config'), XDG_DATA_HOME: path.join(dirs[n], 'pear-data') }, 'DEX_PEER_READY');
  }
  await Promise.all(Object.values(peerProcesses).map(p => p.ready)); log('Eight peers ready');
  const registry = { version: 1, issuedAt: Math.floor(Date.now() / 1000), minSoftware: '0.2.0',
    params: { n: 5, k: 3, dkgTimeoutSec: 60, reserveSec: 600, payMarginSec: 60, termBlocks: { min: 6, max: 200 }, offerMaxBlocks: 200, recoveryMarginSec: 1, tnkReserve: '90000000000000000' },
    products: { loan: 'open', call: 'open', put: 'open' }, assets: { RESET: 'open', TNK: 'open' },
    limits: { RESET: { min: '1', max: '10000000000' }, TNK: { min: '1', max: '100000000000000000000' }, USDC: { min: '1', max: '10000000000' },
      totalLocked: { RESET: '1000000000000', TNK: '10000000000000000000000', USDC: '1000000000000' } },
    fee: { loanBps: 50, optionBps: 1000, optionMin: '50000', signerShareBps: 4000, collector: market.venue.publicKey.toBase58(), escrowCollector: market.stranger.publicKey.toBase58() },
    signers: ['s1', 's2', 's3', 's4', 's5'].map(n => ({ lockKey: ids[n].dexKey, boxKey: ids[n].boxKey, label: n, status: 'active', group: 'operator', software: '0.2.0' })), removed: [] };
  for (const n of names) {
    const isTrader = traders.includes(n), role = isTrader ? 'trader' : n === 'venue' ? 'lock-venue' : 'lock-signer';
    control[n] = { url: `http://127.0.0.1:${await port()}`, tokenFile: path.join(dirs[n], 'control.token') };
    const config = { role, network: 'local', peer: pins[n], dataDir: path.join(dirs[n], 'data'), bridge: bridges[n], serviceKey: ids.venue.dexKey,
      servicePeerKey: peerKeys.venue, mint: mint.toBase58(), platformCollector: market.platform.publicKey.toBase58(), solana: rpc,
      control: { port: Number(new URL(control[n].url).port), tokenFile: control[n].tokenFile } };
    if (n === 'venue') config.registry = registry;
    if (isTrader) { dashboards[n] = await port(); Object.assign(config, { dashboard: { port: dashboards[n] }, proof: { zkey: process.env.DEX_PROOF_ZKEY }, locks: { venueKey: ids.venue.dexKey, settings: { autoRepay: false, autoExercise: false } },
      trac: { walletFile: path.join(dirs[n], 'trac-wallet.json'), passwordEnv: 'DEX_WALLET_PASSWORD', resetGatewayUrl: gateway } }); }
    roleFiles[n] = path.join(dirs[n], 'role.json'); await fs.writeFile(roleFiles[n], JSON.stringify(config));
  }
  const api = (n, method, route, body) => measured('control', n, route, async () => {
    const r = await fetch(control[n].url + route, { method, headers: { authorization: `Bearer ${secretFile(control[n].tokenFile)}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
    const value = await r.json(); if (!r.ok) throw Error(n + ' ' + route + ': ' + JSON.stringify(value)); return value;
  });
  const dashboard = (n, method, route, body) => measured('dashboard', n, route, async () => {
    const port = dashboards[n], token = (await fs.readFile(path.join(dirs[n], 'data/dashboard.token'), 'utf8')).trim();
    const r = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { cookie: `dexdash${port}=${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(180000) });
    assert.ok(r.ok, 'dashboard response'); return r.json();
  });
  const startRole = async n => { roles[n] = launch('role-' + n, ['bin/dex.mjs', '--config', roleFiles[n]], repo,
    { DEX_KEY_PASSWORD: password, DEX_WALLET_PASSWORD: password }, 'DEX_ROLE_READY'); await roles[n].ready; await until(n + ' control', async () => { try { return await api(n, 'GET', '/status'); } catch { return false; } }, 60000); };
  await startRole('venue'); await Promise.all(names.filter(n => n !== 'venue' && !traders.includes(n)).map(startRole));
  await Promise.all(traders.map(startRole)); log('Eight stock roles ready');
  for (const n of traders) {
    const client = new Client({ name: 'locks-stack', version: '1.0.0' }); mcps[n] = client; stops.push(() => client.close());
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(repo, 'src/mcp/server.mjs')],
      env: { ...process.env, DEX_CONFIG: '', DEX_CONTROL_URL: control[n].url, DEX_CONTROL_TOKEN_FILE: control[n].tokenFile }, stderr: 'pipe' }));
  }
  const mcp = (n, name, args = {}) => measured('mcp', n, name, async () => {
    const r = await mcps[n].callTool({ name, arguments: args }, undefined, { timeout: 180000 }), value = JSON.parse(r.content.find(c => c.type === 'text').text);
    if (r.isError || value.ok === false) throw Object.assign(Error(JSON.stringify(value)), value); return value;
  });
  const audit = await new Bridge({ url: bridges.alice.url, token: secretFile(bridges.alice.tokenFile), timeoutMs: 60000 }).connect(); stops.push(() => audit.close());
  const clock = new Clock({ bridge: audit });
  await until('registry at all signers', async () => (await Promise.all(['s1', 's2', 's3', 's4', 's5'].map(n => api(n, 'GET', '/status')))).every(s => s.registryVersion === 1), 90000);
  const mineBlocks = async count => { for (let i = 0; i < count; i++) await mineAt(headerTime = Math.max(headerTime + 1, Math.floor(Date.now() / 1000) - 2)); };
  const row = async (n, id) => (await api(n, 'GET', '/api/locks/mine?positionId=' + id)).rows?.[0];
  const balances = async () => {
    const out = {};
    for (const n of traders) { out[n] = { USDC: (await balance(connection, ata(n))).toString(), ...(await audit.call('locks_balances', { address: wallets[n].address })) }; }
    out.collector = (await balance(connection, market.atas.venue)).toString();
    const vault = deriveVaultAta(deriveConfigPda().pda, mint);
    out.platform = await connection.getAccountInfo(vault) ? (await balance(connection, vault)).toString() : '0'; return out;
  };
  for (const scenario of scenarios) {
    currentScenario = scenario; const startedAt = Date.now();
    scenarioTimer = setTimeout(() => stop('SCENARIO_DEADLINE: 19 minutes elapsed; cleanup must finish within 20 minutes'), 19 * 60000);
    const [variant, asset] = scenario.split(':');
    const offlineDkg = variant.endsWith('-dkg-offline'), offlineDeadline = variant === 'call-expired-offline', offlineVenue = variant.endsWith('-venue');
    const name = offlineDkg ? 'loan-repaid' : offlineDeadline ? 'call-expired' : offlineVenue ? 'call-exercised' : variant;
    const product = name.startsWith('loan') ? 'loan' : name.startsWith('put') ? 'put' : 'call';
    if (offlineDkg) await roles.s5.stop();
    log('SCENARIO', scenario);
    const before = await balances(), counted = await clock.counted(), amount = asset === 'RESET' ? '10000' : '1000000000000000000';
    const terms = { asset, offerUntilBlock: counted + (name === 'put-refunded' ? 1 : 40), ...(product === 'loan' ? { collateral: amount, principal: '1000000', repay: '1100000', termBlocks: 30 }
      : { amount, premium: '200000', strikeTotal: '2000000', expiryBlock: counted + (name === 'put-refunded' ? 8 : 50) }) };
    const preview = await dashboard('alice', 'POST', '/api/locks/preview', { action: 'post', product, asset, terms });
    assert.ok(preview.confirm && preview.sentence && preview.asset === asset, JSON.stringify(preview));
    const posted = asset === 'RESET' ? await dashboard('alice', 'POST', '/api/locks/act', { ...preview.input, confirm: preview.confirm })
      : await mcp('alice', 'dex_lock_post', { product, asset, terms }); const id = posted.result.positionId;
    await until('posted ' + id, async () => (await row('alice', id))?.state === 'posted');
    if (offlineDkg) {
      await startRole('s5');
      await until('late DKG pickup', async () => (await api('s5', 'GET', '/status')).positions.some(p => p.positionId === id && p.lock), 150000);
      const locks = await Promise.all(['s1', 's2', 's3', 's4', 's5'].map(async n => (await api(n, 'GET', '/status')).positions.find(p => p.positionId === id).lock));
      assert.ok(locks.every(lock => lock.A === locks[0].A && JSON.stringify(lock.Q) === JSON.stringify(locks[0].Q))); assert.equal(locks[0].Q.length, 4);
    }
    await until('offer at taker', async () => {
      try { return (await mcp('bob', 'dex_locks', { product, asset })).rows.some(p => p.positionId === id); }
      catch (e) { if (e.reason !== 'venue_unavailable') throw e; return false; }
    });
    let cancelled = false;
    if (name === 'cancel-race') {
      const race = await Promise.allSettled([mcp('bob', 'dex_lock_take', { positionId: id, asset }), mcp('alice', 'dex_lock_cancel', { positionId: id, asset })]);
      for (const r of race) if (r.status === 'rejected' && !['already_taken', 'reservation_active', 'wrong_state'].includes(r.reason.reason)) throw r.reason;
      await until('cancel or take quorum', async () => { const a = await row('alice', id); return a?.state === 'running' || a?.outcome === 'cancelled'; });
      cancelled = (await row('alice', id)).outcome === 'cancelled';
    } else await mcp('bob', 'dex_lock_take', { positionId: id, asset });
    if (!cancelled) await until('both running', async () => (await Promise.all(traders.map(n => row(n, id)))).every(p => p?.state === 'running'));
    const running = await row('alice', id); log('RUNNING', scenario, id, cancelled ? 'cancelled' : 'taken');
    if (offlineDeadline) await roles.s5.stop();
    if (offlineVenue) await roles.venue.stop();
    const exercise = name === 'loan-repaid' || name === 'call-exercised' || name === 'put-claimed' || name === 'put-refunded';
    if (exercise) {
      const payer = product === 'loan' ? 'alice' : 'bob', step = product === 'loan' ? 'repay' : 'exercise';
      try { await mcp(payer, 'dex_lock_pay', { positionId: id, step, asset }); } catch (e) { if (e.reason !== 'payment_pending') throw e; }
      await until('payment finalized', async () => (await row(payer, id))?.paid === true, 120000);
      if (name === 'put-refunded') {
        await roles.bob.stop();
        const refundAfter = (await row('alice', id)).refundAfter;
        validator = await validator.warp(Math.max(1, refundAfter - Number(await chainTime(connection)) + 60)); stops.push(validator.stop); connection = validator.connection;
        assert.ok(Number(await chainTime(connection)) >= refundAfter, 'warped chain Clock reaches actual escrow deadline');
        try { await mcp('alice', 'dex_lock_pay', { positionId: id, step: 'refund', asset }); } catch (e) { if (e.reason !== 'payment_pending') throw e; }
        await until('writer refund finalized', async () => (await row('alice', id)).escrowStatus === 'refunded', 120000);
        await startRole('bob');
      }
      await mineBlocks(name === 'put-refunded' ? 8 : 18);
      if (name !== 'put-refunded') assert.ok(await clock.counted() < (running.dueBlock ?? running.expiryBlock), 'early release before counted deadline');
    } else if (!cancelled) {
      const deadline = running.dueBlock ?? running.expiryBlock;
      while (await clock.counted() < deadline) await mineBlocks(1);
    }
    if (offlineDeadline) await startRole('s5');
    await until('both settled', async () => (await Promise.all(traders.map(n => row(n, id)))).every(p => p?.state === 'released'), 420000);
    const settled = await Promise.all(traders.map(n => row(n, id)));
    const outcome = cancelled ? 'cancelled' : exercise ? product === 'loan' ? 'repaid' : 'exercised' : product === 'loan' ? 'defaulted' : 'expired';
    assert.ok(settled.every(p => p.outcome === outcome), JSON.stringify(settled));
    if (product === 'put') assert.ok(settled.every(p => p.holderWinner === (exercise && name !== 'put-refunded' ? 'maker' : 'taker')));
    if (offlineVenue) await startRole('venue');
    if (offlineDeadline) {
      const decisions = await until('late deadline decision', async () => { const s = (await api('s5', 'GET', '/status')).positions.find(p => p.positionId === id); return s?.decision; }, 120000);
      assert.deepEqual(decisions, { winner: 'maker', outcome: 'expired' });
    }
    const after = await balances(), delta = (n, key) => BigInt(after[n][key]) - BigInt(before[n][key]);
    const fee = cancelled ? 0n : product === 'loan' ? 5000n : 50000n, reserve = 90000000000000000n, networkFee = 30000000000000000n;
    const funder = product === 'put' ? 'bob' : 'alice', winner = product === 'put' ? exercise && name !== 'put-refunded' ? 'alice' : 'bob' : product === 'loan' ? exercise ? 'alice' : 'bob' : exercise ? 'bob' : 'alice';
    for (const n of traders) {
      assert.equal(delta(n, 'RESET'), asset === 'RESET' ? (n === funder ? -BigInt(amount) : 0n) + (n === winner ? BigInt(amount) : 0n) : 0n, n + ' RESET');
      const locked = reserve + (asset === 'TNK' ? BigInt(amount) : 0n), transfers = asset === 'RESET' ? 2n : 1n;
      assert.equal(delta(n, 'TNK'), (n === funder ? -locked - networkFee * transfers : 0n) + (n === winner ? locked - networkFee * transfers : 0n), n + ' TNK');
    }
    const aliceUsdc = cancelled ? 0n : product === 'loan' ? 1000000n - fee - (exercise ? 1100000n : 0n)
      : 200000n - fee + (product === 'call' ? exercise ? 2000000n : 0n : name === 'put-refunded' ? 0n : -2000n - (exercise ? 2000000n : 0n));
    assert.equal(delta('alice', 'USDC'), aliceUsdc); assert.equal(delta('bob', 'USDC'), -aliceUsdc - fee - (product === 'put' && name !== 'put-refunded' ? 2000n : 0n));
    assert.equal(BigInt(after.collector) - BigInt(before.collector), fee); assert.equal(BigInt(after.platform) - BigInt(before.platform), product === 'put' && name !== 'put-refunded' ? 2000n : 0n);
    let credits = [];
    if (!cancelled) {
      const required = offlineDkg ? 4 : 5;
      // Receipt pickup rotates one position per venue heartbeat.
      const venue = await until('signer credits', async () => {
        const s = await api('venue', 'GET', '/status'), rows = Object.values(s.signerCredits).flat().filter(r => r.positionId === id);
        return rows.length === required ? s : null;
      }, 240000 + results.length * 30000);
      credits = Object.values(venue.signerCredits).flat().filter(r => r.positionId === id);
      const each = fee * 4000n / 10000n / BigInt(required);
      assert.ok(credits.every(r => r.amount === each.toString() && r.final === false));
      assert.equal(credits.reduce((n, r) => n + BigInt(r.amount), 0n) + BigInt(venue.positions.find(p => p.positionId === id).venueCredit), fee);
    }
    const result = { scenario, startedAt, finishedAt: Date.now(), durationMs: Date.now() - startedAt, positionId: id, outcome, before, after, credits, ok: true }; results.push(result); await fs.writeFile(path.join(root, 'results.json'), JSON.stringify(results, null, 2)); log('PASS', scenario);
    clearTimeout(scenarioTimer);
  }
  console.log('LOCKS_STACK_COMPLETE ' + JSON.stringify(results.map(({ scenario, ok }) => ({ scenario, ok }))));
} catch (e) { console.error('LOCKS_STACK_FAILED', e.stack); process.exitCode = 1; }
finally { clearTimeout(scenarioTimer); forcedExit ??= setTimeout(() => process.exit(124), 60000); await close(); await new Promise(r => timings.end(r)); clearTimeout(forcedExit); log('Stopped test processes', root); }
