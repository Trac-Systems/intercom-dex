#!/usr/bin/env node
// Runs one dex role (service | signer | trader | market-feed) next to its own peer. Usage: node bin/dex.mjs --config <abs path>
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { Keypair } from '@solana/web3.js';
import { Bridge } from '../src/net/bridge.js';
import { openStore } from '../src/roles/store.js';
import { secretFile } from '../src/roles/common.js';
import { readPrivateFile, openKeyring, createKeyring } from '../src/roles/keyring.js';
import { LockSigner } from '../src/roles/lock-signer.js';
import { Clock } from '../src/locks/clock.js';
import { LockVenue } from '../src/roles/lock-venue.js';
import { Trader } from '../src/roles/trader.js';
import { Signer } from '../src/roles/signer.js';
import { Service } from '../src/roles/service.js';
import { createSolanaAdapter } from '../src/solana/adapter.js';
import { solanaSettings } from '../src/solana/settings.js';
import { createTracAdapter } from '../src/trac/adapter.js';
import { ensureWallets, setupWallets, exportWallets } from '../src/wallets/setup.js';
import { restoreVenue } from '../src/wallets/venue-backup.js';
import { hiddenInput } from '../src/wallets/input.js';
import { createTraderLocks } from '../src/wallets/locks.js';
import { WalletManager } from '../src/wallets/manager.js';
import { controlCall } from '../src/wallets/control.js';
import { FeeManager } from '../src/fees/manager.js';
import { PLATFORM_WARNING, percentBps, platformBps, readAuthorityKeypair } from '../src/fees/input.js';
import { checkKeys } from '../src/fees/keys-check.js';
import { withdrawPlatform, withPlatformLock } from '../src/fees/platform-withdraw.js';
import { createFeeReader } from '../src/solana/fee-reader.js';
import { checkProofFiles } from '../src/proof/lockproof.js';
import { resolveNetwork, checkPeerProfile } from '../src/net/profile.js';
import { startDashboard } from '../src/dashboard/server.js';
import { startMarketFeed } from '../src/market-feed/runtime.js';
import { controlHandler } from '../src/roles/control.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  config: { type: 'string' }, out: { type: 'string' }, asset: { type: 'string' }, amount: { type: 'string' }, to: { type: 'string' },
  'import-solana': { type: 'string' }, 'import-trac-mnemonic': { type: 'boolean' }, 'import-reset-keystore': { type: 'string' },
  'trade-fee': { type: 'string' }, 'signer-share': { type: 'string' }, bps: { type: 'string' },
  'authority-keypair': { type: 'string' }, yes: { type: 'boolean' }, from: { type: 'string' }, mint: { type: 'string' },
  'first-launch': { type: 'boolean' },
} });
if (!isAbsolute(values.config ?? '')) throw new Error('--config must be an absolute path');
const command = ['fee', 'keys'].includes(positionals[0]) ? positionals.join(' ') : positionals[0] ?? 'run';
const allowed = { run: ['first-launch'], setup: ['import-solana', 'import-trac-mnemonic', 'import-reset-keystore'], balances: [], withdraw: ['asset', 'amount', 'to'], export: ['out'],
  restore: ['from'], 'keys check': ['authority-keypair'], 'fee withdraw-platform': ['authority-keypair', 'to', 'mint', 'amount'],
  'fee set': ['trade-fee', 'signer-share'], 'fee platform': ['bps', 'authority-keypair', 'yes'] };
if (!Object.hasOwn(allowed, command) || positionals.length > (command.includes(' ') ? 2 : 1)) throw new Error('Expected setup, balances, withdraw, export, restore, keys check, fee set, fee platform, fee withdraw-platform, or no command');
if (Object.keys(values).some(k => k !== 'config' && !allowed[command].includes(k))) throw new Error('Option does not apply to this command');
const config = JSON.parse(readFileSync(values.config, 'utf8'));
const locksRole = ['lock-signer', 'lock-venue'].includes(config.role);
if (locksRole && !['run', 'setup'].includes(command)) throw new Error('Locks roles support run and setup');
if (config.role === 'market-feed' && command !== 'run') throw new Error('market-feed only supports run');
if (values['first-launch'] && config.role !== 'service') throw new Error('--first-launch is for the first start of a new venue only');
if (['fee set', 'fee platform'].includes(command)) {
  if (config.role !== 'service') throw new Error('Fee commands are service only');
  let body;
  if (command === 'fee platform') {
    console.error(PLATFORM_WARNING);
    if (values.yes !== true) throw new Error('Pass --yes to confirm the global platform fee change');
    if (!isAbsolute(values['authority-keypair'] ?? '')) throw new Error('--authority-keypair must be absolute');
    body = { bps: platformBps(values.bps), authorityKeypair: values['authority-keypair'], yes: true };
  } else {
    if (values['trade-fee'] === undefined && values['signer-share'] === undefined) throw new Error('Provide --trade-fee or --signer-share');
    if (values['trade-fee'] !== undefined) percentBps(values['trade-fee'], 1000);
    if (values['signer-share'] !== undefined) percentBps(values['signer-share'], 10000);
    body = { tradeFee: values['trade-fee'], signerShare: values['signer-share'] };
  }
  const result = await controlCall(config, 'POST', command === 'fee set' ? '/fee/set' : '/fee/platform', body);
  console.log(JSON.stringify(result, null, 2)); process.exit(0);
}
let profile;
try { profile = resolveNetwork(config); }
catch (error) { console.error(error.message); process.exit(1); }
if (command === 'setup') {
  if (locksRole) {
    if (!isAbsolute(config.dataDir ?? '')) throw new Error('Absolute locks dataDir required');
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const password = process.env[config.keyPasswordEnv ?? 'DEX_KEY_PASSWORD'] ?? await hiddenInput('New locks keyring password: ');
    console.log(JSON.stringify(await createKeyring(join(config.dataDir, 'locks-keyring.json'), password), null, 2));
    process.exit(0);
  }
  const password = process.env[config.keyPasswordEnv ?? 'DEX_KEY_PASSWORD'] ?? await hiddenInput('New keyring password: ');
  const tracPassword = config.trac?.passwordEnv ? process.env[config.trac.passwordEnv] ?? await hiddenInput('New Trac wallet password: ') : password;
  const mnemonic = values['import-trac-mnemonic'] ? await hiddenInput('Trac mnemonic: ') : undefined;
  const resetPassword = values['import-reset-keystore'] ? await hiddenInput('RESET keystore password: ') : undefined;
  const result = await setupWallets(config, profile, { password, tracPassword, mnemonic, resetPassword,
    importSolana: values['import-solana'], resetKeystore: values['import-reset-keystore'],
    onMnemonic: text => process.stderr.write('Back up this Trac mnemonic privately. It is shown once:\n' + text + '\n') });
  console.log(JSON.stringify(result, null, 2)); process.exit(0);
}
if (command === 'export') {
  const files = await exportWallets(config, { out: values.out });
  console.log(files.join('\n')); process.exit(0);
}
if (command === 'restore') {
  console.log(JSON.stringify(await restoreVenue(config, { from: values.from }), null, 2)); process.exit(0);
}
if (command === 'keys check') {
  const result = await checkKeys(config, profile, { authorityKeypair: values['authority-keypair'] });
  console.log(result.lines.map(line => `${line.ok ? 'OK' : 'PROBLEM'} ${line.label}: ${line.message}`).join('\n'));
  process.exit(result.ok ? 0 : 1);
}
if (command === 'fee withdraw-platform') {
  if (config.role !== 'service') throw new Error('Platform withdrawal is service only');
  if (!isAbsolute(values['authority-keypair'] ?? '') || !values.to) throw new Error('Provide --authority-keypair as an absolute path and --to');
  const keys = await openKeyring(join(config.dataDir, 'keyring.json'), await hiddenInput('Keyring password: '));
  let authority;
  try {
    await withPlatformLock(config.dataDir, async () => {
      authority = readAuthorityKeypair(values['authority-keypair']);
      const store = openStore(config.dataDir, keys.storeKey);
      // Separate journal namespace: this owner command cannot overwrite the running service's transactions.
      const name = id => 'platform-solintents-' + createHash('sha256').update(id).digest('hex');
      const intents = { get: id => store.get(name(id)), put: (id, value) => store.put(name(id), value), delete: id => store.delete(name(id)) };
      const solana = createSolanaAdapter({ ...solanaSettings(config, profile), keypair: authority, intents, mint: profile.mint, programId: profile.programId,
        commitment: 'finalized', finality: 'finalized', confirmationTimeoutMs: 90000 });
      const reader = createFeeReader({ ...solanaSettings(config, profile), mint: profile.mint, programId: profile.programId });
      const result = await withdrawPlatform({ store, solana, reader, authority, mint: values.mint ?? profile.mint, to: values.to, amount: values.amount });
      console.log(result.empty ? result.message : result.signature);
    });
  } finally { authority?.secretKey.fill(0); keys.storeKey.fill(0); keys.solanaSecret?.fill(0); }
  process.exit(0);
}
if (['balances', 'withdraw'].includes(command)) {
  const result = await controlCall(config, command === 'balances' ? 'GET' : 'POST', command === 'balances' ? '/wallets' : '/withdraw',
    command === 'withdraw' ? { asset: values.asset, amount: values.amount, to: values.to } : undefined);
  console.log(JSON.stringify(result, null, 2)); process.exit(0);
}
const log = (...a) => console.log(new Date().toISOString(), config.role, ...a);

if (!['service', 'signer', 'trader', 'market-feed', 'lock-signer', 'lock-venue'].includes(config.role)) throw new Error('Invalid role');
if (config.role === 'trader' && (typeof config.proof?.zkey !== 'string' || !isAbsolute(config.proof.zkey))) {
  throw new Error('Traders require proof.zkey as an absolute path');
}
if (config.role !== 'market-feed' && !locksRole) await checkProofFiles(config.role === 'trader' ? { zkeyPath: config.proof.zkey } : {});

const bridge = await new Bridge({ url: config.bridge.url, token: readPrivateFile(config.bridge.tokenFile, 256).trim() }).connect();
const peerInfo = (await bridge.info()).info;
checkPeerProfile(peerInfo, profile);
if (!/^[0-9a-f]{64}$/.test(config.servicePeerKey ?? '') || peerInfo.servicePeerKey !== config.servicePeerKey || peerInfo.role !== config.role) {
  throw new Error('Role and peer must agree on role and servicePeerKey');
}
if (config.role === 'service' && peerInfo.peerPubkey !== config.servicePeerKey) throw new Error('Service peer key does not match owner');
if (locksRole) {
  if (!isAbsolute(config.dataDir ?? '')) throw new Error('Absolute locks dataDir required');
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const file = join(config.dataDir, 'locks-keyring.json');
  const password = process.env[config.keyPasswordEnv ?? 'DEX_KEY_PASSWORD'] ?? await hiddenInput('Locks keyring password: ');
  if (!existsSync(file)) await createKeyring(file, password);
  const keys = await openKeyring(file, password), store = openStore(join(config.dataDir, 'locks'), keys.storeKey);
  const rpc = solanaSettings(config, profile);
  if (config.role === 'lock-signer' && !rpc) throw new Error('Locks signer requires Solana RPC readers');
  const role = config.role === 'lock-venue' ? new LockVenue({ bridge, identity: keys.identity, store, registryInput: config.registry, rpc, clock: new Clock({ bridge }), log }) :
    new LockSigner({ bridge, identity: keys.identity, box: keys.box, store, serviceKey: config.serviceKey, profile, rpc, log });
  await role.start();
  if (config.control) createServer(controlHandler({ token: secretFile(config.control.tokenFile), role })).listen(config.control.port, '127.0.0.1');
  console.log('DEX_ROLE_READY ' + JSON.stringify({ role: config.role, lockKey: keys.identity.publicKey, boxKey: keys.box.publicKey }));
  const stop = code => { role.stop(); keys.storeKey.fill(0); bridge.close(); process.exit(code); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(0));
  bridge.on('close', () => stop(75));
} else if (config.role === 'market-feed') {
  const password = process.env[config.keyPasswordEnv ?? 'DEX_KEY_PASSWORD'] ?? await hiddenInput('Market feed keyring password: ');
  const runtime = await startMarketFeed({ config, profile, bridge, password, log });
  console.log('DEX_ROLE_READY ' + JSON.stringify({ role: config.role, dexKey: runtime.feed.identity.publicKey }));
  let stopping = false;
  const stop = async code => {
    if (stopping) return;
    stopping = true; await runtime.close(); bridge.close(); process.exit(code);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void stop(0); });
  bridge.on('close', () => { void stop(75); });
} else {
  const { keys, wallet } = await ensureWallets(config, profile);
  const store = openStore(config.dataDir, keys.storeKey);
  const identity = keys.identity;
  const keypair = keys.solanaSecret ? Keypair.fromSecretKey(keys.solanaSecret) : null;
  // The Solana adapter journals every signed transaction before sending it, in this role's encrypted store, so a
  // restart resumes the same attempt instead of signing a second one.
  const solanaIntents = {
    name: id => 'solintents-' + createHash('sha256').update(id).digest('hex').slice(0, 48),
    get(id) { return store.get(this.name(id)) ?? undefined; },
    put(id, value) { store.put(this.name(id), value); },
    delete(id) { store.delete(this.name(id)); },
  };
  const rpc = solanaSettings(config, profile);
  const solana = rpc ? createSolanaAdapter({ ...rpc, keypair, intents: solanaIntents,
    collectors: config.role === 'service' ? () => keys.collectors.map(({ secretKey, ...c }) => {
      try { return { ...c, keypair: Keypair.fromSecretKey(Uint8Array.from(secretKey)) }; } finally { secretKey.fill(0); }
    }) : null,
    // A lock, claim or refund counts as done only once finalized; until then the trade keeps waiting or retrying.
    commitment: 'finalized', finality: 'finalized', confirmationTimeoutMs: 90000, mint: profile.mint, programId: profile.programId }) : null;
  const trac = createTracAdapter({ bridge, wallet, profile, resetGatewayUrl: config.trac?.resetGatewayUrl ?? null, usedTxFolder: join(config.dataDir, 'used-tx'), intentFolder: join(config.dataDir, 'trac-intents') });

  let role, wallets;
  if (config.role === 'service') {
    role = new Service({ bridge, identity, store, solana, trac, profile, registryInput: config.registry, latest: config.latest, log,
      firstLaunch: values['first-launch'] === true });
  } else if (config.role === 'signer') {
    role = new Signer({ bridge, identity, box: keys.box, store, trac, profile, serviceKey: config.serviceKey, log });
  } else if (config.role === 'trader') {
    const me = { dexKey: identity.publicKey, tracAddr: wallet.address, solAddr: keypair.publicKey.toBase58() };
    role = new Trader({ bridge, identity, store, solana, trac, me, profile, serviceKey: config.serviceKey, mint: profile.mint,
      platformCollector: profile.platformCollector, proof: config.proof, log,
      locks: createTraderLocks({ config, bridge, store, keypair, wallet, profile, rpc, wallets: () => wallets }) });
  } else throw new Error('role must be service, signer or trader');
  wallets = config.role === 'signer' ? null : new WalletManager({ config, configFile: values.config, store, role, solana, trac,
    addresses: { solana: keypair.publicKey.toBase58(), trac: wallet?.address ?? null } });
  if (wallets) role.wallets = wallets;
  const fees = config.role === 'service' ? new FeeManager({ config, keys, store, service: role, solana }) : null;
  await wallets?.checkPayout();
  await fees?.initialize();
  await role.start();
  await wallets?.recover();

  // Local control API (127.0.0.1, bearer token): status for every role; offers and takes for traders.
  if (config.control) {
    const token = secretFile(config.control.tokenFile);
    createServer(controlHandler({ token, role, wallets, fees })).listen(config.control.port, '127.0.0.1');
  }
  // Local dashboard (127.0.0.1, new access token per start in dataDir/dashboard.token).
  if (config.dashboard) {
    const dashboard = await startDashboard({ config, role, wallets, bridge, log });
    console.log('Dashboard (private link, do not share): ' + dashboard.url);
  }
  log('ready', identity.publicKey);
  console.log('DEX_ROLE_READY ' + JSON.stringify({ role: config.role, dexKey: identity.publicKey,
    ...(role.box ? { boxKey: role.box.publicKey } : {}), ...(config.role === 'trader' ? { me: role.me } : {}) }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { role.stop(); trac.close(); wallet?.close(); keys.solanaSecret?.fill(0); keys.storeKey.fill(0); bridge.close(); process.exit(0); });
  // Without its peer the role can neither hear nor speak; exit so the supervisor restarts it (state is on disk).
  bridge.on('close', () => { log('bridge closed, exiting'); role.stop(); process.exit(75); });

}
