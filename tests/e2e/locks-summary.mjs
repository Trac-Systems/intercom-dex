import fs from 'node:fs/promises';
import path from 'node:path';

const stats = values => {
  values.sort((a, b) => a - b);
  const at = q => values.length ? Number(values[Math.min(values.length - 1, Math.floor(values.length * q))].toFixed(2)) : null;
  return { count: values.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
};
const jsonl = async file => (await fs.readFile(file, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const output = [];
for (const log of process.argv.slice(2)) {
  const text = await fs.readFile(log, 'utf8'), roots = [...text.matchAll(/ARTIFACTS (.+)/g)].map(m => m[1]);
  const starts = [...text.matchAll(/(\S+) SCENARIO (\S+)/g)].map(m => ({ at: Date.parse(m[1]), scenario: m[2] }));
  const run = { log, roots, complete: !text.includes('LOCKS_STACK_FAILED') && (text.match(/"ok":true/g) ?? []).length === 22, cases: [] };
  for (const root of roots) {
    const requests = await jsonl(path.join(root, 'requests.jsonl'));
    const results = JSON.parse(await fs.readFile(path.join(root, 'results.json'), 'utf8').catch(() => '[]'));
    const files = (await fs.readdir(path.join(root, 'logs'))).filter(name => name.endsWith('-metrics.jsonl'));
    const metrics = Object.fromEntries(await Promise.all(files.map(async name => [name.replace('-metrics.jsonl', ''), await jsonl(path.join(root, 'logs', name))])));
    for (const scenario of new Set(requests.map(r => r.scenario).filter(s => s !== 'setup'))) {
      const result = results.find(r => r.scenario === scenario), start = starts.find(s => s.scenario === scenario)?.at ?? 0;
      const rows = requests.filter(r => r.scenario === scenario), processes = {};
      const end = result?.finishedAt ?? starts.find(s => s.at > start)?.at ?? rows.reduce((at, r) => Math.max(at, r.at), start);
      for (const [name, all] of Object.entries(metrics)) {
        const rows = all.filter(r => r.at >= start && r.at <= end), ticks = rows.filter(r => r.type === 'process');
        processes[name] = { cpuPct: stats(ticks.map(r => r.cpuPct)), loopP99Ms: stats(ticks.map(r => r.loopP99Ms)), loopMaxMs: stats(ticks.map(r => r.loopMaxMs)),
          rssBytes: stats(ticks.map(r => r.rss)), positions: stats(ticks.flatMap(r => Object.values(r.positions))),
          recordReads: ticks.reduce((n, r) => n + r.recordReads, 0), fsyncs: ticks.reduce((n, r) => n + r.fsyncs, 0),
          methods: Object.fromEntries([...new Set(rows.filter(r => r.type === 'method').map(r => r.method + (r.kind ? ':' + r.kind : '')))].map(key =>
            [key, stats(rows.filter(r => r.type === 'method' && r.method + (r.kind ? ':' + r.kind : '') === key).map(r => r.ms))])),
          bridge: Object.fromEntries([...new Set(rows.filter(r => r.type === 'bridge').map(r => r.method))].map(key =>
            [key, stats(rows.filter(r => r.type === 'bridge' && r.method === key).map(r => r.ms))])) };
      }
      run.cases.push({ scenario, ok: result?.ok ?? false, outcome: result?.outcome ?? null, durationMs: result?.durationMs ?? null, observedDurationMs: result?.durationMs ?? end - start,
        requests: Object.fromEntries(['control', 'mcp', 'dashboard'].map(surface => [surface, { ...stats(rows.filter(r => r.surface === surface).map(r => r.ms)), errors: rows.filter(r => r.surface === surface && r.error).length }])),
        requestsByProcess: Object.fromEntries([...new Set(rows.map(r => `${r.surface}:${r.name}`))].map(key => [key, {
          ...stats(rows.filter(r => `${r.surface}:${r.name}` === key).map(r => r.ms)),
          timeouts: rows.filter(r => `${r.surface}:${r.name}` === key && /timeout|timed out|venue_unavailable/i.test(r.error ?? '')).length }])),
        slowRequests: rows.filter(r => r.ms >= 1000 || r.error), processes });
    }
  }
  output.push(run);
}
console.log(JSON.stringify(output, null, 2));
