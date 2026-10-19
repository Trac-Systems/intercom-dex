import { rpcCall } from './rpc.js';
import { QuorumError } from './quorum.js';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}

export async function readRpcQuorum(method, params, { endpoints, need = 2, timeoutMs = 3000, select = value => value, unanimous = false }) {
  if (!Array.isArray(endpoints) || !endpoints.length) throw new TypeError('Endpoints required');
  const urls = endpoints.map(endpoint => {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new TypeError('Invalid RPC URL');
    return url.href;
  });
  if (new Set(urls).size !== urls.length || !Number.isInteger(need) || need < 1 || need > urls.length) throw new TypeError('Invalid quorum');
  const results = await Promise.allSettled(urls.map(async endpoint => select(await rpcCall(endpoint, method, params, { timeoutMs }))));
  const groups = new Map();
  const reports = results.map((result, i) => {
    if (result.status === 'rejected') return { endpoint: urls[i], status: 'error', message: result.reason.message };
    const value = result.value;
    const digest = JSON.stringify(canonical(value));
    if (digest === undefined) return { endpoint: urls[i], status: 'error', message: 'Missing RPC value' };
    const group = groups.get(digest) ?? { value, indices: [] };
    group.indices.push(i); groups.set(digest, group);
    return { endpoint: urls[i], status: 'disagreed' };
  });
  const winners = [...groups.values()].filter(group => group.indices.length >= need);
  if (winners.length !== 1) throw new QuorumError(winners.length ? 'Ambiguous RPC quorum' : 'No RPC quorum', reports);
  if (unanimous && groups.size > 1) throw new QuorumError('RPC readers disagree', reports);
  for (const i of winners[0].indices) reports[i].status = 'agreed';
  return { value: winners[0].value, reports };
}
