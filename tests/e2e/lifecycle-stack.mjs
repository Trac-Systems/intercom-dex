// Real desktop lifecycle against the same local RESET/MSB and Solana fixtures as stack.mjs.
// RESET_SOURCE_DIR and DEX_PROOF_ZKEY must point to existing local test resources.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
import dgram from 'node:dgram';
import PeerWallet from '../../peer/node_modules/trac-peer/src/wallet.js';
import { startLocalDevnet } from '../integration/trac/local-devnet.mjs';
import { startIsolatedValidator, setupMarket } from '../integration/solana/harness.mjs';
import { resetSourceURL } from '../reset-source.mjs';
import { createKeyring } from '../../src/roles/keyring.js';
import { secretFile } from '../../src/roles/common.js';
import { readLock, alive } from '../../src/lifecycle/lock.js';
import { SOFTWARE } from '../../src/core/software.js';
import { PAIRS } from '../unit/core/helpers.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const area = join(repo, '.test-tmp/trac'); await mkdir(area, { recursive: true });
const root = await mkdtemp(join(area, 'lifecycle-'));
const password = 'disposable-local-lifecycle-test';
const env = { ...process.env, DEX_KEY_PASSWORD: password, DEX_MANAGED_PEER: '1', PEAR_RUNNER_STDIN: '0' };
const stops = [], pids = new Set(); let closing;
const log = (...args) => console.log(new Date().toISOString(), ...args);
log('ARTIFACTS', root);

// Refuse reserved desktop ports before the validator fixture probes a random range.
// Other fixture listeners use port 0 (the OS ephemeral range on this host).
for (const [prototype, method] of [[net.Server.prototype, 'listen'], [dgram.Socket.prototype, 'bind']]) {
  const original = prototype[method];
  prototype[method] = function (...args) {
    const port = typeof args[0] === 'object' ? args[0]?.port : args[0];
    if (Number(port) >= 47200 && Number(port) <= 47212) throw Error('Reserved owner port');
    return original.apply(this, args);
  };
}
async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = server.address().port; await new Promise(resolve => server.close(resolve));
  assert.ok(value < 47200 || value > 47212); return value;
}
async function until(label, fn, ms = 120000) {
  const end = Date.now() + ms;
  while (!closing) {
    const value = await fn(); if (value) return value;
    if (Date.now() > end) throw Error('Timed out: ' + label);
    await delay(250);
  }
  throw Error('Stack is stopping');
}
function launch(name, args, marker) {
  const output = createWriteStream(join(root, name + '.log'));
  const child = spawn(process.execPath, args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  pids.add(child.pid);
  child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
  let ended = false, value, error, pending = '';
  const closed = new Promise(resolve => {
    child.once('error', e => { error = e; });
    child.once('close', (code, signal) => { ended = true; error ??= Error(`${name} exited ${code ?? signal}`); resolve(); });
  });
  child.stdout.on('data', chunk => {
    pending += chunk; let at;
    while ((at = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, at); pending = pending.slice(at + 1);
      if (line.startsWith(marker + ' ')) value = JSON.parse(line.slice(marker.length + 1));
    }
  });
  stops.push(async () => {
    if (!ended) child.kill('SIGTERM');
    const timer = setTimeout(() => { if (!ended) child.kill('SIGKILL'); }, 10000);
    await closed; clearTimeout(timer); await new Promise(resolve => output.end(resolve));
  });
  return until(name, () => { if (error) throw error; return value; }, 180000);
}
function command(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/dex.mjs', ...args], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    pids.add(child.pid); let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 390000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(Error(`dex ${args[0]} exited ${code}: ${stderr}`)); });
  });
}
const close = () => closing ??= (async () => {
  for (const stop of stops.toReversed()) await stop();
})();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  void close().then(() => process.exit(1), () => process.exit(1));
});

try {
  const validator = await startIsolatedValidator({ maxLifetimeMs: 25 * 60000 });
  pids.add(validator.pid); stops.push(validator.stop);
  const market = await setupMarket(validator);
  log('Solana ready', validator.rpc);
  const network = await startLocalDevnet(root); stops.push(() => network.close());
  await network.pauseMining();
  log('RESET/MSB ready');
  const { beaconOptions } = await import(resetSourceURL('tests/helpers/chain.mjs'));
  const pins = { environment: 'development', msbNetworkId: network.validator.config.networkId,
    msbBootstrap: network.manifest.msbBootstrap, msbChannel: 'local-foundation-msb',
    msbDhtBootstrap: network.manifest.dhtBootstrap, peerDhtBootstrap: network.manifest.dhtBootstrap,
    trac: { reset: { bootstrap: network.manifest.indexer.subnetBootstrap, channel: 'local-foundation-subnet',
      dhtBootstrap: network.manifest.dhtBootstrap, beaconOptions } } };
  assert.ok(pins.peerDhtBootstrap.every(address => address.startsWith('127.0.0.1:')));
  const signers = ['s1', 's2', 's3', 's4', 's5'], names = ['service', ...signers, 'trader'];
  const ids = {}, peerKeys = {}, configs = {};
  for (const name of names) {
    const dir = join(root, name), dataDir = join(dir, 'data'); await mkdir(dataDir, { recursive: true, mode: 0o700 });
    if (name !== 'trader') ids[name] = await createKeyring(join(dataDir, 'keyring.json'), password,
      { solanaSecret: name === 'service' ? market.venue.secretKey : null });
    const wallet = new PeerWallet({ networkPrefix: network.validator.config.addressPrefix, derivationPath: network.validator.config.derivationPath });
    await wallet.ready; await wallet.generateKeyPair(null, network.validator.config.derivationPath);
    const file = join(dir, 'peer-store/peer/db/keypair.json');
    await mkdir(dirname(file), { recursive: true, mode: 0o700 }); wallet.exportToFile(file, Buffer.alloc(0)); await chmod(file, 0o600);
    peerKeys[name] = wallet.publicKey;
  }
  const registry = { minSoftware: SOFTWARE, pairs: PAIRS, params: { n: 5, k: 3, sendWindowSec: 300, refundSec: 960, graceSec: 30 },
    fee: { platformFeeBps: 10, tradeFeeBps: 50, collector: market.venue.publicKey.toBase58(), signerShareBps: 5000 },
    signers: signers.map(name => ({ dexKey: ids[name].dexKey, boxKey: ids[name].boxKey, label: name,
      limitUsdc: '1000000000000', status: 'active', assets: ['TNK', 'RESET'], software: SOFTWARE })), removed: [] };
  const peerReady = [];
  for (const name of names) {
    const dir = join(root, name), role = name === 'service' ? 'service' : name === 'trader' ? 'trader' : 'signer';
    const bridgePort = await port(), tokenFile = join(dir, 'bridge.token'); secretFile(tokenFile);
    const common = { role, network: 'local', peer: pins, servicePeerKey: peerKeys.service,
      mint: market.mint.toBase58(), platformCollector: market.platform.publicKey.toBase58() };
    const peer = { ...common, storeDirectory: join(dir, 'peer-store'), validatorKey: network.validator.wallet.publicKey.toString('hex'),
      bridge: { port: bridgePort, tokenFile } };
    const peerFile = join(dir, 'peer.json'); await writeFile(peerFile, JSON.stringify(peer));
    const config = { ...common, dataDir: join(dir, 'data'), serviceKey: ids.service.dexKey,
      bridge: { url: `ws://127.0.0.1:${bridgePort}`, tokenFile }, control: { port: await port(), tokenFile: join(dir, 'control.token') } };
    if (role !== 'signer') config.solana = { endpoints: [validator.rpc, validator.rpc.replace('127.0.0.1', 'localhost')], sendEndpoint: validator.rpc, need: 2 };
    if (role === 'service') config.registry = registry;
    if (role === 'trader') Object.assign(config, { proof: { zkey: process.env.DEX_PROOF_ZKEY }, dashboard: { port: await port() },
      trac: { resetGatewayUrl: network.manifest.gateways[0].gatewayUrl } });
    configs[name] = join(dir, name === 'trader' ? 'trader.json' : 'role.json');
    await writeFile(configs[name], JSON.stringify(config));
    if (name !== 'trader') peerReady.push(launch('peer-' + name, ['peer/scripts/pear-runner.mjs', '--config', peerFile], 'DEX_PEER_READY'));
  }
  await Promise.all(peerReady);
  await Promise.all(['service', ...signers].map(name => launch('role-' + name,
    ['bin/dex.mjs', '--config', configs[name], ...(name === 'service' ? ['--first-launch'] : [])], 'DEX_ROLE_READY')));
  log('Venue and five signers ready');
  const configFile = configs.trader, dataDir = join(root, 'trader/data');
  stops.push(async () => {
    if (!readLock(dataDir)) return;
    await command(['stop', '--config', configFile]);
  });
  const output = await command(['start', '--config', configFile]);
  assert.equal(output.match(/Dashboard \(private link, do not share\): http:\/\/127\.0\.0\.1:/g)?.length, 1);
  const status = () => command(['status', '--config', configFile]).then(JSON.parse);
  const first = await until('running with five signers', async () => {
    const value = await status(); return value.running && value.signers.length === 5 ? value : null;
  });
  for (const pid of Object.values(first.pids)) pids.add(pid);
  assert.equal(first.restarts, 0); assert.ok(first.dashboard);
  log('START returned dashboard link; STATUS running with', first.signers.length, 'signers', JSON.stringify(first.pids));
  const logs = await command(['logs', '--config', configFile]);
  assert.match(logs, /DEX_PEER_READY/); assert.match(logs, /DEX_ROLE_READY/);
  assert.ok(!logs.includes(password)); assert.ok(!logs.includes(first.dashboard));
  log('LOGS contains both readiness markers, no password or dashboard link');
  process.kill(first.pids.trader, 'SIGKILL');
  const recovered = await until('trader restarted and signers rediscovered', async () => {
    const value = await status();
    return value.running && value.pids.trader !== first.pids.trader && value.signers.length === 5 ? value : null;
  });
  pids.add(recovered.pids.trader);
  assert.equal(recovered.pids.peer, first.pids.peer); assert.equal(recovered.pids.supervisor, first.pids.supervisor);
  assert.equal(recovered.restarts, 1); assert.equal(recovered.lastExit.signal, 'SIGKILL');
  log('RECOVERED', JSON.stringify({ pids: recovered.pids, restarts: recovered.restarts, lastExit: recovered.lastExit, signers: recovered.signers.length }));
  assert.equal(JSON.parse(await command(['stop', '--config', configFile])).stopped, true);
  assert.equal((await status()).phase, 'stopped'); assert.equal(readLock(dataDir), null);
  await until('managed PIDs exited', () => Object.values(recovered.pids).every(pid => !alive(pid)), 10000);
  log('STOP succeeded; managed processes exited and lock released');
} finally {
  await close();
  assert.ok([...pids].every(pid => !alive(pid)), 'all directly tracked children exited');
  log('CLEANUP complete');
}
