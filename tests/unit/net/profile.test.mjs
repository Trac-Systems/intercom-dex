import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveNetwork, checkProfileTerms, checkPeerProfile, checkContractFiles } from '../../../src/net/profile.js';
import { buildDraft, offerIdOf } from '../../../src/roles/common.js';
import { fixture, SOL, SOL2, MINT, hex } from '../core/helpers.mjs';

function localConfig() {
  return { network: 'local', mint: MINT, platformCollector: SOL, peer: { environment: 'development',
    msbBootstrap: hex(), msbChannel: 'local-msb', msbNetworkId: 918, msbDhtBootstrap: ['127.0.0.1:12345'],
    peerDhtBootstrap: ['127.0.0.1:12345'], trac: { reset: {
      bootstrap: hex(), channel: 'local-reset', dhtBootstrap: ['127.0.0.1:12345'],
    } } } };
}

function leaves(object, prefix = []) {
  return Object.entries(object).flatMap(([key, value]) => value && typeof value === 'object' && !Array.isArray(value)
    ? leaves(value, [...prefix, key]) : [[...prefix, key]]);
}
function change(path, value) { return path.reduceRight((next, key) => ({ [key]: next }), value); }

test('mainnet refuses every pinned leaf override and does not take missing pins from operator config', () => {
  const pins = JSON.parse(readFileSync(new URL('../../../networks/mainnet.json', import.meta.url)));
  assert.equal(pins.mint, MINT); assert.equal(pins.programId, SOL2);
  for (const field of leaves(pins)) {
    const config = { network: 'mainnet', ...change(field, 'different') };
    assert.throws(() => resolveNetwork(config), /Mainnet pins/, field.join('.'));
  }
  for (const key of ['mint', 'programId', 'platformCollector']) {
    assert.throws(() => resolveNetwork({ network: 'mainnet', solana: { [key]: 'different' } }), /Mainnet pins/);
  }
  assert.throws(() => resolveNetwork({ network: 'mainnet', mint: 'different', solana: { mint: MINT } }), /pins mint/);
  assert.throws(() => resolveNetwork({ network: 'mainnet', peer: { msbChannel: 'different' }, msbChannel: pins.peer.msbChannel }), /pins peer.msbChannel/);
  assert.throws(() => resolveNetwork({ network: 'mainnet', trac: { reset: { bootstrap: hex() } } }), /pins peer.trac.reset.bootstrap/);
  assert.equal(resolveNetwork({ network: 'mainnet' }).peer.msbNetworkId, 918);
  assert.deepEqual(resolveNetwork({ network: 'mainnet', trade: pins.trade }).trade,
    { sendWindowSec: 900, refundSec: 172800, graceSec: 300, minK: 2 });
  assert.throws(() => resolveNetwork({ network: 'mainnet', trade: null }), /Mainnet pins trade/);
  assert.throws(() => resolveNetwork({ network: 'mainnet', trade: { extra: 1 } }), /Unknown network field/);
  assert.ok(!JSON.stringify(pins).includes('REQUIRED:'));
  assert.equal(pins.peer.msbChannel.length, 32);
  assert.equal(resolveNetwork({ network: 'mainnet', subnetChannel: 'operator-topic' }).peer.subnetChannel, undefined);
  for (const network of [undefined, 'testnet', '../mainnet']) assert.throws(() => resolveNetwork({ network }), /Choose network/);
});

test('local profiles accept pinned field overrides, validate types and bind peer and contract identity', () => {
  const config = localConfig(), profile = resolveNetwork(config);
  assert.equal(profile.trade, undefined);
  assert.equal(profile.peer.msbBootstrap, config.peer.msbBootstrap);
  assert.equal(resolveNetwork({ ...config, mint: SOL2, programId: SOL, platformCollector: SOL2 }).mint, SOL2);
  checkPeerProfile({ networkProfile: profile }, profile);
  assert.throws(() => checkPeerProfile({}, profile), /differs/);
  assert.throws(() => checkPeerProfile({ networkProfile: { ...profile, mint: SOL } }, profile), /differs/);
  checkContractFiles(profile);
  assert.throws(() => checkContractFiles({ ...profile, peer: { ...profile.peer, trac: { reset: { ...profile.peer.trac.reset, source: { ...profile.peer.trac.reset.source, manifestSha256: hex() } } } } }), /differs/);
  for (const patch of [{ mint: 'bad' }, { peer: { ...config.peer, msbNetworkId: -1 } },
    { peer: { ...config.peer, msbChannel: '' } }, { peer: { ...config.peer, msbDhtBootstrap: [] } },
    { peer: { ...config.peer, msbBootstrap: 'bad' } }, { peer: { ...config.peer, surprise: true } }]) {
    assert.throws(() => resolveNetwork({ ...config, ...patch }));
  }
});

test('two traders derive identical terms from the same profile, and off-profile terms are refused', () => {
  const f = fixture(), profile = resolveNetwork(localConfig());
  const maker = { dexKey: f.terms.seller.dexKey, tracAddr: f.terms.seller.tracAddr, solAddr: f.terms.seller.solRecipient };
  const taker = { dexKey: f.terms.buyer.dexKey, tracAddr: f.terms.buyer.tracAddr, solAddr: f.terms.buyer.solPayer };
  const offer = { pair: 'TNK/USDC', side: 'sell', baseAmount: '1000000000000000000', price: '1', maker, peerKey: hex(), expiresAt: 10000, software: '0.1.0', registryVersion: 1 };
  offer.offerId = offerIdOf(offer);
  const args = { offer, baseAmount: offer.baseAmount, maker, taker, registry: f.registry, sendBy: 1000, refundAfter: 86500,
    mint: profile.mint, platformCollector: profile.platformCollector };
  const a = buildDraft(args), b = buildDraft(structuredClone(args));
  assert.deepEqual(a, b); checkProfileTerms(a, profile);
  assert.throws(() => checkProfileTerms({ ...a, mint: SOL }, profile), /profile/);
  assert.throws(() => checkProfileTerms({ ...a, fees: { ...a.fees, platformCollector: SOL2 } }, profile), /profile/);
});

test('CLI rejects mainnet overrides with a plain message before any key, peer or RPC access', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'config-')), 'role.json');
  writeFileSync(file, JSON.stringify({ network: 'mainnet', role: 'trader', mint: SOL }));
  const result = spawnSync(process.execPath, ['bin/dex.mjs', '--config', file], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Mainnet pins mint; config overrides are refused\n$/);
});
