import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import Sidechannel from '../../../peer/features/sidechannel/index.js';
import { seal, open, createReplayCache } from '../../../src/core/envelope.js';
import { generateIdentity, encodeKey } from '../../../src/core/keys.js';
import { simulation } from '../core/simulation.mjs';
import { hex } from '../core/helpers.mjs';

test('fresh trade stamps cross an intermediate peer after downstream joins, while applications dedupe the signed deal', async t => {
  const sim = simulation(), action = sim.log.find(x => x.action.kind === 'deal').action;
  let now = 100000;
  const inner = seal({ ch: action.ch, kind: 'deal', body: action.body }, sim.f.buyer.secretKey, { ts: now / 1000, nonce: hex() });
  const identity = generateIdentity(), channel = action.ch;
  const sender = new Sidechannel({ wallet: { publicKey: encodeKey(identity.publicKey), sign: bytes => Buffer.from(ed25519.sign(bytes, identity.secretKey)) } },
    { powEnabled: true, powDifficulty: 4 });
  sender._now = () => now;
  const work = t.mock.method(sender, '_attachPow', sender._attachPow.bind(sender));
  function receiver() {
    const seen = createReplayCache(), accepted = [], delivered = [];
    const sc = new Sidechannel({}, { powEnabled: true, powDifficulty: 4, welcomeRequired: false,
      onMessage(_ch, payload) {
        delivered.push(payload);
        try { accepted.push(open(payload.message, { now: Math.floor(now / 1000), seen })); }
        catch (error) { assert.equal(error.code, 'replay'); }
      } });
    sc._now = () => now;
    let receive;
    const protocol = { opened: true, addMessage(h) { receive = h.onmessage; return h; }, open() {}, fullyOpened: () => new Promise(() => {}) };
    sc._openChannelForConnection({ userData: { createChannel: () => protocol } }, sc._registerChannel(channel));
    return { sc, accepted, delivered, receive: p => receive(structuredClone(p)) };
  }
  const c = receiver(), a = receiver(), b = receiver(), payloads = [];
  for (let second = 0; second < 60; second++) {
    now = 100000 + second * 1000;
    if (second === 1) for (const target of [a, b]) c.sc.connections.set({}, new Map([[channel,
      { channel: { opened: true }, message: { send: target.receive } }]]));
    const first = sender._stampedPayload(channel, structuredClone(inner));
    assert.equal(sender._stampedPayload(channel, structuredClone(inner)), first);
    const payload = await first;
    payloads.push(payload);
    c.receive(payload);
    if (second < 10) assert.equal(a.delivered.length + b.delivered.length, 0);
    if (second === 10) assert.equal(a.delivered.length + b.delivered.length, 2);
    assert.deepEqual(payload.message, inner);
    assert.equal(sender._checkPow(payload, channel), true);
    assert.equal(sender._verifySig(payload, payload.from), true);
  }
  assert.notEqual(payloads[0].id, payloads[10].id);
  assert.notEqual(payloads[0].sig, payloads[10].sig);
  assert.equal(work.mock.callCount(), 6, 'at most one stamp per ten seconds for the same completed trade payload');
  assert.equal(sender.stamped.size, 1);
  assert.ok(sender.stampedBytes < sender.maxMessageBytes);
  assert.deepEqual([c.delivered.length, a.delivered.length, b.delivered.length], [6, 5, 5]);
  assert.deepEqual([c.accepted.length, a.accepted.length, b.accepted.length], [1, 1, 1]);
});
