import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const script = path.resolve('.github/scripts/build-bluetooth-sdk-ota-manifest.mjs');

function runManifestBuild(releaseVersion) {
  const root = mkdtempSync(path.join(tmpdir(), 'mentra-ota-manifest-'));
  const firmwarePath = path.join(root, 'firmware.json');
  const outputPath = path.join(root, 'version.json');
  writeFileSync(
    firmwarePath,
    JSON.stringify({
      mtk_patches: [{start_firmware: 'A', end_firmware: 'B', url: 'https://example.com/mtk.zip'}],
      bes_firmware: {version: '1.0.0', url: 'https://example.com/bes.bin'},
    }),
  );
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ASG_APK_SHA256: 'a'.repeat(64),
      ASG_APK_SIZE: '123',
      ASG_APK_URL: 'https://example.com/asg.apk',
      ASG_VERSION_CODE: '40',
      ASG_VERSION_NAME: 'asg.40',
      FIRMWARE_MANIFEST: firmwarePath,
      OUTPUT_PATH: outputPath,
      RELEASE_VERSION: releaseVersion,
    },
  });
  return {outputPath, result};
}

test('writes the coordinated release version independently of the ASG version', () => {
  const {outputPath, result} = runManifestBuild('3.1.0-beta.3');
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(outputPath, 'utf8'));
  assert.equal(manifest.releaseVersion, '3.1.0-beta.3');
  assert.equal(manifest.apps['com.mentra.asg_client'].versionName, 'asg.40');
});

test('rejects a value outside the coordinated release identity format', () => {
  const {result} = runManifestBuild('asg.40');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid coordinated release version/);
});
