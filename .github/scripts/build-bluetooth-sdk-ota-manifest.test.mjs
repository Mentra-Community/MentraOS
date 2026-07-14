import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

test('builds an immutable ASG pin with a mutable firmware reference', () => {
  const outputPath = join(mkdtempSync(join(tmpdir(), 'asg-manifest-')), 'version.json');
  const result = spawnSync(process.execPath, ['.github/scripts/build-bluetooth-sdk-ota-manifest.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      ASG_APK_SHA256: 'a'.repeat(64),
      ASG_APK_SIZE: '123',
      ASG_APK_URL: 'https://example.com/asg.apk',
      ASG_VERSION: '48332721',
      ASG_VERSION_CODE: '1000000000',
      ASG_VERSION_NAME: '2026.07.13-501addc',
      FIRMWARE_MANIFEST_URL: 'https://ota.mentraglass.com/prod_live_version_v2.json',
      OUTPUT_PATH: outputPath,
      SDK_VERSION: '0.1.20',
      SOURCE_COMMIT: '501addc805abcdef501addc805abcdef501addc8',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(outputPath, 'utf8'));
  assert.equal(manifest.apps['com.mentra.asg_client'].asgVersion, 48332721);
  assert.equal(manifest.apps['com.mentra.asg_client'].versionCode, 1000000000);
  assert.equal(manifest.sourceCommit, '501addc805abcdef501addc805abcdef501addc8');
  assert.equal(manifest.firmwareManifestUrl, 'https://ota.mentraglass.com/prod_live_version_v2.json');
  assert.equal(manifest.mtk_patches, undefined);
  assert.equal(manifest.bes_firmware, undefined);
});
