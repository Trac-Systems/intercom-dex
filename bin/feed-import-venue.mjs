#!/usr/bin/env node
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { openStore } from '../src/roles/store.js';
import { openKeyring } from '../src/roles/keyring.js';
import { hiddenInput } from '../src/wallets/input.js';
import { TradeHistory } from '../src/market-feed/history.js';
import { parseBody } from '../src/core/schemas.js';

export function importVenueStore({ store, history }) {
  const pairs = new Map(); let scanned = 0, skipped = 0;
  for (const name of store.list('settle-')) {
    scanned++;
    const record = store.get(name);
    if (record?.status !== 'logged') { skipped++; continue; }
    const entry = parseBody('tradeLog', record.entry);
    if (name !== 'settle-' + entry.tradeId || record.tradeId !== entry.tradeId) throw new Error(`Settlement id mismatch: ${name}`);
    const count = pairs.get(entry.pair) ?? { pair: entry.pair, imported: 0, duplicates: 0 };
    count[history.addTrade(entry) ? 'imported' : 'duplicates']++;
    pairs.set(entry.pair, count);
  }
  return { scanned, skipped, pairs: [...pairs.values()].sort((a, b) => a.pair.localeCompare(b.pair)) };
}

function canonical(path) {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  return resolve(canonical(dirname(absolute)), relative(dirname(absolute), absolute));
}

export async function importVenue({ venueData, feedData, readPassword = hiddenInput, log = message => process.stderr.write(message + '\n') }) {
  if (!venueData || !feedData) throw new Error('--venue-data and --feed-data are required');
  const venue = realpathSync(resolve(venueData)), feed = canonical(feedData);
  if (feed === venue || feed.startsWith(venue + sep) || venue.startsWith(feed + sep)) throw new Error('Venue and feed data directories must be separate');
  if (!statSync(join(venue, 'records')).isDirectory()) throw new Error('Venue records directory required');
  // Older feed versions have no archive lock: stop those processes before using this command.
  const history = new TradeHistory({ dataDir: feed, log }); let keys;
  try {
    keys = await openKeyring(join(venue, 'keyring.json'), await readPassword('Venue keyring password: '));
    return importVenueStore({ store: openStore(venue, keys.storeKey, { readOnly: true }), history });
  } finally {
    keys?.storeKey.fill(0); keys?.solanaSecret?.fill(0); history.close();
  }
}

async function main() {
  const { values, tokens } = parseArgs({ options: { 'venue-data': { type: 'string' }, 'feed-data': { type: 'string' }, help: { type: 'boolean' } }, tokens: true });
  if (tokens.some((token, i) => tokens.slice(0, i).some(prior => prior.name === token.name))) throw new Error('Duplicate option');
  if (values.help) {
    process.stdout.write('Usage: node bin/feed-import-venue.mjs --venue-data <dir> --feed-data <dir>\n' +
      'Reads logged venue settlements read-only. Stop the feed first (older versions have no archive lock).\n' +
      'The venue keyring password is read without echo from a terminal, or from DEX_KEY_PASSWORD.\n');
    return;
  }
  const result = await importVenue({ venueData: values['venue-data'], feedData: values['feed-data'],
    readPassword: prompt => process.env.DEX_KEY_PASSWORD ?? hiddenInput(prompt) });
  for (const count of result.pairs) process.stdout.write(JSON.stringify(count) + '\n');
  process.stdout.write(JSON.stringify({ scanned: result.scanned, skipped: result.skipped }) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`Feed import failed: ${error.message}\n`); process.exitCode = 1; });
}
