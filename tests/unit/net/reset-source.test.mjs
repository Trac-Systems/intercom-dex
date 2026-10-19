import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyResetSource } from '../../../peer/src/trac/source.js';
import { subnetChannel } from '../../../peer/runtime/subnet-channel.js';
import { resolveNetwork, checkContractFiles } from '../../../src/net/profile.js';
import { walletOptions } from '../../../src/trac/wallet.js';

const pins = resolveNetwork({ network: 'mainnet' });
const sha = data => createHash('sha256').update(data).digest('hex');

test('all vendored sources are pinned; tampering is rejected before import', () => {
  checkContractFiles(pins);
  assert.deepEqual(walletOptions(pins), { networkPrefix: 'trac', derivationPath: "m/918'/0'/0'/0'" });
  const dir = mkdtempSync(join(tmpdir(), 'source-'));
  cpSync(new URL('../../../peer/vendor/reset/', import.meta.url), dir, { recursive: true });
  const source = { ...pins.peer.trac.reset.source, directory: dir };
  verifyResetSource(source, { local: true });
  assert.throws(() => verifyResetSource(source), /local tests/);
  assert.throws(() => verifyResetSource({ ...source, surprise: true }, { local: true }), /Invalid/);
  const manifest = readFileSync(join(dir, 'SOURCE.json'), 'utf8');
  writeFileSync(join(dir, 'SOURCE.json'), manifest + ' ');
  assert.throws(() => verifyResetSource(source, { local: true }), /SOURCE.json differs/);
  assert.throws(() => verifyResetSource({ ...source, manifestSha256: sha(manifest + ' ') }, { local: true }), /Invalid RESET SOURCE/);
  writeFileSync(join(dir, 'SOURCE.json'), manifest);
  for (const file of Object.keys(JSON.parse(manifest).files)) {
    const original = readFileSync(join(dir, file));
    writeFileSync(join(dir, file), 'throw new Error("must never execute");');
    assert.throws(() => verifyResetSource(source, { local: true }), /RESET source differs/);
    writeFileSync(join(dir, file), original);
  }
  const local = JSON.parse(readFileSync(new URL('../../../networks/local.json', import.meta.url)));
  const { trade: _trade, ...localPins } = pins;
  const profile = resolveNetwork({ ...localPins, network: 'local', peer: { ...pins.peer, environment: 'development', trac: { reset: { ...pins.peer.trac.reset, source } } } });
  checkContractFiles(profile);
  assert.throws(() => resolveNetwork({ network: 'mainnet', peer: { trac: { reset: { source } } } }), /Unknown network field/);
  assert.equal(local.peer.subnetChannel, undefined);
  renameSync(join(dir, 'contract/protocol.js'), join(dir, 'contract/original.js'));
  symlinkSync(join(dir, 'contract/original.js'), join(dir, 'contract/protocol.js'));
  assert.throws(() => verifyResetSource(source, { local: true }), /regular vendored tree/);
});

test('each peer persists its own random subnet channel and accepts operator configuration', () => {
  const a = mkdtempSync(join(tmpdir(), 'channel-')), b = mkdtempSync(join(tmpdir(), 'channel-'));
  const channel = subnetChannel(a);
  assert.match(channel, /^dex-[0-9a-f]{24}$/);
  assert.equal(subnetChannel(a), channel); assert.notEqual(subnetChannel(b), channel);
  assert.equal(subnetChannel(a, 'operator-topic'), 'operator-topic');
  assert.throws(() => subnetChannel('relative'), /Absolute/);
  assert.throws(() => subnetChannel(a, 'bad topic'), /Invalid/);
  writeFileSync(join(a, 'dex-channel'), 'invalid channel');
  assert.throws(() => subnetChannel(a), /Invalid stored/);
});
