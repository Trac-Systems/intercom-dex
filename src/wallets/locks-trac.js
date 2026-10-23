import { blake3 } from '@noble/hashes/blake3.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import PeerWallet from '../../peer/node_modules/trac-wallet/index.js';
import { transferNonce } from '../trac/transfers.js';
import { stableJSON } from '../core/canonical.js';

const hex = value => { if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Invalid transfer key'); return Buffer.from(value, 'hex'); };
const key = address => { const bytes = PeerWallet.decodeBech32mSafe(address); if (bytes?.length !== 32 || PeerWallet.encodeBech32mSafe('trac', bytes) !== address) throw new Error('Invalid Trac address'); return Buffer.from(bytes).toString('hex'); };
const uint32 = n => { if (!Number.isInteger(n) || n < 1 || n > 0xffffffff) throw new Error('Invalid network'); const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

// Locks use their own funding nonce and encrypted journal; spot adapter semantics stay unchanged.
export function createLocksTrac({ bridge, wallet, profile, store, resetGatewayUrl, request = fetch }) {
  const gateway = async (route, body) => {
    if (!resetGatewayUrl) throw new Error('RESET gateway required');
    const url = new URL(resetGatewayUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid RESET gateway');
    const response = await request(new URL(route, url), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
      throw new Error(`RESET gateway rejected request (HTTP ${response.status}${detail ? ': ' + detail : ''})`);
    }
    const text = await response.text(); if (text.length > 65536) throw new Error('Invalid gateway reply'); return JSON.parse(text);
  };
  const verify = async intent => {
    const { asset, txHash, from, to, amount, nonce } = intent;
    const proof = await bridge.call('dex_verify', { asset, txHash, from: asset === 'RESET' ? key(from) : from,
      to: asset === 'RESET' ? key(to) : to, minAmount: amount, nonce });
    return { ok: proof?.ok === true && proof.final === true && proof.amount === amount,
      finalized: proof?.ok === true && proof.final === true && proof.amount === amount, txHash };
  };
  // A transfer that already landed (an earlier send or retry) is not an error: verification decides.
  const landed = error => /already exists/i.test(error?.message ?? '');
  const broadcast = intent => send(intent).catch(error => { if (!landed(error)) throw error; });
  const send = async intent => {
    if (intent.asset === 'TNK') {
      const receipt = await bridge.call('dex_tnk_broadcast', { payload: intent.payload });
      if (receipt.txHash !== intent.txHash) throw new Error('Wrong transfer receipt');
    } else {
      const receipt = await gateway('/v1/tx/submit', intent.submission);
      if (receipt.ok !== true || receipt.result?.txo?.tx !== intent.txHash) throw new Error('Wrong transfer receipt');
    }
  };
  async function transfer({ id, asset, to, amount, nonce }) {
    hex(id); hex(nonce); const from = wallet.address, fromKey = key(from), toKey = key(to);
    if (wallet.publicKey !== fromKey || from === to || !['RESET', 'TNK'].includes(asset) || !/^[1-9][0-9]*$/.test(amount) || BigInt(amount) >= 2n ** 128n) throw new Error('Invalid lock transfer');
    const name = `locks-trac-${id}`, terms = { asset, from, to, amount, nonce };
    let intent = store.get(name);
    if (intent) {
      if (stableJSON(intent.terms) !== stableJSON(terms)) throw new Error('Lock transfer intent mismatch');
      const result = await verify(intent); if (result.ok) return result;
    } else {
      const context = await bridge.call(asset === 'TNK' ? 'dex_msb_info' : 'dex_reset_context', {});
      if (context.addressPrefix !== 'trac' || context.networkId !== profile.peer.msbNetworkId ||
          (asset === 'TNK' ? context.msbBootstrap : context.msb) !== profile.peer.msbBootstrap ||
          asset === 'RESET' && context.subnet !== profile.peer.trac.reset.bootstrap) throw new Error('Wrong transfer network');
      let payload, submission, hash;
      if (asset === 'TNK') {
        const am = Buffer.from(BigInt(amount).toString(16).padStart(32, '0'), 'hex');
        hash = blake3(Buffer.concat([uint32(context.networkId), hex(context.txv), Buffer.from(to), am, hex(nonce), uint32(13)]));
        payload = { type: 13, address: from, tro: { tx: Buffer.from(hash).toString('hex'), txv: context.txv, to, am: am.toString('hex'), in: nonce } };
      } else {
        const prepared = await gateway('/v1/tx/prepare', { address: fromKey, to: toKey, amount, nonce });
        const command = { type: 'transfer', value: { to: toKey, amount } }, ch = Buffer.from(blake3(Buffer.from(JSON.stringify(command)))).toString('hex'), pc = prepared.context;
        if (prepared.address !== fromKey || prepared.to !== toKey || prepared.amount !== amount || prepared.nonce !== nonce || stableJSON(prepared.prepared_command) !== stableJSON(command) ||
            !pc || pc.network_id !== context.networkId || pc.txv !== context.txv || pc.content_hash !== ch || pc.subnet !== context.subnet || pc.msb !== context.msb) throw new Error('Gateway transfer mismatch');
        hash = blake3(Buffer.concat([uint32(context.networkId), hex(context.txv), hex(pc.writer), hex(ch), hex(context.subnet), hex(context.msb), hex(nonce), uint32(12)]));
        const tx = Buffer.from(hash).toString('hex'); if (tx !== prepared.tx) throw new Error('Gateway hash mismatch');
        submission = { tx, prepared_command: command, address: fromKey, nonce };
        payload = { type: 12, address: from, txo: { tx, txv: context.txv, iw: pc.writer, ch, bs: context.subnet, mbs: context.msb, in: nonce } };
      }
      const signature = await wallet.sign(hash);
      if (typeof signature !== 'string' || !/^[0-9a-f]{128}$/.test(signature) || !ed25519.verify(Buffer.from(signature, 'hex'), hash, hex(fromKey))) throw new Error('Invalid transfer signature');
      if (asset === 'TNK') payload.tro.is = signature; else { payload.txo.is = signature; submission.signature = signature; }
      intent = { ...terms, terms, payload, ...(submission ? { submission } : {}), txHash: Buffer.from(hash).toString('hex') };
      store.put(name, intent);
    }
    await broadcast(intent); return verify(intent);
  }
  return {
    transfer,
    balances: address => bridge.call('locks_balances', { address }),
    async reconcile({ id }) { const intent = store.get(`locks-trac-${id}`); if (!intent) return { ok: false }; const result = await verify(intent); if (!result.ok) await broadcast(intent); return result; },
    sendTransfer: ({ tradeId, terms }) => transfer({ id: tradeId, asset: terms.base.id, to: terms.buyer.tracAddr, amount: terms.baseAmount, nonce: transferNonce(tradeId) }),
    async withdrawalStatus({ id, asset, to, amount }) {
      const intent = store.get(`locks-trac-${id}`);
      if (!intent || intent.asset !== asset || intent.to !== to || intent.amount !== amount || intent.from !== wallet.address) throw new Error('Lock transfer journal mismatch');
      return verify(intent);
    },
  };
}
