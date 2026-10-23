import { z } from 'zod';
import { hex32, height, units, assetSchema, termsSchemas, errorResult } from '../locks/position.js';
import { validateSettings } from '../locks/client.js';

const product = z.enum(['loan', 'call', 'put']);
const settings = z.object({ autoRepay: z.boolean().optional(), repayBlocksBefore: height.optional(), autoExercise: z.boolean().optional(),
  exerciseBlocksBefore: height.optional(), exerciseMarginBps: height.optional(), autoSweep: z.literal(true).optional() }).strict();
const text = value => ({ ...(value?.ok === false ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const search = input => new URLSearchParams(Object.entries(input).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();

export function registerLocksTools(server, call) {
  const act = (action, input) => call('POST', '/api/locks/act', { action, input });
  const safe = fn => async input => { try { return text(await fn(input ?? {})); } catch (e) { return text(errorResult(e)); } };
  server.registerTool('dex_locks', {
    description: 'List whole posted loans, calls and puts. RESET (8 decimals) and TNK (18 decimals) sizes are base units; terms are Bitcoin blocks counted by RESET. Each page holds 50 positions; outputs include openingTotal, makerReceives and openingFee.',
    inputSchema: { asset: assetSchema.optional(), product: product.optional(), page: height.optional(), minSize: units.optional(), maxSize: units.optional(), minTerm: height.optional(), maxTerm: height.optional() },
  }, safe(input => call('GET', '/api/locks?' + search(input))));
  server.registerTool('dex_lock_post', {
    description: 'Post and fund a loan, covered call or cash-secured put. Explain the amounts, fees, deadline and loss if missed before acting.',
    inputSchema: { product, asset: assetSchema.optional(), terms: z.union([termsSchemas.loan, termsSchemas.call, termsSchemas.put]) },
  }, safe(input => { termsSchemas[input.product].parse(input.terms); return act('post', input); }));
  server.registerTool('dex_lock_take', {
    description: 'Reserve and take one whole position. The client pays only after k reservations have enough time left. A put locks your RESET/TNK for the term before paying the premium. Fees are deducted from the maker receipt; already_taken costs nothing.',
    inputSchema: { asset: assetSchema.optional(), positionId: hex32 },
  }, safe(input => act('take', input)));
  server.registerTool('dex_lock_pay', {
    description: 'Repay a loan or exercise a call with one full payment; a put uses a small signed Solana memo before its counted Bitcoin deadline. A put writer may request refund after refundAfter while the escrow is unclaimed.',
    inputSchema: { asset: assetSchema.optional(), positionId: hex32, step: z.enum(['repay', 'exercise', 'refund']) },
  }, safe(({ positionId, step, asset }) => act(step, { positionId, ...(asset ? { asset } : {}) })));
  server.registerTool('dex_lock_cancel', {
    description: 'Request cancellation of your posted position. A live reservation prevents signers accepting cancellation.',
    inputSchema: { asset: assetSchema.optional(), positionId: hex32 },
  }, safe(input => act('cancel', input)));
  server.registerTool('dex_lock_status', {
    description: 'Own positions, now/ifMissed sentences, next action, counterparty, deadlines and blocks left. Optionally read or update automatic payment settings; sweeping is always enabled.',
    inputSchema: { asset: assetSchema.optional(), positionId: hex32.optional(), settings: settings.optional() },
  }, safe(async input => {
    if (input.settings) validateSettings(input.settings);
    const current = input.settings ? await call('POST', '/api/locks/settings', input.settings) : await call('GET', '/api/locks/settings');
    if (current?.ok === false) return current;
    const positions = await call('GET', '/api/locks/mine?' + search({ positionId: input.positionId, asset: input.asset }));
    return positions?.ok === false ? positions : { ...positions, settings: current };
  }));
  server.registerTool('dex_lock_events', {
    description: 'Position events after an integer cursor. Save next for the following read; truncated means older history fell outside the 1000 retained events.',
    inputSchema: { asset: assetSchema.optional(), since: height.optional() },
  }, safe(input => call('GET', '/api/locks/events?' + search(input))));
}
