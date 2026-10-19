import { parentPort, workerData } from 'node:worker_threads';
import { plonk } from 'snarkjs';
import { buildBn128 } from 'ffjavascript';
import { randomScalar, polynomialCommitments } from '../core/vss.js';
import { bytesToHex, le32, sha256Hex } from '../core/canonical.js';
import { lockStatement } from '../core/dealing.js';

const { wasmPath, zkeyPath, vkey } = workerData;
let { secret, statement } = workerData;
let result;
try {
  let certificate;
  if (workerData.certificate) {
    const scalar = randomScalar(), secretHex = bytesToHex(le32(scalar));
    const H = sha256Hex(le32(scalar)), [C0] = polynomialCommitments([scalar]);
    certificate = { secretHex, H, C0 };
    secret = String(scalar); statement = lockStatement({ H, commitments: [C0] });
  }
  const [hashHi, hashLo, cx, cy] = statement;
  const { proof, publicSignals } = await plonk.fullProve({ s: secret, hashHi, hashLo, cx, cy }, wasmPath, zkeyPath,
    undefined, undefined, { singleThread: true });
  // plonk.verify has no singleThread option; its curve factory reuses this instance.
  globalThis.curve_bn128 = await buildBn128(true);
  if (JSON.stringify(publicSignals) !== JSON.stringify(statement) || !await plonk.verify(vkey, statement, proof)) {
    throw new Error('Generated lock certificate did not verify');
  }
  result = { ok: true, proof, ...(certificate ? { certificate } : {}) };
} catch (error) {
  result = { ok: false, reason: `Lock proof failed: ${error.message}` };
} finally {
  await globalThis.curve_bn128?.terminate();
}
parentPort.postMessage(result);
parentPort.close();
