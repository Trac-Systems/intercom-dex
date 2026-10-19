import test from 'node:test';
import assert from 'node:assert/strict';
import { generateIdentity, encodeKey } from '../../../src/core/keys.js';
import { seal } from '../../../src/core/envelope.js';
import { publicReceiver, PUBLIC_PER_SENDER } from '../../../src/roles/common.js';
import { hex } from '../core/helpers.mjs';

test('a sender fills only its own quota before the shared replay cache; replays and forgeries spend nothing', () => {
  let t = 1000;
  const receive = publicReceiver(() => t), a = generateIdentity(), b = generateIdentity();
  const envelope = id => seal({ kind: 'cancel', ch: 'intercom-dex:offers', body: { offerId: hex() } }, id.secretKey, { ts: t, nonce: hex() });
  const first = envelope(a);
  assert.equal(receive(first).from, encodeKey(a.publicKey));
  assert.equal(receive(first), null, 'replay');
  for (let i = 1; i < PUBLIC_PER_SENDER; i++) assert.ok(receive(envelope(a)));
  assert.equal(receive(envelope(a)), null, 'a sender with a full quota is refused');
  assert.equal(receive({ ...envelope(a), from: encodeKey(b.publicKey) }), null, 'a forgery cannot spend another key');
  assert.ok(receive(envelope(b)), 'other senders are unaffected');
  t += 121;
  assert.ok(receive(envelope(a)), 'expired entries free the quota');
});
