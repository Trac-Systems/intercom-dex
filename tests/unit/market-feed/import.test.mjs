import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { importVenueStore, importVenue } from '../../../bin/feed-import-venue.mjs';
import { TradeHistory } from '../../../src/market-feed/history.js';
import { openStore } from '../../../src/roles/store.js';
import { createKeyring, openKeyring } from '../../../src/roles/keyring.js';
import { memoryStore, setup } from './helpers.mjs';

const temp = () => mkdtempSync(join(tmpdir(), 'feed-import-'));
const snapshot = dir => readdirSync(dir).sort().flatMap(name => {
  const path = join(dir, name), stat = statSync(path);
  return stat.isDirectory() ? snapshot(path).map(row => [name + '/' + row[0], ...row.slice(1)]) :
    [[name, stat.mode, stat.mtimeMs, createHash('sha256').update(readFileSync(path)).digest('hex')]];
});

test('import visits only logged settlement entries, reports per pair and is idempotent', () => {
  const s = setup(), a = s.trade(), b = s.trade({ pair: 'TNK/USDC' }), history = new TradeHistory();
  const store = memoryStore({ ['settle-' + a.tradeId]: { tradeId: a.tradeId, status: 'logged', entry: a },
    ['settle-' + b.tradeId]: { tradeId: b.tradeId, status: 'logged', entry: b },
    'settle-pending': { status: 'pending' }, 'settle-rejected': { status: 'rejected' }, unrelated: { status: 'logged' } });
  store.put = store.delete = () => assert.fail('venue mutation');
  assert.deepEqual(importVenueStore({ store, history }), { scanned: 4, skipped: 2, pairs: [
    { pair: 'RESET/USDC', imported: 1, duplicates: 0 }, { pair: 'TNK/USDC', imported: 1, duplicates: 0 },
  ] });
  assert.deepEqual(importVenueStore({ store, history }).pairs, [
    { pair: 'RESET/USDC', imported: 0, duplicates: 1 }, { pair: 'TNK/USDC', imported: 0, duplicates: 1 },
  ]);
  assert.equal(history.ids.size, 2);
  const trade = history.trades({ pair: 'RESET/USDC', decimals: 8 }).rows[0];
  assert.equal(trade.side, null); assert.equal(trade.usdc, '504');
});

test('import fails on malformed logged records and id mismatches without adding them', () => {
  const s = setup(), entry = s.trade();
  for (const record of [{ status: 'logged' }, { status: 'logged', tradeId: 'bad', entry },
    { status: 'logged', tradeId: entry.tradeId, entry: { ...entry, quoteAmount: '0' } }]) {
    const history = new TradeHistory(), store = memoryStore({ ['settle-' + entry.tradeId]: record });
    assert.throws(() => importVenueStore({ store, history })); assert.equal(history.ids.size, 0);
  }
  assert.throws(() => importVenueStore({ store: memoryStore({ 'settle-wrong': { status: 'logged', tradeId: entry.tradeId, entry } }), history: new TradeHistory() }), /id mismatch/);
});

test('CLI imports encrypted venue records read-only, prints counts and safely skips duplicates', async () => {
  const root = temp(), venueData = join(root, 'venue'), feedData = join(root, 'feed'); mkdirSync(venueData);
  const password = randomBytes(32).toString('hex');
  await createKeyring(join(venueData, 'keyring.json'), password);
  const keys = await openKeyring(join(venueData, 'keyring.json'), password), store = openStore(venueData, keys.storeKey);
  const s = setup(), entry = s.trade();
  store.put('settle-' + entry.tradeId, { status: 'logged', tradeId: entry.tradeId, entry });
  store.put('settle-pending', { status: 'pending' }); keys.storeKey.fill(0);
  const before = snapshot(venueData);
  const run = () => spawnSync(process.execPath, ['bin/feed-import-venue.mjs', '--venue-data', venueData, '--feed-data', feedData],
    { encoding: 'utf8', env: { ...process.env, DEX_KEY_PASSWORD: password } });
  const first = run(); assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(first.stdout.trim().split('\n').map(JSON.parse), [{ pair: 'RESET/USDC', imported: 1, duplicates: 0 }, { scanned: 2, skipped: 1 }]);
  assert.deepEqual(snapshot(venueData), before);
  const second = run(); assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout.split('\n')[0]).duplicates, 1);
  const history = new TradeHistory({ dataDir: feedData });
  assert.equal(history.trades({ pair: entry.pair, decimals: 8 }).rows[0].id, entry.tradeId);
  const blocked = run(); assert.equal(blocked.status, 1); assert.match(blocked.stderr, /locked/);
  await assert.rejects(importVenue({ venueData, feedData, readPassword: () => assert.fail('busy feed must fail before password') }), /locked/);
  history.close(); assert.deepEqual(snapshot(venueData), before);
  await assert.rejects(importVenue({ venueData, feedData, readPassword: () => 'invalid-password-for-test' }), /password/);
  new TradeHistory({ dataDir: feedData }).close();
  assert.deepEqual(snapshot(venueData), before);
});

test('import refuses overlapping or symlinked venue destinations and bad arguments', async () => {
  const root = temp(), venueData = join(root, 'venue'); mkdirSync(venueData); mkdirSync(join(venueData, 'records'));
  for (const feedData of [venueData, join(venueData, 'new', 'feed'), root]) {
    await assert.rejects(importVenue({ venueData, feedData, readPassword: () => assert.fail('no password read') }), /separate/);
  }
  const link = join(root, 'link'); symlinkSync(venueData, link);
  await assert.rejects(importVenue({ venueData, feedData: join(link, 'new') }), /separate/);
  const feedData = join(root, 'feed'); mkdirSync(feedData); symlinkSync(join(venueData, 'records'), join(feedData, 'market-history'));
  await assert.rejects(importVenue({ venueData, feedData }), /symlink/);
  assert.deepEqual(readdirSync(join(venueData, 'records')), []);
  await assert.rejects(importVenue({ venueData }), /required/);
  for (const args of [[], ['--unknown'], ['--feed-data', root, '--feed-data', root]]) {
    const result = spawnSync(process.execPath, ['bin/feed-import-venue.mjs', ...args], { encoding: 'utf8' }); assert.equal(result.status, 1);
  }
  const help = spawnSync(process.execPath, ['bin/feed-import-venue.mjs', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /Stop the feed first/);
});
