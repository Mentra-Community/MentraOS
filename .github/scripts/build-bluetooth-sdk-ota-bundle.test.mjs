import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {buildPortableOtaBundle} from './build-bluetooth-sdk-ota-bundle.mjs';
import {configureOtaManifest} from './configure-bluetooth-sdk-ota-manifest.mjs';

const hash = (data) => createHash('sha256').update(data).digest('hex');

test('builds a portable template and configures a backward-compatible absolute manifest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mentra-ota-bundle-'));
  const outputDirectory = join(root, 'bundle');
  const sources = {
    'https://cdn.example.com/asg.apk': 'asg',
    'https://cdn.example.com/mtk.zip': 'mtk',
    'https://cdn.example.com/bes.bin': 'bes',
    'https://cdn.example.com/full.zip': 'full',
  };
  const localArtifacts = {};
  for (const [source, contents] of Object.entries(sources)) {
    const path = join(root, source.split('/').at(-1));
    writeFileSync(path, contents);
    localArtifacts[source] = path;
  }
  const manifest = {
    apps: {
      'com.mentra.asg_client': {
        versionCode: 100,
        versionName: '100',
        apkUrl: 'https://cdn.example.com/asg.apk',
        apkSize: 3,
        sha256: hash('asg'),
      },
    },
    mtk_patches: [
      {
        start_firmware: 'A',
        end_firmware: 'B',
        url: 'https://cdn.example.com/mtk.zip',
        sha256: hash('mtk'),
      },
    ],
    bes_firmware: {
      version: '1.2.3.4',
      url: 'https://cdn.example.com/bes.bin',
      sha256: hash('bes'),
    },
    mtk_full_ota: {end_firmware: '20260908.0', url: 'https://cdn.example.com/full.zip', sha256: hash('full'), size: 4},
  };

  const result = await buildPortableOtaBundle({manifest, outputDirectory, localArtifacts});

  assert.equal(result.artifactCount, 4);
  const portable = JSON.parse(readFileSync(join(outputDirectory, 'version.template.json'), 'utf8'));
  assert.equal(
    portable.apps['com.mentra.asg_client'].apkUrl,
    `artifacts/${hash('asg')}.apk`,
  );
  assert.equal(portable.mtk_patches[0].url, `artifacts/${hash('mtk')}.zip`);
  assert.equal(portable.mtk_full_ota.url, `artifacts/${hash('full')}.zip`);
  assert.equal(portable.bes_firmware.url, `artifacts/${hash('bes')}.bin`);
  assert.match(readFileSync(join(outputDirectory, 'SHA256SUMS'), 'utf8'), new RegExp(hash('asg')));
  assert.equal(existsSync(join(outputDirectory, 'version.json')), false);

  const finalManifestUrl = 'https://updates.example.com/mentra/v1/version.json';
  const configured = spawnSync(process.execPath, [join(outputDirectory, 'configure.mjs'), finalManifestUrl], {
    encoding: 'utf8',
  });
  assert.equal(configured.status, 0, configured.stderr);
  const configuredManifest = JSON.parse(readFileSync(join(outputDirectory, 'version.json'), 'utf8'));
  assert.equal(configuredManifest.mtk_full_ota.url, `https://updates.example.com/mentra/v1/artifacts/${hash('full')}.zip`);
  assert.equal(
    configuredManifest.apps['com.mentra.asg_client'].apkUrl,
    `https://updates.example.com/mentra/v1/artifacts/${hash('asg')}.apk`,
  );
  assert.equal(
    configuredManifest.mtk_patches[0].url,
    `https://updates.example.com/mentra/v1/artifacts/${hash('mtk')}.zip`,
  );
  assert.equal(
    configuredManifest.bes_firmware.url,
    `https://updates.example.com/mentra/v1/artifacts/${hash('bes')}.bin`,
  );
});

test('rejects a hash mismatch independently for every OTA component', async (t) => {
  const labels = {asg: 'ASG APK', mtk: 'MTK patch 0', full: 'MTK full OTA', bes: 'BES firmware'};
  for (const mismatchedKind of Object.keys(labels)) {
    await t.test(mismatchedKind, async () => {
      const root = mkdtempSync(join(tmpdir(), `mentra-ota-bundle-bad-${mismatchedKind}-`));
      const sources = {
        asg: 'https://cdn.example.com/asg.apk',
        mtk: 'https://cdn.example.com/mtk.zip',
        full: 'https://cdn.example.com/full.zip',
        bes: 'https://cdn.example.com/bes.bin',
      };
      const expected = {asg: 'expected-asg', mtk: 'expected-mtk', full: 'expected-full', bes: 'expected-bes'};
      const localArtifacts = {};
      for (const kind of Object.keys(sources)) {
        const path = join(root, `${kind}.bin`);
        writeFileSync(path, kind === mismatchedKind ? `tampered-${kind}` : expected[kind]);
        localArtifacts[sources[kind]] = path;
      }
      const manifest = {
        apps: {
          'com.mentra.asg_client': {apkUrl: sources.asg, sha256: hash(expected.asg)},
        },
        mtk_patches: [{url: sources.mtk, sha256: hash(expected.mtk)}],
        mtk_full_ota: {url: sources.full, sha256: hash(expected.full), size: expected.full.length},
        bes_firmware: {url: sources.bes, sha256: hash(expected.bes)},
      };

      await assert.rejects(
        buildPortableOtaBundle({
          manifest,
          outputDirectory: join(root, 'bundle'),
          localArtifacts,
        }),
        new RegExp(`${labels[mismatchedKind]} hash mismatch`),
      );
    });
  }
});

test('rejects a non-HTTP final manifest URL', () => {
  assert.throws(
    () => configureOtaManifest({apps: {}}, 'file:///tmp/version.json'),
    /must use HTTP\(S\)/,
  );
});

test('validates full size even when bytes were already bundled under the same hash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mentra-ota-size-'));
  const source = 'https://cdn.example.com/shared.zip';
  const file = join(root, 'shared.zip');
  writeFileSync(file, 'data');
  const artifact = {url: source, sha256: hash('data')};
  for (const size of [undefined, 0, -1, 1.5, '4', 1073741825, 3]) {
    const manifest = {
      apps: {'com.mentra.asg_client': {apkUrl: source, sha256: artifact.sha256}},
      mtk_patches: [artifact], bes_firmware: artifact,
      mtk_full_ota: {...artifact, size},
    };
    await assert.rejects(buildPortableOtaBundle({
      manifest, outputDirectory: join(root, 'bundle'), localArtifacts: {[source]: file},
    }), /MTK full OTA.*(?:size|GiB)/);
    assert.equal(existsSync(join(root, 'bundle', 'version.template.json')), false);
  }
});

test('rejects a final URL that does not match the generated manifest filename', () => {
  assert.throws(
    () => configureOtaManifest({apps: {}}, 'https://updates.example.com/manifest.json'),
    /must end with \/version\.json/,
  );
});
