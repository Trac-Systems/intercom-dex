// One pass over isolated local stacks. No retry, remote host or shared test chain.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
const repo = process.cwd(), area = process.env.DEX_STAKE_ACCEPTANCE_DIR;
if (!area || !path.isAbsolute(area) || !area.startsWith(repo + path.sep)) throw Error('Use a acceptance directory inside this checkout');
const stopAt = Date.parse(process.env.DEX_STAKE_ACCEPTANCE_STOP_AT);
if (!Number.isFinite(stopAt) || stopAt <= Date.now()) throw Error('A future hard stop time is required');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (execFileSync('git', ['diff', '--name-only', 'HEAD'], { encoding: 'utf8' }).trim()) throw Error('Commit final code before acceptance');
const loadMode = process.env.DEX_STAKE_ACCEPTANCE_MODE === 'timing-load';
if (process.env.DEX_STAKE_ACCEPTANCE_MODE && !loadMode) throw Error('Unknown acceptance mode');
const availableRows = loadMode ? ['after-grace', 'inside-grace', 'bonded-delivery'].map(name =>
  ({ name, scenario: 'stake-penalty-cases', cases: name, expected: [name] })) : [
  { name: 'stake-exact-withdraw', scenario: 'stake-exact-withdraw', expected: ['stake-exact-withdraw'] },
  { name: 'handoff', scenario: 'stake-epoch-handoff', expected: ['epoch-handoff', 'epoch-handoff-new-trade-and-reward', 'mixed-epoch-return'] },
  { name: 'penalties', scenario: 'stake-penalty-cases', expected: ['no-show', 'reward-forfeiture', 'award-restart', 'bonded-delivery', 'inside-grace', 'after-grace', 'outage', 'buyer-late-lock', 'buyer-never-lock'] },
  ...['stake-free-expiry', 'stake-withdraw', 'stake-rewards', 'stake-late-funding', 'stake-partial-funding'].map(name => ({ name, scenario: name, expected: [name] })),
  { name: 'deferred', scenario: 'stake-penalty-cases', cases: 'deferred-withdraw', expected: ['deferred-withdraw'] },
  { name: 'released-v0.1.47', scenario: 'stake-release-refusal', expected: ['stake-release-refusal'], old: '0.1.47' },
  { name: 'released-v0.1.48', scenario: 'stake-rewards', expected: ['stake-rewards'], old: '0.1.48' }
];
const selected = (process.env.DEX_STAKE_ACCEPTANCE_ROWS ?? '').split(',').filter(Boolean);
if (selected.some(name => !availableRows.some(row => row.name === name))) throw Error('Unknown acceptance row');
const rows = selected.length ? availableRows.filter(row => selected.includes(row.name)) : availableRows;
await mkdir(area, { recursive: true });
const state = { revision, pid: process.pid, mode: loadMode ? 'timing-load' : 'sequential', startedAt: new Date().toISOString(), stopAt: new Date(stopAt).toISOString(), rows: rows.map(r => ({ ...r, state: 'queued' })) };
const save = () => writeFile(path.join(area, 'acceptance.json'), JSON.stringify(state, null, 2));
await save();
let next = 0;
async function run(row) {
  const dir = path.join(area, row.name); await mkdir(dir, { recursive: true });
  const env = { ...process.env, DEX_E2E_TEST_DIR: dir, DEX_SOLANA_TEST_DIR: path.join(dir, 'solana'), DEX_TRAC_TEST_DIR: path.join(dir, 'trac'), TMPDIR: area };
  delete env.DEX_E2E_STAKE_CASES; delete env.DEX_E2E_OLD; delete env.DEX_E2E_OLD_REPO;
  if (row.cases) env.DEX_E2E_STAKE_CASES = row.cases;
  if (row.old) {
    env.DEX_E2E_OLD = row.old === '0.1.48' ? 'alice,bob' : 'alice,legacy';
    env.DEX_E2E_OLD_REPO = row.old === '0.1.48' ? process.env.DEX_STAKE_OLD_48_REPO : process.env.DEX_STAKE_OLD_REPO;
    if (!env.DEX_E2E_OLD_REPO || JSON.parse(await readFile(path.join(env.DEX_E2E_OLD_REPO, 'package.json'), 'utf8')).version !== row.old)
      throw Error('Released checkout required for ' + row.name);
  }
  row.state = 'running'; row.startedAt = new Date().toISOString(); await save();
  console.log(row.startedAt, 'start', row.name, revision);
  const stream = createWriteStream(path.join(dir, 'stack.log'));
  const child = spawn(process.execPath, ['tests/e2e/stack.mjs', row.scenario], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  row.pid = child.pid; await save();
  child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
  const timer = setTimeout(() => { row.hardStop = true; child.kill('SIGTERM'); }, Math.max(0, stopAt - Date.now()));
  const code = await new Promise(resolve => { child.on('error', e => { row.error = e.message; resolve(-1); }); child.on('exit', resolve); });
  clearTimeout(timer); await new Promise(resolve => stream.end(resolve));
  row.exitCode = code; row.finishedAt = new Date().toISOString(); row.state = code === 0 ? 'passed' : 'failed';
  const folders = (await readdir(dir)).filter(n => n.startsWith('e2e-')); row.root = folders.length === 1 ? path.join(dir, folders[0]) : null;
  let results = [];
  if (row.root) for (const file of ['results.json', 'stake-results.json']) {
    try { results = JSON.parse(await readFile(path.join(row.root, file), 'utf8')); break; } catch {}
  }
  const log = await readFile(path.join(dir, 'stack.log'), 'utf8');
  const printed = log.match(/RESULTS (\[[\s\S]*?\n\])/);
  if (printed) results = JSON.parse(printed[1]);
  row.error ??= log.match(/E2E FAILED ([^\n]*)/)?.[1] ?? (row.hardStop ? 'hard stop reached' : null);
  row.results = row.expected.map(name => results.find(r => r.name === name) ?? { name, ok: false, error: row.error ?? 'Case not reached or no result recorded' });
  if (row.results.some(r => !r.ok)) row.state = 'failed';
  await save(); console.log(row.finishedAt, row.state, row.name, row.error ?? '');
}
async function consume() {
  while (next < state.rows.length && Date.now() < stopAt) await run(state.rows[next++]);
}
const burners = loadMode ? Array.from({ length: 2 }, () => spawn(process.execPath,
  ['--input-type=module', '-e', 'let x = 0; for (;;) { x = Math.sin(x + 1); }'], { stdio: 'ignore' })) : [];
state.cpuLoadPids = burners.map(p => p.pid); await save();
try {
  if (loadMode) await Promise.all([consume(), consume(), consume()]);
  else await consume();
} finally {
  await Promise.all(burners.map(p => new Promise(resolve => {
    if (p.exitCode !== null || p.signalCode !== null) return resolve();
    p.once('exit', resolve); p.kill('SIGTERM');
  })));
  state.cpuLoadStoppedAt = burners.length ? new Date().toISOString() : null;
}
for (const row of state.rows.filter(r => r.state === 'queued')) { row.state = 'not-run'; row.error = 'hard stop reached'; }
state.finishedAt = new Date().toISOString(); await save();
process.exitCode = state.rows.every(r => r.state === 'passed') ? 0 : 1;
