import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { plonk } from 'snarkjs';
import { fromLe32, hexToBytes } from '../core/canonical.js';
import { SCALAR_ORDER } from '../core/vss.js';
import { lockProofSchema, lockStatementSchema } from '../core/lock-certificate.js';
import { PROOF_FILES, ZKEY_SHA256, checkFileHash } from './files.js';

let vkey, proving = Promise.resolve(), verifying = Promise.resolve();
let pendingProves = 0;
// The running background certificate job, if any: an on-demand proof for a trade stops it instead of waiting.
let background = null;
async function verificationKey() {
  if (!vkey) {
    vkey = (async () => {
      const bytes = await readFile(PROOF_FILES.vkey.path);
      if (createHash('sha256').update(bytes).digest('hex') !== PROOF_FILES.vkey.sha256) throw new Error('Verification key hash mismatch');
      return JSON.parse(bytes);
    })();
  }
  return vkey;
}

export async function checkProofFiles({ zkeyPath } = {}) {
  for (const file of Object.values(PROOF_FILES)) await checkFileHash(file.path, file.sha256);
  if (zkeyPath !== undefined) {
    if (typeof zkeyPath !== 'string' || !isAbsolute(zkeyPath)) throw new Error('proof.zkey must be an absolute path');
    await checkFileHash(zkeyPath, ZKEY_SHA256);
  }
}

export async function verifyLock(statement, proof) {
  try {
    // Bound the flat wire object before parsing or passing anything into snarkjs.
    if (!proof || Object.getPrototypeOf(proof) !== Object.prototype || Object.keys(proof).length !== 17) return false;
    for (const value of Object.values(proof)) {
      if (typeof value === 'string') { if (value.length > 77) return false; }
      else if (!Array.isArray(value) || value.length !== 3 || value.some(v => typeof v !== 'string' || v.length > 77)) return false;
    }
    const p = lockProofSchema.parse(proof), signals = lockStatementSchema.parse(statement);
    const task = verifying.then(async () => {
      try { return await plonk.verify(await verificationKey(), signals, p) === true; }
      finally { await globalThis.curve_bn128?.terminate(); }
    });
    verifying = task.catch(() => {});
    return await task;
  } catch { return false; }
}

export async function proveLock({ secretHex, statement }, { zkeyPath }) {
  const secret = fromLe32(hexToBytes(secretHex, 32));
  if (secret === 0n || secret >= SCALAR_ORDER) throw new Error('Invalid lock secret');
  const signals = lockStatementSchema.parse(statement);
  background?.cancel();
  return runProver({ secret: String(secret), statement: signals }, zkeyPath);
}

// Background refill never queues behind an on-demand proof, and one that is running gives way to it.
// Secret generation happens inside the worker. Returns null when there was no room or it was stopped.
export async function makeLockCertificate({ zkeyPath }) {
  if (pendingProves) return null;
  const job = { cancelled: false, worker: null, cancel() { this.cancelled = true; this.worker?.terminate(); } };
  background = job;
  try { return await runProver({ certificate: true }, zkeyPath, job); }
  catch (error) { if (job.cancelled) return null; throw error; }
  finally { if (background === job) background = null; }
}

function runProver(input, zkeyPath, job = null) {
  pendingProves++;
  const task = proving.then(async () => {
    if (job?.cancelled) throw new Error('Background certificate stopped');
    await checkProofFiles({ zkeyPath });
    if (zkeyPath === undefined) throw new Error('proof.zkey is required');
    const vk = await verificationKey();
    // ffjavascript imports web-worker, which initializes its worker scope on import.
    // Use that bootstrap in our native worker; proving itself uses its single-thread mode.
    const worker = new Worker(createRequire(import.meta.url).resolve('web-worker'), {
      execArgv: [],
      workerData: { mod: new URL('./worker.js', import.meta.url).href, type: 'module',
        ...input, zkeyPath, wasmPath: PROOF_FILES.wasm.path, vkey: vk },
    });
    if (job) { job.worker = worker; if (job.cancelled) worker.terminate(); }
    try {
      return await new Promise((resolve, reject) => {
        worker.once('message', result => {
          try {
            if (!result.ok) return reject(new Error(result.reason));
            const proof = lockProofSchema.parse(result.proof);
            resolve(input.certificate ? { ...result.certificate, proof } : proof);
          }
          catch (error) { reject(error); }
        });
        worker.once('error', reject);
        worker.once('exit', code => reject(new Error(`Lock proof worker exited (${code})`)));
      });
    } finally { await worker.terminate(); }
  });
  proving = task.catch(() => {}).finally(() => { pendingProves--; });
  return task;
}
