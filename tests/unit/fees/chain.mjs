import assert from 'node:assert/strict';
import { Keypair, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { createSolanaAdapter } from '../../../src/solana/adapter.js';
import { PROGRAM_ID } from '../../../src/solana/constants.js';
import { deriveConfigPda, deriveTradeConfigPda, deriveVaultAta, deriveEscrowPda, calculateFees } from '../../../src/solana/escrow.js';

// In-memory RPC boundary; actual builders, signatures, journal, finality reads and adapters run unchanged.
export function chainFixture(t) {
  const main = Keypair.generate(), platform = Keypair.generate(), buyer = Keypair.generate(), seller = Keypair.generate(), mint = Keypair.generate().publicKey;
  const accounts = new Map(), receipts = new Map(), records = new Map();
  const chain = { sends: [], reads: [], final: true, drop: false, generation: 1, height: 10, configs: 0 };
  const intents = { get: id => structuredClone(records.get(id)), put: (id, value) => records.set(id, structuredClone(value)), delete: id => records.delete(id) };
  const wire = (data, owner = PROGRAM_ID, lamports = 2000000) => ({ data: [data.toString('base64'), 'base64'], owner: owner.toBase58(), executable: false, lamports });
  const dataAt = address => Buffer.from(accounts.get(String(address)).data[0], 'base64');
  const config = (collector, bps, trade = true) => {
    const { pda, bump } = trade ? deriveTradeConfigPda(collector) : deriveConfigPda();
    const b = Buffer.alloc(68); b[0] = 1; collector.toBuffer().copy(b, 1); collector.toBuffer().copy(b, 33); b.writeUInt16LE(bps, 65); b[67] = bump;
    accounts.set(pda.toBase58(), wire(b));
  };
  const token = (owner, amount, tokenMint = mint) => {
    const b = Buffer.alloc(165); tokenMint.toBuffer().copy(b); owner.toBuffer().copy(b, 32); b.writeBigUInt64LE(BigInt(amount), 64); b[108] = 1;
    accounts.set(deriveVaultAta(owner, tokenMint).toBase58(), wire(b, TOKEN_PROGRAM_ID));
  };
  const balance = address => accounts.has(String(address)) ? dataAt(address).readBigUInt64LE(64) : 0n;
  const move = (from, to, amount) => {
    const a = dataAt(from), b = dataAt(to); assert.ok(a.readBigUInt64LE(64) >= amount, 'funds cover transfer');
    a.writeBigUInt64LE(a.readBigUInt64LE(64) - amount, 64); b.writeBigUInt64LE(b.readBigUInt64LE(64) + amount, 64);
    accounts.set(String(from), wire(a, TOKEN_PROGRAM_ID)); accounts.set(String(to), wire(b, TOKEN_PROGRAM_ID));
  };
  const configBalance = collector => balance(deriveVaultAta(deriveTradeConfigPda(collector).pda, mint));
  config(main.publicKey, 50); config(platform.publicKey, 10, false);
  const mintData = Buffer.alloc(82); mintData[44] = 6; mintData[45] = 1; accounts.set(mint.toBase58(), wire(mintData, TOKEN_PROGRAM_ID));
  token(main.publicKey, 3000000n); token(buyer.publicKey, 100000000n); token(seller.publicKey, 0n);
  for (const k of [main, buyer, seller, platform]) accounts.set(k.publicKey.toBase58(), wire(Buffer.alloc(0), SystemProgram.programId, 100000000));
  const execute = tx => {
    assert.ok(tx.verifySignatures());
    for (const ix of tx.instructions) {
      const keys = ix.keys.map(k => k.pubkey), b = ix.data;
      if (ix.programId.equals(SystemProgram.programId)) continue;
      if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) { if (!accounts.has(keys[1].toBase58())) token(keys[2], 0n, keys[3]); continue; }
      if (ix.programId.equals(TOKEN_PROGRAM_ID)) { assert.equal(b[0], 12); move(keys[0], keys[2], b.readBigUInt64LE(1)); continue; }
      assert.ok(ix.programId.equals(PROGRAM_ID));
      if (b[0] === 6) {
        const collector = new PublicKey(b.subarray(1, 33)); assert.ok(keys[0].equals(collector));
        assert.ok(tx.signatures.some(s => s.publicKey.equals(collector) && s.signature));
        assert.ok(!accounts.has(keys[1].toBase58()), 'new config created exactly once');
        config(collector, b.readUInt16LE(33)); chain.configs++; continue;
      }
      if (b[0] === 4) {
        assert.ok(keys[0].equals(platform.publicKey)); config(platform.publicKey, b.readUInt16LE(33), false); continue;
      }
      if (b[0] === 8 || b[0] === 5) {
        if (b[0] === 5) assert.ok(keys[0].equals(platform.publicKey));
        assert.ok(new PublicKey(dataAt(keys[3]).subarray(32, 64)).equals(keys[0]), 'program requires collector-owned destination');
        move(keys[2], keys[3], b.readBigUInt64LE(1)); continue;
      }
      if (b[0] === 0) {
        const hash = b.subarray(1, 33).toString('hex'), escrow = deriveEscrowPda(hash), collector = new PublicKey(b.subarray(117, 149));
        const p = dataAt(deriveConfigPda().pda), c = dataAt(deriveTradeConfigPda(collector).pda);
        assert.equal(p.readUInt16LE(65), b.readUInt16LE(113)); assert.equal(c.readUInt16LE(65), b.readUInt16LE(115));
        const fees = calculateFees(b.readBigUInt64LE(105), b.readUInt16LE(113), b.readUInt16LE(115));
        const state = Buffer.alloc(263); state[0] = 3; b.subarray(1, 97).copy(state, 2); b.subarray(97, 105).copy(state, 98); mint.toBuffer().copy(state, 106);
        state.writeBigUInt64LE(fees.netAmount, 138); state.writeBigUInt64LE(fees.platformFeeAmount, 146); state.writeUInt16LE(b.readUInt16LE(113), 154);
        platform.publicKey.toBuffer().copy(state, 156); state.writeBigUInt64LE(fees.tradeFeeAmount, 188); state.writeUInt16LE(b.readUInt16LE(115), 196);
        collector.toBuffer().copy(state, 198); keys[3].toBuffer().copy(state, 230); state[262] = escrow.bump;
        accounts.set(keys[2].toBase58(), wire(state)); token(escrow.pda, 0n);
        for (const owner of [deriveConfigPda().pda, deriveTradeConfigPda(collector).pda]) if (!accounts.has(deriveVaultAta(owner, mint).toBase58())) token(owner, 0n);
        move(keys[1], keys[3], fees.totalAmount); continue;
      }
      if (b[0] === 1) {
        const state = dataAt(keys[1]);
        move(keys[2], keys[3], state.readBigUInt64LE(138)); move(keys[2], keys[4], state.readBigUInt64LE(146)); move(keys[2], keys[5], state.readBigUInt64LE(188));
        state[1] = 1; for (const offset of [138, 146, 188]) state.writeBigUInt64LE(0n, offset);
        accounts.set(keys[1].toBase58(), wire(state)); continue;
      }
      assert.fail('Unhandled instruction ' + b[0]);
    }
  };
  const reply = result => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  t.mock.method(globalThis, 'fetch', async (_url, req) => {
    const { method, params } = JSON.parse(req.body); chain.reads.push({ method, params });
    if (method === 'getAccountInfo') return reply({ context: { slot: 100 }, value: (!chain.final && params[1].commitment === 'finalized' && chain.unfinalAccounts ? chain.unfinalAccounts : accounts).get(params[0]) ?? null });
    if (method === 'getMinimumBalanceForRentExemption') return reply(1365120);
    if (method === 'getLatestBlockhash') return reply({ value: { blockhash: new PublicKey(Buffer.alloc(32, chain.generation)).toBase58(), lastValidBlockHeight: 200 } });
    if (method === 'getBlockHeight') return reply(chain.height);
    if (method === 'getSlot') return reply(100);
    if (method === 'getSignatureStatuses') return reply({ value: [receipts.has(params[0][0]) ? { slot: 100, err: null, confirmationStatus: chain.final ? 'finalized' : 'confirmed' } : null] });
    if (method === 'getSignaturesForAddress') return reply([...receipts].filter(([, r]) => r.tx.instructions.some(ix => ix.keys.some(k => k.pubkey.toBase58() === params[0]))).map(([signature]) => ({ signature, slot: 100, err: null })));
    if (method === 'getTransaction') return reply(receipts.has(params[0]) ? { slot: 100, meta: { err: null, ...receipts.get(params[0]).meta }, transaction: [receipts.get(params[0]).wire, 'base64'] } : null);
    if (method === 'sendTransaction') {
      const tx = Transaction.from(Buffer.from(params[0], 'base64')), signature = bs58.encode(tx.signature);
      assert.ok([...records.values()].some(r => r.entries.some(e => e.wire === params[0] && e.sent)), 'durable before send');
      chain.sends.push({ tx, wire: params[0], signature });
      if (!receipts.has(signature)) {
        if (!chain.final) chain.unfinalAccounts ??= structuredClone(accounts);
        const balances = () => tx.compileMessage().accountKeys.flatMap((key, accountIndex) => {
          const a = accounts.get(key.toBase58()); if (!a || a.owner !== TOKEN_PROGRAM_ID.toBase58()) return [];
          const data = dataAt(key); if (data.length !== 165) return [];
          const tokenMint = new PublicKey(data.subarray(0, 32));
          return [{ accountIndex, mint: tokenMint.toBase58(), uiTokenAmount: { amount: data.readBigUInt64LE(64).toString(), decimals: dataAt(tokenMint)[44] } }];
        });
        const preTokenBalances = balances();
        execute(tx); receipts.set(signature, { tx, wire: params[0], meta: { preTokenBalances, postTokenBalances: balances() } });
      }
      if (chain.drop) throw Error('lost response');
      return reply(signature);
    }
    assert.fail(method);
  });
  const adapter = (keypair = main, extra = {}) => createSolanaAdapter({ endpoints: ['http://127.0.0.1:12345'], sendEndpoint: 'http://127.0.0.1:12345', need: 1,
    keypair, intents, mint, commitment: 'finalized', confirmationTimeoutMs: 400, ...extra });
  return { main, platform, buyer, seller, mint, chain, accounts, config, token, balance, configBalance, adapter, records, intents, receipts };
}
