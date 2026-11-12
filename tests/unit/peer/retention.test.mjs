import test from 'node:test';
import assert from 'node:assert/strict';
import { retentionFixture, collect } from './retention-fixture.mjs';

for (const encrypted of [false, true]) test(`closed, rate-checked ${encrypted ? 'Noise + ' : ''}Protomux connections can be collected while the sidechannel stays alive`,
  { skip: typeof globalThis.gc !== 'function' ? 'Run node --expose-gc --test for the retention check' : false }, async t => {
    const fixture = await retentionFixture({ encrypted });
    t.after(() => fixture.close());
    for (let i = 0; i < 40; i++) await fixture.cycle();
    await collect();
    assert.equal(fixture.delivered(), 80);
    assert.equal(fixture.refs.filter(ref => ref.deref() !== undefined).length, 0,
      'no closed connection may be retained by its limiter');
    assert.ok(fixture.nodes.every(node => node.started), 'the feature stays live');
  });
