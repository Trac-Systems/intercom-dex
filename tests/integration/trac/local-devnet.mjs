import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resetSourceURL } from '../../reset-source.mjs';

const area = path.resolve(process.env.DEX_TRAC_TEST_DIR ?? fileURLToPath(new URL('../../../.test-tmp/trac/', import.meta.url))) + path.sep;

export async function startLocalDevnet(root, { validatorHealth = false } = {}) {
  if (!path.isAbsolute(root) || !path.resolve(root).startsWith(area)) throw new Error('Expected a fresh Trac test folder');
  const fixture = new URL('./', resetSourceURL('scripts/lib/devnet-network.mjs')).href;
  // Local copies isolate the reference fixture's hardcoded artifact paths.
  // Its contract and transaction handlers are used unchanged. Supply actual
  // validator capacity and metadata missing from the old one-validator fixture.
  const copies = new Map();
  for (const [name, replacements] of [
    ['devnet-store.mjs', [["fileURLToPath(new URL('../../.devnet', import.meta.url))", JSON.stringify(path.join(root, '.devnet'))]]],
    ['devnet-network.mjs', [
      ["import Gateway from '../../features/gateway/index.js';", `import Gateway from '${new URL('./fixture-gateway.mjs', import.meta.url).href}';\nimport { startValidatorPool } from '${new URL('./fixture-validators.mjs', import.meta.url).href}';`],
      ['const bus = await local.client(validator);', 'const bus = await startValidatorPool(local, validator);'],
      ['new Gateway(peer, { port:', 'new Gateway(peer, { msb: bus, port:'],
      ["}, 'MSB transaction settlement', 30000);", "}, 'MSB transaction settlement', 90000);"]
    ]],
    ['devnet-process.mjs', [["fileURLToPath(new URL('../../', import.meta.url))", JSON.stringify(root)],
      ['[entry, ...args]', `[resolve(${JSON.stringify(fileURLToPath(new URL('../../', fixture)))}, entry), ...args]`], ['HOME: pearDirectory, ', '']]]
  ]) {
    if (name === 'devnet-network.mjs' && !validatorHealth) continue;
    let source = await readFile(new URL(name, fixture), 'utf8');
    for (const [before, after] of replacements) {
      if (!source.includes(before)) throw new Error('RESET fixture changed; inspect artifact isolation');
      source = source.replace(before, after);
    }
    source = source.replaceAll('import.meta.url', JSON.stringify(fixture + name));
    const target = path.join(root, name);
    await writeFile(target, source, { flag: 'wx', mode: 0o600 });
    copies.set(fixture + name, pathToFileURL(target).href);
  }
  const hook = registerHooks({ resolve(specifier, context, nextResolve) {
    const original = [...copies].find(([, copy]) => copy === context.parentURL)?.[0];
    const resolved = nextResolve(specifier, original ? { ...context, parentURL: original } : context);
    return copies.has(resolved.url) ? { ...resolved, url: copies.get(resolved.url) } : resolved;
  } });
  try {
    const { startDevnet } = await import(fixture + 'devnet-network.mjs');
    return await startDevnet({ pear: !validatorHealth, intervalMs: 10000, cleanup: false });
  } finally { hook.deregister(); }
}
