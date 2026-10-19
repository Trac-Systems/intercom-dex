import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, open, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ZKEY_SHA256, checkFileHash } from '../../src/proof/files.js';

const exec = promisify(execFile), root = resolve('.test-tmp/proof');
await mkdir(root, { recursive: true });
test('proof setup derives the pinned key and refuses corrupted input without deleting supplied files', { timeout: 180000 }, async t => {
  assert.ok(process.env.DEX_PROOF_ZKEY, 'Set DEX_PROOF_ZKEY');
  const ptau = join(dirname(process.env.DEX_PROOF_ZKEY), 'powersOfTau28_hez_final_18.ptau');
  const scratch = await mkdtemp(join(root, 'setup-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const out = join(scratch, 'lockkey.zkey');
  const result = await exec(process.execPath, ['bin/proof-setup.mjs', '--out', out, '--ptau', ptau], { timeout: 150000 });
  assert.match(result.stdout, /Verified proving key/); assert.match(result.stdout, /may now be deleted/);
  await checkFileHash(out, ZKEY_SHA256);
  await assert.rejects(exec(process.execPath, ['bin/proof-setup.mjs', '--out', out, '--ptau', ptau]), /Output already exists/);
  await checkFileHash(out, ZKEY_SHA256);
  const bad = join(scratch, 'bad.ptau'); await copyFile(ptau, bad);
  const handle = await open(bad, 'r+'); await handle.write(Buffer.from([0]), 0, 1, 0); await handle.close();
  const refused = join(scratch, 'refused.zkey');
  await assert.rejects(exec(process.execPath, ['bin/proof-setup.mjs', '--out', refused, '--ptau', bad]), /hash mismatch/);
  await assert.rejects(stat(refused), { code: 'ENOENT' });
  assert.ok((await stat(bad)).size > 0, 'caller-supplied corrupted ptau is preserved');
  assert.deepEqual((await readdir(scratch)).sort(), ['bad.ptau', 'lockkey.zkey']);
});
