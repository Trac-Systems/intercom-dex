import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import bs58 from 'bs58';
import { PublicKey, Transaction, SystemProgram, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { ACCOUNT_SIZE, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, unpackAccount } from '@solana/spl-token';
import { PROGRAM_ID, USDC_MINT } from './constants.js';
import {
  deriveEscrowPda, deriveConfigPda, deriveTradeConfigPda, deriveVaultAta, calculateFees,
  decodeConfigState, decodeTradeConfigState, buildInitInstruction, buildClaimInstruction,
  buildRefundInstruction, buildInitTradeConfigInstruction, buildSetTradeConfigInstruction,
  buildWithdrawTradeFeesInstruction, buildSetConfigInstruction, buildWithdrawFeesInstruction,
} from './escrow.js';
import { checkEscrow as inspectEscrow } from './check.js';
import { LOCK_START_MARGIN_SEC } from '../core/trade-buyer.js';
import { rpcCall, readAccount } from './rpc.js';
import { readAccountQuorum, QuorumError } from './quorum.js';
import { readRpcQuorum } from './read-quorum.js';
import { ChainWatch } from './chain-watch.js';

const QUORUM_ATTEMPTS = 4, QUORUM_RETRY_MS = 400;
// A history search proves a withdrawal absent only while it still covers the signing time.
const WITHDRAWAL_PROOF_MS = 6 * 3600 * 1000;
const LEGACY_LOCK_PROOF_MS = 10 * 60 * 1000;
const SYSVAR_OWNER = 'Sysvar1111111111111111111111111111111111111';

function unsigned(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$(?![\s\S])/.test(value)) throw new TypeError('Amount must be a base-unit decimal string');
  const n = BigInt(value);
  if (n > (1n << 64n) - 1n) throw new RangeError('Amount exceeds u64');
  return n;
}

function slotNumber(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid slot or height');
  return value;
}

function hex32(value) {
  if (typeof value !== 'string' || value.length !== 64 || !/^[0-9a-f]{64}$/.test(value)) throw new TypeError('Expected lowercase 32-byte hex');
  return value;
}

export function createSolanaAdapter({
  endpoints, sendEndpoint, need = 2, keypair = null, collectors = null, programId = PROGRAM_ID,
  commitment = 'confirmed', finality = 'finalized', intents = null, mint = USDC_MINT, timeoutMs = 3000, confirmationTimeoutMs = 20000,
}) {
  if (!Array.isArray(endpoints) || !endpoints.length) throw new TypeError('Endpoints required');
  const urls = endpoints.map(value => {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash) throw new TypeError('Invalid RPC URL');
    return u.href;
  });
  if (new Set(urls).size !== urls.length || !Number.isInteger(need) || need < 1 || need > urls.length) throw new TypeError('Invalid quorum');
  if (!['confirmed', 'finalized'].includes(commitment)) throw new TypeError('Commitment must be confirmed or finalized');
  if (!['confirmed', 'finalized'].includes(finality)) throw new TypeError('Finality must be confirmed or finalized');
  if (intents && !['get', 'put', 'delete'].every(method => typeof intents[method] === 'function')) throw new TypeError('Invalid durable intent store');
  if (collectors !== null && typeof collectors !== 'function') throw new TypeError('Invalid collector key source');
  if (![timeoutMs, confirmationTimeoutMs].every(n => Number.isSafeInteger(n) && n > 0 && n <= 2147483647)) throw new TypeError('Invalid timeout');
  if (keypair && (!keypair.publicKey || !sendEndpoint)) throw new TypeError('Signer and sendEndpoint required');
  if (sendEndpoint && !['http:', 'https:'].includes(new URL(sendEndpoint).protocol)) throw new TypeError('Invalid sendEndpoint');
  const program = new PublicKey(programId);
  const serviceMint = new PublicKey(mint);
  const quorumOptions = { endpoints: urls, need, timeoutMs, commitment };
  const pending = new Map();
  const storeId = `solana-intents/v1/${program}/${keypair?.publicKey ?? 'readonly'}`;
  let queue = Promise.resolve();
  const guarded = (id, work) => {
    const next = queue.then(async () => {
      const startupError = await ready;
      if (startupError) throw startupError;
      return work();
    }).catch(error => {
      const entry = pending.get(id);
      const unresolved = entry?.sent && !['done', 'rejected', 'retryable', 'retired-unsent', 'not-executed'].includes(entry.phase);
      return {
        ok: false,
        ...(unresolved ? { unknown: true, ...(entry.intent.hashHex ? { hashHex: entry.intent.hashHex } : {}), signature: entry.signature } : {}),
        reason: error.message,
      };
    });
    queue = next.then(() => undefined);
    return next;
  };
  // Readers can straddle a change of a busy account; retry a disagreement (never an error) a few times.
  const account = async (address, options = {}) => {
    for (let attempt = 1; ; attempt++) {
      try { return (await readAccountQuorum(address, { ...quorumOptions, ...options })).value; }
      catch (error) {
        const split = error instanceof QuorumError && error.reports?.every(r => r.status !== 'error');
        if (!split || attempt >= QUORUM_ATTEMPTS) throw error;
        await new Promise(r => setTimeout(r, QUORUM_RETRY_MS));
      }
    }
  };
  const quorum = async (method, params, select) => (await readRpcQuorum(method, params, { ...quorumOptions, select })).value;
  // A value that moves with every slot (finalized slot, block height) differs slightly between nodes, so exact
  // agreement is rare. The highest value that at least `need` nodes have reached is used instead: every one of them
  // has seen it, and it never runs ahead of the chain.
  const reached = async (method, params) => {
    const results = await Promise.allSettled(urls.map(url => rpcCall(url, method, params, { timeoutMs })));
    const values = [], reports = [];
    results.forEach((r, i) => {
      if (r.status === 'rejected') { reports.push({ endpoint: urls[i], status: 'error', message: r.reason.message }); return; }
      try { values.push(slotNumber(r.value)); reports.push({ endpoint: urls[i], status: 'agreed' }); }
      catch (error) { reports.push({ endpoint: urls[i], status: 'error', message: error.message }); }
    });
    if (values.length < need) throw new QuorumError(`No RPC quorum for ${method}`, reports);
    return values.sort((a, b) => b - a)[need - 1];
  };
  // Each node names its own newest blockhash. One that `need` nodes name together is used; otherwise the newest one
  // that `need` nodes confirm as valid. Its lastValidBlockHeight comes from the node that named it.
  const latestBlockhash = async () => {
    const results = await Promise.allSettled(urls.map(url => rpcCall(url, 'getLatestBlockhash', [{ commitment }], { timeoutMs })));
    const answers = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      try { const v = r.value?.value; new PublicKey(v?.blockhash); slotNumber(v?.lastValidBlockHeight); answers.push(v); } catch {}
    }
    const counts = new Map();
    for (const a of answers) counts.set(a.blockhash, (counts.get(a.blockhash) ?? 0) + 1);
    const agreed = answers.filter(a => counts.get(a.blockhash) >= need).sort((a, b) => b.lastValidBlockHeight - a.lastValidBlockHeight)[0];
    if (agreed) return agreed;
    const seen = new Set();
    for (const a of answers.sort((x, y) => y.lastValidBlockHeight - x.lastValidBlockHeight)) {
      if (seen.has(a.blockhash)) continue;
      seen.add(a.blockhash);
      try {
        await readRpcQuorum('isBlockhashValid', [a.blockhash, { commitment }], { ...quorumOptions, select: v => { if (v?.value !== true) throw new Error('Blockhash not valid on this node'); return true; } });
        return a;
      } catch {}
    }
    throw new QuorumError('No blockhash confirmed by enough endpoints', []);
  };
  const signer = expected => {
    if (!keypair) throw new Error('Read-only adapter has no signer');
    if (expected && !keypair.publicKey.equals(new PublicKey(expected))) throw new Error('Signer does not match trade role');
    return keypair.publicKey;
  };
  const args = (terms, hashHex) => {
    hex32(hashHex);
    const amount = unsigned(terms.quoteAmount);
    if (amount === 0n) throw new RangeError('Quote amount must be positive');
    calculateFees(amount, terms.fees.platformFeeBps, terms.fees.tradeFeeBps);
    return {
      paymentHashHex: hashHex, payer: new PublicKey(terms.buyer.solPayer), recipient: new PublicKey(terms.seller.solRecipient),
      refund: new PublicKey(terms.buyer.solPayer), refundAfter: terms.refundAfter, amount, mint: new PublicKey(terms.mint),
      expectedPlatformFeeBps: terms.fees.platformFeeBps, expectedTradeFeeBps: terms.fees.tradeFeeBps,
      tradeFeeCollector: new PublicKey(terms.fees.collector), programId: program,
      payerTokenAccount: deriveVaultAta(terms.buyer.solPayer, terms.mint),
    };
  };

  async function configState(trade, collector, options = {}) {
    const derived = trade ? deriveTradeConfigPda(collector, program) : deriveConfigPda(program);
    const info = await account(derived.pda, { ...options, unanimous: true });
    if (!info) return null;
    if (info.owner !== program.toBase58() || info.executable) throw new Error('Invalid fee config owner');
    const state = (trade ? decodeTradeConfigState : decodeConfigState)(info.data);
    if (state.bump !== derived.bump || !state.authority.equals(state.feeCollector) || (trade && !state.feeCollector.equals(new PublicKey(collector)))) throw new Error('Invalid fee config identity');
    return state;
  }

  async function token(address, owner, tokenMint) {
    const info = await account(address);
    if (!info) return null;
    if (info.owner !== TOKEN_PROGRAM_ID.toBase58() || info.executable || info.data.length !== 165 || info.data[108] !== 1) throw new Error('Invalid token account');
    const value = unpackAccount(new PublicKey(address), { ...info, owner: TOKEN_PROGRAM_ID });
    if (!value.owner.equals(new PublicKey(owner)) || !value.mint.equals(new PublicKey(tokenMint)) || !value.isInitialized || value.isFrozen) throw new Error('Token account owner, mint or state mismatch');
    return value;
  }

  async function signatureState(signature, { unanimous = false } = {}) {
    return (await readRpcQuorum('getSignatureStatuses', [[signature], { searchTransactionHistory: true }], { ...quorumOptions, unanimous, select: result => {
      const status = result?.value?.[0];
      if (status === null) return null;
      if (!status || !Object.hasOwn(status, 'err') || !['processed', 'confirmed', 'finalized'].includes(status.confirmationStatus)) throw new Error('Invalid signature status');
      return { slot: slotNumber(status.slot), err: status.err, confirmationStatus: status.confirmationStatus };
    } })).value;
  }

  async function saveEntry(id, entry) {
    const next = new Map(pending);
    if (entry) next.set(id, structuredClone(entry));
    else next.delete(id);
    if (intents) {
      if (next.size) await intents.put(storeId, { v: 1, entries: [...next.values()] });
      else await intents.delete(storeId);
    }
    pending.clear();
    for (const [key, value] of next) pending.set(key, value);
  }

  function tradeIntent(kind, terms, hashHex) {
    const input = args(terms, hashHex);
    return { kind, hashHex, terms: {
      seller: { solRecipient: input.recipient.toBase58() }, buyer: { solPayer: input.payer.toBase58() },
      mint: input.mint.toBase58(), quoteAmount: input.amount.toString(), refundAfter: String(input.refundAfter),
      fees: { platformFeeBps: input.expectedPlatformFeeBps, tradeFeeBps: input.expectedTradeFeeBps,
        collector: input.tradeFeeCollector.toBase58(), platformCollector: new PublicKey(terms.fees.platformCollector).toBase58() },
    } };
  }

  async function reconcile(entry) {
    if (['done', 'rejected', 'retryable', 'retired-unsent', 'not-executed'].includes(entry.phase)) return entry;
    const status = await signatureState(entry.signature, { unanimous: entry.intent.kind === 'lock' });
    if (status && ['confirmed', 'finalized'].includes(status.confirmationStatus)) {
      if ((commitment === 'finalized' || entry.intent.kind === 'lock' && status.err ||
          ['collector-config', 'platform-config', 'platform-withdraw'].includes(entry.intent.kind)) &&
          status.confirmationStatus !== 'finalized') return { ...entry, observedConfirmed: true };
      return { ...entry, phase: status.err ? 'rejected' : 'done', observedConfirmed: false,
        reason: status.err ? `Transaction failed: ${JSON.stringify(status.err)}` : null };
    }
    entry = { ...entry, observedConfirmed: false };
    if (!await expiredAttempt(entry)) return entry;
    // Fence subsequent account reads at a finalized slot observed after expiry.
    const minContextSlot = await finalizedSlot();
    const { kind, terms, hashHex } = entry.intent;
    const withdrawal = ['withdraw', 'wallet-withdraw', 'platform-withdraw'].includes(kind);
    const latestStatus = await signatureState(entry.signature, { unanimous: withdrawal || kind === 'lock' });
    if (latestStatus && ['confirmed', 'finalized'].includes(latestStatus.confirmationStatus)) return entry;
    // A processed signature is still evidence of a possible execution, not proof of absence.
    if (kind === 'lock' && latestStatus !== null) return entry;
    if (['lock', 'claim', 'refund'].includes(kind)) {
      const checked = await inspectEscrow({ terms, hashHex, purpose: 'settlement', programId: program,
        ...quorumOptions, commitment: 'finalized', minContextSlot });
      if (kind === 'lock' && checked.reasons.some(reason => reason.code === 'ESCROW_MISSING')) return { ...entry, phase: 'retryable' };
      if (!checked.ok) throw new Error(`Expired intent could not be reconciled: ${checked.reasons.map(reason => reason.code).join(', ')}`);
      if (kind === 'lock' || kind === 'claim' && checked.state.status === 1 || kind === 'refund' && checked.state.status === 2) {
        const signature = await history(terms, hashHex, kind === 'lock' ? 0 : kind === 'claim' ? 1 : 2, 'finalized');
        return { ...entry, phase: 'done', resultSignature: signature };
      }
      if (checked.state.status === 0) return { ...entry, phase: 'retryable' };
      return { ...entry, phase: 'rejected', reason: checked.state.status === 2 ? 'escrow_refunded' : 'escrow_claimed' };
    }
    if (kind === 'config') {
      const state = await configState(true, signer(), { commitment: 'finalized', minContextSlot });
      return state?.feeBps === entry.intent.feeBps ? { ...entry, phase: 'done', resultSignature: null } : { ...entry, phase: 'retryable' };
    }
    if (kind === 'collector-config' || kind === 'platform-config') {
      const state = await configState(kind === 'collector-config', entry.intent.collector, { commitment: 'finalized', minContextSlot });
      return state?.feeBps === entry.intent.feeBps && state.feeCollector.toBase58() === entry.intent.collector
        ? { ...entry, phase: 'done', resultSignature: null } : { ...entry, phase: 'retryable' };
    }
    // A balance cannot prove whether a withdrawal executed. Its expired signature can: when every reader that answers
    // a history search read after expiry finds no status, it never executed.
    if (!entry.sent || latestStatus === null && Date.now() - entry.createdAt < WITHDRAWAL_PROOF_MS) return { ...entry, phase: 'retryable' };
    throw new Error('Expired withdrawal outcome is unknown; signature history is required');
  }

  async function initialize() {
    if (!intents) return;
    const saved = await intents.get(storeId);
    if (saved == null) return;
    if (saved.v !== 1 || !Array.isArray(saved.entries)) throw new Error('Invalid durable intent journal');
    for (const raw of saved.entries) {
      const entry = structuredClone(raw);
      if (!entry || typeof entry.id !== 'string' || pending.has(entry.id) ||
          !['pending', 'retryable', 'done', 'rejected', 'retired-unsent', 'not-executed'].includes(entry.phase) ||
          typeof entry.sent !== 'boolean' || !Number.isSafeInteger(entry.createdAt) || entry.createdAt < 0 ||
          !Number.isSafeInteger(entry.attempt) || entry.attempt < 1 ||
          !['lock', 'claim', 'refund', 'config', 'collector-config', 'platform-config', 'platform-withdraw', 'withdraw', 'wallet-withdraw'].includes(entry.intent?.kind)) throw new Error('Invalid durable intent');
      if (entry.phase === 'not-executed' && entry.intent.kind !== 'lock') throw new Error('Invalid retired lock intent');
      const height = entry.lastValidBlockHeight ?? entry.height;
      if (height != null || entry.intent.kind !== 'lock') slotNumber(height);
      if (entry.height != null && entry.lastValidBlockHeight != null && entry.height !== entry.lastValidBlockHeight) throw new Error('Durable intent expiry mismatch');
      for (const field of ['lastBroadcastAt', 'legacyObservedAt']) if (entry[field] != null) slotNumber(entry[field]);
      const tx = Transaction.from(Buffer.from(entry.wire, 'base64'));
      if (!keypair || !tx.feePayer.equals(keypair.publicKey) || !tx.verifySignatures() || bs58.encode(tx.signature) !== entry.signature) throw new Error('Durable intent signature or payer mismatch');
      pending.set(entry.id, entry);
    }
    for (const entry of [...pending.values()]) {
      // Old journals did not date each broadcast. Start a durable observation window rather than mistaking
      // createdAt (which survives replacement attempts) for the time of the most recent send.
      if (entry.intent.kind === 'lock' && entry.lastValidBlockHeight == null && entry.height == null &&
          entry.lastBroadcastAt == null && entry.legacyObservedAt == null) {
        entry.legacyObservedAt = Date.now();
        await saveEntry(entry.id, entry);
      }
      let reconciled;
      try { reconciled = await reconcile(entry); }
      catch { continue; } // Unavailable quorum retains the exact durable attempt.
      await saveEntry(entry.id, reconciled);
    }
  }

  // The chain tip: the highest processed slot reported by any endpoint (at least `need` must answer), i.e. the newest
  // block any of them has seen. One endpoint reporting too high only makes callers more cautious.
  async function tipSlot() {
    const results = await Promise.allSettled(urls.map(url => rpcCall(url, 'getSlot', [{ commitment: 'processed' }], { timeoutMs })));
    const slots = results.filter(r => r.status === 'fulfilled').map(r => slotNumber(r.value));
    if (slots.length < need) throw new Error('Too few endpoints answered for the chain tip');
    return Math.max(...slots);
  }

  async function expiredAttempt(entry) {
    const height = entry.lastValidBlockHeight ?? entry.height;
    if (height != null) return await reached('getBlockHeight', [{ commitment: 'finalized' }]) > height;
    const since = entry.lastBroadcastAt ?? entry.legacyObservedAt;
    if (entry.intent.kind !== 'lock' || !Number.isSafeInteger(since) || Date.now() - since < LEGACY_LOCK_PROOF_MS) return false;
    // Wall time alone cannot expire a transaction if the chain stopped. Legacy signed bytes still name their
    // blockhash, so require finalized readers to agree that it is no longer valid as well as the safe age.
    const blockhash = Transaction.from(Buffer.from(entry.wire, 'base64')).recentBlockhash;
    return (await readRpcQuorum('isBlockhashValid', [blockhash, { commitment: 'finalized' }], {
      ...quorumOptions, unanimous: true, select: result => {
        if (typeof result?.value !== 'boolean') throw new Error('Invalid blockhash validity');
        return result.value;
      },
    })).value === false;
  }

  // Read-only recovery never signs or sends. Absence requires an expired journaled signature with no status,
  // followed by an absent finalized escrow fenced after expiry. An absent journal alone proves nothing.
  async function lockOutcome({ terms, hashHex }) {
    hex32(hashHex);
    const id = `lock:${hashHex}`, entry = pending.get(id);
    if (entry?.phase === 'not-executed') return { ok: true, outcome: 'none' };
    const expired = entry ? await expiredAttempt(entry) : false;
    const minContextSlot = await finalizedSlot();
    const status = entry ? await signatureState(entry.signature, { unanimous: true }) : undefined;
    const checked = await inspectEscrow({ terms: entry?.intent.terms ?? terms, hashHex, purpose: 'settlement', programId: program,
      ...quorumOptions, commitment: 'finalized', minContextSlot });
    if (checked.ok) return { ok: true, outcome: 'landed' };
    const absent = checked.reasons.length === 1 && checked.reasons[0].code === 'ESCROW_MISSING';
    const failed = status?.confirmationStatus === 'finalized' && Boolean(status.err);
    if (absent && (failed || status === null && (expired || entry?.phase === 'retired-unsent' && !entry.sent))) {
      // Persist the terminal verdict before returning it. A host retry already waiting in the adapter queue
      // must not sign a fresh attempt after the buyer has released this trade's wallet commitment.
      await saveEntry(id, { ...entry, phase: 'not-executed' });
      return { ok: true, outcome: 'none' };
    }
    return { ok: true, outcome: 'unknown' };
  }

  async function pendingIntents() {
    const startupError = await ready;
    if (startupError) throw startupError;
    return [...pending.values()].filter(entry => !['done', 'rejected', 'retired-unsent', 'not-executed'].includes(entry.phase)).map(entry => ({
      id: entry.id, signature: entry.signature, ageMs: Math.max(0, Date.now() - entry.createdAt),
      createdAt: entry.createdAt, attempt: entry.attempt,
    }));
  }

  // `signBefore` (unix seconds): no new or replacement transaction is signed at or after it. `sendBefore` (default
  // `signBefore`): journaled bytes that were never sent are not first sent at or after it. A sent attempt is still
  // reconciled and resent.
  async function submit(id, instructions, intent, { signBefore = null, sendBefore = signBefore, signers = [], afterSign = null } = {}) {
    signer();
    let signed = false;
    let entry = pending.get(id);
    if (entry && JSON.stringify(entry.intent) !== JSON.stringify(intent)) throw new Error('Intent terms differ from the durable submission');
    if (entry?.phase === 'not-executed') throw new Error('Lock did not go through');
    const deadline = Date.now() + confirmationTimeoutMs;
    let lastError = 'Transaction confirmation timed out';
    do {
      if (entry) {
        try {
          entry = await reconcile(entry);
          await saveEntry(id, entry);
        } catch (error) {
          lastError = error.message;
          await delay(150);
          continue;
        }
        if (entry.phase === 'done') {
          const signature = Object.hasOwn(entry, 'resultSignature') ? entry.resultSignature : entry.signature;
          if (!['wallet-withdraw', 'platform-config', 'collector-config', 'platform-withdraw'].includes(intent.kind)) await saveEntry(id, null);
          return signature;
        }
        if (entry.phase === 'rejected') {
          await saveEntry(id, null);
          throw new Error(entry.reason);
        }
        if (entry.observedConfirmed) { await delay(150); continue; }
      }
      if (!entry || ['retryable', 'retired-unsent'].includes(entry.phase)) {
        if (afterSign && signed) throw new Error('Platform authority keypair required to sign again');
        if (intent.kind === 'platform-config' && keypair.publicKey.toBase58() !== intent.collector &&
            !signers.some(s => s.publicKey.toBase58() === intent.collector)) throw new Error('Platform authority keypair required to sign');
        if (signBefore !== null && Date.now() / 1000 >= signBefore) throw new Error('Signing window closed');
        const latest = await latestBlockhash();
        if (signBefore !== null && Date.now() / 1000 >= signBefore) throw new Error('Signing window closed');
        const tx = new Transaction({ feePayer: keypair.publicKey, recentBlockhash: latest.blockhash }).add(...instructions);
        tx.sign(keypair, ...signers.filter(s => !s.publicKey.equals(keypair.publicKey)));
        signed = true; afterSign?.();
        const fresh = { id, intent, phase: 'pending', signature: bs58.encode(tx.signature), wire: tx.serialize().toString('base64'),
          height: latest.lastValidBlockHeight, lastValidBlockHeight: latest.lastValidBlockHeight,
          sent: false, createdAt: entry?.createdAt ?? Date.now(), attempt: (entry?.attempt ?? 0) + 1 };
        await saveEntry(id, fresh); // Never send bytes whose durable write failed.
        entry = fresh;
        const height = await reached('getBlockHeight', [{ commitment: 'finalized' }]);
        if (height > entry.height) lastError = 'Fresh blockhash already expired';
        continue;
      }
      const hadPreviousSubmission = entry.sent;
      // A prepared transaction that was never sent is dropped, not first sent, once its window has closed.
      if (!hadPreviousSubmission && sendBefore !== null && Date.now() / 1000 >= sendBefore) {
        await saveEntry(id, null);
        throw new Error('Signing window closed');
      }
      entry = { ...entry, sent: true, lastBroadcastAt: Date.now() };
      await saveEntry(id, entry); // A crash after this point is conservatively unknown.
      if (!hadPreviousSubmission && sendBefore !== null && Date.now() / 1000 >= sendBefore) {
        await saveEntry(id, { ...entry, phase: 'retired-unsent', sent: false });
        throw new Error('Signing window closed');
      }
      try {
        const signature = await rpcCall(sendEndpoint, 'sendTransaction', [entry.wire, { encoding: 'base64', preflightCommitment: commitment, maxRetries: 0 }], { timeoutMs });
        if (signature !== entry.signature) throw new Error('RPC returned an unexpected transaction signature');
      } catch (error) {
        if (error.kind === 'rpc' && error.code === -32002 && !hadPreviousSubmission) {
          await saveEntry(id, null);
          throw new Error(`Transaction simulation failed: ${error.message}`);
        }
        lastError = error.message;
      }
      await delay(150);
    } while (Date.now() < deadline);
    throw new Error(`Pending transaction ${entry?.signature}: ${lastError}`);
  }

  async function history(terms, hashHex, tag, readCommitment = finality) {
    const address = deriveEscrowPda(hashHex, program).pda;
    const signatures = await quorum('getSignaturesForAddress', [address.toBase58(), { limit: 100, commitment: readCommitment }], result => {
      if (!Array.isArray(result)) throw new Error('Invalid signature history');
      return result.filter(row => row.err === null).map(row => ({ signature: row.signature, slot: slotNumber(row.slot) }));
    });
    const deadline = Date.now() + confirmationTimeoutMs;
    const expected = args(terms, hashHex);
    const init = buildInitInstruction(expected);
    for (const row of signatures) {
      if (Date.now() >= deadline) {
        const error = new Error('Escrow history read timed out');
        error.pending = true;
        throw error;
      }
      const receipt = await quorum('getTransaction', [row.signature, { encoding: 'base64', commitment: readCommitment, maxSupportedTransactionVersion: 0 }], result => {
        if (result === null) return null;
        if (!result?.meta || result.meta.err !== null || result.transaction?.[1] !== 'base64') throw new Error('Invalid transaction receipt');
        return { slot: slotNumber(result.slot), transaction: result.transaction[0] };
      });
      if (!receipt) continue;
      if (receipt.slot !== row.slot) throw new Error('Transaction history slot mismatch');
      const tx = Transaction.from(Buffer.from(receipt.transaction, 'base64'));
      if (!tx.verifySignatures() || bs58.encode(tx.signature) !== row.signature) throw new Error('Invalid transaction signature');
      for (const ix of tx.instructions) {
        if (!ix.programId.equals(program) || ix.data[0] !== tag) continue;
        const escrowIndex = tag === 0 ? 2 : 1;
        if (!ix.keys[escrowIndex]?.pubkey.equals(address)) continue;
        if (tag === 0) {
          if (!ix.data.equals(init.data) || !ix.keys[0]?.pubkey.equals(expected.payer) || !ix.keys[0].isSigner) throw new Error('Original deposit differs from terms');
        } else {
          const authority = tag === 1 ? expected.recipient : expected.refund;
          if (!ix.keys[0]?.pubkey.equals(authority) || !ix.keys[0].isSigner) throw new Error('Settlement signer mismatch');
        }
        return row.signature;
      }
    }
    const error = new Error('Matching escrow transaction history unavailable');
    error.definitive = true;
    throw error;
  }

  async function inspectTrade({ terms, hashHex, purpose = 'lock' }, readCommitment = finality) {
    try {
      args(terms, hashHex);
      if (!['lock', 'settlement'].includes(purpose)) throw new Error('Invalid purpose');
      const result = await inspectEscrow({ terms, hashHex, purpose: 'settlement', programId: program, ...quorumOptions, commitment: readCommitment });
      if (!result.ok) {
        const codes = result.reasons.map(r => r.code);
        const status = codes.includes('ESCROW_MISSING') ? 'missing' : codes.some(c => c.endsWith('_QUORUM')) ? 'pending' : 'mismatch';
        return { ok: false, hashHex, purpose, status, reasons: result.reasons };
      }
      const status = ['active', 'claimed', 'refunded'][result.state.status];
      if (status !== 'active') await history(terms, hashHex, 0, readCommitment);
      return { ok: status === 'active' || purpose === 'settlement', hashHex, purpose, status };
    } catch (error) {
      return { ok: false, hashHex, purpose, status: error.name === 'QuorumError' || error.pending ? 'pending' : 'mismatch', reasons: [{ code: 'ADAPTER', message: error.message }] };
    }
  }

  async function lockEscrow({ terms, hashHex }) {
    signer(terms.buyer.solPayer);
    const input = args(terms, hashHex);
    const intent = tradeIntent('lock', terms, hashHex);
    // A deposit only helps while the seller may still send: a new lock is signed only before sendBy minus the lock-start
    // margin, and journaled bytes are first sent only before sendBy.
    const window = { signBefore: terms.sendBy - LOCK_START_MARGIN_SEC, sendBefore: terms.sendBy };
    const submitLock = async () => {
      try { return await submit(`lock:${hashHex}`, [buildInitInstruction(input)], intent, window); }
      catch (error) {
        if (!pending.has(`lock:${hashHex}`)) {
          const current = await configState(false);
          if (current && current.feeBps !== terms.fees.platformFeeBps) throw new Error('platform fee changed, take again');
        }
        throw error;
      }
    };
    if (pending.has(`lock:${hashHex}`)) return { ok: true, hashHex, signature: await submitLock() };
    if (Date.now() / 1000 >= window.signBefore) throw new Error('Signing window closed');
    const checked = await inspectTrade({ terms, hashHex });
    if (checked.status === 'active') return { ok: true, hashHex, signature: await history(terms, hashHex, 0) };
    if (checked.status !== 'missing') throw new Error(`Cannot lock escrow: ${checked.status}`);
    const [platform, trade] = await Promise.all([configState(false), configState(true, input.tradeFeeCollector)]);
    if (platform && platform.feeBps !== terms.fees.platformFeeBps) throw new Error('platform fee changed, take again');
    if (!platform || !trade || trade.feeBps !== terms.fees.tradeFeeBps || !platform.feeCollector.equals(new PublicKey(terms.fees.platformCollector))) throw new Error('Fee configuration differs from terms');
    const funds = await token(input.payerTokenAccount, input.payer, input.mint);
    const { totalAmount } = calculateFees(input.amount, input.expectedPlatformFeeBps, input.expectedTradeFeeBps);
    if (!funds || funds.amount < totalAmount) throw new Error('Insufficient token balance for net amount plus fees');
    const signature = await submitLock();
    return { ok: true, hashHex, signature };
  }

  function claimInstructions(input, preimageHex) {
    const destination = deriveVaultAta(input.recipient, input.mint);
    return [createAssociatedTokenAccountIdempotentInstruction(input.recipient, destination, input.recipient, input.mint),
      buildClaimInstruction({ ...input, preimageHex, recipientTokenAccount: destination })];
  }

  // Read-only admission check. Before a deal exists its hash/preimage are placeholders: the real claim has the
  // same instructions, one signature and no priority-fee instruction. Quote that message through our RPC quorum.
  async function claimFunds({ address, mint = serviceMint, collector }) {
    const recipient = new PublicKey(address), tokenMint = new PublicKey(mint);
    const [sol, ata, latest] = await Promise.all([account(recipient, { commitment: finality }),
      token(deriveVaultAta(recipient, tokenMint), recipient, tokenMint), latestBlockhash()]);
    const balance = BigInt(slotNumber(sol?.lamports ?? 0));
    const instructions = claimInstructions({ recipient, mint: tokenMint, tradeFeeCollector: new PublicKey(collector),
      paymentHashHex: '00'.repeat(32), programId: program }, '00'.repeat(32));
    const message = new Transaction({ feePayer: recipient, recentBlockhash: latest.blockhash }).add(...instructions)
      .serializeMessage().toString('base64');
    const [fee, rent] = await Promise.all([
      quorum('getFeeForMessage', [message, { commitment }], result => slotNumber(result?.value)),
      ata ? 0 : quorum('getMinimumBalanceForRentExemption', [ACCOUNT_SIZE, { commitment: finality }], slotNumber),
    ]);
    const required = BigInt(fee) + BigInt(rent);
    return { ok: balance >= required, balance: balance.toString(), fee: String(fee), rent: String(rent),
      required: required.toString(), shortfall: (balance < required ? required - balance : 0n).toString() };
  }

  async function settle(kind, { terms, hashHex, preimageHex }) {
    const claim = kind === 'claim';
    const authority = signer(claim ? terms.seller.solRecipient : terms.buyer.solPayer);
    const input = args(terms, hashHex);
    const checked = await inspectTrade({ terms, hashHex, purpose: 'settlement' });
    const target = claim ? 'claimed' : 'refunded';
    const field = claim ? 'claimSignature' : 'refundSignature';
    if (checked.ok && claim && checked.status === 'refunded') {
      if (pending.has(`claim:${hashHex}`)) await saveEntry(`claim:${hashHex}`, null);
      throw new Error('escrow_refunded');
    }
    if (checked.ok && checked.status === target) {
      const signature = await history(terms, hashHex, claim ? 1 : 2);
      if (pending.has(`${kind}:${hashHex}`)) await saveEntry(`${kind}:${hashHex}`, null);
      return { ok: true, [field]: signature };
    }
    if (claim && createHash('sha256').update(Buffer.from(hex32(preimageHex), 'hex')).digest('hex') !== hashHex) throw new Error('Preimage does not match payment hash');
    const destination = deriveVaultAta(authority, input.mint);
    const create = createAssociatedTokenAccountIdempotentInstruction(authority, destination, authority, input.mint);
    const instructions = claim ? claimInstructions(input, preimageHex) :
      [create, buildRefundInstruction({ ...input, refundTokenAccount: destination })];
    const intent = tradeIntent(kind, terms, hashHex);
    if (pending.has(`${kind}:${hashHex}`)) return { ok: true, [field]: await submit(`${kind}:${hashHex}`, instructions, intent) };
    if (!checked.ok || checked.status !== 'active') throw new Error(`Cannot ${kind} escrow: ${checked.status}`);
    if (!claim) {
      const clock = await account(SYSVAR_CLOCK_PUBKEY, { commitment: finality });
      if (clockTime(clock) < terms.refundAfter) throw new Error('Too early to refund according to chain Clock');
    }
    return { ok: true, [field]: await submit(`${kind}:${hashHex}`, instructions, intent) };
  }

  function clockTime(clock) {
    if (!clock || clock.owner !== SYSVAR_OWNER || clock.data.length !== 40) throw new Error('Invalid chain Clock sysvar');
    return Number(clock.data.readBigInt64LE(32));
  }

  // Solana's Clock time (unix seconds) at a confirmed slot: the median of the readers that answer, at least need of
  // them. The sysvar changes every slot, so readers rarely agree byte for byte.
  async function chainTime() {
    const results = await Promise.allSettled(urls.map(async url => clockTime((await readAccount(url, SYSVAR_CLOCK_PUBKEY, { timeoutMs, commitment: 'confirmed' })).value)));
    const times = results.filter(r => r.status === 'fulfilled').map(r => r.value).sort((a, b) => a - b);
    if (times.length < need) throw new Error('Too few endpoints answered for the chain Clock');
    return times[Math.floor((times.length - 1) / 2)];
  }

  async function finalizedSlot() {
    return reached('getSlot', [{ commitment: 'finalized' }]);
  }

  async function firstFinalizedBlockAtLeast(minSlot) {
    slotNumber(minSlot);
    const tip = await finalizedSlot();
    if (tip < minSlot) throw new Error('Requested slot is not finalized yet');
    // Each node keeps its own amount of history, so the first available block differs between nodes by design. Each is
    // asked on its own, and only nodes that still hold minSlot take part in the block search.
    const firsts = await Promise.allSettled(urls.map(url => rpcCall(url, 'getFirstAvailableBlock', [], { timeoutMs })));
    const answered = firsts.filter(r => r.status === 'fulfilled');
    const holding = urls.filter((url, i) => firsts[i].status === 'fulfilled' && slotNumber(firsts[i].value) <= minSlot);
    if (holding.length < need) {
      throw new Error(answered.length >= need && answered.length - holding.length > answered.length - need
        ? 'Requested block history has been pruned; first slot cannot be established'
        : 'Too few endpoints hold the requested block history');
    }
    const search = async (method, params, select) => (await readRpcQuorum(method, params, { ...quorumOptions, endpoints: holding, select })).value;
    const deadline = Date.now() + confirmationTimeoutMs;
    for (let start = minSlot; start <= tip; start += 512) {
      if (Date.now() >= deadline) throw new Error('Finalized block search timed out');
      const end = Math.min(tip, start + 511);
      // Only the first block counts. A node that has not finalized the whole range yet still names the same first
      // block; an empty answer from a node that is behind counts as no answer.
      const slot = await search('getBlocks', [start, end, { commitment: 'finalized' }], result => {
        if (!Array.isArray(result) || result.some((slot, i) => slotNumber(slot) < start || slot > end || i > 0 && slot <= result[i - 1])) throw new Error('Invalid finalized block range');
        if (!result.length) throw new Error('No finalized block in range on this endpoint');
        return result[0];
      }).catch(error => {
        if (error.name === 'QuorumError' && error.reports?.every(r => r.message === 'No finalized block in range on this endpoint')) return null;
        throw error;
      });
      if (slot === null) continue;
      const blockhash = await search('getBlock', [slot, { commitment: 'finalized', transactionDetails: 'none', rewards: false, maxSupportedTransactionVersion: 0 }], result => {
        if (!result) throw new Error('Finalized block unavailable');
        return new PublicKey(result.blockhash).toBuffer().toString('hex');
      });
      return { slot, blockhash, finalized: true };
    }
    throw new Error('No finalized block in the requested range');
  }

  async function ensureTradeConfig({ feeBps }) {
    const collector = signer();
    calculateFees(0n, 0, feeBps);
    const state = await configState(true, collector);
    if (state?.feeBps === feeBps && !pending.has(`config:${feeBps}`)) return { ok: true, signature: null };
    const ix = state ? buildSetTradeConfigInstruction({ authority: collector, feeCollector: collector, feeBps, programId: program }) : buildInitTradeConfigInstruction({ payer: collector, feeCollector: collector, feeBps, programId: program });
    return { ok: true, signature: await submit(`config:${feeBps}`, pending.has(`config:${feeBps}`) ? Transaction.from(Buffer.from(pending.get(`config:${feeBps}`).wire, 'base64')).instructions : [ix], { kind: 'config', feeBps }) };
  }

  async function assertFeeConfig(fee, platformCollector) {
    calculateFees(0n, fee.platformFeeBps, fee.tradeFeeBps);
    const [platform, trade] = await Promise.all([configState(false, null, { commitment: 'finalized' }),
      configState(true, fee.collector, { commitment: 'finalized' })]);
    if (!trade || trade.feeBps !== fee.tradeFeeBps) throw new Error('Collector has no matching finalized trade fee config');
    if (!platform || platform.feeBps !== fee.platformFeeBps || platformCollector && platform.feeCollector.toBase58() !== platformCollector) throw new Error('Registry platform fee differs from finalized platform config');
    return { platformFeeBps: platform.feeBps, tradeFeeBps: trade.feeBps, collector: trade.feeCollector.toBase58() };
  }

  async function platformFeeConfig() {
    const state = await configState(false, null, { commitment: 'finalized' });
    if (!state) throw new Error('Finalized platform config is missing');
    return { feeBps: state.feeBps, authority: state.authority.toBase58(), collector: state.feeCollector.toBase58() };
  }

  // Rotation only initializes a fresh collector. A published collector's bps are never changed.
  async function createCollectorConfig({ collectorKeypair, feeBps }) {
    const payer = signer(), collector = collectorKeypair.publicKey, id = `collector:${collector}`;
    if (!intents) throw new Error('Durable intent store required');
    calculateFees(0n, 0, feeBps);
    const state = await configState(true, collector, { commitment: 'finalized' });
    if (state && state.feeBps !== feeBps) throw new Error('Existing collector config has different bps');
    if (state) return { ok: true, signature: pending.get(id)?.signature ?? null };
    const intent = { kind: 'collector-config', collector: collector.toBase58(), feeBps };
    let instructions;
    if (pending.has(id)) instructions = Transaction.from(Buffer.from(pending.get(id).wire, 'base64')).instructions;
    else {
      // The deployed program requires its init payer to be the collector. The service funds its rent atomically.
      const rent = await quorum('getMinimumBalanceForRentExemption', [68, { commitment: 'finalized' }], slotNumber);
      instructions = [SystemProgram.transfer({ fromPubkey: payer, toPubkey: collector, lamports: rent }),
        buildInitTradeConfigInstruction({ payer: collector, feeCollector: collector, feeBps, programId: program })];
    }
    const signature = await submit(id, instructions, intent, { signers: [collectorKeypair] });
    const finalized = await configState(true, collector, { commitment: 'finalized' });
    if (!finalized || finalized.feeBps !== feeBps) throw new Error('Collector config is not finalized yet');
    return { ok: true, signature };
  }

  async function setPlatformConfig({ id, feeBps, authority, authorityKeypair = null }) {
    hex32(id); signer(); calculateFees(0n, feeBps, 0);
    if (!intents) throw new Error('Durable intent store required');
    const state = await configState(false, null, { commitment: 'finalized' });
    if (!state || state.authority.toBase58() !== authority || authorityKeypair && authorityKeypair.publicKey.toBase58() !== authority) throw new Error('Platform authority does not match config');
    const key = `platform:${id}`, intent = { kind: 'platform-config', feeBps, collector: authority };
    if (state.feeBps === feeBps && !pending.has(key)) return { ok: true, signature: null };
    if (!authorityKeypair && (!pending.has(key) || ['retryable', 'retired-unsent'].includes(pending.get(key).phase))) throw new Error('Platform authority keypair required to sign');
    const instructions = pending.has(key) ? Transaction.from(Buffer.from(pending.get(key).wire, 'base64')).instructions :
      [buildSetConfigInstruction({ authority, feeCollector: authority, feeBps, programId: program })];
    const signature = await submit(key, instructions, intent, { signers: authorityKeypair ? [authorityKeypair] : [],
      afterSign: authorityKeypair ? () => authorityKeypair.secretKey.fill(0) : null });
    const finalized = await configState(false, null, { commitment: 'finalized' });
    if (!finalized || finalized.feeBps !== feeBps) throw new Error('Platform config is not finalized yet');
    return { ok: true, signature };
  }

  async function tradeFeeBalances() {
    if (!collectors) throw new Error('Collector key source required');
    const out = [];
    for (const { collector, feeBps } of collectors()) {
      const config = deriveTradeConfigPda(collector, program).pda;
      const state = await configState(true, collector, { commitment: 'finalized' });
      if (state && state.feeBps !== feeBps) throw new Error('Collector fee config differs from keyring');
      const held = await token(deriveVaultAta(config, serviceMint), config, serviceMint);
      out.push({ collector, feeBps, balance: held?.amount.toString() ?? '0' });
    }
    return out;
  }

  async function tradeFeeBalance() {
    const collector = signer();
    const config = deriveTradeConfigPda(collector, program).pda;
    await configState(true, collector);
    return (await token(deriveVaultAta(config, serviceMint), config, serviceMint))?.amount.toString() ?? '0';
  }

  async function withdrawTradeFees({ amount, to }) {
    const collector = signer();
    const requested = unsigned(amount);
    const destination = new PublicKey(to);
    const available = BigInt(await tradeFeeBalance());
    const id = `withdraw:${amount}:${destination}`;
    const intent = { kind: 'withdraw', amount, to: destination.toBase58() };
    if (pending.has(id)) return { ok: true, signature: await submit(id, Transaction.from(Buffer.from(pending.get(id).wire, 'base64')).instructions, intent) };
    if (requested > available) throw new Error('Withdrawal exceeds fee balance');
    if (!await token(destination, collector, serviceMint)) throw new Error('Fee destination token account missing');
    const ix = buildWithdrawTradeFeesInstruction({ feeCollector: collector, destination, mint: serviceMint, amount: requested, programId: program });
    return { ok: true, signature: await submit(id, [ix], intent) };
  }

  async function walletBalances(address = signer().toBase58(), { fees = false } = {}) {
    const owner = new PublicKey(address);
    const [sol, usdc] = await Promise.all([account(owner, { commitment: finality }), token(deriveVaultAta(owner, serviceMint), owner, serviceMint)]);
    if (sol && !Number.isSafeInteger(sol.lamports)) throw new Error('Unsafe SOL balance');
    const perCollector = fees && collectors ? await tradeFeeBalances() : null;
    const collected = perCollector ? perCollector.reduce((n, c) => n + BigInt(c.balance), 0n) : fees ? BigInt(await tradeFeeBalance()) : 0n;
    return { SOL: String(sol?.lamports ?? 0), USDC: ((usdc?.amount ?? 0n) + collected).toString(), collectedFees: collected.toString(),
      ...(perCollector ? { collectors: perCollector } : {}) };
  }

  // The program that owns an account, or null when it does not exist (finalized).
  async function accountOwner(address) {
    return (await account(new PublicKey(address), { commitment: finality }))?.owner ?? null;
  }

  // Evidence for a finished wallet withdrawal, from its finalized transaction (as for platform fees): the exact
  // journaled bytes, no error, and the amount arriving at the destination in the transaction's own balance records.
  async function walletReceipt(entry) {
    const { asset, amount, to } = entry.intent, n = unsigned(amount);
    const destination = asset === 'SOL' ? new PublicKey(to) : deriveVaultAta(to, serviceMint);
    const index = Transaction.from(Buffer.from(entry.wire, 'base64')).compileMessage().accountKeys.findIndex(key => key.equals(destination));
    return quorum('getTransaction', [entry.signature, { commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 0 }], value => {
      if (!value || value.meta?.err !== null || !Array.isArray(value.transaction) || value.transaction[0] !== entry.wire || index < 0) throw new Error('Finalized withdrawal transaction is unavailable or mismatched');
      let received;
      if (asset === 'SOL') {
        const [pre, post] = [value.meta.preBalances?.[index], value.meta.postBalances?.[index]];
        if (![pre, post].every(Number.isSafeInteger)) throw new Error('Finalized SOL balances unavailable');
        received = BigInt(post) - BigInt(pre);
      } else {
        const units = rows => {
          if (!Array.isArray(rows)) throw new Error('Finalized token balances unavailable');
          const row = rows.find(row => row.accountIndex === index);
          if (!row) return 0n;
          if (row.mint !== serviceMint.toBase58() || row.uiTokenAmount?.decimals !== 6) throw new Error('Finalized token balance mismatch');
          return unsigned(row.uiTokenAmount.amount);
        };
        received = units(value.meta.postTokenBalances) - units(value.meta.preTokenBalances);
      }
      if (received !== n) throw new Error('Finalized withdrawal balances do not match amount');
      return { signature: entry.signature, slot: slotNumber(value.slot) };
    });
  }

  async function walletWithdraw({ id, asset, amount, to, fees = false, collector = null }) {
    hex32(id);
    if (!intents) throw new Error('Durable intent store required');
    if (!['USDC', 'SOL'].includes(asset) || typeof fees !== 'boolean') throw new Error('Invalid wallet withdrawal');
    const n = unsigned(amount), owner = signer(), destination = new PublicKey(to);
    if (!n || owner.equals(destination)) throw new Error('Invalid withdrawal amount or destination');
    const key = `wallet:${id}`, intent = { kind: 'wallet-withdraw', asset, amount, to: destination.toBase58(), fees, ...(collector ? { collector } : {}) };
    const collectorKey = collector ? collectors?.().find(c => c.collector === collector)?.keypair : null;
    if (collector && (!collectorKey || asset !== 'USDC' || fees)) throw new Error('Invalid collector withdrawal');
    const previous = pending.get(key);
    let instructions;
    if (previous) instructions = Transaction.from(Buffer.from(previous.wire, 'base64')).instructions;
    else if (collector) {
      const authority = collectorKey.publicKey, source = deriveVaultAta(authority, serviceMint), target = deriveVaultAta(destination, serviceMint);
      instructions = [createAssociatedTokenAccountIdempotentInstruction(owner, source, authority, serviceMint),
        createAssociatedTokenAccountIdempotentInstruction(owner, target, destination, serviceMint),
        buildWithdrawTradeFeesInstruction({ feeCollector: authority, destination: source, mint: serviceMint, amount: n, programId: program }),
        createTransferCheckedInstruction(source, serviceMint, target, authority, n, 6)];
    }
    else if (asset === 'SOL') instructions = [SystemProgram.transfer({ fromPubkey: owner, toPubkey: destination, lamports: n })];
    else {
      const source = deriveVaultAta(owner, serviceMint), target = deriveVaultAta(destination, serviceMint);
      instructions = [createAssociatedTokenAccountIdempotentInstruction(owner, target, destination, serviceMint)];
      if (fees) {
        const held = (await token(source, owner, serviceMint))?.amount ?? 0n;
        if (held < n) instructions.push(createAssociatedTokenAccountIdempotentInstruction(owner, source, owner, serviceMint),
          buildWithdrawTradeFeesInstruction({ feeCollector: owner, destination: source, mint: serviceMint, amount: n - held, programId: program }));
      }
      instructions.push(createTransferCheckedInstruction(source, serviceMint, target, owner, n, 6));
    }
    return { ok: true, signature: await submit(key, instructions, intent, { signers: collectorKey ? [collectorKey] : [] }) };
  }

  async function walletWithdrawalStatus(id) {
    hex32(id);
    const key = `wallet:${id}`, entry = pending.get(key);
    // Every signed withdrawal is journaled before it is sent.
    if (!entry) return { ok: false, unknown: false, reason: 'Not sent: no signed withdrawal was recorded' };
    const next = await reconcile(entry);
    await saveEntry(key, next);
    if (next.phase === 'done') return { ok: true, unknown: false, ...await walletReceipt(next) };
    if (['retryable', 'retired-unsent'].includes(next.phase)) return { ok: false, unknown: false, signature: next.signature,
      reason: 'Not executed: the transaction expired without landing; nothing was sent' };
    return { ok: false, unknown: next.phase !== 'rejected', signature: next.signature, reason: next.reason ?? null };
  }

  async function withdrawPlatformFees({ id, mint: tokenMint, amount, to, decimals, afterSign }) {
    hex32(id);
    if (!intents) throw new Error('Durable intent store required');
    const authority = signer(), destination = new PublicKey(to), mintKey = new PublicKey(tokenMint), n = unsigned(amount);
    if (!n || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('Invalid platform withdrawal');
    const key = `platform-withdraw:${id}`, intent = { kind: 'platform-withdraw', mint: mintKey.toBase58(), amount, to: destination.toBase58(), decimals };
    const source = deriveVaultAta(authority, mintKey), target = deriveVaultAta(destination, mintKey);
    const vault = deriveVaultAta(deriveConfigPda(program).pda, mintKey);
    const previous = pending.get(key);
    let instructions;
    if (previous) instructions = Transaction.from(Buffer.from(previous.wire, 'base64')).instructions;
    else {
      const state = await configState(false, null, { commitment: 'finalized' });
      if (!state || !state.authority.equals(authority) || !state.feeCollector.equals(authority)) throw new Error('Platform authority does not match config');
      instructions = [createAssociatedTokenAccountIdempotentInstruction(authority, source, authority, mintKey),
        buildWithdrawFeesInstruction({ feeCollector: authority, destination: source, mint: mintKey, amount: n, programId: program })];
      if (!authority.equals(destination)) instructions.push(createAssociatedTokenAccountIdempotentInstruction(authority, target, destination, mintKey),
        createTransferCheckedInstruction(source, mintKey, target, authority, n, decimals));
    }
    const signature = await submit(key, instructions, intent, { afterSign });
    const saved = pending.get(key);
    // A transaction just finalized on one node can take a few seconds to reach the others, so the receipt is read again.
    const readReceipt = () => quorum('getTransaction', [signature, { commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 0 }], value => {
      if (!value || value.meta?.err !== null || !Array.isArray(value.transaction) || value.transaction[0] !== saved.wire) throw new Error('Finalized withdrawal transaction is unavailable or mismatched');
      const tx = Transaction.from(Buffer.from(value.transaction[0], 'base64'));
      const addresses = tx.compileMessage().accountKeys;
      const units = (rows, address, required) => {
        if (!Array.isArray(rows)) throw new Error('Finalized token balances unavailable');
        const index = addresses.findIndex(key => key.equals(address));
        const row = rows.find(row => row.accountIndex === index);
        if (!row && !required) return 0n;
        if (!row || row.mint !== mintKey.toBase58() || row.uiTokenAmount?.decimals !== decimals) throw new Error('Finalized token balance mismatch');
        return unsigned(row.uiTokenAmount.amount);
      };
      const pre = value.meta.preTokenBalances, post = value.meta.postTokenBalances;
      if (units(pre, vault, true) - units(post, vault, true) !== n || units(post, target, true) - units(pre, target, false) !== n) throw new Error('Finalized withdrawal balances do not match amount');
      return { signature, slot: slotNumber(value.slot), vaultAfter: units(post, vault, true).toString() };
    });
    let receipt;
    for (let attempt = 1; ; attempt++) {
      try { receipt = await readReceipt(); break; } catch (error) {
        if (attempt >= 20 || error.name !== 'QuorumError') throw error;
        await delay(3000);
      }
    }
    return { ok: true, ...receipt };
  }

  // Startup reconciliation is awaited before any mutation. Read-only checks remain available.
  const ready = Promise.resolve().then(initialize).then(() => null, error => error);
  return {
    lockEscrow: input => guarded(`lock:${input?.hashHex}`, () => lockEscrow(input)),
    checkEscrow: input => inspectTrade(input),
    // Read-only: null means a successful read found no settlement; pending means the read could not decide.
    settlementSignature: async ({ terms, hashHex }) => {
      const checked = await inspectTrade({ terms, hashHex, purpose: 'settlement' });
      if (checked.status === 'pending') return { status: 'pending' };
      if (!checked.ok || !['claimed', 'refunded'].includes(checked.status)) return null;
      try { return { status: checked.status, signature: await history(terms, hashHex, checked.status === 'claimed' ? 1 : 2) }; }
      catch (error) { if (error.name !== 'QuorumError' && !error.pending) return null; throw error; }
    },
    claim: input => guarded(`claim:${input?.hashHex}`, () => settle('claim', input)),
    refund: input => guarded(`refund:${input?.hashHex}`, () => settle('refund', input)),
    lockOutcome: input => guarded(`lockOutcome:${input?.hashHex}`, () => lockOutcome(input)),
    finalizedSlot, tipSlot, chainTime, firstFinalizedBlockAtLeast, pendingIntents, accountOwner,
    // A pushed view of the finalized slot and the tip from the same RPC nodes (see chain-watch.js); the caller starts it.
    chainWatch: options => new ChainWatch({ endpoints: urls, need, ...options }),
    ensureTradeConfig: input => guarded(`config:${input?.feeBps}`, () => ensureTradeConfig(input)), tradeFeeBalance,
    assertFeeConfig, platformFeeConfig, tradeFeeBalances,
    createCollectorConfig: input => guarded(`collector:${input?.collectorKeypair?.publicKey}`, () => createCollectorConfig(input)),
    setPlatformConfig: input => guarded(`platform:${input?.id}`, () => setPlatformConfig(input)),
    withdrawTradeFees: input => guarded(`withdraw:${input?.amount}:${input?.to}`, () => withdrawTradeFees(input)),
    walletBalances, claimFunds,
    walletWithdraw: input => guarded(`wallet:${input?.id}`, () => walletWithdraw(input)),
    walletWithdrawalStatus: id => guarded(`wallet:${id}`, () => walletWithdrawalStatus(id)),
    withdrawPlatformFees: input => guarded(`platform-withdraw:${input?.id}`, () => withdrawPlatformFees(input)),
  };
}
