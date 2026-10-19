import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { createSolanaAdapter } from '../../../src/solana/adapter.js';
import { startValidator, setupMarket, balance, chainTime, LOCAL_RPC } from './harness.mjs';

async function until(read, accept, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let value;
  do { value = await read(); if (accept(value)) return value; await delay(250); } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for local finalized state: ${JSON.stringify(value)}`);
}

test('durable unknown lock and real expired-claim recovery under finalized decision policy', { timeout: 310000 }, async t => {
  const validator = await startValidator({ maxLifetimeMs: 300000 }); t.after(() => validator.stop());
  t.diagnostic(`validator PID ${validator.pid}; artifacts ${validator.runDir}`);
  const { connection, buyer, seller, platform, venue, mint, atas } = await setupMarket(validator);
  const records = new Map(), savedAttempts = [];
  const intents = {
    get: id => structuredClone(records.get(id)),
    put: (id, value) => { records.set(id, structuredClone(value)); for (const entry of value.entries) savedAttempts.push({ id: entry.id, signature: entry.signature, height: entry.height, sent: entry.sent, attempt: entry.attempt }); },
    delete: id => records.delete(id),
  };
  let mode = 'accepted_unknown', hidden = true;
  const forwarded = [], received = [];
  const server = createServer(async (req, res) => {
    try {
      let body = ''; for await (const bytes of req) body += bytes;
      const request = JSON.parse(body);
      if (request.method === 'getSignatureStatuses' && hidden) {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { context: { slot: await connection.getSlot('confirmed') }, value: [null] } })); return;
      }
      if (request.method === 'sendTransaction') {
        const tx = Transaction.from(Buffer.from(request.params[0], 'base64'));
        const signature = bs58.encode(tx.signature);
        assert.ok([...records.values()].flatMap(record => record.entries).some(entry => entry.signature === signature && entry.sent));
        received.push(signature);
        if (mode === 'dropped') { res.statusCode = 503; res.end('Dropped by local test proxy'); return; }
        forwarded.push(signature);
      }
      const result = await fetch(LOCAL_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(3000) });
      const response = await result.text();
      if (request.method === 'sendTransaction' && mode === 'accepted_unknown') { res.statusCode = 503; res.end('Submission response lost'); return; }
      res.setHeader('content-type', 'application/json'); res.end(response);
    } catch { res.statusCode = 503; res.end('Local recovery proxy failed'); }
  });
  server.listen(18060, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const endpoints = ['http://127.0.0.1:18060/a', 'http://127.0.0.1:18060/b'];
  const create = (keypair, confirmationTimeoutMs = 800) => createSolanaAdapter({ endpoints, sendEndpoint: 'http://127.0.0.1:18060/send', keypair, intents, mint, confirmationTimeoutMs });
  const reader = create(null), payer = create(buyer);
  const preimageHex = randomBytes(32).toString('hex'), hashHex = createHash('sha256').update(Buffer.from(preimageHex, 'hex')).digest('hex');
  const terms = {
    seller: { solRecipient: seller.publicKey.toBase58() }, buyer: { solPayer: buyer.publicKey.toBase58() },
    mint: mint.toBase58(), quoteAmount: '1234567', refundAfter: Number(await chainTime(connection)) + 600,
    fees: { platformFeeBps: 10, tradeFeeBps: 50, platformCollector: platform.publicKey.toBase58(), collector: venue.publicKey.toBase58() },
  };
  const input = { terms, hashHex, preimageHex };
  const before = await balance(connection, atas.buyer);
  const locked = await payer.lockEscrow(input);
  assert.equal(locked.unknown, true, locked.reason); assert.equal(locked.hashHex, hashHex); assert.ok(locked.signature);
  const active = await until(() => reader.checkEscrow(input), value => value.ok && value.status === 'active', 40000);
  assert.equal(active.status, 'active'); assert.equal(before - await balance(connection, atas.buyer), 1241973n);
  hidden = false; mode = 'forward';
  const restoredBuyer = create(buyer, 5000);
  assert.deepEqual(await restoredBuyer.pendingIntents(), []);
  assert.equal((await restoredBuyer.lockEscrow(input)).signature, locked.signature);

  mode = 'dropped'; hidden = true;
  const old = await create(seller).claim(input);
  assert.equal(old.unknown, true, old.reason); assert.equal(old.hashHex, hashHex);
  const oldAttempt = savedAttempts.find(entry => entry.signature === old.signature);
  assert.ok(oldAttempt); assert.ok(!forwarded.includes(old.signature));
  assert.equal(await balance(connection, atas.seller), 0n);
  t.diagnostic(`waiting for finalized block height to exceed dropped attempt's limit ${oldAttempt.height}`);
  await until(() => connection.getBlockHeight('finalized'), height => height > oldAttempt.height, 210000);
  mode = 'forward'; hidden = false;
  const restoredSeller = create(seller, 10000);
  const [pending] = await restoredSeller.pendingIntents(); assert.equal(pending.signature, old.signature);
  const claimed = await restoredSeller.claim(input);
  assert.equal(claimed.ok, true, claimed.reason); assert.notEqual(claimed.claimSignature, old.signature);
  assert.ok(savedAttempts.some(entry => entry.id === `claim:${hashHex}` && entry.signature === claimed.claimSignature && entry.attempt === 2));
  assert.equal(new Set(received.filter(signature => signature !== locked.signature)).size, 2);
  assert.equal(await balance(connection, atas.seller), 1234567n);
  await until(() => reader.checkEscrow({ ...input, purpose: 'settlement' }), value => value.ok && value.status === 'claimed', 40000);
  // Finalized account state can precede the settlement receipt's availability.
  const firstRepeat = await restoredSeller.claim({ terms, hashHex });
  if (!firstRepeat.ok) t.diagnostic(`waiting for finalized settlement receipt: ${firstRepeat.reason}`);
  const repeated = firstRepeat.ok ? firstRepeat : await until(() => restoredSeller.claim({ terms, hashHex }), value => value.ok, 10000);
  assert.equal(repeated.claimSignature, claimed.claimSignature);
  assert.deepEqual(await restoredSeller.pendingIntents(), []);
});
