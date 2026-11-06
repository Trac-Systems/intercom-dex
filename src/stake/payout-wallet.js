import { createLocksTrac } from '../wallets/locks-trac.js';
import { stableJSON } from '../core/canonical.js';
import { requireResetGateway } from '../market/gateway-status.js';

// The only signing capability is the ordinary pool wallet. Saved signed bytes
// must match its encrypted journal; callers cannot supply a new payment here.
export function createPayoutWallet({ bridge, wallet, profile, store, resetGatewayUrl, trac, request }) {
  const base = createLocksTrac({ bridge, wallet, profile, store, resetGatewayUrl, request });
  const pool = async () => {
    const b = await trac.balances(wallet.address);
    return { confirmed: true, RESET: b.RESET, TNK: b.TNK, feeTnk: b.feeTnk };
  };
  const input = transfer => {
    if (!transfer || typeof transfer.bytes !== 'string' || transfer.bytes.length > 200000) throw new Error('Invalid payout bytes');
    const intent = JSON.parse(transfer.bytes);
    if (intent.asset !== 'RESET' || intent.from !== wallet.address || intent.txHash !== transfer.txHash ||
        intent.amount !== transfer.amount || intent.to !== transfer.to || intent.nonce !== transfer.nonce) throw new Error('Payout bytes differ');
    return { id: transfer.nonce, intent };
  };
  return {
    pool,
    async prepare({ operationId, nonce, to, amount, asset }) {
      if (asset !== 'RESET' || operationId !== nonce) throw new Error('Invalid payout operation');
      await requireResetGateway({ id: 'RESET' }, trac);
      const balance = await pool();
      if (BigInt(balance.TNK) < BigInt(balance.feeTnk)) throw new Error('TNK transfer fee unavailable');
      const name = `stake-payout-fee-${operationId}`, prior = store.get(name);
      // Pin the quote before preparing; restart cannot silently reprice signed bytes.
      const feeTnk = prior?.feeTnk ?? balance.feeTnk;
      if (!prior) store.put(name, { feeTnk });
      const intent = await base.prepare({ id: operationId, asset, to, amount, nonce });
      return { txHash: intent.txHash, bytes: stableJSON(intent), amount, to, nonce, feeTnk };
    },
    async sendPrepared(transfer) {
      await requireResetGateway({ id: 'RESET' }, trac);
      return base.sendPrepared(input(transfer));
    },
    async outcome(transfer) {
      const r = await base.outcome(input(transfer));
      // A read miss is safe to rebroadcast only as the identical durable bytes.
      return { confirmed: r.ok === true && r.finalized === true, txHash: transfer.txHash, amount: transfer.amount, to: transfer.to };
    },
  };
}
