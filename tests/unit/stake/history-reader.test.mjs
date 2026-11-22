import test from 'node:test';
import assert from 'node:assert/strict';
import { stakeHistoryReader } from '../../../src/stake/history-reader.js';
import { stakeEscrowHistory } from '../../../src/solana/stake-history.js';

const hex = n => n.toString(16).padStart(64, '0');

test('stake history uses the two-reader stake endpoints, not a single trade reader', async () => {
  // 11-22: signers had one own trade reader (need 1) since 11-10; the history reader needs two, so no delivered or
  // unfunded reservation closed for twelve days.
  const calls = [];
  const solana = { stakeEscrowHistory: async args => { calls.push(args); return { status: 'complete', locks: [] }; } };
  const read = stakeHistoryReader({ solana, rpc: { endpoints: ['https://a.example', 'https://b.example', 'https://c.example'], need: 2 } });
  assert.equal((await read({ hashHex: hex(1), fromSlot: 1, throughSlot: 2 })).status, 'complete');
  assert.deepEqual(calls[0].endpoints, ['https://a.example', 'https://b.example', 'https://c.example']);
  assert.equal(calls[0].need, 2);
  assert.equal(calls[0].hashHex, hex(1));
  // Complete reads are never held back.
  await read({ hashHex: hex(1), fromSlot: 1, throughSlot: 3 });
  assert.equal(calls.length, 2);
});

test('an unreadable escrow waits before the next read; other escrows are not held back', async () => {
  let at = 1000, answer = { status: 'unknown', historyComplete: false, reason: 'history_unavailable' };
  const calls = [];
  const solana = { stakeEscrowHistory: async args => { calls.push(args.hashHex); if (answer instanceof Error) throw answer; return answer; } };
  const read = stakeHistoryReader({ solana, rpc: { endpoints: ['https://a.example', 'https://b.example'], need: 2 }, retryMs: 300000, now: () => at });
  assert.equal((await read({ hashHex: hex(1) })).status, 'unknown');
  assert.equal((await read({ hashHex: hex(1) })).reason, 'history_retry_wait');
  assert.deepEqual(calls, [hex(1)]);
  answer = new Error('Two distinct history readers required');
  assert.match((await read({ hashHex: hex(2) })).reason, /Two distinct/);
  assert.deepEqual(calls, [hex(1), hex(2)]);
  at += 300001; answer = { status: 'complete', locks: [] };
  assert.equal((await read({ hashHex: hex(1) })).status, 'complete');
  assert.equal((await read({ hashHex: hex(1) })).status, 'complete');
  assert.deepEqual(calls, [hex(1), hex(2), hex(1), hex(1)]);
});

test('one trusted reader still cannot adjudicate history', async () => {
  // Fail closed as before when no two-reader quorum is configured anywhere.
  await assert.rejects(stakeEscrowHistory({ terms: {}, hashHex: hex(1), fromSlot: 1, throughSlot: 2, endpoints: ['https://a.example'], need: 1 }),
    /Two distinct history readers required/);
  const solana = { stakeEscrowHistory: args => stakeEscrowHistory({ terms: {}, ...args }) };
  const read = stakeHistoryReader({ solana, rpc: { endpoints: ['https://a.example'], need: 1 } });
  const result = await read({ hashHex: hex(1), fromSlot: 1, throughSlot: 2 });
  assert.equal(result.status, 'unknown'); assert.match(result.reason, /Two distinct history readers required/);
});
