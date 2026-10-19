import { spawn } from 'node:child_process';
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
  const artifactDir = process.env.DEX_SOLANA_TEST_DIR ?? resolve(root, '.test-tmp/solana');
  await mkdir(artifactDir, { recursive: true });
  const runDir = await mkdtemp(resolve(artifactDir, 'ledger-'));
  const buyer = Keypair.generate();
  const config = resolve(runDir, 'cli.yml');
  await writeFile(config, `json_rpc_url: ${LOCAL_RPC}\nwebsocket_url: ''\nkeypair_path: ${runDir}/unused.json\ncommitment: confirmed\n`);
  const output = createWriteStream(resolve(runDir, 'process.log'));
  const child = spawn('solana-test-validator', [
    '--config', config, '--bind-address', '127.0.0.1', '--gossip-host', '127.0.0.1',
    '--rpc-port', '18899', '--faucet-port', '19900', '--gossip-port', '18001',
    '--dynamic-port-range', '18010-18060', '--ledger', resolve(runDir, 'ledger'), '--reset', '--quiet',
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
      try { healthy = await rpcCall(LOCAL_RPC, 'getHealth', [], { timeoutMs: 500 }) === 'ok'; }
      catch { /* Startup is not ready yet. */ }
      if (healthy) break;
      await delay(200);
    }
    if (!healthy) throw new Error(`Validator startup timed out; see ${runDir}/ledger/validator.log`);
    const connection = new Connection(LOCAL_RPC, {
      commitment: 'confirmed', disableRetryOnRateLimit: true,
      fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(3000)]) }),
    });
    if (await connection.getBalance(buyer.publicKey) === 0) throw new Error('RPC did not serve this test genesis');
    return { connection, buyer, pid: child.pid, runDir, stop };
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
