import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SystemProgram, PublicKey } from '@solana/web3.js';
import { startValidator, send } from './harness.mjs';

test('validator death aborts pending confirmation and shutdown remains bounded/idempotent', { timeout: 60000 }, async t => {
  const validator = await startValidator(); t.after(() => validator.stop());
  t.diagnostic(`forced termination of owned validator PID ${validator.pid}; artifacts ${validator.runDir}`);
  const original = validator.connection;
  const connection = {
    getLatestBlockhash: original.getLatestBlockhash.bind(original),
    getSignatureStatuses: original.getSignatureStatuses.bind(original),
    getBlockHeight: original.getBlockHeight.bind(original),
    sendRawTransaction: async (...args) => {
      const signature = await original.sendRawTransaction(...args);
      process.kill(validator.pid, 'SIGKILL');
      return signature;
    },
  };
  const started = Date.now();
  await assert.rejects(send(connection, validator.buyer, [SystemProgram.transfer({
    fromPubkey: validator.buyer.publicKey, toPubkey: new PublicKey(Buffer.alloc(32, 9)), lamports: 1000000,
  })]));
  await validator.stop(); await validator.stop();
  assert.ok(Date.now() - started < 8000, 'dead validator must not leave polling or stop hanging');
  assert.throws(() => process.kill(validator.pid, 0), { code: 'ESRCH' });
  assert.match(await readFile(`${validator.runDir}/process.log`, 'utf8'), /signal=SIGKILL/);
});
