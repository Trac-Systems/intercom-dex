import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkProofFiles, makeLockCertificate, proveLock, verifyLock } from '../../src/proof/lockproof.js';
import { PROOF_FILES } from '../../src/proof/files.js';
import { prepareDeal, lockStatement } from '../../src/core/dealing.js';
import { generateBox, encodeKey } from '../../src/core/keys.js';
import { bytesToHex, le32, hexToBytes, fromLe32, sha256Hex } from '../../src/core/canonical.js';
import { polynomialCommitments } from '../../src/core/vss.js';
import { BN254_BASE, BN254_SCALAR } from '../../src/core/lock-certificate.js';
import { rng, proofStub } from '../unit/core/helpers.mjs';

const zkeyPath = process.env.DEX_PROOF_ZKEY;
const root = resolve('.test-tmp/proof');
await mkdir(root, { recursive: true });
const makeDeal = seed => prepareDeal({ k: 1, committeeBoxKeys: [encodeKey(generateBox().publicKey)], tradeId: '01'.repeat(32), rng: rng(seed) });

test('real lock certificate binds SHA256 halves and the Baby Jubjub constant commitment', { timeout: 240000 }, async t => {
  assert.ok(zkeyPath, 'Set DEX_PROOF_ZKEY to the pinned local proving key');
  await checkProofFiles({ zkeyPath });
  const d = makeDeal('real-proof'), wrongStatement = lockStatement(d.deal);
  const completed = [];
  let ticks = 0;
  const heartbeat = setInterval(() => ticks++, 10);
  t.after(() => clearInterval(heartbeat));
  const certificate = await makeLockCertificate({ zkeyPath }), { proof } = certificate;
  const statement = lockStatement({ H: certificate.H, commitments: [certificate.C0] });
  assert.equal(sha256Hex(hexToBytes(certificate.secretHex, 32)), certificate.H);
  assert.equal(polynomialCommitments([fromLe32(hexToBytes(certificate.secretHex, 32))])[0], certificate.C0);
  clearInterval(heartbeat);
  // A trade's own proof never waits behind a background refill: the refill stops and reports no certificate.
  const background = makeLockCertificate({ zkeyPath }).then(value => { completed.push('background'); return value; });
  await new Promise(r => setTimeout(r, 3000));
  const started = performance.now();
  const wrong = proveLock({ secretHex: bytesToHex(le32(1n)), statement: wrongStatement }, { zkeyPath }).then(
    () => { completed.push('wrong'); return null; }, error => { completed.push('wrong'); return error; });
  await t.test('proving leaves the caller responsive; a trade proof stops a running background refill', async () => {
    assert.ok(ticks > 10, 'main event loop remained responsive');
    assert.equal(await background, null, 'background refill gave way');
    assert.ok(await wrong instanceof Error, 'wrong witness failed');
    assert.deepEqual(completed, ['background', 'wrong']);
    assert.ok(performance.now() - started < 60000, 'the trade proof did not wait for a full background proof');
  });
  await t.test('real proof verifies: vss C_0 coordinates satisfy the circuit', async () => {
    assert.equal(await verifyLock(statement, proof), true);
  });
  await t.test('changing either digest half, C_0 or the dealing invalidates the proof', async () => {
    for (const index of [0, 1]) {
      const changed = [...statement]; changed[index] = String(BigInt(changed[index]) ^ 1n);
      assert.equal(await verifyLock(changed, proof), false);
    }
    const other = lockStatement(makeDeal('other-proof').deal);
    assert.equal(await verifyLock([statement[0], statement[1], other[2], other[3]], proof), false);
    assert.equal(await verifyLock(other, proof), false);
  });
  await t.test('bad, oversized and noncanonical proofs never throw', async () => {
    const cases = [null, [], {}, 'x'.repeat(100000), { ...proof, extra: '0' },
      { ...proof, protocol: 'groth16' }, { ...proof, curve: 'bls12381' },
      { ...proof, A: ['0', '0', '1'] }, { ...proof, A: ['1', '2', '0'] },
      { ...proof, A: [String(BN254_BASE), '2', '1'] }, { ...proof, eval_a: String(BN254_SCALAR) },
      { ...proof, A: Array(100000).fill('1') }, { ...proof, eval_a: '1'.repeat(100000) }];
    for (const value of ['00', '01', '-1', '+1', '1.0', '1e1', '1\n', 'bad', 1, 1n]) cases.push({ ...proof, eval_a: value });
    const cyclic = { ...proof }; cyclic.A = cyclic; cases.push(cyclic);
    for (const bad of cases) assert.equal(await verifyLock(statement, bad), false);
    for (const bad of [[], null, [...statement, '0'], ['00', ...statement.slice(1)]]) assert.equal(await verifyLock(bad, proof), false);
    assert.equal(await verifyLock(statement, proof), true, 'bad inputs did not break future verification');
  });
  await t.test('a private scalar that does not match the statement fails proving', async () => {
    assert.match((await wrong).message, /Lock proof failed/);
  });
});

test('file checks reject a modified copy of every pinned artifact', async t => {
  assert.ok(zkeyPath);
  const scratch = await mkdtemp(join(root, 'hashes-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await mkdir(join(scratch, 'src/proof'), { recursive: true });
  await mkdir(join(scratch, 'circuits'));
  await copyFile('src/proof/files.js', join(scratch, 'src/proof/files.js'));
  const code = (await readFile('src/proof/lockproof.js', 'utf8')).replaceAll("'../core/", "'" + pathToFileURL(resolve('src/core')).href + '/');
  await writeFile(join(scratch, 'src/proof/lockproof.js'), code);
  for (const file of Object.values(PROOF_FILES)) await copyFile(file.path, join(scratch, 'circuits', file.path.split('/').at(-1)));
  const isolated = await import(pathToFileURL(join(scratch, 'src/proof/lockproof.js')));
  await isolated.checkProofFiles();
  for (const [name, file] of Object.entries(PROOF_FILES)) {
    await t.test(name + ' hash', async () => {
      const copy = join(scratch, 'circuits', file.path.split('/').at(-1));
      await corrupt(copy);
      await assert.rejects(isolated.checkProofFiles(), /hash mismatch/);
      await copyFile(file.path, copy);
    });
  }
  const copy = join(scratch, 'lockkey.zkey');
  await copyFile(zkeyPath, copy); await corrupt(copy);
  await assert.rejects(checkProofFiles({ zkeyPath: copy }), /hash mismatch/);
  await assert.rejects(checkProofFiles({ zkeyPath: 'relative.zkey' }), /absolute/);
  await assert.rejects(proveLock({ secretHex: '00'.repeat(32), statement: ['0', '0', '0', '1'] }, { zkeyPath }));
  assert.equal(await verifyLock(['0', '0', '0', '1'], proofStub()), false);
});

async function corrupt(file) {
  const handle = await open(file, 'r+');
  try { const b = Buffer.alloc(1); await handle.read(b, 0, 1, 0); b[0] ^= 1; await handle.write(b, 0, 1, 0); }
  finally { await handle.close(); }
}
