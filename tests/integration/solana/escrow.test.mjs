import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import * as e from '../../../src/solana/escrow.js';
import { checkEscrow } from '../../../src/solana/check.js';
import { readAccountQuorum, QuorumError } from '../../../src/solana/quorum.js';
import { startValidator, setupMarket, send, balance, chainTime, LOCAL_RPC } from './harness.mjs';

const proxyUrl = path => `http://127.0.0.1:18060/${path}`;
const endpoints = [LOCAL_RPC, proxyUrl('honest'), proxyUrl('lie1')];
const rejection = code => error => {
  assert.match(error.message, new RegExp(`custom program error: 0x${code.toString(16)}(?:\\b|$)`));
  return true;
};

test('vendored escrow on an isolated local validator', { timeout: 150000 }, async t => {
  const validator = await startValidator();
  t.after(() => validator.stop());
  t.diagnostic(`validator PID ${validator.pid}; artifacts ${validator.runDir}`);
  const market = await setupMarket(validator);
  const { connection, buyer, seller, platform, venue, stranger, mint, atas } = market;
  const bytes = randomBytes(32);
  const paymentHashHex = createHash('sha256').update(bytes).digest('hex');
  const refundAfter = await chainTime(connection) + 300n;
  const args = {
    payer: buyer.publicKey, payerTokenAccount: atas.buyer, recipient: seller.publicKey,
    refund: buyer.publicKey, refundAfter, amount: 1234567n, mint, paymentHashHex,
    expectedPlatformFeeBps: 10, expectedTradeFeeBps: 50, tradeFeeCollector: venue.publicKey,
  };
  const a = e.escrowAddresses(args);
  const terms = {
    seller: { solRecipient: seller.publicKey.toBase58() }, buyer: { solPayer: buyer.publicKey.toBase58() },
    mint: mint.toBase58(), quoteAmount: '1234567', refundAfter: refundAfter.toString(),
    fees: { platformFeeBps: 10, tradeFeeBps: 50, platformCollector: platform.publicKey.toBase58(), collector: venue.publicKey.toBase58() },
  };
  let mutate = null;
  const proxy = createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      assert.equal(request.method, 'getAccountInfo');
      const response = await fetch(LOCAL_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(2000) });
      const value = await response.json();
      if (mutate) mutate(value, request.params[0]);
      else if (req.url.startsWith('/lie') && value.result?.value) {
        const data = Buffer.from(value.result.value.data[0], 'base64');
        data[0] ^= req.url === '/lie1' ? 1 : 2;
        value.result.value.data[0] = data.toString('base64');
      }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value));
    } catch { res.statusCode = 503; res.end('Local test proxy error'); }
  });
  proxy.listen(18060, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(async () => { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); });

  await t.test('configuration updates, failure inputs and immutable collector identity', async () => {
    assert.equal(e.decodeConfigState((await connection.getAccountInfo(a.configPda)).data).feeBps, 10);
    assert.equal(e.decodeTradeConfigState((await connection.getAccountInfo(a.tradeConfigPda)).data).feeBps, 50);
    await assert.rejects(send(connection, venue, [e.buildInitTradeConfigInstruction({ payer: venue.publicKey, feeCollector: venue.publicKey, feeBps: 50 })]), rejection(12));
    await assert.rejects(send(connection, platform, [e.buildInitConfigInstruction({ payer: platform.publicKey, feeCollector: platform.publicKey, feeBps: 10 })]), rejection(12));
    await assert.rejects(send(connection, stranger, [e.buildSetTradeConfigInstruction({ authority: stranger.publicKey, feeCollector: venue.publicKey, feeBps: 50 })]), rejection(5));
    await assert.rejects(send(connection, stranger, [e.buildSetConfigInstruction({ authority: stranger.publicKey, feeCollector: platform.publicKey, feeBps: 10 })]), rejection(5));
    await send(connection, venue, [e.buildSetTradeConfigInstruction({ authority: venue.publicKey, feeCollector: venue.publicKey, feeBps: 51 })]);
    await assert.rejects(send(connection, buyer, [e.buildInitInstruction(args)]), rejection(17));
    await send(connection, venue, [e.buildSetTradeConfigInstruction({ authority: venue.publicKey, feeCollector: venue.publicKey, feeBps: 50 })]);
    await send(connection, platform, [e.buildSetConfigInstruction({ authority: platform.publicKey, feeCollector: platform.publicKey, feeBps: 11 })]);
    await assert.rejects(send(connection, buyer, [e.buildInitInstruction(args)]), rejection(17));
    await send(connection, platform, [e.buildSetConfigInstruction({ authority: platform.publicKey, feeCollector: platform.publicKey, feeBps: 10 })]);
  });

  await t.test('lock deposits net plus individually rounded fees', async () => {
    const before = await balance(connection, atas.buyer);
    await send(connection, buyer, [e.buildInitInstruction(args)]);
    assert.equal(before - await balance(connection, atas.buyer), 1241973n);
    assert.equal(await balance(connection, a.vault), 1241973n);
    assert.equal(await balance(connection, a.platformFeeVault), 0n);
    assert.equal(await balance(connection, a.tradeFeeVault), 0n);
    const state = e.decodeEscrowState((await connection.getAccountInfo(a.escrowPda)).data);
    assert.equal(state.netAmount, 1234567n); assert.equal(state.platformFeeAmount, 1234n); assert.equal(state.tradeFeeAmount, 6172n);
    await assert.rejects(send(connection, buyer, [e.buildInitInstruction(args)]), rejection(12));
  });

  await t.test('quorum tolerates one liar and rejects two conflicting lies', async () => {
    const q = await readAccountQuorum(a.escrowPda, { endpoints });
    assert.ok(q.value.data.equals((await connection.getAccountInfo(a.escrowPda)).data));
    assert.equal(q.agreeing.length, 2); assert.equal(q.reports[2].status, 'disagreed');
    await assert.rejects(readAccountQuorum(a.escrowPda, { endpoints: [LOCAL_RPC, proxyUrl('lie1'), proxyUrl('lie2')] }), QuorumError);
    const verdict = await checkEscrow({ terms, hashHex: paymentHashHex, endpoints });
    assert.equal(verdict.ok, true, JSON.stringify(verdict.reasons));
  });

  await t.test('seller checker rejects every reason using real account snapshots altered by local proxies', async () => {
    const proxyEndpoints = ['a', 'b', 'c'].map(proxyUrl);
    const isEscrow = address => address === a.escrowPda.toBase58();
    const dataChange = (escrow, change) => (response, address) => {
      if (isEscrow(address) !== escrow || !response.result?.value) return;
      const data = Buffer.from(response.result.value.data[0], 'base64'); change(data);
      response.result.value.data[0] = data.toString('base64');
    };
    const cases = [
      ['STATUS', true, b => { b[1] = 1; }], ['HASH', true, b => { b[2] ^= 1; }], ['BUMP', true, b => { b[262] ^= 1; }],
      ['RECIPIENT', true, b => { b[34] ^= 1; }], ['REFUND_AUTHORITY', true, b => { b[66] ^= 1; }], ['MINT', true, b => { b[106] ^= 1; }],
      ['NET_AMOUNT', true, b => b.writeBigUInt64LE(1n, 138)], ['REFUND_AFTER', true, b => b.writeBigInt64LE(1n, 98)],
      ['PLATFORM_FEE_BPS', true, b => b.writeUInt16LE(9, 154)], ['TRADE_FEE_BPS', true, b => b.writeUInt16LE(49, 196)],
      ['PLATFORM_COLLECTOR', true, b => { b[156] ^= 1; }], ['TRADE_COLLECTOR', true, b => { b[198] ^= 1; }],
      ['FEE_AMOUNTS', true, b => b.writeBigUInt64LE(1n, 146)], ['VAULT_ADDRESS', true, b => { b[230] ^= 1; }],
      ['ESCROW_DATA', true, b => { b[0] = 1; }], ['VAULT_MINT', false, b => { b[0] ^= 1; }],
      ['VAULT_AUTHORITY', false, b => { b[32] ^= 1; }], ['VAULT_STATE', false, b => { b[108] = 2; }],
      ['VAULT_CONTROL', false, b => { b.writeUInt32LE(1, 72); seller.publicKey.toBuffer().copy(b, 76); }],
      ['VAULT_BALANCE', false, b => b.writeBigUInt64LE(1234567n, 64)],
    ];
    for (const [code, escrow, change] of cases) {
      mutate = dataChange(escrow, change);
      const verdict = await checkEscrow({ terms, hashHex: paymentHashHex, endpoints: proxyEndpoints });
      assert.equal(verdict.ok, false, code); assert.ok(verdict.reasons.some(r => r.code === code), code);
    }
    for (const [code, escrow, action] of [
      ['ESCROW_MISSING', true, r => { r.result.value = null; }], ['VAULT_MISSING', false, r => { r.result.value = null; }],
      ['ESCROW_OWNER', true, r => { r.result.value.owner = TOKEN_PROGRAM_ID.toBase58(); }],
      ['VAULT_OWNER', false, r => { r.result.value.owner = a.escrowPda.toBase58(); }],
      ['VAULT_DATA', false, r => { r.result.value.data = ['AA==', 'base64']; }],
      ['ESCROW_QUORUM', true, r => { delete r.result; r.error = { code: -32000, message: 'offline' }; }],
      ['VAULT_QUORUM', false, r => { delete r.result; r.error = { code: -32000, message: 'offline' }; }],
    ]) {
      mutate = (response, address) => { if (isEscrow(address) === escrow) action(response); };
      const verdict = await checkEscrow({ terms, hashHex: paymentHashHex, endpoints: proxyEndpoints });
      assert.equal(verdict.ok, false, code); assert.equal(verdict.reasons[0].code, code);
    }
    assert.equal((await checkEscrow({ terms: {}, hashHex: paymentHashHex, endpoints: proxyEndpoints })).reasons[0].code, 'INVALID_TERMS');
    mutate = null;
  });

  const claim = { ...args, preimageHex: bytes.toString('hex'), recipientTokenAccount: atas.seller };
  await t.test('wrong preimage, non-recipient and early refund are rejected', async () => {
    await assert.rejects(send(connection, seller, [e.buildClaimInstruction({ ...claim, preimageHex: '00'.repeat(32) })]), rejection(6));
    await assert.rejects(send(connection, stranger, [e.buildClaimInstruction({ ...claim, recipient: stranger.publicKey, recipientTokenAccount: atas.stranger })]), rejection(5));
    await assert.rejects(send(connection, buyer, [e.buildRefundInstruction({ ...args, refundTokenAccount: atas.buyer })]), rejection(8));
  });

  await t.test('right preimage claims exact net and both fees; double claim fails', async () => {
    await send(connection, seller, [e.buildClaimInstruction(claim)]);
    assert.equal(await balance(connection, atas.seller), 1234567n);
    assert.equal(await balance(connection, a.vault), 0n);
    assert.equal(await balance(connection, a.platformFeeVault), 1234n);
    assert.equal(await balance(connection, a.tradeFeeVault), 6172n);
    const state = e.decodeEscrowState((await connection.getAccountInfo(a.escrowPda)).data);
    assert.equal(state.status, 1); assert.equal(state.netAmount + state.platformFeeAmount + state.tradeFeeAmount, 0n);
    await assert.rejects(send(connection, seller, [e.buildClaimInstruction(claim)]), rejection(7));
    await assert.rejects(send(connection, buyer, [e.buildRefundInstruction({ ...args, refundTokenAccount: atas.buyer })]), rejection(7));
  });

  await t.test('fee withdrawals require the collector and support partial/all balances', async () => {
    const tradeWithdraw = { feeCollector: venue.publicKey, destination: atas.venue, mint, amount: 1n };
    const bad = e.buildWithdrawTradeFeesInstruction(tradeWithdraw); bad.keys[0].pubkey = stranger.publicKey;
    await assert.rejects(send(connection, stranger, [bad]), rejection(14));
    const badPlatform = e.buildWithdrawFeesInstruction({ feeCollector: platform.publicKey, destination: atas.platform, mint }); badPlatform.keys[0].pubkey = stranger.publicKey;
    await assert.rejects(send(connection, stranger, [badPlatform]), rejection(5));
    await assert.rejects(send(connection, venue, [e.buildWithdrawTradeFeesInstruction({ ...tradeWithdraw, amount: 6173n })]), rejection(1));
    await send(connection, venue, [e.buildWithdrawTradeFeesInstruction(tradeWithdraw)]);
    assert.equal(await balance(connection, atas.venue), 1n);
    await send(connection, venue, [e.buildWithdrawTradeFeesInstruction({ ...tradeWithdraw, amount: 0n })]);
    assert.equal(await balance(connection, atas.venue), 6172n); assert.equal(await balance(connection, a.tradeFeeVault), 0n);
    await send(connection, platform, [e.buildWithdrawFeesInstruction({ feeCollector: platform.publicKey, destination: atas.platform, mint })]);
    assert.equal(await balance(connection, atas.platform), 1234n); assert.equal(await balance(connection, a.platformFeeVault), 0n);
  });

  await t.test('refund at deadline returns net and fees; claim after refund fails', async () => {
    const preimage = randomBytes(32);
    const hash = createHash('sha256').update(preimage).digest('hex');
    const short = { ...args, paymentHashHex: hash, refundAfter: await chainTime(connection) + 5n };
    const b = e.escrowAddresses(short);
    const before = await balance(connection, atas.buyer);
    await send(connection, buyer, [e.buildInitInstruction(short)]);
    await assert.rejects(send(connection, buyer, [e.buildRefundInstruction({ ...short, refundTokenAccount: atas.buyer })]), rejection(8));
    const deadline = Date.now() + 15000;
    while (await chainTime(connection) < short.refundAfter) { assert.ok(Date.now() < deadline, 'local clock advanced'); await delay(250); }
    await send(connection, buyer, [e.buildRefundInstruction({ ...short, refundTokenAccount: atas.buyer })]);
    assert.equal(await balance(connection, atas.buyer), before); assert.equal(await balance(connection, b.vault), 0n);
    assert.equal(await balance(connection, b.platformFeeVault), 0n); assert.equal(await balance(connection, b.tradeFeeVault), 0n);
    assert.equal(e.decodeEscrowState((await connection.getAccountInfo(b.escrowPda)).data).status, 2);
    await assert.rejects(send(connection, seller, [e.buildClaimInstruction({ ...short, preimageHex: preimage.toString('hex'), recipientTokenAccount: atas.seller })]), rejection(7));
    await assert.rejects(send(connection, buyer, [e.buildRefundInstruction({ ...short, refundTokenAccount: atas.buyer })]), rejection(7));
  });
});
