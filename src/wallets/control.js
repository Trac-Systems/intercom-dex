import { readPrivateFile } from '../roles/keyring.js';

export async function controlCall(config, method, route, body) {
  if (!config.control?.port) throw new Error('Configure the running role control port');
  const token = readPrivateFile(config.control.tokenFile, 256).trim();
  const response = await fetch(`http://127.0.0.1:${config.control.port}${route}`, { method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `Control HTTP ${response.status}`);
  return value;
}
