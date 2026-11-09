import test from 'node:test';
import assert from 'node:assert/strict';
import { admissionFixture } from './admission-helpers.mjs';
import { memoryStore, secrets, policy } from './helpers.mjs';
import { prepareBond, bondReservation } from '../../../src/stake/admission.js';
import { StakeLedger, reservationId } from '../../../src/stake/ledger.js';
import { PenaltySigner } from '../../../src/stake/penalty-signer.js';
import { PenaltyCoordinator } from '../../../src/stake/penalty-coordinator.js';
import { verifyCertificate } from '../../../src/stake/certificates.js';
import { seal } from '../../../src/core/envelope.js';
import { admissionInventory } from '../../../src/stake/admission.js';
import { prepareOrphanClient, recoverOrphanClients } from '../../../src/stake/orphan.js';

const hex = n => n.toString(16).padStart(64, '0');
function fixture(clockSettings = null, holders = 4) {
  const f = admissionFixture(), settings = f.policy.economics.active.settings;
  if (clockSettings) settings.proofClock = clockSettings; else delete settings.proofClock;
  f.policy.economics.active = policy(settings);
  const terms = { ...f.terms, bond: prepareBond(f.args) }, H = hex(40);
  const input = bondReservation(terms, H), id = reservationId(input);
  let now = terms.sendBy, healthy = true, version = 10, deliveredAt = null, escrowState = 'active', timely = true;
  const sigs = [f.parties.buyer, f.parties.seller].map((p, i) => seal({ kind: 'termsSig', ch: `intercom-dex:t:${input.tradeId}`,
    body: { tradeId: input.tradeId } }, p.secretKey, { ts: 4000, nonce: hex(70 + i) }));
  const store = memoryStore(), stores = secrets.map((_, i) => {
    const s = memoryStore(); for (const name of f.store.list('')) s.put(name, f.store.get(name));
    if (i < holders) new StakeLedger({ store: s, context: f.context, address: terms.seller.tracAddr }).reserve(input, { terms, fromSlot: 1, policy: f.policy, sigs }); return s;
  });
  const position = async p => p ?? { bootstrap: hex(1), coreKey: hex(2), root: hex(version), length: version };
  const clock = async () => ({ at: now, slot: now });
  const signers = stores.map((store, i) => new PenaltySigner({ store, identity: { publicKey: f.context.epoch.members[i].dexKey, secretKey: secrets[i] }, clock, position,
    policyFor: () => f.policy,
    history: async () => ({ status: 'complete', evidenceDigest: hex(4), escrowState, locks: timely ? [{ includedAt: terms.sendBy - (timely === 'late' ? 120 : 121), exact: true }] : [] }),
    health: async () => healthy, verifyDelivery: async (t, tx, p) => ({ state: deliveredAt === null ? 'unknown' : deliveredAt <= p.length ? 'in-time' : 'late', ...(deliveredAt === null ? { reason: 'unknown_or_not_final' } : {}), txHash: tx }) }));
  for (const signer of signers) signer.timing = () => ({ triggerAt: terms.sendBy + 5, windowSec: 10 });
  const prepare = reservation => prepareOrphanClient({ reservation, policy: f.policy,
    identity: { publicKey: terms.seller.dexKey, secretKey: f.parties.seller.secretKey }, store: f.store, from: f.context.venueKey, now });
  const request = (to, method, body) => to === terms.seller.dexKey && method === 'orphanPrepare' ? prepare(body.reservation) :
    signers[f.context.epoch.members.findIndex(m => m.dexKey === to)].handle(method, body, f.context.venueKey);
  const coordinator = new PenaltyCoordinator({ store, registry: () => ({ sellerBond: f.policy }), request, clock, position, timing: signers[0].timing });
  return { ...f, terms, id, stores, signers, coordinator, store, prepare, set: values => {
    if (values.now !== undefined) now = values.now; if (values.healthy !== undefined) healthy = values.healthy;
    if (values.version !== undefined) version = values.version; if (values.deliveredAt !== undefined) deliveredAt = values.deliveredAt;
    if (values.escrowState !== undefined) escrowState = values.escrowState; if (values.timely !== undefined) timely = values.timely;
  }, tick: async at => { now = at; await coordinator.tick(); }, evidence: tx => Promise.all(signers.map(s => s.handle('penaltyEvidence', { reservationId: id, txHash: tx }, terms.seller.dexKey))) };
}

test('no-show reserves through the shortened healthy proof window, then produces one buyer award', async () => {
  const f = fixture();
  await f.tick(5005); await f.tick(5010);
  assert.equal(f.coordinator.result(f.id).decision, null);
  await f.tick(5015);
  const result = f.coordinator.result(f.id);
  assert.ok(result.decision, result.error);
  assert.equal(verifyCertificate(result.decision, f.context, 'decision').body.winnerAddress, f.terms.buyer.tracAddr);
  const original = JSON.stringify(result.decision); await f.tick(5020);
  assert.equal(JSON.stringify(f.coordinator.result(f.id).decision), original);
  await assert.rejects(f.signers[0].settlement(f.id, hex(50)), /Timely|blocks/);
});

test('signed proof timing completes with 38-second rounds and still rejects an actual outage', async () => {
  for (const outage of [false, true]) {
    const f = fixture({ sampleGapSec: 60, sampleFreshSec: 90, checkpointFreshSec: 180 });
    await f.tick(5005);
    const all = f.coordinator.all.bind(f.coordinator); let now = 5043;
    f.coordinator.all = async (...args) => {
      const result = await all(...args);
      if (['penaltyClockCommit', 'penaltyPrepare'].includes(args[1])) {
        now += 38; f.set({ now, healthy: !outage });
      }
      return result;
    };
    await f.tick(5043);
    const result = f.coordinator.result(f.id);
    assert.equal(result.clock.activeElapsedSec, 38);
    if (outage) { assert.equal(result.decision, null); assert.match(result.error, /healthy proof/); }
    else assert.ok(result.decision, result.error);
  }
});

test('slow health probes are explicitly unknown and timestamped at completion', async () => {
  const f = fixture({ sampleGapSec: 60, sampleFreshSec: 90, checkpointFreshSec: 180 });
  f.set({ now: 5005 });
  f.signers[0].health = async () => { f.set({ now: 5096 }); return true; };
  const vote = await f.signers[0].handle('penaltySample', { reservationId: f.id, position: null }, f.context.venueKey);
  assert.equal(vote.fact.body.healthy, false); assert.equal(vote.fact.body.reason, 'sample-slow');
  assert.equal(vote.fact.body.at, 5096);
});

test('delivery inside grace closes for reuse, after-grace delivery still awards the reserved pieces', async () => {
  const early = fixture(); early.set({ deliveredAt: 10 });
  await early.evidence(hex(50)); await early.tick(5001);
  assert.equal(early.coordinator.result(early.id).resolved[0].fact.body.outcome, 'delivered');
  assert.equal(early.coordinator.result(early.id).decision, null);
  const late = fixture(); await late.tick(5005);
  late.set({ version: 11, deliveredAt: 11 }); await late.evidence(hex(51));
  await late.tick(5010); await late.tick(5015);
  assert.ok(late.coordinator.result(late.id).decision, late.coordinator.result(late.id).error);
});

test('outage pauses the proof clock; delivery inside the certified outage is excused', async () => {
  const f = fixture(); await f.tick(5005); await f.tick(5010);
  f.set({ healthy: false }); await f.tick(5015);
  assert.equal(f.coordinator.result(f.id).clock.activeElapsedSec, 5);
  f.set({ version: 11, deliveredAt: 11 }); await f.tick(5020);
  f.set({ healthy: true }); await f.tick(5025);
  await f.evidence(hex(52)); await f.tick(5030);
  assert.equal(f.coordinator.result(f.id).decision, null);
  assert.equal(f.coordinator.result(f.id).resolved?.[0].fact.body.outcome, 'delivered', f.coordinator.result(f.id).error);
});

test('slow coordinator rounds pause their gap but fresh consecutive health probes can still earn time', async () => {
  const f = fixture(); await f.tick(5005);
  const all = f.coordinator.all.bind(f.coordinator); let sampleCalls = 0;
  f.coordinator.all = async (...args) => {
    const result = await all(...args);
    if (args[1] === 'penaltySample' && ++sampleCalls === 1) f.set({ now: 5035 });
    return result;
  };
  await f.tick(5030);
  const clock = f.coordinator.result(f.id).clock;
  assert.equal(sampleCalls, 2);
  assert.equal(clock.activeElapsedSec, 5);
  assert.deepEqual(clock.pausedIntervals, [{ from: 5005, to: 5030 }]);
  assert.deepEqual(clock.healthyIntervals, [{ from: 5030, to: 5035 }]);
  assert.equal(f.coordinator.result(f.id).decision, null);
});

test('slow-round pause retains the old position and ends before the fresh healthy tail', async () => {
  for (const deliveredAt of [11, 12]) {
    const f = fixture(); await f.tick(5005); f.set({ version: 11 });
    const all = f.coordinator.all.bind(f.coordinator); let sampleCalls = 0;
    f.coordinator.all = async (...args) => {
      const result = await all(...args);
      if (args[1] === 'penaltySample' && ++sampleCalls === 1) f.set({ now: 5035, version: 12 });
      return result;
    };
    await f.tick(5030); f.set({ deliveredAt }); await f.evidence(hex(53)); await f.tick(5040);
    const result = f.coordinator.result(f.id);
    if (deliveredAt === 11) {
      assert.equal(result.resolved?.[0].fact.body.outcome, 'delivered', result.error);
      assert.equal(result.decision, null);
    } else {
      assert.ok(result.decision, 'delivery in the healthy tail is still late');
      assert.equal(result.resolved, null);
    }
  }
});

test('slow cutoff commits finish before consecutive health observations begin', async () => {
  const f = fixture(); await f.tick(5005);
  const all = f.coordinator.all.bind(f.coordinator); let committed = false, fresh = 0;
  f.coordinator.all = async (...args) => {
    const result = await all(...args);
    if (args[1] === 'penaltyCutoffCommit') { committed = true; f.set({ now: 5050 }); }
    if (args[1] === 'penaltySample' && committed && ++fresh === 1) f.set({ now: 5055 });
    return result;
  };
  await f.tick(5030);
  const clock = f.coordinator.result(f.id).clock;
  assert.equal(fresh, 2); assert.equal(clock.activeElapsedSec, 5);
  assert.deepEqual(clock.pausedIntervals, [{ from: 5005, to: 5050 }]);
  assert.deepEqual(clock.healthyIntervals, [{ from: 5050, to: 5055 }]);
});

test('terminal rounds refresh health after slow clock commits and preparation without relaxing freshness', async () => {
  for (const mode of ['healthy', 'outage', 'stale-clock']) {
    const f = fixture(); await f.tick(5005); await f.tick(5010);
    const all = f.coordinator.all.bind(f.coordinator); let now = 5015;
    f.coordinator.all = async (...args) => {
      const result = await all(...args);
      if (args[1] === 'penaltyClockCommit') {
        now += mode === 'stale-clock' ? 31 : 16;
        f.set({ now, healthy: mode !== 'outage' });
      }
      if (args[1] === 'penaltyPrepare') { now += 16; f.set({ now }); }
      return result;
    };
    await f.tick(5015);
    const result = f.coordinator.result(f.id);
    assert.equal(result.clock.remainingSec, 0);
    if (mode === 'healthy') assert.ok(result.decision, result.error);
    else {
      assert.equal(result.decision, null);
      assert.match(result.error, /Complete healthy proof window required/);
    }
  }
});

test('late lock / never lock safely closes; a finalized claim vetoes a no-show award', async () => {
  for (const kind of ['late-lock', 'never-lock']) {
    const f = fixture(); f.set({ timely: kind === 'late-lock' ? 'late' : false });
    await f.tick(4999); assert.equal(f.coordinator.result(f.id).resolved, null);
    await f.tick(5005);
    assert.equal(f.coordinator.result(f.id).resolved?.[0].fact.body.outcome, 'unfunded', kind);
    assert.equal(f.coordinator.result(f.id).decision, null);
    for (const signer of f.signers) {
      const { ledger, r } = signer.find(f.id), piece = ledger.read().pieces[r.body.pieces[0].unitId];
      assert.equal(piece.state, 'free'); assert.equal(piece.generation, r.body.pieces[0].generation + 1);
    }
  }
  const f = fixture(); await f.tick(5005); await f.tick(5010); f.set({ escrowState: 'claimed' }); await f.tick(5015);
  assert.equal(f.coordinator.result(f.id).decision, null);
});

test('lost terminal replies recover the exact durable vote after restart without advancing its clock', async () => {
  const f = fixture(), original = f.coordinator.request; let drop = true;
  f.coordinator.request = async (...args) => { const reply = await original(...args); if (drop && args[1] === 'penaltyVote') throw Error('reply lost'); return reply; };
  await f.tick(5005); await f.tick(5010); await f.tick(5015);
  assert.equal(f.coordinator.result(f.id).decision, null);
  assert.match(f.coordinator.result(f.id).error, /penaltyVote: reply lost/);
  const pending = f.store.get(`stake-penalty-job-${f.id}`).pendingDecision.decision;
  drop = false; await f.tick(5500);
  assert.deepEqual(f.coordinator.result(f.id).decision[0].fact.body, pending);
  assert.equal(f.coordinator.awards(0).awards.length, 1);
  await f.tick(5510); assert.equal(f.coordinator.awards(0).awards.length, 1);
});

test('registry replacement and coordinator restart retain original penalty committee and one award', async () => {
  const f = fixture(); await f.tick(5005);
  const changed = { ...f.policy, epoch: { ...f.policy.epoch, id: hex(101), members: [...f.policy.epoch.members.slice(1), { dexKey: hex(102), boxKey: hex(103) }] } };
  f.coordinator.registry = () => ({ sellerBond: changed });
  await f.tick(5010); await f.tick(5015);
  const first = f.coordinator.result(f.id).decision;
  assert.ok(first, f.coordinator.result(f.id).error);
  assert.equal(verifyCertificate(first, f.context, 'decision').epochId, f.policy.epoch.id);
  const restarted = new PenaltyCoordinator({ ...f.coordinator, registry: () => ({ sellerBond: changed }) });
  await restarted.tick(); await restarted.tick();
  assert.deepEqual(restarted.result(f.id).decision, first);
  assert.equal(restarted.awards(0).awards.length, 1);
});

test('retained custody epoch discovers a reservation even if the venue restarted before its first penalty scan', async () => {
  const f = fixture();
  f.store.put(`stake-venue-epoch-${f.policy.epoch.id}`, f.policy);
  f.coordinator.registry = () => ({ sellerBond: { ...f.policy, epoch: { ...f.policy.epoch, id: hex(104) } } });
  f.set({ deliveredAt: 10 }); await f.evidence(hex(105)); await f.tick(5001);
  assert.equal(f.coordinator.result(f.id).resolved[0].fact.body.outcome, 'delivered');
});

test('two durable terminal votes finish after recovery and refund using fresh health/history; closed inbox cannot split votes', async () => {
  const f = fixture(), original = f.coordinator.request; let fail = true;
  const unavailable = new Set(f.context.epoch.members.slice(2).map(m => m.dexKey));
  f.coordinator.request = async (...args) => { if (fail && args[1] === 'penaltyVote' && unavailable.has(args[0])) throw Error('offline before vote'); return original(...args); };
  await f.tick(5005); await f.tick(5010); await f.tick(5015);
  assert.equal(f.coordinator.result(f.id).decision, null);
  f.set({ deliveredAt: 10 }); const receipts = await f.evidence(hex(89));
  assert.ok(receipts.every(v => v.fact.body.state === 'closed'));
  f.set({ escrowState: 'refunded' }); fail = false; await f.tick(5500);
  assert.ok(f.coordinator.result(f.id).decision, f.coordinator.result(f.id).error);
});

test('bounded penalty scans rotate past the first page and exclude fully collected awards', async () => {
  const f = fixture(), signer = f.signers[0], store = f.stores[0];
  const name = store.list('stake-ledger-')[0], ledger = store.get(name), original = ledger.reservations[f.id];
  ledger.reservations = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [hex(100 + i), { ...original, reservationId: hex(100 + i) }]));
  store.put(name, ledger);
  const found = new Set();
  for (let i = 0; i < 3; i++) { const page = await signer.handle('penaltyList', {}, f.context.venueKey); assert.equal(page.length, 32); page.forEach(id => found.add(id)); }
  assert.equal(found.size, 70);
  for (const r of Object.values(ledger.reservations)) r.state = 'decided';
  for (const piece of Object.values(ledger.pieces)) piece.state = 'retired';
  store.put(name, ledger);
  assert.deepEqual(await signer.handle('penaltyList', {}, f.context.venueKey), []);
  const visited = new Set();
  f.coordinator.all = async () => [[...found]];
  f.coordinator.advance = async id => visited.add(id);
  await f.coordinator.tick(); assert.equal(visited.size, 32);
  await f.coordinator.tick(); await f.coordinator.tick(); assert.equal(visited.size, 70);
});

test('unavailable signer readers preserve the pre-outage position until a recovery quorum can excuse delivery', async () => {
  const f = fixture(); await f.tick(5005); await f.tick(5010);
  const original = f.signers.map(s => s.position);
  for (const signer of f.signers.slice(0, 2)) signer.position = async () => { throw Error('reader offline'); };
  await f.tick(5015);
  assert.equal(f.coordinator.result(f.id).clock.activeElapsedSec, 5);
  assert.ok(f.signers.every(s => s.record(f.id).pendingPausePosition));
  f.set({ version: 11, deliveredAt: 11 });
  await f.evidence(hex(54));
  assert.ok(f.signers.every(s => s.record(f.id).candidates[hex(54)].state === 'unknown'));
  await f.tick(5020);
  f.signers.forEach((s, i) => { s.position = original[i]; });
  await f.tick(5025); await f.evidence(hex(54)); await f.tick(5030);
  assert.equal(f.coordinator.result(f.id).decision, null);
  assert.equal(f.coordinator.result(f.id).resolved?.[0].fact.body.outcome, 'delivered', f.coordinator.result(f.id).error);
});

test('a proof submitted after trigger but before the first cutoff cannot deadlock cutoff health', async () => {
  const f = fixture(); f.set({ now: 5006, version: 11, deliveredAt: 11 });
  const receipts = await f.evidence(hex(55));
  assert.ok(receipts.every(v => v.fact.body.reason === 'cutoff_unavailable'));
  await f.tick(5006); assert.ok(f.store.get(`stake-penalty-job-${f.id}`).cutoff);
  await f.tick(5011);
  assert.equal(f.coordinator.result(f.id).decision, null);
  assert.equal(f.coordinator.result(f.id).resolved?.[0].fact.body.outcome, 'delivered', f.coordinator.result(f.id).error);
});

test('one or two holders close an unfunded orphan with three votes and identical generations', async () => {
  for (const holders of [1, 2]) {
    const f = fixture(null, holders); f.set({ timely: false });
    await f.tick(5300);
    assert.equal(f.coordinator.result(f.id).resolved, null, 'the verification deadline is inclusive');
    await f.tick(5301);
    const certificate = f.coordinator.result(f.id).resolved;
    assert.equal(verifyCertificate(certificate, f.context, 'resolved').body.outcome, 'unfunded');
    const inventories = f.signers.map(s => {
      const { r, ledger } = s.find(f.id);
      assert.equal(r.state, 'unfunded');
      assert.throws(() => ledger.reserve(r.body, r.admission), /bond_not_reserved/);
      return admissionInventory(ledger.read(), f.terms.seller, 5301, f.context.epoch.id);
    });
    assert.ok(inventories.every(i => JSON.stringify(i) === JSON.stringify(inventories[0])));
    assert.equal(inventories[0].pieces[0].generation, 1);
    await f.tick(5400);
    assert.equal(f.signers[3].find(f.id).ledger.read().pieces[inventories[0].pieces[0].unitId].generation, 1);
  }
});

test('orphan votes independently reject live locks, incomplete history, forged terms and old history frontiers', async () => {
  for (const failure of ['live-lock', 'unknown-history', 'forged-signature', 'wrong-policy', 'wrong-reservation']) {
    const f = fixture(null, 2); f.set({ now: 5301, timely: false });
    const reservation = f.signers[0].find(f.id).r;
    const body = { reservationId: f.id, reservation, ready: f.prepare(reservation), evidenceDigest: hex(90), throughSlot: 1 };
    if (failure === 'live-lock') f.set({ timely: true });
    if (failure === 'unknown-history') f.signers[2].history = async () => ({ status: 'unknown' });
    if (failure === 'forged-signature') reservation.admission.sigs[0].sig = '0'.repeat(128);
    if (failure === 'wrong-policy') reservation.admission.policy.venueKey = hex(99);
    if (failure === 'wrong-reservation') reservation.body.H = hex(99);
    await assert.rejects(f.signers[2].handle('penaltyOrphanVote', body, f.context.venueKey));
    assert.equal(f.stores[2].get(f.stores[2].list('stake-ledger-')[0]).reservations[f.id], undefined);
  }
  const f = fixture(null, 2); f.set({ now: 5301, timely: false });
  let frontier;
  f.signers[2].history = async args => { frontier = args.throughSlot; return { status: 'complete', locks: [] }; };
  await f.signers[2].handle('penaltyOrphanVote', { reservationId: f.id, reservation: f.signers[0].find(f.id).r,
    ready: f.prepare(f.signers[0].find(f.id).r), evidenceDigest: hex(90), throughSlot: 1 }, f.context.venueKey);
  assert.equal(frontier, 5301);
  const { ledger, r } = f.signers[2].find(f.id);
  assert.throws(() => ledger.reserve(r.body, r.admission), /bond_not_reserved/);
  assert.throws(() => ledger.prepareFreeze({ operationId: hex(91), pieces: r.body.pieces, acceptedAt: 5301 }), /bond_reserved/);
});

test('two votes cannot free any orphan; conflicting local custody cannot be overwritten', async () => {
  const f = fixture(null, 2); f.set({ timely: false });
  for (const s of f.signers.slice(2)) s.history = async () => ({ status: 'unknown' });
  await f.tick(5301);
  assert.equal(f.coordinator.result(f.id).resolved, null);
  assert.ok(f.signers.slice(0, 2).every(s => s.find(f.id).r.state === 'reserved'));
  const g = fixture(null, 2); g.set({ timely: false, now: 5301 });
  const r = g.signers[0].find(g.id).r;
  const ledger = new StakeLedger({ store: g.stores[2], context: g.context, address: g.terms.seller.tracAddr });
  ledger.reserve({ ...r.body, tradeId: hex(99) });
  await assert.rejects(g.signers[2].handle('penaltyOrphanVote', { reservationId: g.id, reservation: r, ready: g.prepare(r), evidenceDigest: hex(90) }, g.context.venueKey), /generation conflict/);
});

test('old holders apply unchanged closure; an old non-holder is retried after upgrade and coordinator restart', async () => {
  const f = fixture(null, 2); f.set({ timely: false });
  const request = f.coordinator.request; let fourthUpgraded = false;
  f.coordinator.request = async (key, method, body) => {
    const i = f.context.epoch.members.findIndex(m => m.dexKey === key);
    if ((i < 2 || i === 3 && !fourthUpgraded) && method === 'penaltyOrphanVote') throw Error('Unsupported penalty request');
    if (i === 3 && !fourthUpgraded && method !== 'penaltyList') throw Error('Unknown penalty reservation');
    return request(key, method, body);
  };
  await f.tick(5301);
  assert.ok(f.coordinator.result(f.id).resolved);
  assert.equal(f.store.get(`stake-penalty-job-${f.id}`).resolvedMembers.length, 3);
  fourthUpgraded = true;
  const restarted = new PenaltyCoordinator({ ...f.coordinator });
  await restarted.tick();
  assert.equal(f.store.get(`stake-penalty-job-${f.id}`).resolvedMembers.length, 4);
  assert.equal(f.signers[3].find(f.id).r.state, 'unfunded');
  assert.equal(f.signers[3].find(f.id).ledger.read().pieces[f.terms.bond.pieces[0].unitId].generation, 1);
});

test('an old seller app cannot be moved to a new generation by the orphan extension', async () => {
  const f = fixture(null, 2); f.set({ timely: false });
  const request = f.coordinator.request;
  f.coordinator.request = (to, method, body) => {
    if (method === 'orphanPrepare') throw Error('Unsupported stake request');
    return request(to, method, body);
  };
  await f.tick(5301);
  assert.equal(f.coordinator.result(f.id).resolved, null);
  assert.equal(f.ledger.read().pieces[f.terms.bond.pieces[0].unitId].generation, 0);
  f.coordinator.request = request;
  await f.tick(5401);
  const certificate = f.coordinator.result(f.id).resolved;
  assert.ok(certificate);
  const ownerStore = f.ledger.store;
  let calls = 0;
  const requestResult = async (to, method, body) => {
    calls++; assert.equal(to, f.context.venueKey); assert.equal(method, 'penaltyResult');
    return f.coordinator.result(body.reservationId);
  };
  await recoverOrphanClients({ store: ownerStore, request: requestResult });
  assert.equal(f.ledger.read().pieces[f.terms.bond.pieces[0].unitId].generation, 1);
  await recoverOrphanClients({ store: ownerStore, request: requestResult });
  assert.equal(calls, 1, 'completed closure survives without an active spot trade');
});

test('funding recovered at a newer generation accepts an older closure tombstone without rewinding', async () => {
  const f = fixture(null, 2); f.set({ timely: false });
  const request = f.coordinator.request;
  f.coordinator.request = (to, method, body) => {
    if (to === f.context.epoch.members[3].dexKey && method !== 'penaltyList') throw Error('offline');
    return request(to, method, body);
  };
  await f.tick(5301);
  const result = f.coordinator.result(f.id), l = new StakeLedger({ store: f.stores[3], context: f.context, address: f.terms.seller.tracAddr });
  const p = Object.values(l.read().pieces)[0], inv = admissionInventory(f.signers[0].find(f.id).ledger.read(), f.terms.seller, 5301, f.context.epoch.id);
  l.recoverFunded(p.fundingCertificate, { settings: f.policy.economics.active.settings, price: f.priceReference.q, now: 5301 }, f.cert('admission-inventory', inv));
  f.coordinator.request = request;
  await f.tick(5302);
  assert.equal(l.read().pieces[p.unitId].generation, 1);
  assert.equal(l.read().reservations[f.id].state, 'unfunded');
  assert.equal(f.store.get(`stake-penalty-job-${f.id}`).resolvedMembers.length, 4);
  assert.throws(() => l.reserve(result.reservation.body), /bond_not_reserved/);
});

test('durable non-holder closure vote blocks settlement shares and survives a lost vote reply', async () => {
  const f = fixture(null, 2); f.set({ timely: false, now: 5301 });
  const r = f.signers[0].find(f.id).r, b = { reservationId: f.id, reservation: r, ready: f.prepare(r), evidenceDigest: hex(90) };
  const first = await f.signers[2].handle('penaltyOrphanVote', b, f.context.venueKey);
  const signer = new PenaltySigner({ ...f.signers[2] });
  assert.deepEqual(await signer.handle('penaltyOrphanVote', b, f.context.venueKey), first);
  assert.throws(() => signer.find(f.id).ledger.deliveryIntent(f.id, { txHash: hex(92), evidenceDigest: hex(93), share: true }), /blocks settlement/);
  await assert.rejects(signer.handle('penaltyOrphanVote', { ...b, evidenceDigest: hex(91) }, f.context.venueKey), /fixed/);
});
