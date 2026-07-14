import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASG_ANDROID_VERSION_CODE,
  assertTransportVersionCodeSafe,
  calculateModifiedEpochVersion,
  formatAsgVersionName,
  resolveAsgVersion,
} from './asg-version.mjs';

test('continues the historical modified-epoch sequence', () => {
  assert.equal(calculateModifiedEpochVersion(1_735_689_600), 100_000);
  assert.equal(calculateModifiedEpochVersion(1_783_922_321), 48_332_721);
  assert.equal(ASG_ANDROID_VERSION_CODE, 1_000_000_000);
});

test('advances past a same-second or clock-skewed published version', () => {
  assert.equal(resolveAsgVersion(1_783_922_321, 48_332_721), 48_332_722);
  assert.equal(resolveAsgVersion(1_783_922_300, 48_332_721), 48_332_722);
});

test('formats a diagnostic-only UTC version name', () => {
  assert.equal(
    formatAsgVersionName(1_783_922_321, '501addc805abcdef', 'staging'),
    'staging.2026.07.13.055841-501addc805ab',
  );
});

test('fixed Android transport version is not below a published artifact', () => {
  assert.doesNotThrow(() => assertTransportVersionCodeSafe([39, 48_332_721, 1_000_000_000]));
  assert.throws(() => assertTransportVersionCodeSafe([1_000_000_001]), /not above published/);
});
