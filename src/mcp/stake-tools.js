import { z } from 'zod';
import { stakeRequestSchema, rewardsRequestSchema } from '../stake/status.js';

const text = value => ({ ...(value?.ok === false ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
export function registerStakeTools(server, call) {
  server.registerTool('dex_stake', {
    description: 'RESET stake: deposit requires a positive decimal amount with at most 8 places; withdraw accepts an amount or all (default); status takes no amount. A deposit needs TNK fees and a certified price. Withdrawals wait the venue-signed delay and cannot preempt reserved trades. Read the returned movement and pending state before retrying. Setup may be unavailable; never send funds manually.',
    inputSchema: z.object({ action: z.enum(['deposit', 'withdraw', 'status']), amount: z.string().optional() }).strict(),
  }, async input => {
    const args = stakeRequestSchema.parse(input);
    return text(await call(args.action === 'status' ? 'GET' : 'POST', args.action === 'status' ? '/stake' : `/stake/${args.action}`,
      args.action === 'status' ? undefined : { ...(args.amount !== undefined ? { amount: args.amount } : {}) }));
  });
  server.registerTool('dex_rewards', {
    description: 'Stake rewards status: unpaid and paid RESET, weight, estimated daily rate, and pool status. An empty pool pauses accrual without debt; no payout is implied by a status read.',
    inputSchema: z.object({ action: z.literal('status') }).strict(),
  }, async input => { rewardsRequestSchema.parse(input); return text(await call('GET', '/rewards')); });
}
