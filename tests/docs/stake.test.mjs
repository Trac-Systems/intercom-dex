import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defaultSettings, settingsSchema } from '../../src/stake/settings.js';
import { errorDetails } from '../../src/stake/errors.js';
import { DELIVERY_STATES, DELIVERY_REASONS } from '../../src/stake/status.js';
import { PAUSE_CODES } from '../../src/stake/prevention.js';
import { parseStakeCommand } from '../../src/stake/cli.js';
const read = path => readFileSync(fileURLToPath(new URL('../../' + path, import.meta.url)), 'utf8');
const stake = read('docs/STAKE.md');

test('documented stake defaults and inclusive bounds are accepted, adjacent values rejected', () => {
  const rows = [...read('docs/NETWORKS.md').matchAll(/^\| `([\w.]+)` \| (\d+) \| (\d+) \| (\d+) \|$/gm)];
  assert.equal(rows.length, 17);
  const settings = defaultSettings();
  for (const [, path, value, min, max] of rows) {
    const keys = path.split('.'), field = keys.pop(), parent = keys.reduce((a, k) => a[k], settings);
    assert.equal(String(parent[field]), value, path);
    for (const [candidate, accepted] of [[min, true], [max, true], [(BigInt(min) - 1n).toString(), false], [(BigInt(max) + 1n).toString(), false]]) {
      const changed = structuredClone(settings), target = keys.reduce((a, k) => a[k], changed);
      target[field] = typeof parent[field] === 'string' ? candidate : Number(candidate);
      assert.equal(settingsSchema.safeParse(changed).success, accepted, path + ':' + candidate);
    }
  }
});

test('stake error documentation lists exactly the implemented codes and typed detail fields', () => {
  const rows = [...stake.matchAll(/^\| `((?:bond_|update_)[a-z_]+)` \| ([^|]+) \|$/gm)];
  assert.deepEqual(rows.map(r => r[1]).sort(), Object.keys(errorDetails).sort());
  for (const [, code, cell] of rows) {
    const keys = cell.trim() === 'none' ? [] : cell.replace(/`/g, '').trim().split(',');
    const actual = Object.entries(errorDetails[code].shape).map(([k, s]) => k + (s.isOptional() ? '?' : ''));
    assert.deepEqual(keys.sort(), actual.sort(), code);
  }
});

test('delivery states, pause codes, reasons and CLI examples match the public contract', () => {
  const states = [...stake.matchAll(/^\| `(delivery_[a-z]+|delivered|penalty_paid)` \|/gm)].map(m => m[1]);
  assert.deepEqual(states, [...DELIVERY_STATES]);
  for (const code of [...PAUSE_CODES, ...DELIVERY_REASONS]) assert.ok(stake.includes('`' + code + '`'));
  const commands = [...stake.matchAll(/^node bin\/dex\.mjs (.+) --config \/absolute\/trader\.json$/gm)];
  assert.equal(commands.length, 4);
  for (const [, command] of commands) assert.doesNotThrow(() => parseStakeCommand(command.split(' ')));
  assert.match(stake, /local custody path can deposit exact RESET/);
  assert.match(stake, /enforcing production registry/);
  assert.match(stake, /unknown pool/);
});
