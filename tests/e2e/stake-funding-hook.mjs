import { readFileSync } from 'node:fs';
import { isMainThread } from 'node:worker_threads';
import { StakeCustodySigner } from '../../src/stake/custody-signer.js';
import { StakeClient } from '../../src/stake/client.js';

if (isMainThread) {
  const index = process.argv.indexOf('--config');
  const config = index >= 0 && JSON.parse(readFileSync(process.argv[index + 1], 'utf8'));
  if (!process.env.DEX_E2E_ATTACK_FILE || config?.network !== 'local' || !config.solana?.endpoints?.length ||
      config.solana.endpoints.some(endpoint => !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(endpoint).hostname)))
    throw new Error('Funding interruption is restricted to the local stack');
  const selected = () => JSON.parse(readFileSync(process.env.DEX_E2E_ATTACK_FILE, 'utf8')).stakeFunding;
  const apply = StakeCustodySigner.prototype.apply;
  StakeCustodySigner.prototype.apply = function(method, body, from) {
    if (method === 'fundedVote' && selected() === 'late-full') throw new Error('Local fixture holds admission until after funding window');
    return apply.call(this, method, body, from);
  };
  const fund = StakeClient.prototype.fund;
  StakeClient.prototype.fund = async function(op) {
    const original = this.funding, transfer = original.transfer;
    this.funding = { ...original, transfer: args => selected() === 'late-tnk' && args.asset === 'RESET'
      ? Promise.resolve({ ok: false, pending: true }) : transfer.call(original, args) };
    try { return await fund.call(this, op); } finally { this.funding = original; }
  };
}
