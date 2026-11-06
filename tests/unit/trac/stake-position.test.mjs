import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Hypercore from '../../../peer/node_modules/hypercore/index.js';
import Hyperbee from '../../../peer/node_modules/hyperbee/index.js';
import { signedPosition, readAtPosition } from '../../../peer/src/trac/stake-position.js';

test('signed MSB cutoff reads a stable historical Hyperbee prefix after later writes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stake-position-'));
  const core = new Hypercore(dir), bee = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'binary' });
  t.after(async () => { await bee.close(); await core.close(); });
  await bee.ready();
  const early = '11'.repeat(32), late = '22'.repeat(32);
  await bee.put(early, Buffer.from('early'));
  const msb = { config: { bootstrap: Buffer.alloc(32, 7) }, state: { base: { view: bee } } };
  const cutoff = await signedPosition(msb);
  await bee.put(late, Buffer.from('late'));
  assert.ok((await signedPosition(msb)).length > cutoff.length);
  assert.equal((await readAtPosition(msb, early, cutoff)).toString(), 'early');
  assert.equal(await readAtPosition(msb, late, cutoff), null);
  assert.equal((await readAtPosition(msb, late, await signedPosition(msb))).toString(), 'late');
  for (const patch of [{ length: core.signedLength + 1 }, { root: '00'.repeat(32) }, { coreKey: '00'.repeat(32) },
    { bootstrap: '00'.repeat(32) }, { extra: true }]) await assert.rejects(signedPosition(msb, { ...cutoff, ...patch }));
  await assert.rejects(readAtPosition(msb, 'not a hash', cutoff));
});

test('stalled historical reads are bounded, close their checkout and never report absence', async () => {
  let closed = 0, rejectRead;
  const core = { key: Buffer.alloc(32, 2), signedLength: 4, treeHash: async () => Buffer.alloc(32, 3) };
  const msb = { config: { bootstrap: Buffer.alloc(32, 1) }, state: { base: { view: { core, checkout() {
    return { get: () => new Promise((_, reject) => { rejectRead = reject; }), close: async () => { closed++; rejectRead?.(new Error('closed')); } };
  } } } } };
  const cutoff = await signedPosition(msb);
  await assert.rejects(readAtPosition(msb, '11'.repeat(32), cutoff, 10), /timed out/);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(closed, 1);
});
