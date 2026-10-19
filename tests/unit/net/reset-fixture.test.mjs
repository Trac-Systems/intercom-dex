import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resetSourceURL } from '../../reset-source.mjs';

const area = fileURLToPath(new URL('../../../.test-tmp/publish/reset-source/', import.meta.url));
mkdirSync(area, { recursive: true });

test('RESET source imports require an explicit absolute checkout directory', () => {
  for (const directory of ['', 'relative']) assert.throws(() => resetSourceURL('contract.js', directory), /Set RESET_SOURCE_DIR/);
  assert.throws(() => resetSourceURL('contract.js', join(area, 'absent')), /existing RESET checkout/);
  const dir = mkdtempSync(join(area, 'checkout-')), file = join(dir, 'contract.js');
  writeFileSync(file, 'export default null;');
  assert.throws(() => resetSourceURL('contract.js', file), /existing RESET checkout/);
  assert.throws(() => resetSourceURL('../outside.js', dir), /inside RESET_SOURCE_DIR/);
  assert.throws(() => resetSourceURL('absent.js', dir), /RESET_SOURCE_DIR is missing absent.js/);
  assert.throws(() => resetSourceURL('.', dir), /RESET_SOURCE_DIR is missing/);
});

test('RESET source URLs encode checkout paths and use the environment setting', async () => {
  const dir = mkdtempSync(join(area, 'checkout space #-')), file = join(dir, 'contract.mjs');
  writeFileSync(file, 'export default 42;');
  const previous = process.env.RESET_SOURCE_DIR;
  try {
    process.env.RESET_SOURCE_DIR = dir;
    const url = resetSourceURL('contract.mjs');
    assert.equal(url.href, pathToFileURL(file).href);
    assert.equal((await import(url)).default, 42);
    delete process.env.RESET_SOURCE_DIR;
    assert.throws(() => resetSourceURL('contract.mjs'), /Set RESET_SOURCE_DIR/);
  } finally {
    if (previous === undefined) delete process.env.RESET_SOURCE_DIR;
    else process.env.RESET_SOURCE_DIR = previous;
  }
});
