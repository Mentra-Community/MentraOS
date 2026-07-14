import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASG_ANDROID_VERSION_CODE,
  assertTransportVersionCodeSafe,
  calculateModifiedEpochVersion,
  formatAsgVersionName,
  readPublishedAsgMetadata,
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

test('reads explicit ASG versions without treating the fixed transport code as logical', () => {
  assert.deepEqual(
    readPublishedAsgMetadata({
      apps: {
        'com.mentra.asg_client': {
          asgVersion: 48_332_721,
          versionCode: ASG_ANDROID_VERSION_CODE,
        },
      },
    }),
    {asgVersion: 48_332_721, versionCode: ASG_ANDROID_VERSION_CODE},
  );
  assert.deepEqual(
    readPublishedAsgMetadata({
      apps: {'com.mentra.asg_client': {versionCode: ASG_ANDROID_VERSION_CODE}},
    }),
    {asgVersion: 0, versionCode: ASG_ANDROID_VERSION_CODE},
  );
  assert.deepEqual(
    readPublishedAsgMetadata({
      apps: {'com.mentra.asg_client': {versionCode: 47_442_366}},
    }),
    {asgVersion: 47_442_366, versionCode: 47_442_366},
  );
});
