import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STATES, OUTCOMES, REASONS } from '../../src/locks/position.js';
import { CLIENT_EVENTS, DEFAULT_SETTINGS } from '../../src/locks/client.js';
import { registerLocksTools } from '../../src/mcp/locks-tools.js';

const read = file => readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
const skill = read('SKILL.md'), locks = read('docs/LOCKS.md'), text = skill + '\n' + locks;
test('locks tools, every state, outcome, event and actionable failure are documented', () => {
  const names = [];
  registerLocksTools({ registerTool: name => names.push(name) }, () => {});
  assert.equal(names.length, 7);
  for (const name of names) assert.ok(skill.includes(`### ${name}\n`), name);
  for (const value of [...STATES, ...OUTCOMES, ...CLIENT_EVENTS, ...Object.keys(DEFAULT_SETTINGS)]) assert.ok(text.includes(value), value);
  for (const reason of Object.keys(REASONS)) assert.match(skill, new RegExp('\\| `' + reason + '` \\| [^|]+ \\|'), reason);
});

test('all registry limits and recovery rules appear in the public locks reference', () => {
  const fields = ['params.n', 'params.k', 'params.dkgTimeoutSec', 'params.reserveSec', 'params.payMarginSec',
    'params.termBlocks.min', 'params.termBlocks.max', 'params.offerMaxBlocks', 'params.recoveryMarginSec', 'params.tnkReserve',
    'products.loan', 'products.call', 'products.put', 'limits.RESET.min', 'limits.RESET.max', 'limits.USDC.min', 'limits.USDC.max',
    'limits.totalLocked.RESET', 'limits.totalLocked.USDC', 'fee.loanBps', 'fee.optionBps', 'fee.optionMin', 'fee.signerShareBps', 'assets.TNK', 'limits.TNK.min', 'limits.TNK.max', 'limits.totalLocked.TNK', 'fee.collector', 'fee.escrowCollector', 'minSoftware'];
  for (const field of fields) assert.ok(locks.includes(field), field);
  for (const limit of ['k > n/2', 'k <= n <= 16', '2000', '50', '1000', '60 seconds', 'at least 6', '100 rows']) assert.ok(locks.includes(limit), limit);
  assert.match(skill, /RESET\/TNK locks rely on enough signers surviving/);
  assert.match(skill, /refunded by the writer through the escrow after `refundAfter`/);
  for (const kind of ['registry', 'heartbeat', 'lockRequest', 'posted', 'book', 'bookRequest', 'releaseRequest',
    'dkgDeal', 'dkgFail', 'lockReady', 'funded', 'take', 'reserve', 'paid', 'opened', 'cancel', 'release', 'ended']) assert.ok(locks.includes('`' + kind + '`'), kind);
});


test('asset locks, deducted fees, median release and recovery are consistent across public references', () => {
  for (const file of ['README.md', 'SKILL.md', 'docs/LOCKS.md', 'docs/FEES.md', 'docs/OPERATORS.md', 'docs/WALLETS.md', 'src/core/API.md', 'docs/llms.txt']) {
    const value = read(file);
    assert.match(value, /TNK/, file);
    assert.doesNotMatch(value, /escrow_hash_unavailable|put sends `amount` RESET|Put exercise must be final in RESET ledger order/, file);
  }
  for (const file of ['SKILL.md', 'docs/LOCKS.md', 'src/core/API.md']) {
    const value = read(file);
    for (const fragment of ['99.50', '0.50', '4.50', '1–2 hours', 'handover', 'refundAfter']) assert.ok(value.includes(fragment), `${file}: ${fragment}`);
  }
});
