import { spawn } from 'node:child_process';
import net from 'node:net';
import dgram from 'node:dgram';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Connection, Keypair, SystemProgram, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, MINT_SIZE, getAssociatedTokenAddressSync, createInitializeMint2Instruction,
  createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAccount,
} from '@solana/spl-token';
import { PROGRAM_ID } from '../../../src/solana/constants.js';
import { buildTransaction, buildInitConfigInstruction, buildInitTradeConfigInstruction } from '../../../src/solana/escrow.js';
import { rpcCall } from '../../../src/solana/rpc.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
export const LOCAL_RPC = 'http://127.0.0.1:18899';

// maxLifetimeMs: a stuck test can never leave a validator behind (SIGKILL after this long).
export async function startValidator({ maxLifetimeMs = 140000 } = {}) {
  return validator({ maxLifetimeMs, ports: { rpc: 18899, faucet: 19900, gossip: 18001, dynamic: 18010 } });
}

export async function startIsolatedValidator({ maxLifetimeMs = 140000 } = {}) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const base = 20000 + Math.floor(Math.random() * 30000), held = [];
    try {
      for (const port of [base, base + 1, base + 2, base + 3, ...Array.from({ length: 51 }, (_, i) => base + 10 + i)]) {
        const tcp = net.createServer(); held.push(() => new Promise(r => tcp.close(r)));
        await new Promise((r, j) => { tcp.once('error', j); tcp.listen(port, '127.0.0.1', r); });
        const udp = dgram.createSocket('udp4'); held.push(() => new Promise(r => udp.close(r)));
        await new Promise((r, j) => { udp.once('error', j); udp.bind(port, '127.0.0.1', r); });
      }
    } catch { await Promise.allSettled(held.map(close => Promise.resolve().then(close))); continue; }
    await Promise.allSettled(held.map(close => Promise.resolve().then(close)));
    return validator({ maxLifetimeMs, ports: { rpc: base, faucet: base + 2, gossip: base + 3, dynamic: base + 10 } });
  }
  throw new Error('No free validator port range');
}

async function validator({ maxLifetimeMs, ports, existing = null, warpSlot = null }) {
  const rpc = `http://127.0.0.1:${ports.rpc}`;
  const artifactDir = process.env.DEX_SOLANA_TEST_DIR ?? resolve(root, '.test-tmp/solana');
  await mkdir(artifactDir, { recursive: true });
  const runDir = existing?.runDir ?? await mkdtemp(resolve(artifactDir, 'ledger-'));
  const buyer = existing?.buyer ?? Keypair.generate();
  const config = resolve(runDir, 'cli.yml');
  await writeFile(config, `json_rpc_url: ${rpc}\nwebsocket_url: ''\nkeypair_path: ${runDir}/unused.json\ncommitment: confirmed\n`);
  const output = createWriteStream(resolve(runDir, 'process.log'));
  const child = spawn('solana-test-validator', [
    '--config', config, '--bind-address', '127.0.0.1', '--gossip-host', '127.0.0.1',
    '--rpc-port', String(ports.rpc), '--faucet-port', String(ports.faucet), '--gossip-port', String(ports.gossip),
    '--dynamic-port-range', `${ports.dynamic}-${ports.dynamic + 50}`, '--ledger', resolve(runDir, 'ledger'), ...(existing ? ['--warp-slot', String(warpSlot)] : ['--reset']), '--quiet',
    '--mint', buyer.publicKey.toBase58(), '--bpf-program', PROGRAM_ID.toBase58(), resolve(root, 'vendor/ln_usdt_escrow.mainnet.so'),
  ], { cwd: runDir, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
  const lifetime = new AbortController();
  let ended = false;
  let exitDescription = '';
  const exited = new Promise(resolve => {
    const finish = description => {
      ended = true; exitDescription = description;
      output.write(`${description}\n`);
      lifetime.abort(new Error(description)); resolve();
    };
    child.once('error', error => finish(`Validator spawn error: ${error.message}`));
    child.once('exit', (code, signal) => finish(`Validator PID ${child.pid} exited: code=${code}, signal=${signal}`));
  });
  const emergencyStop = () => { if (!ended) child.kill('SIGKILL'); };
  process.on('exit', emergencyStop);
  const watchdog = setTimeout(() => { if (!ended) child.kill('SIGKILL'); }, maxLifetimeMs);
  const waitForExit = milliseconds => new Promise(resolve => {
    const timer = setTimeout(resolve, milliseconds);
    exited.then(() => { clearTimeout(timer); resolve(); });
  });
  let stopping;
  const stop = () => stopping ??= (async () => {
    clearTimeout(watchdog);
    if (!ended && child.pid) {
      child.kill('SIGTERM');
      await waitForExit(2000);
      if (!ended) { child.kill('SIGKILL'); await waitForExit(2000); }
    }
    process.removeListener('exit', emergencyStop);
    await new Promise(resolve => output.end(resolve));
    if (!ended) throw new Error(`Validator PID ${child.pid} did not exit within 4 seconds`);
  })();
  try {
    const deadline = Date.now() + 45000;
    let healthy = false;
    while (Date.now() < deadline) {
      if (ended) throw new Error(`${exitDescription}; see ${runDir}/ledger/validator.log`);
      try { healthy = await rpcCall(rpc, 'getHealth', [], { timeoutMs: 500 }) === 'ok'; }
      catch { /* Startup is not ready yet. */ }
      if (healthy) break;
      await delay(200);
    }
    if (!healthy) throw new Error(`Validator startup timed out; see ${runDir}/ledger/validator.log`);
    const connection = new Connection(rpc, {
      commitment: 'confirmed', disableRetryOnRateLimit: true,
      fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(3000)]) }),
    });
    if (await connection.getBalance(buyer.publicKey) === 0) throw new Error('RPC did not serve this test genesis');
    return { connection, buyer, rpc, pid: child.pid, runDir, stop,
      async warp(seconds) {
        if (!Number.isSafeInteger(seconds) || seconds < 1) throw new Error('Positive warp duration required');
        const slot = await connection.getSlot('finalized');
        await stop();
        const target = slot + Math.ceil(seconds / 0.2);
        const resumed = await validator({ maxLifetimeMs, ports, existing: { runDir, buyer }, warpSlot: target });
        const end = Date.now() + 45000;
        while (await resumed.connection.getSlot('finalized') <= target) {
          if (Date.now() >= end) { await resumed.stop(); throw new Error('Warp finality timeout'); }
          await delay(250);
        }
        return resumed;
      },
    };
  } catch (error) { await stop(); throw error; }
}

let transactionSequence = 0n;

export async function send(connection, payer, instructions, signers = []) {
  const built = await buildTransaction({ connection, payer, instructions, signers, computeUnitLimit: 400000, computeUnitPriceMicroLamports: ++transactionSequence });
  const signature = await connection.sendRawTransaction(built.tx.serialize(), { preflightCommitment: 'confirmed', maxRetries: 0 });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const { value: [status] } = await connection.getSignatureStatuses([signature]);
    if (status?.err) throw new Error(`Local transaction failed: ${JSON.stringify(status.err)}`);
    if (status && ['confirmed', 'finalized'].includes(status.confirmationStatus)) return signature;
    if (await connection.getBlockHeight('confirmed') > built.lastValidBlockHeight) throw new Error('Local transaction expired');
    await delay(100);
  }
  throw new Error('Local transaction confirmation timed out after 15 seconds');
}

export async function setupMarket(validator) {
  const { connection, buyer } = validator;
  const seller = Keypair.generate(), platform = Keypair.generate(), venue = Keypair.generate(), stranger = Keypair.generate();
  await send(connection, buyer, [seller, platform, venue, stranger].map(account => SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: account.publicKey, lamports: 2_000_000_000 })));
  const mintKey = Keypair.generate();
  const mint = mintKey.publicKey;
  await send(connection, buyer, [
    SystemProgram.createAccount({ fromPubkey: buyer.publicKey, newAccountPubkey: mint, lamports: await connection.getMinimumBalanceForRentExemption(MINT_SIZE), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeMint2Instruction(mint, 6, buyer.publicKey, null),
  ], [mintKey]);
  const atas = {};
  const ataInstructions = Object.entries({ buyer, seller, platform, venue, stranger }).map(([name, account]) => {
    atas[name] = getAssociatedTokenAddressSync(mint, account.publicKey);
    return createAssociatedTokenAccountIdempotentInstruction(buyer.publicKey, atas[name], account.publicKey, mint);
  });
  await send(connection, buyer, [...ataInstructions, createMintToInstruction(mint, atas.buyer, buyer.publicKey, 100_000_000n)]);
  await send(connection, platform, [buildInitConfigInstruction({ payer: platform.publicKey, feeCollector: platform.publicKey, feeBps: 10 })]);
  await send(connection, venue, [buildInitTradeConfigInstruction({ payer: venue.publicKey, feeCollector: venue.publicKey, feeBps: 50 })]);
  return { ...validator, seller, platform, venue, stranger, mint, atas };
}

export async function balance(connection, address) {
  return (await getAccount(connection, address, 'confirmed')).amount;
}

export async function chainTime(connection) {
  const clock = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed');
  if (!clock) throw new Error('Clock missing');
  return clock.data.readBigInt64LE(32);
}
