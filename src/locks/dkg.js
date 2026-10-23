import { randomBytes } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hexToBytes, bytesToHex, fromLe32, le32, utf8, concatBytes, stableJSON, sha256Hex } from '../core/canonical.js';
import { boxPublic } from '../core/keys.js';
import { split, randomScalar, verifyShare, aggregate, SCALAR_ORDER } from './crypto/edvss.js';
import { address } from './trac-lock.js';

function context(scope, value) {
  hexToBytes(value.positionId, 32);
  if (!['dkg-share', 'release'].includes(scope)) throw new Error('Invalid locks seal domain');
  return { info: utf8(`intercom-locks/v1/${scope}`), aad: utf8(stableJSON(value)) };
}
export function sealShare(bytes, recipientKey, value, scope = 'dkg-share', rng = randomBytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new Error('Expected share bytes');
  const { info, aad } = context(scope, value), secret = rng(32), ep = boxPublic(secret), recipient = hexToBytes(recipientKey, 32), nonce = rng(24);
  const key = hkdf(sha256, x25519.getSharedSecret(secret, recipient), sha256(concatBytes(ep, recipient)), info, 32);
  return { ephemeralKey: bytesToHex(ep), nonce: bytesToHex(nonce), ciphertext: bytesToHex(xchacha20poly1305(key, nonce, aad).encrypt(bytes)) };
}
export function openShare(sealed, recipientSecret, value, scope = 'dkg-share') {
  const { info, aad } = context(scope, value), secret = typeof recipientSecret === 'string' ? hexToBytes(recipientSecret, 32) : recipientSecret;
  const recipient = boxPublic(secret), ep = hexToBytes(sealed.ephemeralKey, 32);
  const key = hkdf(sha256, x25519.getSharedSecret(secret, ep), sha256(concatBytes(ep, recipient)), info, 32);
  return xchacha20poly1305(key, hexToBytes(sealed.nonce, 24), aad).decrypt(hexToBytes(sealed.ciphertext, 48));
}

export function deal({ positionId, takeId, i, committee, k, rng = randomBytes }) {
  hexToBytes(positionId, 32);
  if (!Number.isInteger(i) || i < 1 || i > committee.length || committee.length > 16 || k <= committee.length / 2) throw new Error('Invalid dealer');
  const p = split(randomScalar(rng), k, committee.map((_, j) => j + 1), rng);
  return { positionId, ...(takeId ? { takeId } : {}), i, commitments: p.commitments, sealed: p.shares.map(({ id, share }) =>
    sealShare(le32(share), committee[id - 1].boxKey, { positionId, ...(takeId ? { takeId } : {}), from: i, to: id }, 'dkg-share', rng)) };
}

export function create({ positionId, takeId, committee, k, j, boxSecret, ownDeal, chain, now, timeoutSec = 120 }) {
  hexToBytes(positionId, 32);
  if (!Number.isInteger(k) || k <= committee.length / 2 || k > committee.length || committee.length > 16 ||
      !Number.isInteger(j) || j < 1 || j > committee.length || !['trac', 'solana'].includes(chain) ||
      !Number.isSafeInteger(now) || now < 0 || !Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 3600 ||
      ownDeal?.i !== j || ownDeal.positionId !== positionId || ownDeal.takeId !== takeId || new Set(committee.map(s => s.lockKey)).size !== committee.length ||
      new Set(committee.map(s => s.boxKey)).size !== committee.length) throw new Error('Invalid DKG configuration');
  if (bytesToHex(boxPublic(typeof boxSecret === 'string' ? hexToBytes(boxSecret, 32) : boxSecret)) !== committee[j - 1].boxKey) throw new Error('Wrong DKG box key');
  return { positionId, ...(takeId ? { takeId } : {}), committee: structuredClone(committee), k, j, boxSecret: typeof boxSecret === 'string' ? boxSecret : bytesToHex(boxSecret),
    ownDeal: structuredClone(ownDeal), chain, phase: 'dealing', deadline: now + timeoutSec, now, deals: {}, shares: {} };
}

const readyBody = s => ({ positionId: s.positionId, ...(s.takeId ? { takeId: s.takeId } : {}), Q: s.Q, j: s.j, A: s.A, C: s.C, chain: s.chain, address: s.address });
const persist = s => ({ type: 'persist', positionId: s.positionId, record: { ...readyBody(s), share: s.share } });
export const readyThreshold = (n, k = Math.floor(n / 2) + 1) => Math.max(n - 1, k);
function finish(s, Q) {
  s.Q = [...Q].sort((a, b) => a - b);
  if (s.Q.length < readyThreshold(s.committee.length, s.k) || new Set(s.Q).size !== s.Q.length) throw new Error('Insufficient qualified dealers');
  s.C = aggregate(s.Q.map(i => s.deals[i].commitments)); s.A = s.C[0];
  s.share = bytesToHex(le32(s.Q.reduce((n, i) => (n + fromLe32(hexToBytes(s.shares[i], 32))) % SCALAR_ORDER, 0n)));
  if (!verifyShare(s.j, fromLe32(hexToBytes(s.share, 32)), s.C)) throw new Error('Invalid aggregate share');
  s.address = s.chain === 'trac' ? address(s.A) : new PublicKey(hexToBytes(s.A, 32)).toBase58(); s.phase = 'persisting';
}
function accept(s, b) {
  if (b.commitments?.length !== s.k || b.sealed?.length !== s.committee.length) throw new Error('Invalid deal size');
  const share = fromLe32(openShare(b.sealed[s.j - 1], s.boxSecret, { positionId: s.positionId, ...(s.takeId ? { takeId: s.takeId } : {}), from: b.i, to: s.j }));
  if (!verifyShare(s.j, share, b.commitments)) throw new Error('Invalid dealer share');
  s.deals[b.i] = structuredClone(b); s.shares[b.i] = bytesToHex(le32(share));
}
// No clocks, network, random draws or storage in step. The host authenticates envelopes, including pickup evidence.
export function step(state, event) {
  const s = structuredClone(state), actions = [], result = () => ({ state: s, actions });
  if (!Number.isSafeInteger(event.now) || event.now < s.now) throw new Error('DKG clock regressed');
  s.now = event.now;
  const fail = reason => {
    s.phase = 'failed'; s.reason = reason;
    actions.push({ type: 'send', kind: 'dkgFail', body: { positionId: s.positionId, ...(s.takeId ? { takeId: s.takeId } : {}), i: s.j, reason } });
    return result();
  };
  if (event.type === 'recover' && !['ready', 'persisting'].includes(s.phase)) {
    const ready = identicalReady(event.ready, s.committee, s.positionId, s.takeId, s.k);
    if (!ready) return result();
    s.deals = {}; s.shares = {};
    for (const m of event.deals) {
      const b = m.body;
      if (m.kind !== 'dkgDeal' || b.positionId !== s.positionId || b.takeId !== s.takeId || s.committee[b.i - 1]?.lockKey !== m.from || !ready.Q.includes(b.i)) throw new Error('Invalid recovery dealer');
      if (s.deals[b.i] && stableJSON(s.deals[b.i]) !== stableJSON(b)) throw new Error('Recovery dealer equivocated');
      accept(s, b);
    }
    finish(s, ready.Q);
    if (s.A !== ready.A || stableJSON(s.C) !== stableJSON(ready.C) || s.address !== ready.address || s.chain !== ready.chain) throw new Error('Recovery commitments differ');
    actions.push(persist(s)); return result();
  }
  if (s.phase === 'failed') return result();
  if (s.phase === 'dealing' && event.now >= s.deadline) {
    if (Object.keys(s.deals).length < readyThreshold(s.committee.length, s.k)) return fail('DKG timed out');
    try { finish(s, Object.keys(s.deals).map(Number)); actions.push(persist(s)); } catch (e) { return fail(e.message); }
    return result();
  }
  if (event.type === 'resume') {
    if (s.phase === 'dealing') actions.push({ type: 'send', kind: 'dkgDeal', body: s.ownDeal });
    if (s.phase === 'persisting') actions.push(persist(s));
    if (s.phase === 'ready') actions.push({ type: 'send', kind: 'lockReady', body: readyBody(s) });
    return result();
  }
  if (event.type === 'persisted' && event.positionId === s.positionId && s.phase === 'persisting') {
    if (event.ok !== true) return result();
    s.phase = 'ready'; delete s.shares; delete s.boxSecret; delete s.ownDeal;
    actions.push({ type: 'send', kind: 'lockReady', body: readyBody(s) }); return result();
  }
  const m = event.message, b = m?.body;
  if (!b || b.positionId !== s.positionId || b.takeId !== s.takeId || !Number.isInteger(b.i) || s.committee[b.i - 1]?.lockKey !== m.from) return result();
  if (m.kind === 'dkgFail') return result(); // A missing member may time out; only local verification rejects a deal.
  if (m.kind !== 'dkgDeal' || s.phase !== 'dealing') return result();
  if (s.deals[b.i]) return stableJSON(s.deals[b.i]) === stableJSON(b) ? result() : fail('Dealer equivocated');
  try {
    accept(s, b);
    if (Object.keys(s.deals).length === s.committee.length) { finish(s, Object.keys(s.deals).map(Number)); actions.push(persist(s)); }
  } catch (error) { return fail(error.message); }
  return result();
}

export function identicalReady(messages, committee, positionId, takeId, k = Math.floor(committee.length / 2) + 1) {
  const by = new Map(); let digest;
  for (const m of messages) {
    const b = m.body;
    if (m.kind !== 'lockReady' || b.positionId !== positionId || b.takeId !== takeId || committee[b.j - 1]?.lockKey !== m.from ||
        !Array.isArray(b.Q) || b.Q.length < readyThreshold(committee.length, k) || new Set(b.Q).size !== b.Q.length || b.Q.some((i, at) => !committee[i - 1] || at && i <= b.Q[at - 1])) throw new Error('Invalid lockReady signer or qualified set');
    const value = stableJSON({ A: b.A, C: b.C, Q: b.Q, chain: b.chain, address: b.address });
    if (digest !== undefined && value !== digest) throw new Error('Conflicting lockReady');
    digest = value; by.set(b.j, b);
  }
  return by.size >= readyThreshold(committee.length, k) ? by.values().next().value : null;
}

// Publish only after sweeping: the receipt discloses this release's decryption key, never the winner's box secret.
export function releaseReceiptKey(sealed, recipientSecret, value) {
  const secret = typeof recipientSecret === 'string' ? hexToBytes(recipientSecret, 32) : recipientSecret;
  const recipient = boxPublic(secret), ep = hexToBytes(sealed.ephemeralKey, 32), { info } = context('release', value);
  return bytesToHex(hkdf(sha256, x25519.getSharedSecret(secret, ep), sha256(concatBytes(ep, recipient)), info, 32));
}
export function verifyReleaseReceipt(release, key, value) {
  const { aad } = context('release', value), b = release.body;
  const share = fromLe32(xchacha20poly1305(hexToBytes(key, 32), hexToBytes(b.sealed.nonce, 24), aad).decrypt(hexToBytes(b.sealed.ciphertext, 48)));
  return verifyShare(b.j, share, b.C);
}
export const releaseDigest = release => sha256Hex(stableJSON(release.body));
