import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CertificatePool } from '../../../src/roles/certificate-pool.js';
import { TradeHost } from '../../../src/roles/host.js';
import { makeLockCertificate, proveLock } from '../../../src/proof/lockproof.js';
import { lockStatement, prepareDeal } from '../../../src/core/dealing.js';
import { simulation } from '../core/simulation.mjs';
import { encodeKey } from '../../../src/core/keys.js';
import { fixture, hex, proofStub } from '../core/helpers.mjs';

function store() {
  const records = new Map();
  return { records, put: (k, v) => records.set(k, structuredClone(v)), get: k => structuredClone(records.get(k) ?? null),
    delete: k => records.delete(k), list: prefix => [...records.keys()].filter(k => k.startsWith(prefix)) };
}
function entry() {
  const f = fixture(), d = prepareDeal({ k: 1, committeeBoxKeys: [f.terms.committee[0].boxKey], tradeId: hex() });
  return { secretHex: d.privateState.secretHex, H: d.deal.H, C0: d.deal.commitments[0], proof: proofStub() };
}
const proof = { zkey: '/unused-test.zkey' };
const flush = async host => { for (let i = 0; i < 12; i++) { await Promise.all([...host.trades.values()].map(t => t.queue)); await new Promise(r => setImmediate(r)); } };

test('pool fills to default two, one at a time, verifies before storing and reserves without reuse', async () => {
  const records = store(), generated = [], logs = [];
  let release;
  const pool = new CertificatePool({ store: records, proof, log: m => logs.push(m),
    make: async () => { const e = entry(); generated.push(e); await new Promise(r => { release = r; }); return e; },
    verify: async (statement, p) => { assert.equal(records.list('certpool-').length, generated.length - 1); assert.deepEqual(p, proofStub()); return statement.length === 4; } });
  assert.equal(pool.target, 2);
  const first = pool.refill(); await pool.refill(); assert.equal(generated.length, 1); release(); await first;
  const second = pool.refill(); release(); await second;
  await pool.refill(); assert.equal(generated.length, 2); assert.equal(pool.available().length, 2);
  const a = pool.take(), b = pool.take(); assert.notEqual(a.H, b.H); assert.equal(pool.take(), null);
  assert.ok(logs.includes('certificate pool empty; proving on demand'));
  assert.ok(!JSON.stringify(logs).includes(a.secretHex));
  pool.consumed(a.H); pool.consumed(b.H); assert.equal(records.list('certpool-').length, 0);
});

test('pool rejects bad proofs, mismatched secrets, busy prover results and failed generation', async () => {
  for (const mode of ['bad-proof', 'bad-H', 'bad-C0', 'bad-secret', 'busy', 'error']) {
    const records = store(), e = entry(); let checked = 0;
    const pool = new CertificatePool({ store: records, proof,
      make: async () => {
        if (mode === 'error') throw new Error(e.secretHex);
        if (mode === 'busy') return null;
        return { ...e, ...(mode === 'bad-H' ? { H: hex() } : {}), ...(mode === 'bad-C0' ? { C0: hex() } : {}),
          ...(mode === 'bad-secret' ? { secretHex: '00'.repeat(32) } : {}) };
      }, verify: async () => { checked++; return mode !== 'bad-proof'; }, log: text => assert.ok(!text.includes(e.secretHex)) });
    await pool.refill(); assert.equal(pool.available().length, 0);
    if (mode === 'bad-proof') assert.equal(checked, 1);
  }
  for (const size of [-1, 1.5, '2']) assert.throws(() => new CertificatePool({ store: store(), proof: { ...proof, pool: size } }), /proof.pool/);
  const disabled = new CertificatePool({ store: store(), proof: { ...proof, pool: 0 }, make: () => assert.fail('disabled pool') });
  await disabled.refill();
});

test('stopping a refill discards its result and timer; persisted assignments exclude undeleted entries after restart', async t => {
  const records = store(), e = entry(); let release, cleared = false;
  t.mock.method(globalThis, 'setInterval', () => 7); t.mock.method(globalThis, 'clearInterval', id => { cleared = id === 7; });
  const pool = new CertificatePool({ store: records, proof, make: () => new Promise(r => { release = r; }), verify: async () => true });
  pool.start(); pool.stop(); release(e); await new Promise(r => setImmediate(r));
  assert.equal(cleared, true); assert.equal(pool.available().length, 0);
  records.put('certpool-' + e.H, e); records.put('trade-first', { state: { tradeId: hex(), certificate: e } });
  const restarted = new CertificatePool({ store: records, proof });
  assert.equal(restarted.available().length, 0); assert.equal(restarted.take(), null);
  assert.equal(records.get('certpool-' + e.H), null, 'the leftover entry of an assigned certificate is deleted');
});

test('host crash between assignment and deletion resumes the same certificate and never assigns it to another trade', async t => {
  const sim = simulation({ capturePhases: true }), records = store(), certificate = entry();
  const identity = { publicKey: encodeKey(sim.f.buyer.publicKey), secretKey: sim.f.buyer.secretKey };
  const bridge = new EventEmitter(); bridge.join = async () => {}; const sent = []; bridge.send = async (_ch, m) => sent.push(m);
  records.put('certpool-' + certificate.H, certificate);
  let failDelete = true;
  records.delete = k => { if (failDelete && k.startsWith('certpool-')) throw new Error('crash before deletion'); return records.records.delete(k); };
  const pool = new CertificatePool({ store: records, proof });
  const host = new TradeHost({ bridge, identity, store: records, certificatePool: pool, now: () => 100, log: () => {} });
  const state = structuredClone(sim.snapshots.get('buyer:awaitCertificate'));
  await host.addTrade({ key: 'first', role: 'buyer', state, lifetimeSec: 176400 });
  await host.deliver('first', { type: 'resume' }); await flush(host);
  const saved = records.get('trade-first').state;
  assert.equal(saved.phase, 'preparingDeal'); assert.equal(saved.certificate.H, certificate.H); assert.equal(saved.deal, undefined);
  assert.ok(records.get('certpool-' + certificate.H)); assert.ok(!sent.some(m => m.kind === 'deal'));
  failDelete = false;
  const againPool = new CertificatePool({ store: records, proof }); assert.equal(againPool.take(), null);
  const again = new TradeHost({ bridge, identity, store: records, certificatePool: againPool, now: () => 100, tickMs: 999999 });
  t.after(() => again.stop()); await again.start(); await flush(again);
  assert.equal(again.trades.get('first').state.phase, 'awaitAcks');
  assert.equal(again.trades.get('first').state.deal.H, certificate.H);
  assert.equal(records.get('certpool-' + certificate.H), null);
  assert.deepEqual(sent.filter(m => m.kind === 'deal').map(m => m.body.H), [certificate.H]);
});

test('failed assignment persistence never builds or sends a deal', async () => {
  const sim = simulation({ capturePhases: true }), records = store(), certificate = entry();
  records.put('certpool-' + certificate.H, certificate);
  const put = records.put;
  records.put = (name, value) => { if (value.state?.phase === 'preparingDeal') throw Error('disk unavailable'); return put(name, value); };
  const bridge = new EventEmitter(), sent = []; bridge.join = async () => {}; bridge.send = async (_ch, m) => sent.push(m);
  const host = new TradeHost({ bridge, store: records, certificatePool: new CertificatePool({ store: records, proof }), now: () => 100,
    identity: { publicKey: encodeKey(sim.f.buyer.publicKey), secretKey: sim.f.buyer.secretKey } });
  await host.addTrade({ key: 'first', role: 'buyer', state: sim.snapshots.get('buyer:awaitCertificate'), lifetimeSec: 176400 });
  await host.deliver('first', { type: 'resume' }); await flush(host);
  assert.equal(records.get('trade-first').state.phase, 'awaitCertificate'); assert.ok(records.get('certpool-' + certificate.H));
  assert.ok(!sent.some(m => m.kind === 'deal')); assert.equal(host.trades.get('first').state.phase, 'awaitCertificate');
});

test('background certificate generation yields while the prover is busy and missing files fail without launching a proof', async () => {
  const e = entry(), statement = lockStatement({ H: e.H, commitments: [e.C0] });
  const pending = proveLock({ secretHex: e.secretHex, statement }, { zkeyPath: '/missing-certificate-test.zkey' });
  assert.equal(await makeLockCertificate({ zkeyPath: '/missing-certificate-test.zkey' }), null);
  await assert.rejects(pending);
  await new Promise(r => setImmediate(r));
  await assert.rejects(makeLockCertificate({ zkeyPath: '/missing-certificate-test.zkey' }));
});
