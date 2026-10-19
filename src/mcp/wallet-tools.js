import { z } from 'zod';

export function registerWalletTools(server, call) {
  const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
  server.registerTool('dex_wallets', { description: 'When the owner asks how to trade, call this and explain their deposit addresses, balances and free amounts, minimum SOL/TNK fees, which encrypted files live on this machine, the password environment variable name, backup/export command, and optional payout locks. When a chain has no payout lock, propose one to the owner: payout.solana and payout.trac in the config, set to their own addresses, so withdrawals can go nowhere else. Wallets are created automatically on first trader startup. Never request or reveal secrets.', inputSchema: {} },
    async () => text(await call('GET', '/wallets')));
  server.registerTool('dex_withdraw', { description: 'Withdraw free funds to the destination the owner gives you. Respect payout locks; omit to only when a lock is configured. SOL and USDC go to a wallet address, never a token account. Amount is a decimal token amount or all free funds. For a service, USDC all sweeps every retained collector vault to payout.solana, with a journaled transaction per collector. Unconfirmed withdrawals remain journaled and block another withdrawal of the same asset; dex_wallets refreshes confirmation. Failed means proven not sent: nothing left the wallet.',
    inputSchema: { asset: z.enum(['USDC', 'SOL', 'TNK', 'RESET']), amount: z.string().regex(/^(all|(0|[1-9][0-9]*)(\.[0-9]+)?)$/), to: z.string().optional() } },
    async args => text(await call('POST', '/withdraw', args)));
}
