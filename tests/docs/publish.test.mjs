import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const rules = [
  ['machine path', /\/(?:Application[s]|User[s]|home)(?:\/|\b)|\bMAM[P]\b|[a-z]:[\\/]Users[\\/]/i],
  ['process identifier', /\b(?:R[1-8](?:[-–]\d+)?|P(?:1[0-5]|[1-9])|Z[1-9][a-z]?)(?=[\s:/.-]|$)/i],
  ['process wording', /\b(?:brie[f]s?|second[- ]revie[w]|core[- ]fixe[s])\b|\b(?:review|round|finding)\s*#?\d+\b/i],
  ['process attribution', /\b(?:primar[y]|helpe[r]|owne[r]|agen[t])\s+(?:said|asked|requested|reviewed|replaced|fixed|implemented|approved|instructed)\b/i],
  ['development tooling', /\b(?:code[x]|claud[e]|opu[s]|sonne[t]|haik[u]|astr[a]|gemin[i]|gp[t][- ]?\d*|openmayhe[m]|opena[i]|windsur[f])\b|\bcurso[r]\s+(?:AI|IDE|editor|MCP)\b/i],
  ['machine identity', /\b(?:muffi[n]|playba[y]|castaway[s])\b|MAYHEM_INTERCO[M]/i],
  ['historical wording', /\b(?:previousl[y]|used t[o]|was vulnerabl[e]|regressio[n](?: for)?|the old (?:harness|implementation))\b/i],
  ['publication wording', /\b(?:local[- ]onl[y]|not publishe[d]|unpublishe[d])\b/i],
  ['private hostname', /\b(?:[a-z0-9-]+\.)+(?:interna[l]|loca[l]|la[n])\b(?!\.[a-z])/i],
];
const publicHosts = new Set([
  'nodejs.org', 'github.com', 'explorer.solana.com', 'circom.info', 'www.tradingview.com', 'reset.much.fun', 'www.apache.org', 'www.w3.org',
  'api.mainnet-beta.solana.com', 'public.rpc.solanavibestation.com', 'solana.api.pocket.network',
  'solana.leorpc.com', 'rpc.solanatracker.io', 'solana-rpc.publicnode.com',
  ['reset', 'open' + 'mayhem', 'ai'].join('.'),
]);
const bootstrapIPs = [[116, 202, 214, 149], [157, 180, 12, 214]].map(parts => parts.join('.'));
const localIP = ip => /^127\.\d+\.\d+\.\d+$/.test(ip) || ip === '0.0.0.0' || /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/.test(ip);
const excluded = file => /(^|\/)package-lock\.json$/.test(file) || file.startsWith('peer/vendor/reset/');
const privateFile = file => /(^|\/)(?:node_modules|\.test-tmp|\.local|data|dex-data|peer-data|logs|\.idea|\.vscode)(\/|$)|(?:\.log|\.sw[op]|~)$|(^|\/)\.DS_Store$/i.test(file);

function checkText(file, text) {
  const errors = [];
  for (const [i, line] of text.split('\n').entries()) {
    // Only this public gateway is exempt from the development-tool vocabulary.
    const words = line.replace(/https:\/\/reset\.openmayhe[m]\.ai(?=[/\s"'`)}]|$)/gi, '');
    for (const [label, pattern] of rules) if (pattern.test(words)) errors.push(`${file}:${i + 1}: ${label}`);
    for (const [ip] of line.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
      if (!localIP(ip) && !(file === 'networks/mainnet.json' && bootstrapIPs.includes(ip) && line.includes(`"${ip}:10001"`))) {
        errors.push(`${file}:${i + 1}: nonpublic server IP`);
      }
    }
    for (const [url] of line.matchAll(/(?:https?|wss?):\/\/[^\s"'`<>),;]+/gi)) {
      if (url.includes('${')) continue;
      let hostname;
      try { hostname = new URL(url).hostname; } catch { continue; }
      if (hostname !== 'localhost' && !localIP(hostname) && !publicHosts.has(hostname) && !/\.(?:example|invalid|test)$/.test(hostname)) {
        errors.push(`${file}:${i + 1}: unlisted URL host`);
      }
    }
  }
  return errors;
}

function checkFile(directory, file) {
  if (excluded(file)) return [];
  const path = join(directory, file);
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (privateFile(file)) return [`${file}:1: private artifact`];
  if (stat.isSymbolicLink()) return [`${file}:1: symlink must not ship`];
  if (!stat.isFile()) return [`${file}:1: expected a regular file`];
  const names = checkText(file, file), bytes = readFileSync(path);
  if (bytes.includes(0)) return names;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return names; }
  return [...names, ...checkText(file, text)];
}

test('release text checks reject private paths, process notes, historical wording and server details', () => {
  const bad = [
    ['/', 'Applications', '/project'].join(''), ['/', 'Users', '/person/project'].join(''),
    ['MAM', 'P'].join(''), ['R', '7-06: message'].join(''), ['Z', '9'].join(''), ['P', '15'].join(''),
    ['second', 'review'].join(' '), ['core', 'fixes'].join('-'), ['brie', 'f'].join(''),
    ['primary', 'replaced a file'].join(' '), ['clau', 'de'].join(''), ['code', 'x'].join(''),
    ['previous', 'ly'].join(''), ['used', 'to'].join(' '), ['was', 'vulnerable'].join(' '),
    ['regress', 'ion for'].join(''), ['local', 'only'].join(' '), ['not', 'published'].join(' '),
    ['un', 'published'].join(''), ['muf', 'fin'].join(''), ['play', 'bay'].join(''),
    [10, 23, 45, 67].join('.'), ['service', 'internal'].join('.'),
    'https://' + ['private-service', 'com'].join('.'),
  ];
  for (const value of bad) {
    const errors = checkText('sample.txt', 'public text\n' + value.toUpperCase());
    assert.ok(errors.length, `unchecked case: ${bad.indexOf(value)}`);
    assert.ok(errors.every(error => error.startsWith('sample.txt:2:')));
  }
});

test('release text checks allow protocol terms, generated fixtures and exact public endpoints', () => {
  const text = [
    'account.owner; transaction.attempt; Math.round(value); button.primary; helper functions; review the action; network.local.fund()',
    'http://127.0.0.1:12345', 'https://rpc.example', 'http://user:pass@127.0.0.1',
    'https://' + ['reset', 'open' + 'mayhem', 'ai'].join('.'),
  ].join('\n');
  assert.deepEqual(checkText('sample.txt', text), []);
  for (const ip of bootstrapIPs) {
    assert.deepEqual(checkText('networks/mainnet.json', `"${ip}:10001"`), []);
    assert.ok(checkText('sample.txt', ip).length);
  }
  assert.equal(excluded('peer/vendor/reset/contract/contract.js'), true);
  assert.equal(excluded('peer/package-lock.json'), true);
  assert.equal(excluded('package.json'), false);
  assert.equal(excluded('src/core/API.md'), false);
  for (const file of ['.local/note.md', '.test-tmp/capture.json', 'data/wallet.json', '.vscode/settings.json', 'run.log']) assert.equal(privateFile(file), true);
});

test('release file checks inspect new text and names without following symlinks or private artifacts', () => {
  const area = join(root, '.test-tmp/publish/scanner');
  mkdirSync(area, { recursive: true });
  const directory = mkdtempSync(join(area, 'files-'));
  writeFileSync(join(directory, 'public.md'), 'Public documentation');
  assert.deepEqual(checkFile(directory, 'public.md'), []);
  writeFileSync(join(directory, 'new.md'), ['local', 'only'].join(' '));
  assert.deepEqual(checkFile(directory, 'new.md'), ['new.md:1: publication wording']);
  writeFileSync(join(directory, 'binary.bin'), Buffer.from([0, 255, 254]));
  assert.deepEqual(checkFile(directory, 'binary.bin'), []);
  const name = ['Z', '9.bin'].join('');
  writeFileSync(join(directory, name), Buffer.from([0]));
  assert.ok(checkFile(directory, name).some(error => error.endsWith('process identifier')));
  symlinkSync('public.md', join(directory, 'link.md'));
  assert.deepEqual(checkFile(directory, 'link.md'), ['link.md:1: symlink must not ship']);
  mkdirSync(join(directory, '.local'));
  assert.deepEqual(checkFile(directory, '.local'), ['.local:1: private artifact']);
  assert.deepEqual(checkFile(directory, 'missing.md'), []);
  writeFileSync(join(directory, 'package-lock.json'), ['brie', 'f'].join(''));
  assert.deepEqual(checkFile(directory, 'package-lock.json'), []);
});

test('every tracked release text file is suitable for publication', () => {
  // Include new files before staging; deleted files are absent from the release tree.
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
  const errors = [...new Set(files.split('\0').filter(Boolean))].sort().flatMap(file => checkFile(root, file));
  assert.equal(errors.length, 0, '\n' + errors.join('\n'));
});
