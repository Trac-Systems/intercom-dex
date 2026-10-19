import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PROOF_FILES = Object.freeze({
  r1cs: Object.freeze({ path: fileURLToPath(new URL('../../circuits/lockkey.r1cs', import.meta.url)), sha256: 'bac722805fcc04a20de2789eb5c36dbb4525fdd0a8f3d52ce24a00f92e88dfc2' }),
  wasm: Object.freeze({ path: fileURLToPath(new URL('../../circuits/lockkey.wasm', import.meta.url)), sha256: '7b4b3a43d9eb0f5158eb0e18ec21f7d86054f7939dcddf2639eccdfcb906e053' }),
  vkey: Object.freeze({ path: fileURLToPath(new URL('../../circuits/lockkey.vkey.json', import.meta.url)), sha256: '0e35a7d80fec3fd76e84b8bdcf8e0a47be41883ef01a3e26f5e1a84f04e8242a' }),
});
export const ZKEY_SHA256 = '23c72437797a1796aca33c57765b97154657c8ee88624c177f5b9be03848e968'; // gitleaks:allow public proving-file checksum
export const PTAU_BLAKE2B = '7e6a9c2e5f05179ddfc923f38f917c9e6831d16922a902b0b4758b8e79c2ab8a81bb5f29952e16ee6c5067ed044d7857b5de120a90704c1d3b637fd94b95b13e';
export const PTAU_URL = 'https://circom.info/powersOfTau28_hez_final_18.ptau';

export async function checkFileHash(path, expected, algorithm = 'sha256') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== expected) throw new Error(`Proof file hash mismatch: ${path}`);
}
