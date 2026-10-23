import { generateIdentity, encodeKey } from '../../../src/core/keys.js';
import { tracAddress } from '../core/helpers.mjs';
import { Keypair } from '@solana/web3.js';
import { LocksClient, signPost, lockChannel } from '../../../src/locks/client.js';
import { createPost, positionId, selectCommittee } from '../../../src/locks/position.js';

export const identity = () => { const key = generateIdentity(); return { ...key, publicKey: encodeKey(key.publicKey) }; };
export function party(key = identity()) { return { lockKey: key.publicKey, boxKey: identity().publicKey, trac: tracAddress(key.publicKey), sol: Keypair.generate().publicKey.toBase58() }; }
export const terms = product => product === 'loan' ? { collateral: '100000000', principal: '100000000', repay: '103000000', termBlocks: 144, offerUntilBlock: 200 }
  : { amount: '100000000', premium: '5000000', strikeTotal: '300000000', expiryBlock: 244, offerUntilBlock: 200 };
export function registry() {
  return { version: 1, issuedAt: 0, minSoftware: '0.1.0', products: { loan: 'open', call: 'open', put: 'open' },
    params: { n: 5, k: 3, dkgTimeoutSec: 120, reserveSec: 600, payMarginSec: 120, termBlocks: { min: 144, max: 12960 },
      offerMaxBlocks: 12960, recoveryMarginSec: 604800, tnkReserve: '60000000000000000' },
    limits: { RESET: { min: '1', max: '1000000000000' }, USDC: { min: '1', max: '1000000000000' }, totalLocked: { RESET: '10000000000000', USDC: '10000000000000' } },
    fee: { bps: 50, collector: Keypair.generate().publicKey.toBase58(), escrowCollector: Keypair.generate().publicKey.toBase58() },
    signers: Array.from({ length: 5 }, () => ({ lockKey: identity().publicKey, boxKey: identity().publicKey, status: 'active', software: '0.2.0' })), removed: [] };
}
export function position(product = 'loan', maker = party(), reg = registry()) {
  const post = createPost({ product, maker, terms: terms(product), registryVersion: reg.version, createdAt: 1000 });
  const id = positionId(post);
  return { post, positionId: id, registry: reg, committee: selectCommittee(reg, id), state: 'running', opened: true, taker: party(), takeAnchor: 100,
    ...(product === 'loan' ? { dueBlock: 244 } : {}), votes: {}, operations: {}, releases: [] };
}
export function fixture() {
  const key = identity(), me = party(key), reg = registry(), records = new Map(), sent = [], calls = [], joins = [], leaves = [];
  const store = { get: k => structuredClone(records.get(k) ?? null), put: (k, v) => records.set(k, structuredClone(v)), list: prefix => [...records.keys()].filter(k => k.startsWith(prefix)) };
  const time = { now: 1000, counted: 100 }, A = identity().publicKey;
  const options = { venueKey: identity().publicKey, identity: key, me, store, registry: { usable: reg, snapshot: v => v === 1 ? reg : null },
    now: () => time.now, clock: { read: async () => ({ counted: time.counted }) },
    transport: { open: async (_ch, raw) => { if (!raw.auth) throw new Error('signature'); return raw; },
      send: async (...args) => sent.push(args), join: async ch => joins.push(ch), leave: async ch => leaves.push(ch), subscribe: () => () => {} },
    adapters: { mint: Keypair.generate().publicKey.toBase58(), freeBalance: async () => '999999999999999999999', lastPrice: () => '400',
      transfer: async input => { calls.push(input); return { ok: true, finalized: true, txHash: 'hash' }; },
      submit: async input => { await input.beforeSend?.(); calls.push(input); return { ok: true, finalized: true, signature: 'signature' }; },
      reconcile: async () => ({ ok: false }), solanaPay: { memo: (id, step) => `intercom-locks:v1:${id}:${step}`, build: async input => input },
      tracLock: { address: a => tracAddress(a), sweep: async input => { calls.push(input); return { ok: true, finalized: true }; } },
      edvss: { verifyShare: (_j, share) => share === 1n, reconstruct: () => 7n, publicOf: () => A }, openRelease: async () => 1n },
  };
  const client = new LocksClient(options);
  const put = (p, signer = key) => { p.sig = signPost(p.post, signer.secretKey); client.positions.set(p.positionId, p); store.put(`locks-position-${p.positionId}`, p); return p; };
  const receive = (p, kind, index, body = {}, channel = lockChannel(p.positionId)) => client.receive(channel, { auth: true, ch: channel,
    from: p.committee[index].lockKey, kind, body: { positionId: p.positionId,
      ...(['posted', 'opened', 'release'].includes(kind) ? { j: index + 1 } : {}),
      ...(kind === 'posted' ? { post: p.post, registryVersion: p.registry.version, ...p.lock } : {}),
      ...(kind === 'release' ? { A: p.lock?.A, C: p.lock?.C } : {}), ...body } });
  return { client, options, time, key, me, reg, store, sent, calls, joins, leaves, A, put, receive };
}
