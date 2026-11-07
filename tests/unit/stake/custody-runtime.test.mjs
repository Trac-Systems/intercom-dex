import { verifyStakeFunding } from '../../../src/stake/funding.js';
import { tracPublicKey } from '../../../src/core/addresses.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { StakeCustodySigner } from '../../../src/stake/custody-signer.js';
import { StakeClient } from '../../../src/stake/client.js';
import { StakeLedger } from '../../../src/stake/ledger.js';
import { finalizedStakeClock } from '../../../src/stake/chain.js';
import { createAddressProof } from '../../../src/core/address-proof.js';
import { transferNonce } from '../../../src/trac/transfers.js';
import { sha256Hex } from '../../../src/core/canonical.js';
import { registryPolicy, memoryStore, members, secrets } from './helpers.mjs';
import { tracAddress } from '../core/helpers.mjs';
import { publicationBytes, effectiveSettings } from '../../../src/stake/settings.js';
import { matchingCertificate, signFact } from '../../../src/stake/certificates.js';
import { CompletionLog } from '../../../src/stake/price.js';
import { capacityName } from '../../../src/stake/capacity.js';

const hex = n => n.toString(16).padStart(64, '0');
const publicKey = secret => Buffer.from(ed25519.getPublicKey(secret)).toString('hex');
const boxKey = secret => Buffer.from(x25519.getPublicKey(secret)).toString('hex');
test('finalized stake clock uses lower agreeing readers and fails closed', async () => {
  const seen = [], read = async (endpoint, address, options) => {
    seen.push(options.commitment); const data = Buffer.alloc(40); data.writeBigInt64LE(BigInt(endpoint), 32);
    return { slot: 10, value: { owner: 'Sysvar1111111111111111111111111111111111111', data } };
  };
  assert.deepEqual(await finalizedStakeClock({ endpoints: ['100', '102'], read }), { at: 100, slot: 10 });
  assert.deepEqual(seen, ['finalized', 'finalized']);
  await assert.rejects(finalizedStakeClock({ endpoints: ['100', '110'], read }), /disagree/);
  await assert.rejects(finalizedStakeClock({ endpoints: ['100', '100'], read }), /distinct/);
  await assert.rejects(finalizedStakeClock({ endpoints: ['100', '102'], need: 1.5, read }), /distinct/);
  await assert.rejects(finalizedStakeClock({ endpoints: ['100', '102'], read: async () => { throw Error('offline'); } }), /unavailable/);
});

for (const mode of ['withdraw', 'award', 'handoff', 'exact', 'exact-lagging', 'deferred', 'mixed', 'late-full', 'late-tnk', 'dkg-failed', 'dkg-split']) test(mode === 'dkg-failed'
  ? 'a deposit whose key setup failed ends without sending anything and frees its capacity for a new deposit'
  : mode === 'dkg-split' ? 'a deposit whose key setup finished on only two members is released by all four on the proof of two votes'
  : mode.startsWith('late-') ? `expired unadmitted funding returns ${mode === 'late-full' ? 'finalized RESET and TNK' : 'TNK-only residue'} without signing another deposit or requiring price`
  : mode === 'mixed' ? 'one withdraw-all intent returns mixed original epochs with separately certified barriers and retirements'
  : mode === 'deferred' ? 'withdraw all persists across a reserved trade and starts cooldown only after certified closure'
  : mode === 'exact' ? 'exact withdrawal uses certified prior-day price, retains expiry and allowance, and recovers each funding leg'
  : mode === 'exact-lagging' ? 'exact withdrawal completes surplus DKG with a lagging fourth custodian and stalled finalized time after retirement'
  : mode === 'award' ? 'buyer award reconstructs original custody, collects once and rejects a redirected winner'
  : mode === 'handoff' ? 'authenticated capacity handoff to a changed committee retains original withdrawal and retires both projections once'
  : 'custody RPC coordinator funds, freezes before voting, refuses early release, resumes and collects only once', async () => {
  const awardMode = mode === 'award', exactMode = mode.startsWith('exact');
  let now = 4000, localNow = 1000;
  const venueSecret = new Uint8Array(32).fill(30);
  const scope = { networkId: 1, venueKey: exactMode ? publicKey(venueSecret) : '8'.repeat(64), epochId: 'a'.repeat(64) };
  let policy = registryPolicy(scope); const boxes = [11, 12, 13, 14].map(n => new Uint8Array(32).fill(n));
  policy.epoch.members = members.map((m, i) => ({ ...m, boxKey: boxKey(boxes[i]) }));
  policy.custody = { lifetimeSec: ['award', 'exact', 'exact-lagging', 'deferred', 'mixed'].includes(mode) ? 2592000 : 86400, fundingWindowSec: 3600, dkgTimeoutSec: 30, tnkReserve: '120' };
  const registry = () => ({ sellerBond: policy }), context = { networkId: 1, venueKey: scope.venueKey, epoch: policy.epoch };
  const secret = new Uint8Array(32).fill(20), boxSecret = new Uint8Array(32).fill(21), walletSecret = new Uint8Array(32).fill(22);
  const identity = { publicKey: publicKey(secret), secretKey: secret }, box = { publicKey: boxKey(boxSecret), secretKey: boxSecret };
  const me = { dexKey: identity.publicKey, tracAddr: tracAddress(publicKey(walletSecret)) };
  const wallet = { address: me.tracAddr, sign: b => Buffer.from(ed25519.sign(b, walletSecret)).toString('hex') };
  const clock = async () => ({ at: now });
  const priceLog = new CompletionLog({ store: memoryStore(), context });
  const certifiedPrice = (kind, body) => {
    const fact = { v: 1, networkId: 1, venueKey: scope.venueKey, epochId: scope.epochId, kind, body };
    return { venue: signFact(fact, venueSecret), certificate: secrets.slice(0, 3).map(s => signFact(fact, s)) };
  };
  const priceSnapshot = () => {
    const checkpoint = certifiedPrice('price-head', { cutoffAt: now, headPosition: priceLog.read().position, headHash: priceLog.read().hash });
    return { checkpoint, reference: priceLog.reference(checkpoint, now, 60, effectiveSettings(policy, now).settings.priceLookbackSec) };
  };
  if (exactMode) priceLog.append(certifiedPrice('completion', {
    logPosition: 1, prevHash: priceLog.read().hash, tradeId: hex(501), escrowId: hex(502), nonce: hex(503),
    pair: 'RESET/USDC', baseAmount: '100000000', quoteAmount: '20000000', completedAt: now,
    termsDigest: hex(504), escrowDigest: hex(505), deliveryDigest: hex(506),
  }), now);
  const price = { import: async snapshot => exactMode
    ? priceLog.verifyReference(snapshot.reference, snapshot.checkpoint, now, 60, effectiveSettings(policy, now).settings.priceLookbackSec)
    : { numerator: '20000000', denominator: '1' } };
  const balances = new Map([[me.tracAddr, { RESET: '10000000', TNK: '10000', feeTnk: '30' }]]), sent = new Map();
  let sends = 0, deferFunding = true;
  const trac = { balances: async address => balances.get(address) ?? { RESET: '0', TNK: '0', feeTnk: '30' },
    proveAddress: async args => createAddressProof(wallet, { ...args, networkId: 1 }),
    verifyTransfer: async args => { const tx = sent.get(args.txHash); return { ok: !!tx && tx.from === args.from && tx.to === args.to && tx.asset === args.asset && tx.amount === args.minAmount && tx.nonce === args.nonce, final: true }; } };
  const transfer = async (from, args) => {
    const txHash = sha256Hex(args.id), prior = sent.get(txHash);
    if (!prior) {
      const fromB = { ...await trac.balances(from) }, toB = { ...await trac.balances(args.to) };
      fromB[args.asset] = (BigInt(fromB[args.asset]) - BigInt(args.amount)).toString();
      fromB.TNK = (BigInt(fromB.TNK) - 30n).toString();
      toB[args.asset] = (BigInt(toB[args.asset]) + BigInt(args.amount)).toString();
      balances.set(from, fromB); balances.set(args.to, toB); sent.set(txHash, { ...args, from }); sends++;
    }
    return { ok: true, txHash };
  };
  const stores = members.map(memoryStore), clientStore = memoryStore(), archives = [];
  const roster = [...members];
  const makeSigner = (store, identity, secretKey) => new StakeCustodySigner({ store, identity,
    box: { secretKey }, registry,
    // The fourth member can persist its barrier after the certified quorum's
    // timestamp, then refuse freeze/release/collection without vetoing return.
    clock: async () => ({ at: now + (['mixed', 'exact-lagging'].includes(mode) && identity.publicKey === members[3].dexKey ? 1 : 0) }),
    timeoutNow: () => localNow, trac, price,
    verifyFunding: args => verifyStakeFunding({ ...args, bridge: { call: async (method, args) => {
      const tx = sent.get(args.txHash), key = a => Buffer.from(tracPublicKey(a)).toString('hex');
      return { ok: !!tx && args.asset === tx.asset && args.nonce === tx.nonce &&
        args.from === (tx.asset === 'RESET' ? key(tx.from) : tx.from) && args.to === (tx.asset === 'RESET' ? key(tx.to) : tx.to),
        final: true, amount: tx?.amount };
    } } }) });
  const signers = members.map((m, i) => makeSigner(stores[i], { publicKey: m.dexKey, secretKey: secrets[i] }, boxes[i]));
  // The app relays no deals in time (as when its stake messages queued behind a backlog): those members' setup fails.
  let badFreezeReplies = 2, dropDeals = new Set(mode === 'dkg-failed' ? [0, 1, 2, 3] : mode === 'dkg-split' ? [0, 1] : []);
  const request = async (to, method, body) => {
    if (to === scope.venueKey) { if (method === 'priceSnapshot') return exactMode ? priceSnapshot() : {}; archives.push(body); return { archived: true }; }
    const index = roster.findIndex(m => m.dexKey === to);
    if (dropDeals.has(index) && method === 'dkgDeals') return { messages: [] };
    const result = await signers[index].handle(method, body, identity.publicKey);
    return (method === 'freezePrepare' && index >= 4 - badFreezeReplies) ||
      (index === 3 && ['fundedVote', 'returnVote', 'release'].includes(method)) ? { ...result, sig: '0'.repeat(128) } : result;
  };
  const makeClient = () => new StakeClient({ store: clientStore, identity, box, me, registry, clock, trac, price, request,
    funding: { hasIntent: id => sent.has(sha256Hex(id)), transfer: async args => { const sent = await transfer(me.tracAddr, args);
      if (deferFunding && (mode !== 'late-full' || args.asset === 'RESET')) { deferFunding = false; return { ...sent, ok: false }; } return sent; } } });
  // Collector uses the actual reconstructed point, while transfers are synthetic chain receipts in this unit test.
  const { publicOf } = await import('../../../src/locks/crypto/edvss.js');
  const client = () => { const c = makeClient(); c.collector = scalar => {
    const from = tracAddress(publicOf(scalar));
    return { balances: trac.balances, sendTransfer: ({ tradeId, terms }) => transfer(from, { id: tradeId, asset: terms.base.id,
      to: terms.buyer.tracAddr, amount: terms.baseAmount, nonce: transferNonce(tradeId) }),
      withdrawalStatus: async ({ id }) => ({ ok: sent.has(sha256Hex(id)), txHash: sha256Hex(id) }) };
  }; return c; };
  const preview = await client().preview('2500000');
  assert.equal(preview.tnkTotal, '180'); assert.equal(preview.pieces, 1); assert.equal(sends, 0);
  const live = client(), first = live.deposit('2500000');
  assert.equal(live.deposit('2500000'), first, 'simultaneous clicks share one operation');
  const pending = await first; assert.equal(pending.pending, true);
  if (mode.startsWith('dkg-')) {
    const op = () => clientStore.get('stake-client-operation'), d = op().pieces[0].descriptor;
    const { unitId } = await import('../../../src/stake/ledger.js'), id = unitId(d);
    await assert.rejects(signers[0].handle('abandonVote', { descriptor: d }, identity.publicKey), /still usable/);
    await assert.rejects(signers[0].handle('abandonVote', { descriptor: d }, members[1].dexKey), /authorization/);
    assert.equal((await live.recover()).pending, true, 'a setup inside its wait keeps waiting');
    localNow += 31;
    const done = await live.recover();
    assert.equal(done.operationId, pending.operationId); assert.equal(done.funded, '0'); assert.equal(done.notDeposited, '2500000');
    assert.equal(sends, 0); assert.equal(op().done, true); assert.equal(op().pieces[0].abandoned, true);
    assert.deepEqual((await live.recover()), undefined, 'a finished deposit is not resumed');
    assert.equal(op().pieces[0].abandon.length, 4, 'all four members released it');
    for (const [i, store] of stores.entries()) {
      assert.equal(store.get(capacityName(scope)).pieces[id].retired, true);
      assert.equal(store.get(`stake-dkg-${id}`).state.phase, mode === 'dkg-split' && i >= 2 ? 'ready' : 'failed');
    }
    if (mode === 'dkg-split') {
      const ready = await Promise.all([2, 3].map(i => signers[i].handle('dkgDeals', { unitId: id, deals: [] }, identity.publicKey).catch(e => e.message)));
      assert.deepEqual(ready, ['Stake piece was abandoned before funding', 'Stake piece was abandoned before funding']);
    }
    assert.equal(clientStore.get(`stake-capacity-retirement-${id}`).done, true);
    await assert.rejects(signers[0].handle('dkgStart', { descriptor: d, capacity: op().capacity }, identity.publicKey), /abandoned/);
    await assert.rejects(signers[0].handle('refundVote', { unitId: id, ready: [], returnReset: '0' }, identity.publicKey), /abandoned/);
    // The capacity is free again: the same amount deposits normally.
    dropDeals = new Set();
    await client().deposit('2500000'); const again = await client().recover();
    assert.equal(again.funded, '2500000'); assert.equal(sends, 2);
    return;
  }
  if (mode.startsWith('late-')) now += 3601;
  const recovering = live.recover(), retry = live.deposit('2500000');
  const [deposited, replay] = await Promise.all([recovering, retry]);
  assert.equal(deposited.operationId, pending.operationId); assert.equal(replay.operationId, pending.operationId);
  if (mode.startsWith('late-')) {
    assert.equal(deposited.funded, '0'); assert.equal(deposited.refunded, mode === 'late-full' ? '2500000' : '0');
    assert.equal(replay.funded, '0'); assert.equal(replay.refunded, deposited.refunded);
    assert.equal((await trac.balances(me.tracAddr)).RESET, '10000000'); assert.equal(sends, mode === 'late-full' ? 4 : 2);
    const op = clientStore.get('stake-client-operation'), piece = op.pieces[0];
    assert.equal(piece.refundOperation.decisionBody.outcome, 'seller-unfunded');
    const before = sends; await client().recover(); assert.equal(sends, before);
    for (const store of stores.slice(0, 3)) {
      const l = new StakeLedger({ store, context, address: me.tracAddr });
      assert.equal(Object.values(l.read().pieces)[0].state, 'retired');
      assert.ok(Object.values(store.get(capacityName(scope)).pieces).every(p => p.retired));
    }
    assert.equal(archives.some(a => a.kind === 'funded'), false);
    return;
  }
  assert.equal(deposited.funded, '2500000'); assert.equal(sends, 2);
  const ledger = () => new StakeLedger({ store: clientStore, context, address: me.tracAddr });
  assert.equal(Object.values(ledger().read().pieces)[0].state, 'free');
  if (awardMode) {
    const { StakeAwardClient } = await import('../../../src/stake/award-client.js');
    const { fixture } = await import('../core/helpers.mjs');
    const { prepareBond, admissionInventory, bondReservation, bondAck } = await import('../../../src/stake/admission.js');
    const { signFact } = await import('../../../src/stake/certificates.js');
    const buyerSecret = new Uint8Array(32).fill(23), buyerBox = new Uint8Array(32).fill(24);
    const buyer = { dexKey: publicKey(buyerSecret), tracAddr: tracAddress(hex(25)), boxKey: boxKey(buyerBox) };
    const terms = fixture({ n: 4, pair: 'RESET/USDC' }).terms;
    terms.seller = { ...terms.seller, ...me, boxKey: box.publicKey }; terms.buyer = { ...terms.buyer, ...buyer };
    terms.committee = policy.epoch.members; terms.sendBy = 5000; terms.refundAfter = 10000;
    const cert = (kind, body) => secrets.slice(0, 3).map(secret => signFact({ v: 1, networkId: context.networkId, venueKey: context.venueKey, epochId: context.epoch.id, kind, body }, secret));
    terms.bond = prepareBond({ terms, policy, context, now, inventoryCertificate: cert('admission-inventory', admissionInventory(ledger().read(), terms.seller, now, context.epoch.id)),
      priceCheckpoint: {}, priceReference: {}, priceLog: { verifyReference: () => ({ numerator: '20000000', denominator: '1' }) } });
    const H = hex(70), r = bondReservation(terms, H), rid = bondAck(terms, H).reservationId;
    const decision = cert('decision', { decisionId: hex(71), outcome: 'buyer-no-show', reservationId: rid, pieces: terms.bond.pieces, at: now,
      winnerAddress: buyer.tracAddr, winnerBoxKey: buyer.boxKey, evidenceDigest: hex(72) });
    for (const store of stores) { const l = new StakeLedger({ store, context, address: me.tracAddr }); l.reserve(r); l.decide(decision); }
    const awardStore = memoryStore(), awardClient = { store: awardStore, me: buyer, identity: { publicKey: buyer.dexKey },
      box: { publicKey: buyer.boxKey, secretKey: buyerBox }, collector: client().collector,
      retireCapacity: certificate => client().retireCapacity(certificate),
      request: (to, method, body) => to === context.venueKey ? { accepted: true } : signers[members.findIndex(m => m.dexKey === to)].handle(method, body, buyer.dexKey) };
    const input = { terms, H, policy, result: { decision, funded: Object.values(ledger().read().pieces).map(p => p.fundingCertificate) } };
    await assert.rejects(new StakeAwardClient({ client: { ...awardClient, me } }).collect(input), /recipient/);
    await new StakeAwardClient({ client: awardClient }).collect(input);
    assert.equal((await trac.balances(buyer.tracAddr)).RESET, '2500000'); assert.equal(sends, 4);
    await new StakeAwardClient({ client: awardClient }).collect(input); assert.equal(sends, 4);
    assert.ok(stores.every(store => Object.values(new StakeLedger({ store, context, address: me.tracAddr }).read().pieces)[0].state === 'retired'));
    return;
  }

  if (mode === 'mixed') {
    badFreezeReplies = 1;
    const previous = { ...policy, acceptNew: false, epoch: { ...policy.epoch, stopNewAt: now } };
    policy = previous;
    const next = registryPolicy({ ...scope, epochId: hex(95) });
    next.acceptNew = false; next.epoch = { ...next.epoch, members: policy.epoch.members, startAt: now }; next.custody = policy.custody;
    const body = { previousEpochId: previous.epoch.id, nextPolicy: next };
    const certificate = matchingCertificate(await Promise.all(signers.map(s => s.handle('capacityHandoffVote', body, scope.venueKey))), context, 'capacity-handoff');
    await Promise.all(signers.map(s => s.handle('capacityHandoffAdopt', { ...body, certificate }, scope.venueKey)));
    // This unit exercises custody routing; the injected price reader supplies the reconciled price boundary.
    policy = { ...next, acceptNew: true }; now++;
    await client().deposit('2500000'); assert.equal(sends, 4);
    const frozen = await client().withdraw('all'); assert.equal(frozen.withdrawing, '5000000');
    const op = clientStore.get('stake-client-operation');
    assert.equal(Object.keys(op.policies).length, 2); assert.equal(op.batches.length, 2);
    assert.deepEqual(new Set(op.batches.map(b => b.freeze[0].fact.epochId)), new Set([previous.epoch.id, next.epoch.id]));
    const lagging = new StakeLedger({ store: stores[3], context, address: me.tracAddr });
    assert.ok(Object.values(lagging.read().pieces).every(p => p.state === 'withdrawing' && p.availableAt === undefined));
    now = frozen.availableAt;
    const result = await client().recover(); assert.equal(result.returned, '5000000'); assert.equal(sends, 8);
    assert.equal((await trac.balances(me.tracAddr)).RESET, '10000000');
    assert.ok(Object.values(ledger().read().pieces).every(p => p.state === 'retired'));
    await client().recover(); assert.equal(sends, 8);
    for (const store of stores) assert.ok(Object.values(store.get(capacityName(scope)).pieces).every(p => p.retired));
    assert.ok(Object.values(lagging.read().pieces).every(p => !p.collectionCertificate), 'capacity catch-up does not bypass local custody checks');
    return;
  }
  if (mode === 'deferred') {
    badFreezeReplies = 1;
    const { reservationId } = await import('../../../src/stake/ledger.js');
    const { signFact } = await import('../../../src/stake/certificates.js');
    const p = Object.values(ledger().read().pieces)[0], pieces = [{ unitId: p.unitId, generation: p.generation }];
    const reservation = { tradeId: hex(31), H: hex(32), sellerDexKey: me.dexKey, buyerAddress: tracAddress(hex(33)), buyerBoxKey: hex(34),
      policyId: policy.economics.active.policyId, targetReset: '2500000', payoutReset: '2500000', pieces, expiresNotBefore: 100000 };
    const ledgers = [ledger(), ...stores.map(store => new StakeLedger({ store, context, address: me.tracAddr }))];
    for (const l of ledgers) l.reserve(reservation);
    const pending = await client().withdraw('all'); assert.equal(pending.deferred, '2500000'); assert.equal(pending.availableAt, null);
    assert.equal(sends, 2); assert.equal((await client().withdraw('all')).operationId, pending.operationId);
    now += 100;
    const certificate = secrets.slice(0, 3).map(secret => signFact({ v: 1, networkId: context.networkId, venueKey: context.venueKey,
      epochId: context.epoch.id, kind: 'resolved', body: { reservationId: reservationId(reservation), pieces, outcome: 'delivered', evidenceDigest: hex(35) } }, secret));
    for (const l of ledgers) {
      l.resolve(certificate);
      assert.throws(() => l.reserve({ ...reservation, tradeId: hex(36), pieces: [{ unitId: p.unitId, generation: 1 }] }), /not_reserved/);
    }
    const frozen = await client().recover(); assert.equal(frozen.availableAt, now + 86400); assert.equal(frozen.deferred, '0');
    now = frozen.availableAt - 1; await client().recover(); assert.equal(sends, 2);
    now++; assert.equal((await client().recover()).collected, true); assert.equal(sends, 4);
    assert.equal((await trac.balances(me.tracAddr)).RESET, '10000000');
    return;
  }
  if (exactMode) {
    badFreezeReplies = 1;
    const original = Object.values(ledger().read().pieces)[0];
    const frozen = await client().withdraw('1000000');
    assert.equal(frozen.pending, true); assert.equal(sends, 2);
    if (mode === 'exact-lagging') {
      localNow += 86400;
      assert.equal((await client().recover()).pending, true);
      assert.equal(sends, 2, 'local time cannot mature a withdrawal before finalized time');
    }
    now = frozen.availableAt; deferFunding = true;
    const snapshot = priceSnapshot();
    assert.equal(snapshot.reference.utcDay, '1970-01-01');
    assert.equal(new Date(now * 1000).toISOString().slice(0, 10), '1970-01-02');
    assert.throws(() => priceLog.reference(snapshot.checkpoint, now), /unavailable/, 'the old price rule blocks surplus replacement after midnight');
    let waiting = await client().recover(); assert.equal(waiting.pending, true);
    if (mode === 'exact-lagging') {
      const replacement = clientStore.get('stake-client-operation').batches[0].replacementOperation;
      const id = replacement.grant.units[0].unitId;
      assert.deepEqual(replacement.pieces[0].deals.map(v => v.fact.body.i), [1, 2, 3]);
      assert.equal(replacement.pieces[0].ready, undefined);
      assert.equal(sends, 4, 'source is swept but the surplus is not funded before readiness');
      assert.equal(clientStore.get(`stake-capacity-retirement-${original.unitId}`).done, true);
      assert.ok(stores.every(store => store.get(capacityName(scope)).pieces[original.unitId].retired));
      const lagging = new StakeLedger({ store: stores[3], context, address: me.tracAddr }).read().pieces[original.unitId];
      assert.equal(lagging.state, 'withdrawing'); assert.equal(lagging.collectionCertificate, undefined);
      assert.equal(stores[3].get(`stake-dkg-${id}`), null);
      localNow += 29;
      await client().recover(); assert.equal(sends, 4, 'three dealers wait the full DKG timeout');
      // Restart all signers and the client without moving finalized chain time.
      signers.splice(0, signers.length, ...members.map((m, i) => makeSigner(stores[i],
        { publicKey: m.dexKey, secretKey: secrets[i] }, boxes[i])));
      localNow++;
      waiting = await client().recover(); assert.equal(waiting.pending, true);
      assert.equal(now, frozen.availableAt);
      const lock = clientStore.get('stake-client-operation').batches[0].replacementOperation.pieces[0].lock;
      assert.ok(lock, 'the local timeout must complete surplus readiness despite stalled finalized time');
      assert.deepEqual(lock.Q, [1, 2, 3]);
    }
    const rootOp = clientStore.get('stake-client-operation'), op = rootOp.batches[0];
    assert.equal(op.replacementPlan.withdrawReset, '1000000'); assert.equal(op.replacementOperation.amount, '1500000');
    assert.equal(op.replacementOperation.pieces[0].descriptor.expiresAt, original.descriptor.expiresAt);
    assert.equal(op.replacementOperation.snapshot.reference.lastTradeId, hex(501));
    assert.equal(priceLog.read().position, 1); assert.equal(priceLog.entry(1).entry.completedAt, 4000, 'replacement never fabricates a new completion');
    assert.equal(ledger().read().pieces[original.unitId].state, 'retired');
    const { stakeWalletHolds } = await import('../../../src/stake/accounting.js');
    assert.equal(stakeWalletHolds(rootOp, '30').RESET, '1500000', 'surplus is never ordinary spendable wallet money');
    assert.equal((await client().recover()).collected, true);
    assert.equal((await trac.balances(me.tracAddr)).RESET, '8500000'); assert.equal(sends, 6);
    assert.equal(Object.values(ledger().read().pieces).filter(p => p.state === 'free')[0].descriptor.principalReset, '1500000');
    const budget = clientStore.get(`stake-maintenance-budget-${original.descriptor.batchId}`);
    assert.deepEqual(Object.values(budget.allocations), ['180']);
    await client().recover(); assert.equal(sends, 6);
    await client().withdraw('500000'); now += 86400;
    await assert.rejects(client().recover(), /allowance/); assert.equal(sends, 6, 'no second debit after allowance exhaustion');
    now = original.descriptor.expiresAt;
    await client().recover(); assert.equal(sends, 8, 'expiry safely returns surplus without renewing it');
    assert.equal((await trac.balances(me.tracAddr)).RESET, '10000000');
    return;
  }
  await assert.rejects(client().withdraw('all'), /Three valid original withdrawal barriers/); assert.equal(sends, 2);
  badFreezeReplies = 1;
  // Recover an older journal that retained the invalid fourth reply before certification.
  const pendingFreeze = clientStore.get('stake-client-operation');
  const pendingBatch = pendingFreeze.batches[0];
  pendingBatch.accepts = await Promise.all(members.map(m => request(m.dexKey, 'freezePrepare', {
    operationId: pendingBatch.operationId, pieces: pendingBatch.pieces })));
  clientStore.put('stake-client-operation', pendingFreeze);
  const frozen = await client().withdraw('all'); assert.equal(frozen.pending, true); assert.equal(frozen.availableAt, 90400);
  const op = clientStore.get('stake-client-operation').batches[0];
  for (const store of stores) {
    const state = new StakeLedger({ store, context, address: me.tracAddr }).read();
    assert.equal(Object.values(state.pieces)[0].state, 'withdrawing'); assert.ok(state.freezeVotes[op.operationId]);
  }
  const decision = { decisionId: hex(88), outcome: 'seller-withdraw', pieces: op.pieces, at: now,
    winnerAddress: me.tracAddr, winnerBoxKey: box.publicKey, evidenceDigest: hex(89) };
  await assert.rejects(signers[0].handle('returnVote', { decision }, identity.publicKey), /cooldown/);
  await assert.rejects(signers[0].handle('freezePrepare', { operationId: hex(90), pieces: op.pieces }, hex(91)), /authorization/);
  assert.equal(sends, 2);
  const originalPolicy = policy;
  const successor = registryPolicy({ ...scope, epochId: hex(99) });
  successor.epoch.members = originalPolicy.epoch.members; successor.custody = originalPolicy.custody;
  if (mode === 'handoff') {
    policy = { ...policy, acceptNew: false, epoch: { ...policy.epoch, stopNewAt: now } };
    const extraSecret = new Uint8Array(32).fill(31), extraBox = new Uint8Array(32).fill(32);
    const extra = { dexKey: publicKey(extraSecret), boxKey: boxKey(extraBox) }, extraStore = memoryStore();
    roster.push(extra); stores.push(extraStore);
    signers.push(makeSigner(extraStore, { publicKey: extra.dexKey, secretKey: extraSecret }, extraBox));
    successor.acceptNew = false; successor.epoch = { ...successor.epoch, startAt: now, members: [...policy.epoch.members.slice(1), extra] };
    successor.economics.active.receipts = secrets.slice(1).map((secret, i) => ({ from: members[i + 1].dexKey, at: 100,
      sig: Buffer.from(ed25519.sign(publicationBytes(successor.economics.active.policyId, 100, { ...scope, epochId: successor.epoch.id }), secret)).toString('hex') }));
    const body = { previousEpochId: policy.epoch.id, nextPolicy: successor };
    await assert.rejects(signers[0].handle('capacityHandoffVote', body, identity.publicKey), /authorization/);
    const capacityBefore = stores[0].get(capacityName(scope)), pendingCapacity = structuredClone(capacityBefore);
    pendingCapacity.pieces[hex(190)] = { unitId: hex(190), retired: false };
    stores[0].put(capacityName(scope), pendingCapacity);
    await assert.rejects(signers[0].handle('capacityHandoffVote', body, scope.venueKey), /pending stake funding/);
    assert.equal(stores[0].get(capacityName(scope)).handoff, undefined, 'unreconciled funding cannot freeze a handoff');
    stores[0].put(capacityName(scope), capacityBefore);
    const votes = await Promise.all(signers.slice(0, 4).map(s => s.handle('capacityHandoffVote', body, scope.venueKey)));
    const certificate = matchingCertificate(votes, context, 'capacity-handoff');
    await Promise.all(signers.slice(1).map(s => s.handle('capacityHandoffAdopt', { ...body, certificate }, scope.venueKey)));
    await Promise.all(signers.slice(1).map(s => s.handle('capacityHandoffAdopt', { ...body, certificate }, scope.venueKey)));
    assert.ok(stores.slice(1).every(store => store.get(capacityName(scope)).epochId === successor.epoch.id));
  }
  policy = successor;
  now = frozen.availableAt;
  const collected = await client().recover(); assert.equal(collected.collected, true); assert.equal(sends, 4);
  assert.equal((await trac.balances(me.tracAddr)).RESET, '10000000');
  assert.equal(Object.values(ledger().read().pieces)[0].state, 'retired');
  await client().recover(); assert.equal(sends, 4);
  assert.deepEqual(archives.map(a => a.kind), ['funded', 'freeze', 'decision', 'collected']);
  if (mode === 'handoff') {
    policy = originalPolicy;
    await signers.at(-1).handle('capacityRetire', { certificate: archives.find(a => a.kind === 'collected').certificate }, scope.venueKey);
    policy = successor;
    for (const store of stores) {
      const capacity = store.get(capacityName(scope));
      assert.equal(Object.values(capacity.pieces)[0].retired, true);
      assert.equal(capacity.tokens[1].generation, 1);
    }
    return;
  }
  policy = originalPolicy; now += 100;
  await client().deposit('2500000'); assert.equal(sends, 6);
  now += 86399; await client().recover(); assert.equal(sends, 6, 'expiry cannot return early');
  now++; const expired = await client().recover(); assert.equal(expired.collected, true); assert.equal(sends, 8);
  assert.equal(clientStore.get('stake-client-operation').decisionBody.outcome, 'seller-expiry');
  assert.equal((await trac.balances(me.tracAddr)).RESET, '10000000');
  await client().recover(); assert.equal(sends, 8, 'expiry never renews the deposit');
});

test('stake funding verifier binds lock nonces and refuses overpayment, unfinalized and mismatched facts', async () => {
  const { unitId } = await import('../../../src/stake/ledger.js');
  const { fundingNonce } = await import('../../../src/locks/trac-lock.js');
  const descriptor = { networkId: 1, venueKey: hex(1), epochId: hex(2), batchId: hex(3), nonce: hex(4),
    owner: { dexKey: hex(5), tracAddr: tracAddress(hex(6)), boxKey: hex(7) }, purpose: 'seller', principalReset: '25000',
    tnkReserve: '120', createdAt: 100, expiresAt: 86500 };
  const id = unitId(descriptor), destination = tracAddress(hex(8)), funding = { TNK: hex(9), RESET: hex(10) }, calls = [];
  const bridge = { call: async (method, b) => { calls.push(b); return { ok: true, final: true, amount: b.minAmount }; } };
  const input = { bridge, descriptor, unitId: id, address: destination, funding };
  assert.equal(await verifyStakeFunding(input), true);
  assert.equal(calls[0].nonce, fundingNonce(id, 'TNK')); assert.equal(calls[1].nonce, fundingNonce(id, 'RESET'));
  assert.equal(calls[0].from, descriptor.owner.tracAddr); assert.equal(calls[1].to, hex(8));
  for (const proof of [{ ok: true, final: false, amount: '120' }, { ok: true, final: true, amount: '121' },
    { ok: false, final: true, amount: '120', reason: 'wrong_nonce' }])
    await assert.rejects(verifyStakeFunding({ ...input, bridge: { call: async () => proof } }), /exactly finalized/);
  await assert.rejects(verifyStakeFunding({ ...input, descriptor: { ...descriptor, principalReset: '25001' } }), /descriptor/);
});

test('a repriced deposit cannot spend TNK already held by ordinary wallet operations', async () => {
  const policy = registryPolicy();
  policy.custody = { lifetimeSec: 86400, fundingWindowSec: 3600, dkgTimeoutSec: 30, tnkReserve: '120' };
  const store = memoryStore(); let prices = 0, proofs = 0;
  const client = new StakeClient({ store, registry: () => ({ sellerBond: policy }), clock: async () => ({ at: 4000 }),
    me: { tracAddr: tracAddress(hex(1)) }, request: async (_, method) => { assert.equal(method, 'priceSnapshot'); return {}; },
    price: { import: async () => ({ numerator: ++prices === 1 ? '20000000' : '40000000', denominator: '1' }) },
    trac: { balances: async () => ({ RESET: '10000000', TNK: '10000', feeTnk: '30' }),
      proveAddress: async () => { proofs++; } },
    freeBalances: async () => ({ RESET: { free: '10000000' }, TNK: { free: '200' } }) });
  await assert.rejects(client.deposit('2500000'), /This deposit needs [0-9.]+ TNK and the wallet has 0\.0000000000000002 TNK free/);
  assert.equal(prices, 2); assert.equal(proofs, 0);
  assert.equal(store.get('stake-client-operation'), null, 'refusal precedes capacity, DKG and funding');
});

test('finalized clock: the oldest agreeing pair wins; one lone reader does not block it', async () => {
  const read = async endpoint => { if (endpoint === 'down') throw Error('rate limited');
    const data = Buffer.alloc(40); data.writeBigInt64LE(BigInt(endpoint), 32);
    return { slot: Math.floor(Number(endpoint) / 10), value: { owner: 'Sysvar1111111111111111111111111111111111111', data } }; };
  assert.deepEqual(await finalizedStakeClock({ endpoints: ['100', '200', '203', 'down'], read }), { at: 200, slot: 20 });
  assert.deepEqual(await finalizedStakeClock({ endpoints: ['200', '203', '900', '904'], read }), { at: 200, slot: 20 }, 'never the later pair');
  await assert.rejects(finalizedStakeClock({ endpoints: ['100', '200', 'down'], read }), /disagree/);
});
