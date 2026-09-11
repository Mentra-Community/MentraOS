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
      mtk_full_ota: {end_firmware: '20260908.0', url: 'https://example.com/full.zip', sha256: 'b'.repeat(64), size: 640341205},
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
  assert.equal(manifest.mtk_full_ota.end_firmware, '20260908.0');
  assert.equal(manifest.mtk_full_ota.size, 640341205);
  const inputsPath = path.join(path.dirname(outputPath), 'inputs.json');
  const collected = spawnSync(process.execPath, [
    path.resolve('.github/scripts/collect-ota-release-inputs.mjs'), outputPath, inputsPath,
  ], {encoding: 'utf8'});
  assert.equal(collected.status, 0, collected.stderr);
  assert.deepEqual(JSON.parse(readFileSync(inputsPath, 'utf8')).mtkFullOta, manifest.mtk_full_ota);
});

test('labels a pull request build manifest with its PR number and commit', () => {
  const {outputPath, result} = runManifestBuild('pr-3927-4987210f6e');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(outputPath, 'utf8')).releaseVersion, 'pr-3927-4987210f6e');
});

test('rejects a value outside the coordinated release identity format', () => {
  for (const invalid of ['asg.40', 'pr-3927', 'pr-0-4987210', 'pr-3927-branch']) {
    const {result} = runManifestBuild(invalid);
    assert.notEqual(result.status, 0, invalid);
    assert.match(result.stderr, /Invalid release version/);
  }
});
