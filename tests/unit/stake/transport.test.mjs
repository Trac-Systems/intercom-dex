import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ed25519 } from '@noble/curves/ed25519.js';
import { StakeTransport, STAKE_CHANNEL, sealStakeMessage, openStakeMessage } from '../../../src/stake/transport.js';

const identity = n => { const secretKey = new Uint8Array(32).fill(n); return { secretKey, publicKey: Buffer.from(ed25519.getPublicKey(secretKey)).toString('hex') }; };
const a = identity(1), b = identity(2), c = identity(3);
const input = { kind: 'stakeRequest', to: b.publicKey, id: '0'.repeat(64), at: 100, method: 'status', body: {} };
test('stake envelopes bind domain, sender, recipient, method, identity and bounded freshness', () => {
  const m = sealStakeMessage(input, a.secretKey);
  assert.equal(openStakeMessage(m, 220).from, a.publicKey);
  assert.throws(() => openStakeMessage(m, 221), /stale/);
  for (const patch of [{ to: c.publicKey }, { method: 'release' }, { body: { amount: '1' } }, { ch: 'intercom-dex' }, { extra: true }])
    assert.throws(() => openStakeMessage({ ...m, ...patch }, 100));
  assert.throws(() => sealStakeMessage({ ...input, body: { text: 'x'.repeat(180000) } }, a.secretKey), /limit/);
});
test('stake transport correlates signed replies and propagates handler refusal and stop', async () => {
  const bridge = new EventEmitter(); bridge.join = async ch => assert.equal(ch, STAKE_CHANNEL);
  bridge.send = async (ch, m) => { bridge.emit('message', ch, m); };
  const client = new StakeTransport({ bridge, identity: a, now: () => 100 });
  const server = new StakeTransport({ bridge, identity: b, now: () => 100, handle: async (method, body, from) => {
    assert.equal(from, a.publicKey); if (method === 'fail') throw new Error('Withdrawal is still waiting'); return { amount: body.amount };
  } });
  await client.start(); await server.start();
  assert.deepEqual(await client.request(b.publicKey, 'status', { amount: '9007199254740993' }), { amount: '9007199254740993' });
  await assert.rejects(client.request(b.publicKey, 'fail'), /still waiting/);
  const waiting = client.request(c.publicKey, 'status'); client.stop();
  await assert.rejects(waiting, /stopped/); server.stop();
  assert.equal(bridge.listenerCount('message'), 0);
});
test('stake transport ignores a correctly signed response from the wrong signer', async () => {
  const bridge = new EventEmitter(); bridge.join = async () => {};
  bridge.send = async (ch, m) => bridge.emit('message', ch, sealStakeMessage({ ...input, kind: 'stakeReply',
    id: m.id, to: a.publicKey, body: { ok: true, value: { stolen: true } } }, c.secretKey));
  const client = new StakeTransport({ bridge, identity: a, now: () => 100, timeoutMs: 10 }); await client.start();
  await assert.rejects(client.request(b.publicKey, 'status'), /timed out/); client.stop();
});
