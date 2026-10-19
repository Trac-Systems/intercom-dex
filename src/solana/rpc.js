import { PublicKey } from '@solana/web3.js';

export class RpcError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = 'RpcError';
    this.kind = kind;
    Object.assign(this, details);
  }
}

export async function rpcCall(endpoint, method, params = [], { timeoutMs = 5000 } = {}) {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('RPC requires HTTP(S)');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new RangeError('Invalid timeoutMs');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!response.ok) throw new RpcError('http', `RPC HTTP ${response.status}`, { status: response.status });
    let body;
    try { body = await response.json(); }
    catch (cause) {
      if (controller.signal.aborted) throw cause;
      throw new RpcError('protocol', 'RPC returned invalid JSON');
    }
    if (!body || body.jsonrpc !== '2.0' || body.id !== 1 || (Object.hasOwn(body, 'result') === Object.hasOwn(body, 'error'))) {
      throw new RpcError('protocol', 'Invalid JSON-RPC response');
    }
    if (Object.hasOwn(body, 'error')) {
      if (!body.error || !Number.isInteger(body.error.code) || typeof body.error.message !== 'string') throw new RpcError('protocol', 'Invalid JSON-RPC error');
      throw new RpcError('rpc', body.error.message, { code: body.error.code, data: body.error.data });
    }
    return body.result;
  } catch (error) {
    if (controller.signal.aborted) throw new RpcError('timeout', `RPC timed out after ${timeoutMs}ms`);
    if (error instanceof RpcError) throw error;
    throw new RpcError('network', 'RPC transport failed', { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

export async function readAccount(endpoint, address, { timeoutMs = 5000, minContextSlot, commitment = 'confirmed' } = {}) {
  if (!['confirmed', 'finalized'].includes(commitment)) throw new TypeError('Unsupported account commitment');
  const config = { encoding: 'base64', commitment };
  if (minContextSlot !== undefined) {
    if (!Number.isSafeInteger(minContextSlot) || minContextSlot < 0) throw new RangeError('Invalid minContextSlot');
    config.minContextSlot = minContextSlot;
  }
  const result = await rpcCall(endpoint, 'getAccountInfo', [new PublicKey(address).toBase58(), config], { timeoutMs });
  if (!result || !Number.isSafeInteger(result.context?.slot) || result.context.slot < 0 || !Object.hasOwn(result, 'value')) throw new RpcError('protocol', 'Invalid account context');
  if (minContextSlot !== undefined && result.context.slot < minContextSlot) throw new RpcError('stale', 'Account context below minContextSlot');
  const { value } = result;
  if (value === null) return { slot: result.context.slot, value: null };
  if (!value || !Array.isArray(value.data) || value.data.length !== 2 || value.data[1] !== 'base64' ||
      typeof value.data[0] !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data[0]) ||
      !Number.isSafeInteger(value.lamports) || value.lamports < 0 || typeof value.executable !== 'boolean' || typeof value.owner !== 'string') {
    throw new RpcError('protocol', 'Invalid account value');
  }
  let owner;
  try { owner = new PublicKey(value.owner).toBase58(); }
  catch { throw new RpcError('protocol', 'Invalid account owner'); }
  const data = Buffer.from(value.data[0], 'base64');
  if (data.toString('base64') !== value.data[0]) throw new RpcError('protocol', 'Noncanonical account base64');
  return { slot: result.context.slot, value: { data, owner, lamports: value.lamports, executable: value.executable } };
}
