import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForControl } from '../../e2e/control-ready.mjs';

const refused = () => new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });

test('control readiness waits through refused connections and returns the first real response', async () => {
  let attempts = 0;
  const response = { role: 'trader' };
  assert.equal(await waitForControl(async () => {
    if (++attempts < 3) throw refused();
    return response;
  }), response);
  assert.equal(attempts, 3);
});

test('control readiness does not hide application errors, other transport errors or a failed startup', async () => {
  for (const error of [Error('unauthorized'), new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }), refused()]) {
    let attempts = 0;
    const options = error.cause?.code === 'ECONNREFUSED' ? { timeoutMs: 0 } : {};
    await assert.rejects(waitForControl(async () => { attempts++; throw error; }, options), e => e === error);
    assert.equal(attempts, 1);
  }
});
