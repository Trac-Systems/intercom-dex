import { randomBytes } from 'node:crypto';
import { PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { identityPublic, boxPublic } from '../core/keys.js';
import { sha256Hex } from '../core/canonical.js';
import { RegistryView } from '../locks/registry.js';
import { Clock } from '../locks/clock.js';
import { seal, open, join, MAIN, SOFTWARE, bodySchemas } from '../locks/transport.js';
import { lockError, formatUnits } from '../locks/position.js';
import * as escrowLock from '../locks/escrow-lock.js';
import * as solanaPay from '../locks/solana-pay.js';
import { scalarSigner } from '../locks/crypto/scalar-sign.js';
import { rpcCall } from '../solana/rpc.js';
import { readRpcQuorum } from '../solana/read-quorum.js';
import { createFeeReader } from '../solana/fee-reader.js';
import { buildInitInstruction, buildRefundInstruction, deriveVaultAta, calculateFees, deriveEscrowPda, decodeEscrowState } from '../solana/escrow.js';
import { readAccountQuorum } from '../solana/quorum.js';
import { createLocksTrac } from './locks-trac.js';
import { MIN_SOL, MSB_FEE } from './accounting.js';

// Signed bytes are durable before submission. Recovery checks or resends the identical transaction only.
export function createLocksSubmitter({ store, keypair, rpc, call = rpcCall, read = readRpcQuorum }) {
  const options = { endpoints: rpc.endpoints, need: rpc.need ?? 2, unanimous: true };
  async function reconcile({ id }) {
    const row = store.get(`locks-sol-${id}`); if (!row) return { ok: false };
    const { value } = await read('getTransaction', [row.signature, { commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 0 }], {
      ...options, select: r => r && ({ transaction: r.transaction, err: r.meta?.err, slot: r.slot, blockTime: r.blockTime }) });
    if (value && value.err === null && value.transaction?.[0] === row.wire && value.transaction?.[1] === 'base64') {
      return { ok: true, finalized: true, signature: row.signature, slot: value.slot, blockTime: value.blockTime };
    }
    if (!value && row.authorized && (!row.sendBefore || Math.floor(Date.now() / 1000) < row.sendBefore)) {
      await call(rpc.sendEndpoint, 'sendTransaction', [row.wire, { encoding: 'base64', preflightCommitment: 'finalized', maxRetries: 0 }]);
    }
    return { ok: false, signature: row.signature };
  }
  return {
    reconcile,
    async submit({ id, transaction, beforeSend, scalar, sendBefore }) {
      if (store.get(`locks-sol-${id}`)) return reconcile({ id });
      const block = await call(rpc.sendEndpoint, 'getLatestBlockhash', [{ commitment: 'finalized' }]);
      transaction.recentBlockhash = block.value.blockhash; transaction.feePayer = keypair.publicKey;
      await beforeSend?.();
      if (scalar !== undefined) { const signer = scalarSigner(scalar); transaction.addSignature(new PublicKey(Buffer.from(signer.publicKey, 'hex')), Buffer.from(signer.sign(transaction.serializeMessage()), 'hex')); }
      transaction.partialSign(keypair);
      const row = { wire: transaction.serialize().toString('base64'), signature: bs58.encode(transaction.signature), ...(sendBefore ? { sendBefore } : {}) };
      store.put(`locks-sol-${id}`, row);
      await beforeSend?.();
      row.authorized = true; store.put(`locks-sol-${id}`, row);
      const signature = await call(rpc.sendEndpoint, 'sendTransaction', [row.wire, { encoding: 'base64', preflightCommitment: 'finalized', maxRetries: 0 }]);
      if (signature !== row.signature) throw new Error('Unexpected payment signature');
      return reconcile({ id });
    },
  };
}

export function createTraderLocks({ config, bridge, store, keypair, wallet, profile, rpc, wallets = () => null }) {
  if (!config.locks?.venueKey) return null;
  const venueKey = config.locks.venueKey;
  if (!/^[0-9a-f]{64}$/.test(venueKey) || !rpc || rpc.endpoints.length < 2 || new Set(rpc.endpoints).size !== rpc.endpoints.length) throw new Error('Locks require a pinned venue key and two distinct Solana readers');
  let keys = store.get('locks-keys');
  if (!keys) { keys = { identity: randomBytes(32).toString('hex'), box: randomBytes(32).toString('hex') }; store.put('locks-keys', keys); }
  const identity = { secretKey: Buffer.from(keys.identity, 'hex'), publicKey: Buffer.from(identityPublic(keys.identity)).toString('hex') };
  const box = { secretKey: Buffer.from(keys.box, 'hex'), publicKey: Buffer.from(boxPublic(keys.box)).toString('hex') };
  const registry = new RegistryView(venueKey, store), clock = new Clock({ bridge });
  const transport = {
    join: ch => join(bridge, ch), leave: ch => bridge.leave(ch),
    send: (ch, kind, body) => bridge.send(ch, seal({ ch, kind, body }, identity.secretKey)),
    forward: (ch, raw) => bridge.send(ch, raw),
    open(ch, raw, { historical = false } = {}) {
      const m = open(raw, { ...(historical || raw.kind === 'release' || raw.kind === 'opened' ? { maxAgeSec: Number.MAX_SAFE_INTEGER } : {}) });
      if (m.ch !== ch) throw new Error('Wrong locks channel'); return m;
    },
    requestBook(body) {
      return new Promise((resolve, reject) => {
        const done = (error, raw) => { clearTimeout(timer); bridge.off('message', listener); error ? reject(error) : resolve(raw); };
        const listener = (ch, raw) => {
          if (ch !== MAIN || raw.kind !== 'book' || raw.from !== venueKey || raw.body?.requester !== identity.publicKey || raw.body?.page !== body.page) return;
          try { open(raw); done(null, raw); } catch (error) { done(error); }
        };
        const timer = setTimeout(() => done(lockError('venue_unavailable')), 8000);
        bridge.on('message', listener); transport.send(MAIN, 'bookRequest', body).catch(done);
      });
    },
    subscribe(listener) { const onMessage = (ch, raw) => { if (ch === MAIN || ch.startsWith(MAIN + ':p:')) listener(ch, raw); }; bridge.on('message', onMessage); return () => bridge.off('message', onMessage); },
  };
  const submitter = createLocksSubmitter({ store, keypair, rpc });
  const tracFor = signingWallet => createLocksTrac({ bridge, wallet: signingWallet, profile, store, resetGatewayUrl: config.trac?.resetGatewayUrl });
  const trac = tracFor(wallet), reader = createFeeReader({ ...rpc, need: rpc.need ?? 2, programId: profile.programId, mint: profile.mint });
  const escrowCosts = async ({ registry, amount }) => {
    const [platform, collector] = await Promise.all([reader.platform(), reader.collector(registry.fee.escrowCollector)]);
    if (collector.feeBps !== 0) throw new Error('Put escrow collector must charge zero');
    return { total: calculateFees(BigInt(amount), platform.feeBps, 0).totalAmount.toString(), platformFeeBps: platform.feeBps };
  };
  const adapters = {
    async admit({ registry: reg }) {
      if (!bodySchemas.lockReady.shape.takeId || !solanaPay.buildExercise || !reg.assets ||
          !['loanBps', 'optionBps', 'optionMin'].every(key => Object.hasOwn(reg.fee, key))) throw lockError('protocol_unavailable');
      if (!wallets()) throw lockError('insufficient_funds');
      const sol = (await wallets().balances()).SOL.free;
      if (BigInt(sol) < BigInt(MIN_SOL)) throw lockError('insufficient_funds', `Not enough SOL for Solana network fees. Keep at least ${formatUnits(MIN_SOL, 'SOL')} free, you have ${formatUnits(sol, 'SOL')}.`);
    },
    fundingFee: async () => (await wallets().raw()).feeTnk ?? MSB_FEE,
    finalizedSlot: () => solanaPay.finalizedSlot({ ...rpc, need: rpc.need ?? 2 }),
    drawBlock: slot => { if (!solanaPay.firstFinalizedBlockAtLeast) throw new Error('Committee draw unavailable'); return solanaPay.firstFinalizedBlockAtLeast(slot, { ...rpc, need: rpc.need ?? 2 }); },
    mint: profile.mint, programId: profile.programId, solanaPay, tracFor, escrowCosts,
    escrowBalance: A => reader.balance(new PublicKey(Buffer.from(A, 'hex'))),
    async escrowSettlement(p) {
      const H = escrowLock.hash(p.post.escrowPreimage);
      const account = await readAccountQuorum(deriveEscrowPda(H, profile.programId).pda, { ...rpc, commitment: 'finalized', unanimous: true });
      if (!account.value) throw new Error('Escrow account unavailable');
      const state = decodeEscrowState(account.value.data);
      // Settlement uses fees frozen in the program account, even if configuration has since changed.
      const cfg = { platformFeeBps: state.platformFeeBps, platformCollector: state.platformFeeCollector.toBase58(), tradeFeeBps: state.tradeFeeBps };
      return escrowLock.settlement({ ...rpc, ...cfg, A: p.lock.A, escrowPreimage: p.post.escrowPreimage, payer: p.post.maker.sol,
        amount: p.post.terms.strikeTotal, mint: profile.mint, refundAfter: Number(state.refundAfter),
        escrowCollector: p.registry.fee.escrowCollector, programId: profile.programId });
    },
    exclusive: work => wallets() ? wallets().exclusive(work) : work(),
    freeBalance: async (asset, context) => { if (!wallets()) throw new Error('Wallet accounting unavailable'); return (await wallets().balances(context))[asset].free; },
    submit: submitter.submit, transfer: trac.transfer,
    hasIntent: id => !!(store.get(`locks-sol-${id}`) || store.get(`locks-trac-${id}`)),
    async reconcile(input) {
      if (input.step.startsWith('fund:') && input.input.asset !== 'USDC') return trac.reconcile(input);
      const result = await submitter.reconcile(input);
      if (result.ok && input.step === 'fund:USDC') return { ...result, ...store.get(`locks-escrow-${input.position.positionId}`) };
      return result;
    },
    async refundEscrow({ id, position: p }) {
      const settlement = await adapters.escrowSettlement(p);
      if (!settlement.ok) throw lockError('payment_pending');
      if (settlement.status === 'refunded') return { ok: true, finalized: true, refunded: true };
      if (settlement.status !== 'active') throw lockError('wrong_state');
      const slot = await adapters.finalizedSlot(), time = await readRpcQuorum('getBlockTime', [slot], { ...rpc, unanimous: true });
      if (!Number.isSafeInteger(time.value) || time.value < p.refundAfter) throw lockError('refund_not_ready');
      const transaction = new Transaction().add(buildRefundInstruction({ paymentHashHex: escrowLock.hash(p.post.escrowPreimage),
        refund: keypair.publicKey, refundTokenAccount: deriveVaultAta(keypair.publicKey, profile.mint), mint: profile.mint, programId: profile.programId }));
      return submitter.submit({ id, transaction });
    },
    async fundEscrow({ id, position: p }) {
      const { platformFeeBps, total } = await escrowCosts({ registry: p.registry, amount: p.post.terms.strikeTotal });
      if (total !== p.escrowCost) throw lockError('fee_changed');
      const H = sha256Hex(Buffer.from(p.post.escrowPreimage, 'hex'));
      let saved = store.get(`locks-escrow-${p.positionId}`);
      if (!saved) {
        const refundAfter = Math.floor(Date.now() / 1000) + (p.post.terms.expiryBlock - await clock.counted()) * 600 + p.registry.params.recoveryMarginSec + p.registry.params.reserveSec;
        saved = { refundAfter, escrow: { H, refundAfter } }; store.put(`locks-escrow-${p.positionId}`, saved);
      }
      const input = escrowLock.initArgs({ A: p.lock.A, H, escrowPreimage: p.post.escrowPreimage, payer: keypair.publicKey, mint: profile.mint, amount: p.post.terms.strikeTotal,
        refundAfter: saved.refundAfter, expectedPlatformFeeBps: platformFeeBps, expectedTradeFeeBps: 0,
        tradeFeeCollector: p.registry.fee.escrowCollector, programId: profile.programId });
      const transaction = new Transaction().add(buildInitInstruction(input));
      return { ...await submitter.submit({ id, transaction }), ...saved };
    },
    escrowLock,
    subscribeClock(listener) {
      // Public heartbeats are the event source; there is no blanket position-channel polling.
      let pending = false;
      const tick = (ch, raw) => { if (ch === MAIN && ['heartbeat', 'registry'].includes(raw.kind)) { try {
        const m = open(raw); if (!pending && (m.from === venueKey || registry.usable?.signers.some(s => s.lockKey === m.from))) {
          pending = true; Promise.resolve(listener()).finally(() => { pending = false; });
        }
      } catch {} } }; bridge.on('message', tick); return () => bridge.off('message', tick);
    },
  };
  return { venueKey, identity, box, store, registry, transport, clock, adapters, software: SOFTWARE,
    settings: config.locks.settings ?? {}, me: { lockKey: identity.publicKey, boxKey: box.publicKey, trac: wallet.address, sol: keypair.publicKey.toBase58() } };
}
