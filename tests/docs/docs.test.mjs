// The public documents must match the code: tools, commands, config keys, stated numbers, wording and links.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STEP_BUDGET_MS, RANDOMNESS, ACCEPT_SLOT_BEHIND } from '../../src/core/terms.js';
import { LOCK_START_MARGIN_SEC } from '../../src/core/trade-buyer.js';
import { SIGNER_ONLINE_SEC, MAX_TRADES_PER_OFFER, MAX_NEGOTIATIONS_PER_TAKER } from '../../src/roles/trader.js';
import { MIN_SOL, MIN_TNK, DECIMALS, validatePayout } from '../../src/wallets/accounting.js';
import { bodySchemas, registrySchema, termsSchema } from '../../src/core/schemas.js';
import { seal } from '../../src/core/envelope.js';
import { generateIdentity } from '../../src/core/keys.js';
import { resolveNetwork } from '../../src/net/profile.js';
import { PROOF_FILES, ZKEY_SHA256, PTAU_BLAKE2B } from '../../src/proof/files.js';
import { DEX_POW_BITS, dexTransport } from '../../peer/features/dex-transport.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = file => readFileSync(join(root, file), 'utf8');
const PUBLIC = ['README.md', 'SKILL.md', 'docs/llms.txt', 'docs/SPEC.md', 'docs/OPERATORS.md', 'docs/DEVELOPERS.md'];
const LINKED = ['docs/NETWORKS.md', 'docs/WALLETS.md', 'docs/FEES.md'];
const docs = Object.fromEntries([...PUBLIC, ...LINKED].map(f => [f, read(f)]));

function sourceFiles(dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap(e => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'static' ? [] : sourceFiles(path);
    return /\.(m?js)$/.test(e.name) ? [path] : [];
  });
}
const roleSource = ['bin/dex.mjs', ...sourceFiles('src')].map(read).join('\n');
const coreSource = [...sourceFiles('src/core'), ...sourceFiles('src/roles'), ...sourceFiles('src/wallets'), ...sourceFiles('src/market'),
  'src/mcp/server.mjs', 'bin/dex.mjs'].map(read).join('\n');

const codeBlocks = text => [...text.matchAll(/```(\w*)\n([\s\S]*?)```/g)].map(m => ({ lang: m[1], text: m[2] }));
const inlineCode = text => [...text.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map(m => m[1]);
const section = (text, heading) => {
  const start = text.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `missing section ${heading}`);
  const end = text.indexOf('\n## ', start + 4);
  return text.slice(start, end < 0 ? undefined : end);
};
const ticks = text => [...text.matchAll(/`([^`]+)`/g)].map(m => m[1]);

// Depth-0 keys of the first object literal after `from` in a source text.
function objectKeys(text, from) {
  let i = text.indexOf('{', from), depth = 0, start = i + 1;
  const parts = [];
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') { const q = c; for (i++; text[i] !== q; i++) if (text[i] === '\\') i++; continue; }
    if (c === '/' && text[i + 1] !== '/' && depth > 0 && /[(,:]\s*$/.test(text.slice(start, i))) { for (i++; text[i] !== '/'; i++) if (text[i] === '\\') i++; continue; }
    if ('({['.includes(c)) depth++;
    if (')}]'.includes(c)) depth--;
    if (depth === 1 && c === ',') { parts.push(text.slice(start, i)); start = i + 1; }
    if (depth === 0) { parts.push(text.slice(start, i)); break; }
  }
  return parts.map(p => p.trim()).filter(Boolean).map(p => ({ key: p.match(/^'?([A-Za-z_$][\w$-]*)'?/)[1], optional: /\.optional\(\)\s*$/.test(p) }));
}

const mcpSource = sourceFiles('src/mcp').map(read).join('\n');
const tools = new Map([...mcpSource.matchAll(/registerTool\('([a-z_]+)'/g)].map(m => {
  const at = m.index, next = mcpSource.indexOf('registerTool(', at + 1), segment = mcpSource.slice(at, next < 0 ? undefined : next);
  const schemaAt = segment.indexOf('inputSchema:');
  return [m[1], schemaAt < 0 ? [] : objectKeys(segment, schemaAt)];
}));

test('every MCP tool is documented in SKILL.md and llms.txt, and every documented tool exists', () => {
  assert.ok(tools.size >= 7);
  for (const file of ['SKILL.md', 'docs/llms.txt']) {
    const named = new Set(docs[file].match(/\bdex_[a-z_]+\b/g));
    for (const name of named) assert.ok(tools.has(name), `${file} names unknown tool ${name}`);
    for (const name of tools.keys()) assert.ok(named.has(name), `${file} does not document ${name}`);
  }
});

test('SKILL.md lists the exact arguments of every tool, and llms.txt examples use only real arguments', () => {
  for (const [name, schema] of tools) {
    const at = docs['SKILL.md'].indexOf(`\n### ${name}\n`);
    assert.ok(at >= 0, `SKILL.md has no section for ${name}`);
    const line = docs['SKILL.md'].slice(at).split('\n').find(l => l.startsWith('Arguments:'));
    const documented = line === 'Arguments: none.' ? [] : line.slice(10).split(',').map(part => ({ key: ticks(part)[0], optional: part.includes('(optional)') }));
    assert.deepEqual(documented.sort((a, b) => a.key.localeCompare(b.key)), [...schema].sort((a, b) => a.key.localeCompare(b.key)), `arguments of ${name}`);
    const example = docs['docs/llms.txt'].split('\n').find(l => l.startsWith(name + ' {'));
    assert.ok(example, `llms.txt has no line for ${name}`);
    const keys = [...example.slice(name.length).split('}')[0].matchAll(/"([A-Za-z]+)":/g)].map(m => m[1]);
    for (const key of keys) assert.ok(schema.some(s => s.key === key), `llms.txt ${name} uses unknown argument ${key}`);
    for (const s of schema.filter(s => !s.optional)) assert.ok(keys.includes(s.key), `llms.txt ${name} omits ${s.key}`);
  }
});

const dexSource = read('bin/dex.mjs');
const allowed = new Function('return ' + dexSource.match(/const allowed = (\{[\s\S]*?\});\n/)[1])();
const optionTypes = Object.fromEntries([...dexSource.match(/options: \{([\s\S]*?)\} \}\);/)[1]
  .matchAll(/'?([a-z][a-z-]*)'?: \{ type: '(string|boolean)' \}/g)].map(m => [m[1], m[2]]));
const proofFlags = [...read('bin/proof-setup.mjs').match(/options: \{([^}]*\}[^}]*\}) \}/)[1].matchAll(/([a-z]+): \{ type: 'string' \}/g)].map(m => m[1]);

function commandLines(text) {
  const lines = codeBlocks(text).flatMap(b => b.text.replace(/\\\n\s*/g, ' ').split('\n'));
  return [...lines, ...inlineCode(text)];
}

test('every bin/dex.mjs, proof-setup and peer command in the documents uses real subcommands and flags', () => {
  assert.ok(Object.keys(optionTypes).length > 10 && proofFlags.length === 2);
  let checked = 0;
  for (const [file, text] of Object.entries(docs)) {
    for (const line of commandLines(text)) {
      const tokens = line.split(/\s+/).filter(Boolean);
      const at = tokens.findIndex(t => /(^|\/)bin\/(dex|proof-setup)\.mjs$|(^|\/)pear-runner\.mjs$/.test(t));
      if (at < 0) continue;
      const rest = tokens.slice(at + 1), program = tokens[at];
      const end = rest.findIndex(t => ['|', '&&', '>', ')'].includes(t));
      const args = end < 0 ? rest : rest.slice(0, end);
      const positionals = [], flags = [];
      for (let i = 0; i < args.length; i++) {
        if (!args[i].startsWith('--')) { positionals.push(args[i]); continue; }
        const flag = args[i].slice(2).split('=')[0];
        flags.push(flag);
        if (!args[i].includes('=') && (program.includes('dex.mjs') ? optionTypes[flag] === 'string' : true)) i++;
      }
      checked++;
      if (program.endsWith('proof-setup.mjs')) {
        for (const flag of flags) assert.ok(proofFlags.includes(flag), `${file}: proof-setup has no --${flag}`);
      } else if (program.endsWith('pear-runner.mjs')) {
        for (const flag of flags) assert.equal(flag, 'config', `${file}: the peer takes only --config`);
      } else {
        const command = positionals.length ? positionals.join(' ') : 'run';
        assert.ok(Object.hasOwn(allowed, command), `${file}: unknown command "${command}" in ${line}`);
        for (const flag of flags) assert.ok(optionTypes[flag] && (flag === 'config' || allowed[command].includes(flag)), `${file}: --${flag} does not apply to ${command}`);
      }
    }
  }
  assert.ok(checked > 20);
});

// Config keys: role configs are read through `config.<key>`; nested keys through `<key>.<nested>`.
// The Solana and Trac modules receive only their own option objects, never the role config.
const configSource = ['bin/dex.mjs', ...['roles', 'wallets', 'fees', 'dashboard', 'mcp', 'net', 'proof'].flatMap(d => sourceFiles('src/' + d))].map(read).join('\n');
const roleKeys = new Set([...configSource.matchAll(/\bconfig\??\.([A-Za-z_]\w*)/g)].map(m => m[1]));
for (const list of read('src/net/profile-core.js').matchAll(/for \(const key of \[([^\]]+)\]\)/g)) for (const m of list[1].matchAll(/'(\w+)'/g)) roleKeys.add(m[1]);
const peerSource = read('peer/runtime/dex-peer.js');
const peerKeys = new Set([...peerSource.match(/const FIELDS = new Set\(\[([^\]]+)\]/)[1].matchAll(/'(\w+)'/g)].map(m => m[1]));
for (const key of ['network', 'mint', 'programId', 'platformCollector', 'peer']) peerKeys.add(key);
const shapeKeys = schema => Object.keys(schema.shape);
const SOL = '4RS6xpspM1V2K7FKSqeSH6VVaZbtzHzhJqacwrz8gJrF';

function checkKeys(value, keys, label) {
  for (const key of Object.keys(value)) assert.ok(keys.includes(key), `${label}: unknown key ${key}`);
}

function checkRegistry(registry, label) {
  const shape = registrySchema.shape;
  checkKeys(registry, shapeKeys(registrySchema), label);
  if (registry.params) checkKeys(registry.params, shapeKeys(shape.params), label + '.params');
  if (registry.fee) checkKeys(registry.fee, shapeKeys(shape.fee), label + '.fee');
  for (const p of registry.pairs ?? []) { checkKeys(p, shapeKeys(shape.pairs.element), label + '.pairs'); checkKeys(p.base, shapeKeys(shape.pairs.element.shape.base), label + '.base'); }
  for (const s of registry.signers ?? []) checkKeys(s, shapeKeys(shape.signers.element), label + '.signers');
  for (const r of registry.removed ?? []) checkKeys(r, shapeKeys(shape.removed.element), label + '.removed');
}

function checkRoleConfig(config, label) {
  for (const [key, value] of Object.entries(config)) {
    assert.ok(roleKeys.has(key), `${label}: role config key ${key} is not read by the program`);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    if (key === 'registry') checkRegistry(value, label + '.registry');
    else if (key === 'latest') checkKeys(value, shapeKeys(bodySchemas.status.shape.latest.unwrap()), label + '.latest');
    else if (key === 'payout') {
      for (const chain of Object.keys(value)) assert.throws(() => validatePayout({ [chain]: 'x' }), /Invalid payout address/, `${label}: payout.${chain}`);
    } else {
      for (const nested of Object.keys(value)) assert.ok(new RegExp(`\\b${key}\\??\\.${nested}\\b`).test(roleSource), `${label}: ${key}.${nested} is not read by the program`);
    }
  }
}

test('every config, registry, terms and envelope block in the documents uses accepted keys', () => {
  const envelopeKeys = Object.keys(seal({ kind: 'cancel', ch: 'intercom-dex:offers', body: { offerId: 'a'.repeat(64) } }, generateIdentity().secretKey, { ts: 1, nonce: 'b'.repeat(64) })).sort();
  let configs = 0;
  for (const [file, text] of Object.entries(docs)) {
    for (const block of codeBlocks(text).filter(b => b.lang === 'json')) {
      const value = JSON.parse(block.text);
      const label = `${file} ${block.text.slice(0, 40).replace(/\s+/g, ' ')}`;
      if (value.mcpServers) continue;
      if (value.sig && value.kind) assert.deepEqual(Object.keys(value).sort(), envelopeKeys, label);
      else if (value.offerId && value.fees) checkKeys(value, shapeKeys(termsSchema), label);
      else if (value.pairs && value.params) checkRegistry(value, label);
      else if (value.storeDirectory || value.relayKeys || value.serveRelay !== undefined) {
        checkKeys(value, [...peerKeys], label);
        if (value.bridge) for (const k of Object.keys(value.bridge)) assert.ok(new RegExp(`\\bb\\.${k}\\b`).test(peerSource), `${label}: bridge.${k}`);
        configs++;
      } else { checkRoleConfig(value, label); configs++; }
      if (value.network) assert.doesNotThrow(() => resolveNetwork(value), label);
    }
  }
  assert.ok(configs >= 7);
});

// The venue registry configuration in OPERATORS.md holds the registry values every other document states.
const serviceConfig = codeBlocks(docs['docs/OPERATORS.md']).map(b => b.lang === 'json' && JSON.parse(b.text)).find(v => v?.role === 'service');
const { params, fee } = serviceConfig.registry;

test('the documented venue registry is a valid registry', () => {
  registrySchema.shape.params.parse(params);
  registrySchema.shape.fee.parse({ ...fee, collector: SOL });
  assert.ok(params.refundSec - params.sendWindowSec - params.graceSec >= 600);
  assert.ok(params.k <= params.n);
  assert.equal(registrySchema.shape.fee.safeParse({ ...fee, collector: SOL, tradeFeeBps: 1001 }).success, false);
});

function probe(file, re, expected) {
  const matches = [...docs[file].matchAll(re)];
  assert.ok(matches.length, `${file}: ${re} not found`);
  for (const m of matches) assert.deepEqual(m.slice(1).map(Number), [expected].flat(), `${file}: ${m[0]}`);
}
const WORDS = { three: 3, five: 5 };

test('fees, deadlines and limits stated in the documents equal the code and the venue registry', () => {
  const pct = bps => bps / 100;
  probe('README.md', /platform fee is ([\d.]+) %/g, pct(fee.platformFeeBps));
  probe('README.md', /trade fee is ([\d.]+) %/g, pct(fee.tradeFeeBps));
  probe('README.md', /owes\s+(\d+) % of it/g, pct(fee.signerShareBps));
  probe('README.md', /after (\d+)\s+hours/g, params.refundSec / 3600);
  probe('README.md', /about (\d+) minutes after the take/g, params.sendWindowSec / 60);
  for (const m of docs['README.md'].matchAll(/\b(three) of the (five)\b/g)) assert.deepEqual([WORDS[m[1]], WORDS[m[2]]], [params.k, params.n]);
  probe('SKILL.md', /platform fee of (\d+) bps \(([\d.]+) %\)/g, [fee.platformFeeBps, pct(fee.platformFeeBps)]);
  probe('SKILL.md', /venue fee of (\d+) bps \(([\d.]+) %\)/g, [fee.tradeFeeBps, pct(fee.tradeFeeBps)]);
  probe('SKILL.md', /(\d+) bps \((\d+) %\) of the\s+venue fee/g, [fee.signerShareBps, pct(fee.signerShareBps)]);
  probe('SKILL.md', /`sendBy`, (\d+) seconds \((\d+) minutes\)/g, [params.sendWindowSec, params.sendWindowSec / 60]);
  probe('SKILL.md', /`graceSec` \((\d+) seconds\)/g, params.graceSec);
  probe('SKILL.md', /`refundAfter`, (\d+) seconds \((\d+) hours\)/g, [params.refundSec, params.refundSec / 3600]);
  probe('SKILL.md', /(\d+) seconds before\s+`sendBy`/g, LOCK_START_MARGIN_SEC);
  probe('SKILL.md', /at most (\d+) seconds old/g, SIGNER_ONLINE_SEC);
  probe('SKILL.md', /at least ([\d.]+) SOL and ([\d.]+) TNK/g, [Number(MIN_SOL) / 1e9, Number(BigInt(MIN_TNK) / 10n ** 14n) / 1e4]);
  probe('SKILL.md', /already has (\d+) trades before their lock, or you have (\d+) with this maker/g, [MAX_TRADES_PER_OFFER, MAX_NEGOTIATIONS_PER_TAKER]);
  probe('docs/llms.txt', /uses (\d+), (\d+) and (\d+) seconds/g, [params.sendWindowSec, params.graceSec, params.refundSec]);
  probe('docs/llms.txt', /sendBy - (\d+) minutes/g, params.sendWindowSec / 60);
  probe('docs/llms.txt', /- (\d+) minutes later/g, params.graceSec / 60);
  probe('docs/llms.txt', /refundAfter - (\d+) hours/g, params.refundSec / 3600);
  probe('docs/llms.txt', /starts (\d+) seconds before/g, LOCK_START_MARGIN_SEC);
  probe('docs/llms.txt', /offer has (\d+) trades before their lock, or you have (\d+)/g, [MAX_TRADES_PER_OFFER, MAX_NEGOTIATIONS_PER_TAKER]);
  probe('docs/OPERATORS.md', /at most (\d+) seconds old/g, SIGNER_ONLINE_SEC);
  probe('docs/OPERATORS.md', /(\d+) % of the ([\d.]+) % trade fee/g, [pct(fee.signerShareBps), pct(fee.tradeFeeBps)]);
  probe('docs/OPERATORS.md', /which is (\d+)\s+hours after the take/g, params.refundSec / 3600);
  const ttl = read('src/mcp/server.mjs').match(/ttlSec: z\.number\(\)\.int\(\)\.min\((\d+)\)\.max\((\d+)\)/);
  const ttlDefault = read('src/roles/trader.js').match(/ttlSec = (\d+) \}/)[1];
  probe('SKILL.md', /`ttlSec` is (\d+) to (\d+) seconds and defaults to (\d+)/g, [Number(ttl[1]), Number(ttl[2]), Number(ttlDefault)]);
  probe('docs/llms.txt', /ttlSec (\d+)\.\.(\d+), default (\d+)/g, [Number(ttl[1]), Number(ttl[2]), Number(ttlDefault)]);
});

test('SPEC.md states the step budgets, timing constants, transport limits and pinned hashes of the code', () => {
  const spec = docs['docs/SPEC.md'];
  const budgets = section(spec, '8. Deadlines, budgets and liveness');
  const rows = Object.fromEntries([...budgets.matchAll(/^\| `(\w+)` \| (\d+) s\b/gm)].map(m => [m[1], Number(m[2]) * 1000]));
  assert.deepEqual(rows, { ...STEP_BUDGET_MS });
  probe('docs/SPEC.md', /at most (\d+) seconds ago \(`SIGNER_ONLINE_SEC`\)/g, SIGNER_ONLINE_SEC);
  probe('docs/SPEC.md', /`sendBy - (\d+)`/g, LOCK_START_MARGIN_SEC);
  probe('docs/SPEC.md', /`A \+ (\d+)`\.\n/g, RANDOMNESS.REVEAL_CUTOFF);
  probe('docs/SPEC.md', /at or after\s+`A \+ (\d+)`/g, RANDOMNESS.TARGET);
  probe('docs/SPEC.md', /at most (\d+) seconds old, dated/g, RANDOMNESS.TIP_MAX_AGE_MS / 1000);
  probe('docs/SPEC.md', /which is at most (\d+) seconds old/g, RANDOMNESS.FINALIZED_MAX_AGE_MS / 1000);
  const window = read('src/core/trade-common.js').match(/b\.slot < event\.observedSlot - ACCEPT_SLOT_BEHIND \|\| b\.slot > event\.observedSlot \+ (\d+)/);
  probe('docs/SPEC.md', /within -(\d+) to \+(\d+) slots/g, [ACCEPT_SLOT_BEHIND, Number(window[1])]);
  probe('docs/SPEC.md', /at least (\d+) leading zero bits/g, DEX_POW_BITS);
  const transport = dexTransport({ role: 'trader', servicePeerKey: 'a'.repeat(64) }).sidechannel;
  const server = dexTransport({ role: 'signer', servicePeerKey: 'a'.repeat(64) }).sidechannel;
  probe('docs/SPEC.md', /at most (\d+) bytes\. Each connection may send a trader (\d+) bytes per second with a burst of (\d+)\s+bytes, and a signer or the venue (\d+) bytes per second with a burst of (\d+) bytes/g,
    [transport.maxMessageBytes, transport.rateBytesPerSecond, transport.rateBurstBytes, server.rateBytesPerSecond, server.rateBurstBytes]);
  probe('docs/SPEC.md', /serialized registry is at most (\d+) characters/g, Number(read('src/core/schemas.js').match(/JSON\.stringify\(r\)\.length > (\d+)/)[1]));
  probe('docs/SPEC.md', /\(`MAX_TRADES_PER_OFFER`\) or (\d+) negotiations/g, MAX_NEGOTIATIONS_PER_TAKER);
  probe('docs/SPEC.md', /when (\d+) trades on the offer/g, MAX_TRADES_PER_OFFER);
  const hashes = { 'circuits/lockkey.r1cs': PROOF_FILES.r1cs.sha256, 'circuits/lockkey.wasm': PROOF_FILES.wasm.sha256,
    'circuits/lockkey.vkey.json': PROOF_FILES.vkey.sha256, 'proving key (`lockkey.zkey`)': ZKEY_SHA256, '`powersOfTau28_hez_final_18.ptau`': PTAU_BLAKE2B };
  for (const [name, hash] of Object.entries(hashes)) {
    const cell = name.startsWith('circuits/') ? '`' + name + '`' : name;
    assert.ok(new RegExp(`^\\| ${cell.replace(/[.()`]/g, '\\$&')} \\| (sha256|blake2b-512) \`${hash}\` \\|$`, 'm').test(spec), `SPEC hash for ${name}`);
  }
});

test('SPEC.md lists every message kind exactly once, and the agent documents list every decline reason', () => {
  const kinds = [...section(docs['docs/SPEC.md'], '4. Message kinds').matchAll(/^\| `(\w+)` \|/gm)].map(m => m[1]);
  assert.deepEqual([...kinds].sort(), Object.keys(bodySchemas).sort());
  const reasons = bodySchemas.decline.shape.reason.options;
  const skill = section(docs['SKILL.md'], 'Declines');
  assert.deepEqual([...skill.matchAll(/^\| `(\w+)` \|/gm)].map(m => m[1]).sort(), [...reasons].sort());
  const llmsDeclines = docs['docs/llms.txt'].split('\n\n').find(p => p.startsWith('Declines'));
  assert.deepEqual([...llmsDeclines.matchAll(/^(\w+) - /gm)].map(m => m[1]).sort(), [...reasons].sort());
  for (const reason of reasons) assert.ok(docs['docs/SPEC.md'].includes(`\`${reason}\``));
});

test('every phase, error and abort reason in SKILL.md and llms.txt exists in the code', () => {
  const phases = new Set(['src/core/trade-buyer.js', 'src/core/trade-seller.js', 'src/core/trade-common.js']
    .flatMap(f => [...read(f).matchAll(/phase(?:: | = | === )'(\w+)'/g)].map(m => m[1])));
  const life = section(docs['SKILL.md'], 'The trade life cycle');
  const listed = new Set([...life.matchAll(/^\| ([^|]+) \|/gm)].flatMap(m => ticks(m[1])));
  assert.deepEqual([...listed].sort(), [...phases].sort());
  for (const line of docs['docs/llms.txt'].split('\n').filter(l => /^(negotiation|buyer|seller|  finished):/.test(l))) {
    for (const phase of line.split(':')[1].split(/[,;.]/).map(p => p.trim()).filter(Boolean)) assert.ok(phases.has(phase), `llms.txt phase ${phase}`);
  }
  const quoted = [];
  for (const block of docs['SKILL.md'].split('\n\n').filter(p => /^Errors?: /.test(p))) quoted.push(...ticks(block));
  for (const row of section(docs['SKILL.md'], 'Abort reasons').split('\n').filter(l => l.startsWith('| `'))) quoted.push(...ticks(row));
  quoted.push(...ticks(section(docs['SKILL.md'], 'Abort reasons').split('\n\n').find(p => p.startsWith('Other reasons'))));
  assert.ok(quoted.length > 40);
  for (const text of quoted) {
    for (const fragment of text.split(/<[^>]+>/).map(f => f.trim()).filter(Boolean)) assert.ok(coreSource.includes(fragment), `SKILL.md quotes "${text}", not in the code`);
  }
  const table = [...docs['SKILL.md'].matchAll(/^\| (\w+) \| (Trac|Solana) \| (\d+) \| (\d+) \|$/gm)];
  assert.deepEqual(table.map(m => [m[1], Number(m[3])]).sort(), Object.entries(DECIMALS).sort());
  for (const m of table) assert.equal(m[4], (10n ** BigInt(m[3])).toString());
});

const BANNED = /\b(honest\w*|trade-?offs?|caveats?|admittedly|concretely|genuinely|seamless\w*|robust\w*|leverag\w*)\b|—/i;
test('the public documents use consistent wording', () => {
  for (const file of PUBLIC) {
    docs[file].split('\n').forEach((line, i) => {
      assert.ok(!BANNED.test(line), `${file}:${i + 1} banned wording: ${line}`);
    });
  }
});

const slug = heading => heading.toLowerCase().replace(/`/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s/g, '-');

test('every relative link in the documents resolves to a file and heading', () => {
  let links = 0;
  for (const file of [...PUBLIC, ...LINKED]) {
    for (const [, target] of docs[file].matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [path, anchor] = target.split('#');
      const resolved = path ? join(dirname(join(root, file)), path) : join(root, file);
      assert.ok(existsSync(resolved), `${file} links to missing ${target}`);
      links++;
      if (anchor) {
        const headings = readFileSync(resolved, 'utf8').split('\n').filter(l => /^#+ /.test(l)).map(l => slug(l.replace(/^#+ /, '')));
        assert.ok(headings.includes(anchor), `${file} links to missing heading ${relative(root, resolved)}#${anchor}`);
      }
    }
  }
  assert.ok(links > 15);
  assert.ok(existsSync(join(root, 'LICENSE.md')));
});
