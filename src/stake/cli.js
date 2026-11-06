import { stakeRequestSchema } from './status.js';

export const STAKE_HELP = `dex stake deposit <amount> --config <absolute trader.json>
dex stake withdraw [amount|all] --config <absolute trader.json>
dex stake status --config <absolute trader.json>
dex rewards status --config <absolute trader.json>
Amounts are decimal RESET (8 places). Deposits need TNK fees; withdrawals wait the venue-signed delay.
Status includes stake, rewards and pending movement. Never repeat an uncertain deposit or manually resend a trade payment.`;

export function parseStakeCommand(positionals) {
  if (!Array.isArray(positionals) || positionals.some(x => typeof x !== 'string')) throw new Error('Invalid command');
  const [group, action, amount] = positionals;
  if (group === 'rewards') {
    if (positionals.length !== 2 || action !== 'status') throw new Error('Expected rewards status');
    return { method: 'GET', route: '/rewards' };
  }
  if (group !== 'stake' || positionals.length < 2 || positionals.length > 3) throw new Error('Expected stake deposit, withdraw or status');
  const args = stakeRequestSchema.parse({ action, ...(amount === undefined ? {} : { amount }) });
  return { method: action === 'status' ? 'GET' : 'POST', route: action === 'status' ? '/stake' : `/stake/${action}`,
    ...(action === 'status' ? {} : { body: { ...(args.amount === undefined ? {} : { amount: args.amount }) } }) };
}
