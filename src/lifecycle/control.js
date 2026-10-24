import { realpathSync } from 'node:fs';
import { SOFTWARE } from '../core/software.js';
import { isFinished } from '../roles/host.js';

export function stopBlockers(role, wallets) {
  const blockers = [...(role.host?.trades.values() ?? [])].filter(t => !isFinished(t)).map(t => ({
    kind: 'trade', id: t.state.tradeId ?? t.key, step: t.state.phase,
  }));
  for (const w of wallets?.pending() ?? []) blockers.push({ kind: 'withdrawal', id: w.id, step: w.status });
  for (const p of role.locks?.positions.values() ?? []) {
    if (p.state !== 'released') blockers.push({ kind: 'position', id: p.positionId, step: p.state });
  }
  return blockers;
}

export function lifecycleHandler({ id, config, role, wallets, dashboard, stop, fallback }) {
  let stopping = false;
  return (req, res) => {
    if (!['/lifecycle', '/lifecycle/stop'].includes(req.url)) return fallback(req, res);
    // The enclosing control handler authenticates this route before dispatch.
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      const reply = (code, value) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      try {
        if (req.method === 'GET' && req.url === '/lifecycle') return reply(200, {
          id, dataDir: realpathSync(config.dataDir), pid: process.pid, software: SOFTWARE, node: process.version,
          signers: role.onlineSigners(), dashboard: dashboard(), blockers: stopBlockers(role, wallets), stopping,
        });
        if (req.method !== 'POST' || req.url !== '/lifecycle/stop') return reply(404, { error: 'not found' });
        const input = JSON.parse(body || '{}');
        if (input.id !== id) return reply(409, { error: 'DEX instance changed; retry status' });
        if (input.force !== undefined && typeof input.force !== 'boolean') return reply(400, { error: 'force must be boolean' });
        const blockers = stopBlockers(role, wallets);
        if (blockers.length && !input.force) return reply(409, { error: 'Stop refused: ' + blockers.map(b => `${b.kind} ${b.id} (${b.step})`).join(', ') + '; use --force to interrupt', blockers });
        if (!stopping) {
          // stop() quiesces the role synchronously before any other request or trade event can run.
          stop();
          stopping = true;
        }
        reply(200, { stopping: true, forced: input.force === true, blockers });
      } catch (error) { reply(400, { error: error.message }); }
    });
  };
}
