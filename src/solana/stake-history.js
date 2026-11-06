import { PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { rpcCall } from './rpc.js';
import { PROGRAM_ID } from './constants.js';
import { buildInitInstruction, deriveEscrowPda, deriveVaultAta } from './escrow.js';
import { checkEscrow } from './check.js';
import { sha256Hex, stableJSON } from '../core/canonical.js';

const uint = n => { if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid history boundary'); return n; };
const signature = s => { if (typeof s !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(s)) throw new Error('Invalid history signature'); return s; };

// A separate complete-range reader for stake adjudication. Missing/pruned data,
// pagination limits and unsupported transaction forms stay unknown. The spot
// adapter's settlement/recovery semantics are unchanged.
export async function stakeEscrowHistory({ terms, hashHex, fromSlot, throughSlot, endpoints, need = 2,
  programId = PROGRAM_ID, timeoutMs = 3000, maxPages = 20, read = rpcCall, inspect = checkEscrow }) {
  uint(fromSlot); uint(throughSlot);
  if (throughSlot < fromSlot || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || !/^[0-9a-f]{64}$/.test(hashHex ?? '')) throw new Error('Invalid history request');
  const urls = (endpoints ?? []).map(endpoint => {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid history endpoint');
    return url.href;
  });
  if (!Number.isInteger(need) || need < 2 || urls.length < need || new Set(urls).size !== urls.length) throw new Error('Two distinct history readers required');
  const program = new PublicKey(programId), escrow = deriveEscrowPda(hashHex, program).pda;
  const init = buildInitInstruction({ payer: new PublicKey(terms.buyer.solPayer), recipient: new PublicKey(terms.seller.solRecipient),
    refund: new PublicKey(terms.buyer.solPayer), mint: new PublicKey(terms.mint), amount: BigInt(terms.quoteAmount),
    refundAfter: BigInt(terms.refundAfter), paymentHashHex: hashHex, expectedPlatformFeeBps: terms.fees.platformFeeBps, expectedTradeFeeBps: terms.fees.tradeFeeBps,
    payerTokenAccount: deriveVaultAta(terms.buyer.solPayer, terms.mint), tradeFeeCollector: new PublicKey(terms.fees.collector), programId: program });
  const deadline = Date.now() + Math.min(120000, timeoutMs * 40);
  const scan = async endpoint => {
    const call = async (method, params) => {
      if (Date.now() >= deadline) throw new Error('History deadline exceeded');
      return read(endpoint, method, params, { timeoutMs: Math.min(timeoutMs, Math.max(1, deadline - Date.now())) });
    };
    if (uint(await call('getSlot', [{ commitment: 'finalized' }])) < throughSlot) throw new Error('History range is not finalized');
    if (uint(await call('getFirstAvailableBlock', [])) > fromSlot) throw new Error('Relevant block history is pruned');
    let before, complete = false, priorSlot = Infinity;
    const seen = new Set(), rows = [], locks = [], settlements = [], receipts = [];
    for (let page = 0; page < maxPages; page++) {
      const batch = await call('getSignaturesForAddress', [escrow.toBase58(), { limit: 100, commitment: 'finalized', ...(before ? { before } : {}) }]);
      if (!Array.isArray(batch) || batch.length > 100) throw new Error('Invalid signature page');
      for (const row of batch) {
        signature(row.signature); uint(row.slot);
        if (seen.has(row.signature) || row.slot > priorSlot || row.err === undefined) throw new Error('History page repeats or reorders');
        seen.add(row.signature); priorSlot = row.slot;
        if (row.slot < fromSlot) { complete = true; break; }
        if (row.slot <= throughSlot) rows.push(row);
      }
      if (complete || batch.length < 100) { complete = true; break; }
      before = batch.at(-1).signature;
    }
    if (!complete) throw new Error('History page limit reached');
    for (const row of rows) {
      if (row.err !== null) { receipts.push({ signature: row.signature, slot: row.slot, failed: true }); continue; }
      const result = await call('getTransaction', [row.signature, { encoding: 'base64', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
      if (!result || result.slot !== row.slot || result.meta?.err !== null || result.transaction?.[1] !== 'base64') throw new Error('Final transaction receipt unavailable');
      const raw = Buffer.from(result.transaction[0], 'base64'), tx = Transaction.from(raw);
      if (!tx.verifySignatures() || bs58.encode(tx.signature) !== row.signature) throw new Error('History transaction signature differs');
      receipts.push({ signature: row.signature, slot: row.slot, wireHash: sha256Hex(raw) });
      for (const ix of tx.instructions) {
        const tag = ix.data[0], index = tag === 0 ? 2 : 1;
        if (!ix.programId.equals(program) || ![0, 1, 2].includes(tag) || !ix.keys[index]?.pubkey.equals(escrow)) continue;
        const includedAt = uint(result.blockTime), blockAt = uint(await call('getBlockTime', [row.slot]));
        if (blockAt !== includedAt) throw new Error('Historical block clocks disagree');
        if (tag === 0) {
          const exact = ix.data.equals(init.data) && ix.keys.length === init.keys.length && init.keys.every((key, i) =>
            ix.keys[i].pubkey.equals(key.pubkey) && (!key.isSigner || ix.keys[i].isSigner) && (!key.isWritable || ix.keys[i].isWritable));
          locks.push({ signature: row.signature, slot: row.slot, includedAt, exact });
        } else {
          const expected = new PublicKey(tag === 1 ? terms.seller.solRecipient : terms.buyer.solPayer);
          if (!ix.keys[0]?.pubkey.equals(expected) || !ix.keys[0].isSigner) throw new Error('Historical settlement authority differs');
          settlements.push({ signature: row.signature, slot: row.slot, includedAt, state: tag === 1 ? 'claimed' : 'refunded' });
        }
      }
    }
    const sort = (a, b) => a.slot - b.slot || a.signature.localeCompare(b.signature);
    return { escrow: escrow.toBase58(), fromSlot, throughSlot, locks: locks.sort(sort), settlements: settlements.sort(sort),
      historyDigest: sha256Hex(stableJSON(receipts.sort(sort))) };
  };
  const results = await Promise.allSettled(urls.map(scan)), successes = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (successes.length < need || successes.some(r => stableJSON(r) !== stableJSON(successes[0])))
    return { status: 'unknown', historyComplete: false, reason: successes.length < need ? 'history_unavailable' : 'history_disagrees' };
  const facts = successes[0];
  if (facts.locks.some(l => l.exact)) {
    let state;
    try { state = await inspect({ terms, hashHex, endpoints: urls, need, timeoutMs, programId: program, commitment: 'finalized',
      purpose: 'settlement', minContextSlot: throughSlot }); }
    catch { return { status: 'unknown', historyComplete: false, reason: 'escrow_state_unavailable' }; }
    // The init instruction binds amounts and expected fee rates. The retained
    // escrow state additionally proves the actual platform collector and mint.
    if (!state.ok) return { status: 'unknown', historyComplete: false, reason: 'escrow_state_unavailable' };
    facts.escrowState = ['active', 'claimed', 'refunded'][state.state.status];
    if (!facts.escrowState) return { status: 'unknown', historyComplete: false, reason: 'escrow_state_unavailable' };
  }
  return { status: 'complete', finalized: true, historyComplete: true, ...facts, evidenceDigest: sha256Hex(stableJSON(facts)) };
}
