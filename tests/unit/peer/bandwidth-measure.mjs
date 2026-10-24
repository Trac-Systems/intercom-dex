// source ~/.nvm/nvm.sh && nvm use 23.11.0
// node tests/unit/peer/bandwidth-measure.mjs [trader-count]
// node tests/unit/peer/bandwidth-measure.mjs --snapshots < two-bandwidth-stats-responses.ndjson
import { measurePublic, measureReplication, difference } from './bandwidth-fixture.mjs';

const rates = (rows, seconds) => {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.layer}/${row.subsystem}/${row.direction}`;
    groups.set(key, (groups.get(key) ?? 0) + row.bytes);
  }
  return Object.fromEntries([...groups].map(([key, bytes]) => [key, { bytes, KBps: +(bytes / seconds / 1000).toFixed(4) }]));
};
if (process.argv[2] === '--snapshots') {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const snapshots = input.trim().split('\n').map(line => { const value = JSON.parse(line); return value.stats ?? value; });
  if (snapshots.length !== 2 || snapshots.some(s => !Number.isFinite(s.at) || !Array.isArray(s.rows)) ||
    snapshots[1].at <= snapshots[0].at || snapshots[0].started !== snapshots[1].started) throw new Error('Two increasing snapshots from the same peer run are required');
  const rows = difference(...snapshots), seconds = (snapshots[1].at - snapshots[0].at) / 1000;
  console.log(JSON.stringify({ seconds, rows, rates: rates(rows, seconds) }));
} else {
  const traders = Number(process.argv[2] ?? 24);
  if (!Number.isInteger(traders) || traders < 2 || traders > 58) throw new Error('Choose 2..58 traders');
  for (const legacy of [true, false]) {
    const result = await measurePublic({ legacy, books: true, traders });
    console.log(JSON.stringify({ scenario: legacy ? 'public-before' : 'public-after', ...result,
      rates: rates(result.rows, result.seconds) }));
  }
  const replication = await measureReplication();
  console.log(JSON.stringify({ scenario: 'deterministic-RESET-view-replay', ...replication,
    note: 'Rates normalize each header to 600 seconds; no mainnet state or transactions. DHT/relay/UDP not exercised by the in-memory links.',
    readerRates: rates(replication.reader, replication.rounds * 600),
    writerRates: rates(replication.writer, replication.rounds * 600) }));
}
