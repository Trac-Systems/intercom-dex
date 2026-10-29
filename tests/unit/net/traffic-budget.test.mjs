import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import Sidechannel from '../../../peer/features/sidechannel/index.js';
import { DEX_POW_BITS } from '../../../peer/features/dex-transport.js';
import { OfferBook } from '../../../src/market/book.js';
import { BookFeed } from '../../../src/market/book-feed.js';
import { simulation } from '../core/simulation.mjs';
import { fixture, hex, SIG } from '../core/helpers.mjs';
import { seal } from '../../../src/core/envelope.js';
import { generateIdentity, encodeKey } from '../../../src/core/keys.js';
import { offerIdOf } from '../../../src/roles/common.js';
import { HEARTBEAT_MS, BUYER_PAUSES_PER_BEAT } from '../../../src/roles/signer.js';
import { buyerPauseText } from '../../../src/market/buyer-pauses.js';

test('500 offers, 20 signers and 200 refund-window trades stay under 32 KB/s, including repair traffic', async () => {
  const sim = simulation(), f = sim.f, now = 1780000000, transportKey = generateIdentity();
  const sc = new Sidechannel({ wallet: { publicKey: encodeKey(transportKey.publicKey), sign: bytes => Buffer.from(ed25519.sign(bytes, transportKey.secretKey)) } });
  sc._now = () => now * 1000;
  // Use real serialization/signatures, adding the exact work-stamp fields without spending PoW in this fast test.
  sc._attachPow = async p => { if (p.channel !== 'intercom-dex') p.pow = { nonce: 2 ** DEX_POW_BITS, difficulty: DEX_POW_BITS }; };
  async function payload(ch, kind, body, identity = f.seller) {
    const message = seal({ ch, kind, body }, identity.secretKey, { ts: now, nonce: hex() });
    return sc._buildPayload(ch, message);
  }
  const bytes = p => Buffer.byteLength(JSON.stringify({ ...p, relayedBy: encodeKey(transportKey.publicKey) }));
  const perSecond = { 'intercom-dex': 0, 'intercom-dex:offers': 0, 'intercom-dex:signers': 0 };
  const b = new OfferBook(), makers = Array.from({ length: 25 }, generateIdentity);
  for (let i = 0; i < 500; i++) {
    const maker = makers[Math.floor(i / 20)], o = { pair: 'TNK/USDC', registryVersion: 1, software: '0.1.0', side: i % 2 ? 'sell' : 'buy',
      baseAmount: '1000000000000000000', price: String(1 + i % 120), maker: { dexKey: encodeKey(maker.publicKey), tracAddr: f.terms.seller.tracAddr, solAddr: f.terms.seller.solRecipient },
      peerKey: hex(), expiresAt: now + 86400 };
    o.offerId = offerIdOf(o); b.add(o, now);
    perSecond['intercom-dex:offers'] += bytes(await payload('intercom-dex:offers', 'offer', o, maker)) / 120;
  }
  assert.equal(b.snapshot('TNK/USDC', now).length, 500);
  const feed = new BookFeed(), full = feed.next('TNK/USDC', 1, b.snapshot('TNK/USDC', now), now, () => 1);
  assert.equal(full.body.remaining.length, 199);
  assert.deepEqual(full.body.remaining, [...b.snapshot('TNK/USDC', now).filter(o => o.side === 'sell').slice(0, 99),
    ...b.snapshot('TNK/USDC', now).filter(o => o.side === 'buy').slice(0, 100)].map(o => ({ offerId: o.offerId, amount: o.baseAmount })));
  assert.equal(Object.hasOwn(full.body, 'offers'), false);
  const bookBytes = bytes(await payload('intercom-dex', full.kind, full.body, f.service));
  perSecond['intercom-dex'] += bookBytes / 60;
  console.log('Z13b_BOOK_BYTES ' + bookBytes);
  const registry = { ...f.registry, signers: [f, fixture(), fixture(), fixture()].flatMap(x => x.registry.signers) };
  perSecond['intercom-dex'] += bytes(await payload('intercom-dex', 'registry', registry, f.service)) / 30;
  perSecond['intercom-dex'] += bytes(await payload('intercom-dex', 'status', { software: '0.1.0', ts: now, status: 'online', message: '' }, f.service)) / 30;
  for (const pair of ['TNK/USDC', 'RESET/USDC']) perSecond['intercom-dex'] += bytes(await payload('intercom-dex', 'ticker', {
    registryVersion: 1, pair, ts: now, last: '1', volume24h: '1000000000000000000', high24h: '2', low24h: '1', trades24h: 200 }, f.service)) / 30;
  perSecond['intercom-dex:signers'] += 20 * bytes(await payload('intercom-dex:signers', 'heartbeat', { registryVersion: 1, software: '0.1.0', status: 'online', holdCount: 50 }, sim.nodes.get('signer1').identity)) / (HEARTBEAT_MS / 1000);
  const publications = sim.log.filter(x => x.action.type === 'publishShare');
  for (const { name, action } of publications) perSecond['intercom-dex:signers'] += 200 * bytes(await payload('intercom-dex:signers', 'sharePublish', action.body, sim.nodes.get(name).identity)) / 600;
  const steady = Object.fromEntries(Object.entries(perSecond).map(([ch, n]) => [ch, Math.round(n * 100) / 100]));
  // Repair upper scenario: every watch requests all shares each 10 min, all levels change each 5 s,
  // and all 200 sellers still repeat their settlement report each minute awaiting a service log.
  const repair = { ...perSecond };
  repair['intercom-dex:signers'] += 200 * bytes(await payload('intercom-dex:signers', 'shareRequest', { tradeId: sim.state('buyer').tradeId }, f.service)) / 600;
  for (const { name, action } of publications) repair['intercom-dex:signers'] += 200 * bytes(await payload('intercom-dex:signers', 'sharePublish', action.body, sim.nodes.get(name).identity)) / 600;
  // Bid reallocations require complete per-offer inventory for legacy clients, even when a level total stays flat.
  repair['intercom-dex'] += bookBytes / 5;
  const seller = sim.state('seller'), buyer = sim.state('buyer');
  const report = { offerId: f.offerId, tradeId: seller.tradeId, terms: seller.terms, hashHex: seller.H, txHash: seller.txHash, claimSignature: SIG };
  repair['intercom-dex:offers'] += 200 * bytes(await payload('intercom-dex:offers', 'settled', report)) / 60;
  // Every signer also drains a full policy-announcement batch, using the largest admitted address text.
  const pause = { status: 'degraded', software: '0.1.43', ts: now,
    message: buyerPauseText({ tracAddr: 'a'.repeat(256), dexKey: encodeKey(f.buyer.publicKey), until: now + 7 * 86400 }) };
  repair['intercom-dex:signers'] += 20 * BUYER_PAUSES_PER_BEAT * bytes(await payload('intercom-dex:signers', 'status', pause,
    sim.nodes.get('signer1').identity)) / (HEARTBEAT_MS / 1000);
  const total = o => Object.values(o).reduce((a, b) => a + b, 0);
  assert.ok(total(perSecond) < 32000); assert.ok(total(repair) < 32000, `repair traffic ${total(repair)} bytes/s`);

  const work = {}, messages = [];
  const add = async (name, ch, kind, body) => messages.push({ name, payload: await payload(ch, kind, body, sim.nodes.get(name).identity) });
  for (const { name, action } of sim.log) {
    if (action.type === 'send') await add(name, action.ch, action.kind, action.body);
    if (action.type === 'publishShare') for (const ch of action.channels) await add(name, ch, 'sharePublish', action.body);
  }
  const sigs = messages.filter(x => x.payload.message.kind === 'termsSig').map(x => x.payload.message);
  let newTradePublicBytes = 0;
  for (const name of ['buyer', 'seller']) {
    if (name === 'buyer') await add(name, 'intercom-dex:signers', 'summon', { tradeId: buyer.tradeId, terms: buyer.terms, sigs });
    for (const ref of [f.offerId, buyer.tradeId]) await add(name, `intercom-dex:t:${ref}`, 'present', { ref });
  }
  for (let i = 1; i <= 5; i++) await add(`signer${i}`, `intercom-dex:t:${buyer.tradeId}`, 'present', { ref: buyer.tradeId });
  await add('seller', 'intercom-dex:offers', 'settled', report);
  for (const { name, payload: p } of messages) {
    if (Object.hasOwn(perSecond, p.channel)) newTradePublicBytes += bytes(p);
    const [prefix, suffix] = sc._powParts(p), attempts = 8192, start = performance.now();
    for (let nonce = 0; nonce < attempts; nonce++) crypto.createHash('sha256').update(prefix + nonce + suffix).digest('hex');
    const hashesPerSecond = attempts / ((performance.now() - start) / 1000);
    const party = work[name] ??= { stamps: 0, expectedPowSeconds: 0 };
    party.stamps++; party.expectedPowSeconds += 2 ** DEX_POW_BITS / hashesPerSecond;
    if (process.env.Z4_MEASURE_POW === '1') {
      sc.powEnabled = true; sc.powDifficulty = DEX_POW_BITS;
      const started = performance.now();
      await Sidechannel.prototype._attachPow.call(sc, p);
      party.measuredPowSeconds = (party.measuredPowSeconds ?? 0) + (performance.now() - started) / 1000;
      party.hashes = (party.hashes ?? 0) + p.pow.nonce + 1;
    }
  }
  for (const party of Object.values(work)) {
    party.expectedPowSeconds = Number(party.expectedPowSeconds.toFixed(2));
    if (party.measuredPowSeconds) party.measuredPowSeconds = Number(party.measuredPowSeconds.toFixed(2));
  }
  const settlementBytes = bytes(await payload('intercom-dex:offers', 'settled', report));
  const tradeLogBytes = bytes(await payload('intercom-dex', 'tradeLog', { registryVersion: 1, tradeId: seller.tradeId, pair: seller.terms.pair,
    baseAmount: seller.terms.baseAmount, quoteAmount: seller.terms.quoteAmount, price: '5',
    seller: { tracAddr: seller.terms.seller.tracAddr, solAddr: seller.terms.seller.solRecipient },
    buyer: { tracAddr: seller.terms.buyer.tracAddr, solAddr: seller.terms.buyer.solPayer }, ts: now, termsHash: seller.tradeId, escrowAddress: seller.terms.mint, claimSignature: SIG, tracTxHash: seller.txHash }, f.service));
  console.log('Z4_MEASURE ' + JSON.stringify({ offers: 500, signers: 20, trades: 200, bookBytes, steady, steadyTotal: Number(total(perSecond).toFixed(2)),
    repair: Object.fromEntries(Object.entries(repair).map(([ch, n]) => [ch, Number(n.toFixed(2))])), repairTotal: Number(total(repair).toFixed(2)), newTradePublicBytes, formationPublicBytes: newTradePublicBytes - settlementBytes, tradeLogBytes, completeTradePublicBytes: newTradePublicBytes + tradeLogBytes, powBits: DEX_POW_BITS, work }));
});
