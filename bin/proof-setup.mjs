#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { plonk, zKey } from 'snarkjs';
import { stableJSON } from '../src/core/canonical.js';
import { checkProofFiles } from '../src/proof/lockproof.js';
import { PROOF_FILES, ZKEY_SHA256, PTAU_BLAKE2B, PTAU_URL, checkFileHash } from '../src/proof/files.js';

const exists = async path => { try { await access(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
let temporary, wroteTemporary = false;
try {
  const { values } = parseArgs({ options: { out: { type: 'string' }, ptau: { type: 'string' } } });
  if (!values.out || !isAbsolute(values.out) || (values.ptau !== undefined && !isAbsolute(values.ptau))) {
    throw new Error('Usage: node bin/proof-setup.mjs --out <absolute zkey path> [--ptau <absolute path>]');
  }
  if (await exists(values.out)) throw new Error('Output already exists; choose a new path');
  await checkProofFiles();
  await mkdir(dirname(values.out), { recursive: true });
  const ptau = values.ptau ?? join(dirname(values.out), 'powersOfTau28_hez_final_18.ptau');
  if (!values.ptau && !await exists(ptau)) {
    temporary = ptau + '.' + randomUUID() + '.tmp';
    const response = await fetch(PTAU_URL);
    if (!response.ok || !response.body) throw new Error(`Powers of Tau download failed (${response.status})`);
    const file = await open(temporary, 'wx');
    wroteTemporary = true;
    try { await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { fd: file.fd, autoClose: false })); }
    finally { await file.close(); }
    await checkFileHash(temporary, PTAU_BLAKE2B, 'blake2b512');
    // Publish atomically without overwriting a file another invocation created.
    await link(temporary, ptau);
    await unlink(temporary);
    temporary = undefined;
    wroteTemporary = false;
  }
  await checkFileHash(ptau, PTAU_BLAKE2B, 'blake2b512');
  temporary = values.out + '.' + randomUUID() + '.tmp';
  const output = await open(temporary, 'wx');
  wroteTemporary = true;
  await output.close();
  await plonk.setup(PROOF_FILES.r1cs.path, ptau, temporary);
  await checkFileHash(temporary, ZKEY_SHA256);
  const exported = await zKey.exportVerificationKey(temporary);
  if (stableJSON(exported) !== stableJSON(JSON.parse(await readFile(PROOF_FILES.vkey.path, 'utf8')))) {
    throw new Error('Exported verification key mismatch');
  }
  await link(temporary, values.out);
  await unlink(temporary);
  temporary = undefined;
  wroteTemporary = false;
  console.log(`Verified proving key: ${values.out}\nThe Powers of Tau file may now be deleted: ${ptau}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (wroteTemporary) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await globalThis.curve_bn128?.terminate();
}
