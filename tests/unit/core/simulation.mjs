import assert from 'node:assert/strict';
import { createBuyer, step as buyerStep } from '../../../src/core/trade-buyer.js';
import { createSeller, step as sellerStep } from '../../../src/core/trade-seller.js';
import { createSigner, step as signerStep } from '../../../src/core/trade-signer.js';
import { createReplayCache, open, seal } from '../../../src/core/envelope.js';
import { sha256Hex } from '../../../src/core/canonical.js';
import { encodeKey } from '../../../src/core/keys.js';
import { fixture, hex, SIG, proofStub } from './helpers.mjs';

export function simulation(options = {}) {
  const f = options.fixture ?? fixture({ pair: options.pair ?? 'TNK/USDC' });
  const nodes = new Map(), queue = [], log = [], escrow = new Map(), snapshots = new Map();
  const usedTx = options.usedTx ?? new Map();
  const usedEscrows = options.usedEscrows ?? new Map();
  const now = 100;
  let messageCounter = 0;
  let pendingChecks = options.pendingChecks ?? 0, claimFailures = options.claimFailures ?? 0;
  const heldVerifications = [];
  const config = mode => ({ mode, offerId: f.offerId, terms: f.terms, registry: f.registry, nonce: hex(), entropy: hex(), now, networkId: options.networkId });
  nodes.set('buyer', { state: createBuyer(config(options.buyerMaker ? 'maker' : 'taker')), step: buyerStep, identity: f.buyer, seen: createReplayCache() });
  nodes.set('seller', { state: createSeller(config(options.buyerMaker ? 'taker' : 'maker')), step: sellerStep, identity: f.seller, seen: createReplayCache() });

  function dispatch(name, event) {
    const node = nodes.get(name);
    const result = node.step(node.state, { now: Math.max(now, node.state.now), ...event });
    node.state = result.state;
    if (options.capturePhases && !snapshots.has(name + ':' + node.state.phase)) snapshots.set(name + ':' + node.state.phase, structuredClone(node.state));
    for (const action of result.actions) {
      log.push({ name, action }); queue.push({ name, action });
    }
    return result;
  }
  function recipients(name, kind) {
    const handshake = ['take', 'accept', 'reveal', 'terms'].includes(kind);
    return [...nodes.keys()].filter(n => n !== name && !(handshake && n.startsWith('signer')) &&
      !options.offline?.includes(nodes.get(n).state.signerIndex));
  }
  function deliver(name, kind, body, ch) {
    const node = nodes.get(name);
    const envelope = seal({ kind, body, ch }, node.identity.secretKey,
      { ts: node.state.now, nonce: sha256Hex('simulation-envelope:' + messageCounter++) });
    for (const target of recipients(name, kind)) {
      const receiver = nodes.get(target);
      dispatch(target, { type: 'message', now: Math.max(node.state.now, receiver.state.now), observedSlot: 100,
        finalizedAgeMs: 0, tipSlot: 132, tipAgeMs: 0,
        message: open(envelope, { now: Math.max(node.state.now, receiver.state.now), seen: receiver.seen }) });
    }
  }
  function drain() {
    let limit = 10000;
    while (queue.length) {
      assert.ok(--limit > 0, 'Simulation action loop');
      const { name, action: a } = queue.shift(), node = nodes.get(name);
      if (a.type === 'send') {
        if (a.kind === 'deal' && options.corruptShares) {
          a.body = structuredClone(a.body);
          for (const index of options.corruptShares) a.body.sealedShares[index - 1].ciphertext = '00'.repeat(48);
        }
        deliver(name, a.kind, a.body, a.ch);
      }
      else if (a.type === 'acquireCertificate') dispatch(name, { type: 'certificateAssigned', tradeId: a.tradeId, certificate: options.certificate ?? null });
      else if (a.type === 'prepareDeal') dispatch(name, { type: 'prepareDeal', tradeId: a.tradeId });
      else if (a.type === 'prove') {
        if (!options.holdProof) dispatch(name, { type: 'proved', tradeId: a.tradeId, ok: options.proveOk !== false, proof: proofStub() });
      } else if (a.type === 'checkProof') {
        if (!options.holdProofCheck) dispatch(name, { type: 'proofChecked', tradeId: a.tradeId, ok: options.checkProofOk !== false });
      }
      else if (a.type === 'checkSellerFunds') {
        if (!options.holdSellerFunds) dispatch(name, { type: 'sellerFunds', tradeId: a.tradeId, ok: options.sellerFundsOk !== false, feeTnk: '30000000000000000' });
      }
      else if (a.type === 'publishShare') for (const ch of a.channels) deliver(name, 'sharePublish', a.body, ch);
      else if (a.type === 'lockEscrow') {
        if (!escrow.has(a.hashHex)) escrow.set(a.hashHex, { status: 'active', terms: a.terms });
        dispatch(name, options.lockUnknown ? { type: 'escrowLocked', tradeId: a.tradeId, ok: false, unknown: true }
          : { type: 'escrowLocked', tradeId: a.tradeId, hashHex: a.hashHex, ok: true });
      } else if (a.type === 'checkEscrow' && options.escrowCheck !== false) {
        const account = escrow.get(a.hashHex);
        if (a.purpose !== 'settlement' && pendingChecks-- > 0) dispatch(name, { type: 'escrowChecked', tradeId: a.tradeId, hashHex: a.hashHex, ok: false, status: 'missing' });
        else dispatch(name, { type: 'escrowChecked', tradeId: a.tradeId, hashHex: a.hashHex,
          ok: options.escrowOk !== false && !!account, status: account?.status ?? 'missing', purpose: a.purpose });
      } else if (a.type === 'reserveEscrow') {
        if (options.reserveEscrow === false) continue;
        const existing = usedEscrows.get(a.hashHex), ok = !existing || existing === a.tradeId;
        if (ok) usedEscrows.set(a.hashHex, a.tradeId);
        dispatch(name, { type: 'escrowReserved', tradeId: a.tradeId, hashHex: a.hashHex, ok, reservedFor: existing ?? a.tradeId });
      } else if (a.type === 'persist') {
        if (a.scope === 'signerShare' && node.state.signerIndex > (options.ackCount ?? 5)) continue;
        if (a.scope === 'verifiedTransfer') {
          if (options.persistTransfer === false) continue;
          const existing = usedTx.get(a.record.txHash);
          const ok = !existing || existing === a.tradeId;
          if (ok) usedTx.set(a.record.txHash, a.tradeId);
          dispatch(name, { type: 'persisted', scope: a.scope, tradeId: a.tradeId, txHash: a.record.txHash, reservedFor: existing ?? a.tradeId, ok });
        } else dispatch(name, { type: 'persisted', scope: a.scope, tradeId: a.tradeId, ok: options.persistShare !== false || a.scope !== 'signerShare' });
      } else if (a.type === 'sendTransfer' && !options.neverSend) {
        dispatch(name, { type: 'transferSent', tradeId: a.tradeId, ok: !options.transferUnknown,
          ...(options.transferUnknown ? { unknown: true } : { sentAt: now }),
          txHash: options.txHash ?? sha256Hex('transfer:' + a.tradeId) });
      } else if (a.type === 'verifyTransfer' && options.holdVerify) {
        heldVerifications.push({ name, a });
      } else if (a.type === 'verifyTransfer') {
        dispatch(name, { type: 'transferVerified', tradeId: a.tradeId, txHash: a.txHash, ok: true, final: true,
          amount: a.minAmount, from: a.from, to: a.to, nonce: a.nonce, asset: a.asset, finalizedAt: now,
          usedBy: usedTx.get(a.txHash), ...options.transferPatch });
      } else if (a.type === 'claim' && claimFailures > 0) {
        claimFailures--;
        dispatch(name, { type: 'error', tradeId: a.tradeId, reason: 'claim: No RPC quorum' });
      } else if (a.type === 'claim') {
        assert.equal(sha256Hex(Buffer.from(a.preimageHex, 'hex')), a.hashHex, 'Escrow preimage');
        assert.equal(escrow.get(a.hashHex)?.status, 'active');
        escrow.get(a.hashHex).status = 'claimed';
        dispatch(name, { type: 'claimed', tradeId: a.tradeId, ok: true, claimSignature: SIG });
      } else if (a.type === 'refund') {
        assert.ok(node.state.now >= a.terms.refundAfter);
        if (escrow.get(a.hashHex)?.status === 'claimed') dispatch(name, { type: 'error', reason: 'Already claimed' });
        else {
          escrow.get(a.hashHex).status = 'refunded';
          dispatch(name, { type: 'refunded', tradeId: a.tradeId, ok: true, refundSignature: SIG });
        }
      }
    }
    const seller = nodes.get('seller').state;
    if (seller.phase === 'awaitReady' && !seller.escrowOk && !seller.checkInFlight && escrow.has(seller.H) &&
        options.pendingChecks === undefined && options.escrowCheck !== false) {
      dispatch('seller', { type: 'tick' });
      if (queue.length) drain();
    }
    const buyer = nodes.get('buyer').state;
    if (buyer.phase === 'locked' && !buyer.settlementPending && escrow.get(buyer.H)?.status === 'claimed') {
      dispatch('buyer', { type: 'tick', now: Math.max(buyer.now, buyer.nextSettlementCheck ?? buyer.now) });
      if (queue.length) drain();
    }
  }
  dispatch('buyer', { type: 'tick' }); dispatch('seller', { type: 'tick' }); drain();
  assert.equal(nodes.get('buyer').state.phase, 'awaitRandomness', 'Buyer completed reveals');
  assert.equal(nodes.get('seller').state.phase, 'awaitRandomness', 'Seller completed reveals');
  const chain = { acceptSlot: 132, slot: 228, finalized: true, firstFinalized: true, blockhash: hex() };
  dispatch('buyer', { type: 'tick', chain }); dispatch('seller', { type: 'tick', chain });
  const terms = nodes.get('buyer').state.terms;
  assert.ok(terms && nodes.get('seller').state.terms, 'Both traders computed terms');
  assert.equal(nodes.get('buyer').state.tradeId, nodes.get('seller').state.tradeId);
  terms.committee.forEach((member, i) => {
    const fixtureSigner = f.signers.find(s => encodeKey(s.identity.publicKey) === member.dexKey);
    nodes.set('signer' + (i + 1), { state: createSigner({ terms, signerIndex: i + 1, boxSecret: fixtureSigner.box.secretKey, now,
      usedTx: options.usedSnapshot ?? {}, networkId: options.networkId }), step: signerStep, identity: fixtureSigner.identity, seen: createReplayCache() });
  });
  drain();
  // Answers verifications that options.holdVerify kept back (as the real nodes would, a little later).
  function releaseVerifications(patch = {}) {
    for (const { name, a } of heldVerifications.splice(0)) dispatch(name, { type: 'transferVerified', tradeId: a.tradeId, txHash: a.txHash, ok: true, final: true,
      amount: a.minAmount, from: a.from, to: a.to, nonce: a.nonce, asset: a.asset, finalizedAt: now, usedBy: usedTx.get(a.txHash), ...patch });
    drain();
  }
  return { f, nodes, log, escrow, usedTx, snapshots, dispatch, drain, deliver, releaseVerifications,
    state: name => nodes.get(name).state,
    count: type => log.filter(x => x.action.type === type).length };
}
