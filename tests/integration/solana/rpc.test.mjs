import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { rpcCall, RpcError } from '../../../src/solana/rpc.js';
import { readAccountQuorum, QuorumError } from '../../../src/solana/quorum.js';
import { checkEscrow } from '../../../src/solana/check.js';
import { addresses, hashHex, terms, wireAccount, wireVault } from '../../unit/solana/vectors.mjs';

const url = path => `http://127.0.0.1:18060/${path}`;

test('real loopback HTTP: timeouts, malformed responses, quorum and seller verdict', async t => {
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const request = JSON.parse(text);
    if (req.url === '/timeout') return;
    if (req.url === '/badjson') { res.end('{'); return; }
    if (req.url === '/unavailable') { res.statusCode = 503; res.end('offline'); return; }
    assert.equal(request.method, 'getAccountInfo');
    assert.equal(request.params[1].commitment, 'confirmed');
    const escrow = request.params[0] === addresses.escrowPda.toBase58();
    const value = escrow ? wireAccount() : wireVault();
    if (req.url === '/lie1' || req.url === '/lie2') {
      const data = Buffer.from(value.data[0], 'base64');
      data[0] ^= req.url === '/lie1' ? 1 : 2; value.data[0] = data.toString('base64');
    }
    const slot = req.url === '/stale' ? 10 : 100;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { context: { slot }, value } }));
  });
  server.listen(18060, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const endpoints = ['honest1', 'honest2', 'lie1'].map(url);
  const q = await readAccountQuorum(addresses.escrowPda, { endpoints });
  assert.equal(q.agreeing.length, 2); assert.equal(q.reports[2].status, 'disagreed');
  assert.equal((await checkEscrow({ terms, hashHex, endpoints })).ok, true);
  const lies = ['honest1', 'lie1', 'lie2'].map(url);
  await assert.rejects(readAccountQuorum(addresses.escrowPda, { endpoints: lies }), QuorumError);
  assert.equal((await checkEscrow({ terms, hashHex, endpoints: lies })).reasons[0].code, 'ESCROW_QUORUM');
  await assert.rejects(readAccountQuorum(addresses.escrowPda, { endpoints: ['honest1', 'stale', 'lie1'].map(url) }), e => e.reports.some(r => r.status === 'stale'));
  const partial = await readAccountQuorum(addresses.escrowPda, { endpoints: ['honest1', 'honest2', 'timeout'].map(url), timeoutMs: 100 });
  assert.equal(partial.agreeing.length, 2); assert.equal(partial.reports[2].kind, 'timeout');
  for (const [path, kind] of [['timeout', 'timeout'], ['badjson', 'protocol'], ['unavailable', 'http']]) {
    await assert.rejects(rpcCall(url(path), 'getAccountInfo', [], { timeoutMs: 50 }), e => e instanceof RpcError && e.kind === kind);
  }
});
