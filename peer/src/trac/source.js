import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { stableJSON } from '../../../src/core/canonical.js';

const files = ['contract/beacon/bitcoin.js', 'contract/contract.js', 'contract/games.js', 'contract/launch.js',
  'contract/protocol.js', 'contract/rules/games.js', 'contract/rules/index.js', 'contract/rules/json.js',
  'contract/state.js', 'features/sidechannel/commands.js'];
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// No RESET module is imported until the entire dependency tree has passed these checks.
export function verifyResetSource(source, { local = false } = {}) {
  if (!source || !/^[0-9a-f]{40}$/.test(source.commit) || !/^[0-9a-f]{64}$/.test(source.manifestSha256) ||
      Object.keys(source).some(k => !['commit', 'manifestSha256', 'directory'].includes(k))) throw new Error('Invalid RESET source pin');
  if (source.directory != null && (!local || !path.isAbsolute(source.directory))) throw new Error('RESET source directory override requires local tests');
  const directory = source.directory ?? new URL('../../vendor/reset/', import.meta.url).pathname;
  for (const relative of ['', 'SOURCE.json', ...files]) {
    const parts = relative.split('/').filter(Boolean);
    for (let i = 0; i <= parts.length; i++) {
      const item = path.join(directory, ...parts.slice(0, i)), stat = fs.lstatSync(item);
      if (stat.isSymbolicLink() || (i < parts.length || !parts.length ? !stat.isDirectory() : !stat.isFile())) throw new Error(`RESET source must be a regular vendored tree: ${relative}`);
    }
  }
  const bytes = fs.readFileSync(path.join(directory, 'SOURCE.json'));
  if (sha256(bytes) !== source.manifestSha256) throw new Error('RESET SOURCE.json differs from the network profile');
  const manifest = JSON.parse(bytes.toString());
  if (bytes.toString() !== stableJSON(manifest) + '\n' || manifest.repository !== 'https://github.com/Trac-Systems/reset' ||
      manifest.commit !== source.commit || Object.keys(manifest).sort().join() !== 'commit,files,repository' ||
      !manifest.files || Object.keys(manifest.files).sort().join() !== files.join()) throw new Error('Invalid RESET SOURCE.json');
  for (const file of files) {
    if (sha256(fs.readFileSync(path.join(directory, file))) !== manifest.files[file]) throw new Error(`RESET source differs: ${file}`);
  }
  return { protocolFile: path.join(directory, 'contract/protocol.js'), contractFile: path.join(directory, 'contract/contract.js') };
}
