// Applies intercom-dex's patches to installed dependencies (runs after `npm ci --prefix peer`). Each patch names the
// exact original text; a dependency that changed is reported instead of patched blindly. Re-running is harmless.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const patches = JSON.parse(fs.readFileSync(path.join(root, 'patches', 'patches.json'), 'utf8'));
let failed = false;
for (const p of patches) {
  const file = path.join(root, 'node_modules', p.file);
  const version = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', p.package, 'package.json'), 'utf8')).version;
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes(p.patched)) { console.log(`patch ${p.name}: already applied`); continue; }
  if (version !== p.version || text.split(p.original).length !== 2) {
    console.error(`patch ${p.name}: ${p.package} ${version} does not match the expected ${p.version} source; not applied`);
    failed = true; continue;
  }
  fs.writeFileSync(file, text.replace(p.original, p.patched));
  console.log(`patch ${p.name}: applied to ${p.package} ${version}`);
}
if (failed) process.exit(1);
