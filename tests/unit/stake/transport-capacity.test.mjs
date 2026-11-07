import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ed25519 } from '@noble/curves/ed25519.js';
import { StakeTransport, STAKE_CHANNEL, sealStakeMessage, stakeMessageExpired } from '../../../src/stake/transport.js';

const identity = n => { const secretKey = new Uint8Array(32).fill(n); return { secretKey, publicKey: Buffer.from(ed25519.getPublicKey(secretKey)).toString('hex') }; };
const venue = identity(1), signer = identity(2), trader = identity(3);
const request = (from, i, at = 1000, method = 'admissionInventory') =>
  sealStakeMessage({ kind: 'stakeRequest', to: signer.publicKey, id: i.toString(16).padStart(64, '0'), at, method, body: {} }, from.secretKey);

function server(now = 1000) {
  const bridge = new EventEmitter(), replies = [];
  bridge.join = async () => {}; bridge.send = async (ch, m) => { replies.push(m); };
  let release; const gate = new Promise(resolve => { release = resolve; });
  const handled = [];
  const transport = new StakeTransport({ bridge, identity: signer, now: () => now, allowPagingPeer: key => key === venue.publicKey,
    handle: async (method, body, from) => { handled.push(from); await gate; return { ok: 1 }; } });
  return { bridge, transport, handled, replies, release };
}

test('the venue runs 16 stake requests at a signer, beside traders who keep 4 each', async () => {
  const s = server(); await s.transport.start();
  for (let i = 0; i < 20; i++) s.bridge.emit('message', STAKE_CHANNEL, request(venue, i));
  for (let i = 0; i < 6; i++) s.bridge.emit('message', STAKE_CHANNEL, request(trader, 100 + i));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.handled.filter(k => k === venue.publicKey).length, 16);
  assert.equal(s.handled.filter(k => k === trader.publicKey).length, 4);
  s.release(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(s.replies.length, 20);
  assert.equal(s.transport.active.size, 0); assert.equal(s.transport.servers.size, 0);
  s.transport.stop();
});

test('a request older than its requester waits is neither handled nor answered', async () => {
  const s = server(1046); await s.transport.start(); s.release();
  s.bridge.emit('message', STAKE_CHANNEL, request(venue, 1, 1000));
  s.bridge.emit('message', STAKE_CHANNEL, request(venue, 2, 1000, 'rewardBlock'));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(s.handled.length, 1, 'rewardBlock requesters wait 60 s, so it is still served');
  assert.equal(s.replies.length, 1);
  assert.equal(stakeMessageExpired({ at: 1000, method: 'priceHeadVote' }, 1045), false);
  assert.equal(stakeMessageExpired({ at: 1000, method: 'priceHeadVote' }, 1046), true);
  assert.equal(stakeMessageExpired({ at: 1000, method: 'rewardBlock' }, 1075), false);
  assert.equal(stakeMessageExpired({ at: 1000, method: 'rewardBlock' }, 1076), true);
  s.transport.stop();
});
