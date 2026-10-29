import fs from 'node:fs';
import path from 'node:path';
import { blake3 } from '@noble/hashes/blake3.js';
import PeerWallet from '../../peer/node_modules/trac-wallet/index.js';
import { openUsedTxStore } from '../../peer/src/trac/used-tx.js';
import { transferNonce, buildTnkTransfer, buildResetTransfer } from './transfers.js';
import { openIntentStore } from './intents.js';
import { supportedBase } from '../market/assets.js';
import { createAddressProof } from '../core/address-proof.js';
import { createGatewayHealth, resetGatewayOrigin, GATEWAY_TIMEOUT_MS } from './gateway-health.js';
import { RESET_PAUSED_MESSAGE } from '../market/gateway-status.js';

const isHash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const isAmount = value => typeof value === 'string' && value.length <= 78 && /^[1-9][0-9]*$/.test(value);
const seconds = () => Math.floor(Date.now() / 1000);
const exact = (object, fields) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).length === fields.length && fields.every(key => Object.hasOwn(object, key));
const reject = reason => { const error = new Error(reason); error.reason = reason; throw error; };

function publicKey(address) {
  if (typeof address !== 'string' || !address.startsWith('trac1')) reject('invalid_address');
  const key = PeerWallet.decodeBech32mSafe(address);
  if (key?.length !== 32 || PeerWallet.encodeBech32mSafe('trac', key) !== address) reject('invalid_address');
  return Buffer.from(key).toString('hex');
}

export { sendFinalTransfer } from './finality.js';

function observations(folder) {
  const fd = fs.openSync(path.join(folder, 'finality.jsonl'), 'a+', 0o600);
  const rows = new Map();
  let failed = false, closed = false;
  const fields = ['v', 'asset', 'txHash', 'from', 'to', 'amount', 'nonce', 'finalizedAt'];
  try {
    const contents = fs.readFileSync(fd, 'utf8');
    if (contents && !contents.endsWith('\n')) throw new Error('Incomplete finality journal');
    for (const line of contents.split('\n').slice(0, -1)) {
      const row = JSON.parse(line);
      if (!exact(row, fields) || row.v !== 1 || !['TNK', 'RESET'].includes(row.asset) || !isHash(row.txHash) || !isHash(row.nonce) || !isAmount(row.amount) || !Number.isSafeInteger(row.finalizedAt) || row.finalizedAt < 0) throw new Error('Invalid finality journal');
      publicKey(row.from); publicKey(row.to);
      const key = `${row.asset}:${row.txHash}`;
      if (rows.has(key)) throw new Error('Duplicate finality record');
      rows.set(key, row);
    }
    fs.fsyncSync(fd);
    const directory = fs.openSync(folder, 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } catch (error) { fs.closeSync(fd); throw error; }
  return {
    get(record) {
      if (failed || closed) reject('finality_store_unavailable');
      const previous = rows.get(`${record.asset}:${record.txHash}`);
      if (!previous || ['from', 'to', 'amount', 'nonce'].some(name => previous[name] !== record[name])) return null;
      return previous.finalizedAt;
    },
    record(record) {
      if (failed || closed) reject('finality_store_unavailable');
      const key = `${record.asset}:${record.txHash}`;
      const previous = rows.get(key);
      if (previous) {
        for (const name of ['from', 'to', 'amount', 'nonce']) if (previous[name] !== record[name]) reject('conflicting_finality_record');
        return previous.finalizedAt;
      }
      const row = { v: 1, ...record };
      const bytes = Buffer.from(JSON.stringify(row) + '\n');
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
          if (!written) throw new Error('Finality write made no progress');
          offset += written;
        }
        fs.fsyncSync(fd);
      } catch { failed = true; reject('finality_store_unavailable'); }
      rows.set(key, row);
      return row.finalizedAt;
    },
    close() { if (!closed) { closed = true; fs.closeSync(fd); } }
  };
}

async function gatewayCall(origin, route, body) {
  const response = await fetch(new URL(route, origin), { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS) });
  if (!response.ok) { await response.body?.cancel(); reject('gateway_rejected'); }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 65536) reject('invalid_gateway_response');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { reject('invalid_gateway_response'); }
}

export function createTracAdapter({ bridge, wallet = null, profile = null, resetGatewayUrl = null,
  explorerUrl = 'https://explorer.trac.network', usedTxFolder = null, intentFolder = null }) {
  if (typeof bridge?.call !== 'function') throw new Error('Bridge.call is required');
  const explorer = new URL(explorerUrl);
  if (!['http:', 'https:'].includes(explorer.protocol) || explorer.username || explorer.password || explorer.search || explorer.hash || explorer.pathname !== '/') throw new Error('Expected a Trac explorer origin');
  const origin = resetGatewayOrigin(resetGatewayUrl), health = createGatewayHealth({ resetGatewayUrl });
  let used, observed, intents, closed = false;
  const sends = new Map();
  try {
    if (intentFolder !== null) intents = openIntentStore(intentFolder);
    if (usedTxFolder !== null) {
      used = openUsedTxStore(usedTxFolder);
      observed = observations(usedTxFolder);
    }
  } catch (error) { intents?.close(); used?.close(); throw error; }

  async function prepare({ terms, tradeId, from, to, fromKey, toKey }) {
    if (!wallet || typeof wallet.sign !== 'function') reject('wallet_required');
    if (wallet.address !== from || wallet.publicKey !== fromKey) reject('wrong_wallet');
    if (seconds() >= terms.sendBy) reject('send_deadline');
    if (terms.base.kind === 'trac-native') {
      const context = await bridge.call('dex_msb_info', {});
      if (context?.addressPrefix !== 'trac') reject('wrong_network');
      if (profile && (context.networkId !== profile.peer.msbNetworkId || context.msbBootstrap !== profile.peer.msbBootstrap)) reject('wrong_network');
      const payload = await buildTnkTransfer({ ...context, from, to, amount: terms.baseAmount, tradeId, sign: bytes => wallet.sign(bytes) });
      return { payload, submission: null, txHash: payload.tro.tx };
    }
    if (!origin) reject('reset_gateway_required');
    // No signature or durable intent exists on this path. Retries must sample again, even on resume.
    if (!(await health.read({ fresh: true })).ok) reject(RESET_PAUSED_MESSAGE);
    if (seconds() >= terms.sendBy) reject('send_deadline');
    const nonce = transferNonce(tradeId);
    const context = await bridge.call('dex_reset_context', {});
    if (context?.addressPrefix !== 'trac') reject('wrong_network');
    if (profile && (context.networkId !== profile.peer.msbNetworkId || context.msb !== profile.peer.msbBootstrap || context.subnet !== profile.peer.trac.reset.bootstrap)) reject('wrong_network');
    const prepared = await gatewayCall(origin, '/v1/tx/prepare', { address: fromKey, to: toKey, amount: terms.baseAmount, nonce });
    if (!exact(prepared, ['address', 'to', 'amount', 'prepared_command', 'tx', 'nonce', 'context']) || prepared.address !== fromKey || prepared.to !== toKey || prepared.amount !== terms.baseAmount || prepared.nonce !== nonce || !isHash(prepared.tx) || !exact(prepared.prepared_command, ['type', 'value']) || prepared.prepared_command.type !== 'transfer' || !exact(prepared.prepared_command.value, ['to', 'amount']) || prepared.prepared_command.value.to !== toKey || prepared.prepared_command.value.amount !== terms.baseAmount) reject('invalid_gateway_response');
    const pc = prepared.context;
    const command = { type: 'transfer', value: { to: toKey, amount: terms.baseAmount } };
    const ch = Buffer.from(blake3(Buffer.from(JSON.stringify(command)))).toString('hex');
    if (!exact(pc, ['network_id', 'txv', 'writer', 'content_hash', 'subnet', 'msb']) || pc.network_id !== context.networkId || pc.txv !== context.txv || pc.subnet !== context.subnet || pc.msb !== context.msb || pc.content_hash !== ch || !isHash(pc.writer)) reject('gateway_context_mismatch');
    // Preparation can outlast the health cache or the send window. Neither permits a late signature.
    if (seconds() >= terms.sendBy) reject('send_deadline');
    if (!(await health.read()).ok) reject(RESET_PAUSED_MESSAGE);
    if (seconds() >= terms.sendBy) reject('send_deadline');
    const { payload, submission } = await buildResetTransfer({ ...context, writer: pc.writer, from: fromKey, to: toKey,
      amount: terms.baseAmount, tradeId, sign: bytes => {
        if (Buffer.from(bytes).toString('hex') !== prepared.tx) reject('gateway_hash_mismatch');
        return wallet.sign(bytes);
      } });
    return { payload, submission, txHash: submission.tx };
  }

  // Submit exactly the journaled bytes. Never refresh txv or prepare another RESET command.
  async function broadcast(intent) {
    if (intent.asset === 'TNK') {
      const receipt = await bridge.call('dex_tnk_broadcast', { payload: structuredClone(intent.payload) });
      if (receipt?.txHash !== intent.txHash) reject('invalid_broadcast_receipt');
    } else {
      const response = await gatewayCall(origin, '/v1/tx/submit', intent.submission);
      if (response?.ok !== true || response.result?.txo?.tx !== intent.txHash) reject('invalid_broadcast_receipt');
    }
  }

  async function send({ terms, tradeId, resume = false }) {
    const event = () => ({ type: 'transferSent', now: seconds(), tradeId });
    let intent, submitted = false;
    try {
      if (closed) reject('adapter_closed');
      if (!isHash(tradeId)) reject('invalid_terms');
      if (!intents) reject('intent_store_required');
      intent = intents.get(tradeId);
      submitted = Boolean(intent); // A crash can occur between the durable intent and submission.
      if (typeof resume !== 'boolean' || !supportedBase(terms?.base) || !isAmount(terms.baseAmount) || !Number.isSafeInteger(terms.sendBy) || terms.sendBy < 0) reject('invalid_terms');
      const from = terms.seller?.tracAddr, to = terms.buyer?.tracAddr;
      const fromKey = publicKey(from), toKey = publicKey(to);
      const asset = terms.base.id;
      if (intent) {
        if (intent.asset !== asset || intent.from !== from || intent.to !== to || intent.amount !== terms.baseAmount || intent.sendBy !== terms.sendBy) reject('intent_terms_mismatch');
        if (seconds() < intent.sentAt) reject('clock_regressed');
        let proof;
        try {
          proof = await bridge.call('dex_verify', { asset, txHash: intent.txHash, from: asset === 'RESET' ? fromKey : from,
            to: asset === 'RESET' ? toKey : to, minAmount: intent.amount, nonce: transferNonce(tradeId) });
        } catch (error) {
          if (seconds() >= intent.sendBy) reject('past_send_deadline');
          throw error;
        }
        if (proof?.ok === true && proof.final === true && proof.amount === intent.amount) return { ...event(), ok: true, txHash: intent.txHash, sentAt: intent.sentAt };
        if (seconds() >= intent.sendBy) reject('past_send_deadline');
        if (proof?.final === true) reject(proof.reason ?? 'transfer_mismatch');
      } else {
        const signed = await prepare({ terms, tradeId, from, to, fromKey, toKey });
        if (closed) reject('adapter_closed');
        const sentAt = seconds();
        if (sentAt >= terms.sendBy) reject('send_deadline');
        intent = { tradeId, asset, from, to, amount: terms.baseAmount, sendBy: terms.sendBy, createdAt: sentAt, sentAt, ...signed };
        try { intents.save(intent); } catch { reject('intent_store_unavailable'); }
        if (seconds() >= terms.sendBy) reject('send_deadline');
      }
      if (closed) reject('adapter_closed');
      if (asset === 'RESET' && !origin) reject('reset_gateway_required');
      submitted = true;
      await broadcast(intent);
      return { ...event(), ok: true, txHash: intent.txHash, sentAt: intent.sentAt };
    } catch (error) {
      return { ...event(), ok: false, ...(submitted ? { unknown: true, txHash: intent.txHash, sentAt: intent.sentAt } : {}), reason: error.reason ?? 'send_failed' };
    }
  }

  return {
    gatewayHealth: options => health.read(options),
    gatewayHealthStatus: () => health.peek(),
    proveAddress({ dexKey, expiresAt }) {
      if (closed || !wallet || !profile) throw new Error('Trac wallet and network profile required');
      return createAddressProof(wallet, { networkId: profile.peer.msbNetworkId, dexKey, expiresAt });
    },
    async balances(address = wallet?.address) {
      if (closed) throw new Error('Adapter is closed');
      publicKey(address);
      const result = await bridge.call('dex_balances', { address });
      if (!result || ['TNK', 'RESET', 'feeTnk'].some(k => typeof result[k] !== 'string' || !/^(0|[1-9][0-9]*)$/.test(result[k]))) throw new Error('Invalid Trac balances');
      return result;
    },
    async withdrawalStatus({ id, asset, to, amount }) {
      if (closed || !wallet) throw new Error('Open signing wallet required');
      const intent = intents?.get(id);
      // Every signed transfer is journaled before it is broadcast.
      if (!intent) return { ok: false, unknown: false, reason: 'Not sent: no signed transfer was recorded' };
      if (intent.asset !== asset || intent.to !== to || intent.amount !== amount || intent.from !== wallet.address) throw new Error('Withdrawal differs from durable transfer');
      const { txHash } = intent;
      const from = wallet.address, fromKey = publicKey(from), toKey = publicKey(to);
      const result = await bridge.call('dex_verify', { asset, txHash, from: asset === 'RESET' ? fromKey : from,
        to: asset === 'RESET' ? toKey : to, minAmount: amount, nonce: transferNonce(id) });
      // A transfer that is still not final after its send window is broadcast again with the same bytes: it either
      // lands once (the network refuses a known hash) or stays visible here as unconfirmed.
      if (result?.final !== true && seconds() >= intent.sendBy && (asset === 'TNK' || origin)) await broadcast(intent).catch(() => {});
      return { ok: result?.ok === true && result.final === true && result.amount === amount,
        unknown: result?.final !== true, txHash, reason: result?.reason };
    },
    sendTransfer({ terms, tradeId, resume = false } = {}) {
      // Snapshot the fields we use before asynchronous signing/prepare and serialize each trade.
      const request = { tradeId, resume, terms: terms && { pair: terms.pair, base: terms.base && { ...terms.base }, baseAmount: terms.baseAmount, sendBy: terms.sendBy,
        seller: { tracAddr: terms.seller?.tracAddr }, buyer: { tracAddr: terms.buyer?.tracAddr } } };
      const pending = (sends.get(tradeId) ?? Promise.resolve()).then(() => send(request));
      sends.set(tradeId, pending);
      return pending.finally(() => { if (sends.get(tradeId) === pending) sends.delete(tradeId); });
    },

    // Seller recovery after sendBy is read-only. The intent may exist even if a crash kept its hash out of the
    // trade journal. Never infer an unsigned transfer from the trade journal alone, or discard its signed intent.
    async checkSellerTransfer({ terms, tradeId, txHash } = {}) {
      const event = () => ({ type: 'sellerTransferChecked', now: seconds(), tradeId, txHash });
      try {
        if (closed) reject('adapter_closed');
        if (!intents) reject('intent_store_required');
        if (!isHash(tradeId) || !supportedBase(terms?.base) || !isAmount(terms.baseAmount) ||
            !Number.isSafeInteger(terms.sendBy) || terms.sendBy < 0 || seconds() < terms.sendBy ||
            txHash != null && !isHash(txHash)) reject('invalid_request');
        await sends.get(tradeId);
        const intent = intents.get(tradeId);
        if (intent) {
          if (intent.asset !== terms.base.id || intent.from !== terms.seller?.tracAddr || intent.to !== terms.buyer?.tracAddr ||
              intent.amount !== terms.baseAmount || intent.sendBy !== terms.sendBy || txHash && txHash !== intent.txHash) reject('intent_terms_mismatch');
          txHash = intent.txHash;
        }
        if (!txHash) return { ...event(), ok: false, final: false, notApplied: true, noIntent: true };
        const proof = await this.verifyTransfer({ asset: terms.base.id, txHash, from: terms.seller.tracAddr,
          to: terms.buyer.tracAddr, minAmount: terms.baseAmount, nonce: transferNonce(tradeId), tradeId,
          finalBefore: Number.MAX_SAFE_INTEGER, fresh: true });
        return { ...proof, ...event() };
      } catch (error) { return { ...event(), ok: false, final: false, reason: error.reason ?? 'verification_failed' }; }
    },

    // The explorer only supplies candidate hashes. The caller must verify each one on its own peer.
    async recentTransferCandidates({ asset, from, to, tradeId, since } = {}) {
      if (closed) reject('adapter_closed');
      if (!used) reject('used_tx_store_required');
      if (!['TNK', 'RESET'].includes(asset) || !isHash(tradeId) || !Number.isSafeInteger(since)) reject('invalid_request');
      publicKey(from); publicKey(to);
      const url = new URL('/api/transactions', explorer);
      url.searchParams.set('address', from);
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok) { await response.body?.cancel(); reject('explorer_rejected'); }
      const body = await response.json();
      const rows = JSON.parse(body.transactions);
      if (!Array.isArray(rows)) reject('invalid_explorer_response');
      const candidates = new Set();
      for (const row of rows) {
        if (!row || !isHash(row.tx) || row.address !== from || row.type !== (asset === 'RESET' ? '12' : '13') ||
            (asset === 'TNK' && row.to !== to) || typeof row.createdAt !== 'string' || !(Date.parse(row.createdAt) >= since * 1000)) continue;
        const reservedFor = used.get(row.tx);
        if (reservedFor && reservedFor !== tradeId) continue;
        candidates.add(row.tx);
        if (candidates.size === 5) break;
      }
      return [...candidates];
    },

    async verifyTransfer({ asset, txHash, from, to, minAmount, nonce, tradeId, finalBefore, fresh = false } = {}) {
      const event = () => ({ type: 'transferVerified', now: seconds(), tradeId, txHash, asset, from, to, nonce });
      try {
        if (closed) reject('adapter_closed');
        if (!used || !observed) reject('used_tx_store_required');
        if (!['TNK', 'RESET'].includes(asset) || !isHash(txHash) || !isHash(tradeId) || !isHash(nonce) || !isAmount(minAmount) || !Number.isSafeInteger(finalBefore) || finalBefore < 0 || typeof fresh !== 'boolean') reject('invalid_request');
        const fromKey = publicKey(from), toKey = publicKey(to);
        const usedBy = used.get(txHash);
        if (usedBy && usedBy !== tradeId) return { ...event(), ok: false, final: false, usedBy, reason: 'tx_already_used' };
        if (nonce !== transferNonce(tradeId)) reject('wrong_nonce');
        const observation = { asset, txHash, from, to, amount: minAmount, nonce };
        let finalizedAt = observed.get(observation);
        if (finalizedAt === null || fresh) {
          const proof = await bridge.call('dex_verify', { asset, txHash, from: asset === 'RESET' ? fromKey : from,
            to: asset === 'RESET' ? toKey : to, minAmount, nonce });
          if (proof?.reason === 'read_failed') reject('read_failed');
          if (proof?.ok === true && proof.final === true) {
            if (proof.amount !== minAmount) reject('wrong_amount');
            finalizedAt = observed.record({ ...observation, finalizedAt: seconds() });
          } else if (finalizedAt === null) {
            // Only successful reads of absent signed state or an explicit contract rejection establish that
            // nothing was applied. Errors, incomplete replies and transfer mismatches never release a hold.
            const notApplied = proof?.ok === false && (proof.final === false &&
              (proof.reason === 'unknown_or_not_final' || asset === 'RESET' && proof.reason === 'reset_not_final') ||
              asset === 'RESET' && proof.final === true && proof.reason === 'contract_rejected');
            return { ...event(), ok: false, final: proof?.final === true, amount: proof?.amount ?? null,
              reason: proof?.reason ?? 'not_final', ...(fresh ? { notApplied } : {}) };
          }
          // A previously recorded final transfer cannot become unapplied when a replica falls behind.
        }
        const now = seconds();
        if (finalizedAt > now) reject('clock_regressed');
        if (finalizedAt >= finalBefore) return { ...event(), ok: false, final: true, finalizedAt, reason: 'finality_deadline' };
        // Recheck after the asynchronous bridge call: another trade may have reserved it.
        const reservedFor = used.get(txHash);
        if (reservedFor && reservedFor !== tradeId) return { ...event(), ok: false, final: true, usedBy: reservedFor, reason: 'tx_already_used' };
        return { ...event(), ok: true, final: true, amount: minAmount, finalizedAt, ...(reservedFor ? { usedBy: reservedFor } : {}) };
      } catch (error) { return { ...event(), ok: false, final: false, reason: error.reason ?? 'verification_failed' }; }
    },

    reserveTx({ txHash, tradeId } = {}) {
      try {
        if (closed) reject('adapter_closed');
        if (!used) reject('used_tx_store_required');
        const result = used.claim(txHash, tradeId);
        return { ok: result.ok, reservedFor: used.get(txHash) };
      } catch (error) { return { ok: false, reservedFor: null, reason: error.reason ?? 'reservation_failed' }; }
    },

    close() {
      if (closed) return;
      closed = true;
      try { intents?.close(); } finally { try { observed?.close(); } finally { used?.close(); } }
    }
  };
}
