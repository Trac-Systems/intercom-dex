import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyPearRunRequested, parsePearMajor, selectPearRunnerMode } from '../../../peer/scripts/pear-runner.mjs';

test('legacy Pear execution requires the explicit DEX setting', () => {
  for (const value of ['1', 'true', ' YES ']) assert.equal(legacyPearRunRequested({ DEX_LEGACY_PEAR_RUN: value }), true);
  for (const value of ['', '0', 'false', 'other', undefined]) assert.equal(legacyPearRunRequested({ DEX_LEGACY_PEAR_RUN: value }), false);
});

test('Pear version detection selects legacy execution only below version three', () => {
  for (const value of ['{"semver":"2.1.0"}', 'SemVer: v2.1.0', 'pear/2.1.0']) {
    assert.equal(parsePearMajor(value), 2); assert.equal(selectPearRunnerMode(value), 'legacy');
  }
  assert.equal(selectPearRunnerMode('{"version":"3.0.0"}'), 'module');
  for (const value of ['', null, 'unrecognized', '{broken']) {
    assert.equal(parsePearMajor(value), null); assert.equal(selectPearRunnerMode(value), 'module');
  }
});
