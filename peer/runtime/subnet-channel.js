import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export function subnetChannel(directory, configured) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('Absolute storeDirectory required');
  const valid = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,32}$/.test(x);
  if (configured !== undefined) {
    if (!valid(configured)) throw new Error('Invalid subnetChannel');
    return configured;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'dex-channel');
  try {
    // Pear's filesystem has no fsync. Exclusive creation preserves the chosen topic
    // across process restarts; a torn file fails validation rather than changing it.
    fs.writeFileSync(file, 'dex-' + crypto.randomBytes(12).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const channel = fs.readFileSync(file, 'utf8').trim();
  if (!valid(channel)) throw new Error('Invalid stored subnetChannel');
  return channel;
}
