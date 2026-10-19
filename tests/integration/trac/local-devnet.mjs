import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resetSourceURL } from '../../reset-source.mjs';

const area = fileURLToPath(new URL('../../../.test-tmp/trac/', import.meta.url));

export async function startLocalDevnet(root) {
  if (!path.isAbsolute(root) || !path.resolve(root).startsWith(area)) throw new Error('Expected a fresh Trac test folder');
  const fixture = new URL('./', resetSourceURL('scripts/lib/devnet-network.mjs')).href;
  // Local copies isolate the reference fixture's hardcoded artifact paths.
  // Its contract, network and production Pear runner are used unchanged.
  const copies = new Map();
  for (const [name, replacements] of [
    ['devnet-store.mjs', [["fileURLToPath(new URL('../../.devnet', import.meta.url))", JSON.stringify(path.join(root, '.devnet'))]]],
    ['devnet-process.mjs', [["fileURLToPath(new URL('../../', import.meta.url))", JSON.stringify(root)],
      ['[entry, ...args]', `[resolve(${JSON.stringify(fileURLToPath(new URL('../../', fixture)))}, entry), ...args]`], ['HOME: pearDirectory, ', '']]]
  ]) {
    let source = await readFile(new URL(name, fixture), 'utf8');
    for (const [before, after] of replacements) {
      if (!source.includes(before)) throw new Error('RESET fixture changed; inspect artifact isolation');
      source = source.replace(before, after);
    }
    const target = path.join(root, name);
    await writeFile(target, source, { flag: 'wx', mode: 0o600 });
    copies.set(fixture + name, pathToFileURL(target).href);
  }
  const hook = registerHooks({ resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    return copies.has(resolved.url) ? { ...resolved, url: copies.get(resolved.url) } : resolved;
  } });
  try {
    const { startDevnet } = await import(fixture + 'devnet-network.mjs');
    return await startDevnet({ pear: true, intervalMs: 10000, cleanup: false });
  } finally { hook.deregister(); }
}
