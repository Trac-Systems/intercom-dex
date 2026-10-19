import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCommittee } from '../../../src/core/committee.js';
import { fixture, hex } from './helpers.mjs';

test('committee selection is stable, order independent, unique and filtered by status/limit/exclusion', () => {
  const f = fixture({ n: 8 }), R = hex(), options = { n: 3, k: 2, quoteAmount: '5000000', pair: 'TNK/USDC', exclude: [f.registry.signers[0].dexKey] };
  f.registry.signers[1].limitUsdc = '4999999'; f.registry.signers[2].status = 'inactive';
  const selected = selectCommittee(f.registry, R, options);
  assert.deepEqual(selectCommittee({ ...f.registry, signers: [...f.registry.signers].reverse() }, R, options), selected);
  assert.equal(new Set(selected.map(s => s.dexKey)).size, 3);
  assert.ok(selected.every(s => s.status === 'active' && BigInt(s.limitUsdc) >= 5000000n && !options.exclude.includes(s.dexKey)));
  const boundary = selectCommittee(f.registry, R, { ...options, n: 5, k: 3 }); assert.equal(boundary.length, 5);
  assert.throws(() => selectCommittee(f.registry, R, { ...options, n: 6 }));
  assert.throws(() => selectCommittee(f.registry, R, { ...options, k: 4 }));
  assert.throws(() => selectCommittee(f.registry, 'ff', options));
  assert.throws(() => selectCommittee(f.registry, R, { ...options, quoteAmount: '01' }));
  assert.throws(() => selectCommittee({ ...f.registry, signers: [...f.registry.signers, f.registry.signers[0]] }, R, options));
});
