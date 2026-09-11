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
  };

  const result = await buildPortableOtaBundle({manifest, outputDirectory, localArtifacts});

  assert.equal(result.artifactCount, 3);
  const portable = JSON.parse(readFileSync(join(outputDirectory, 'version.template.json'), 'utf8'));
  assert.equal(
    portable.apps['com.mentra.asg_client'].apkUrl,
    `artifacts/${hash('asg')}.apk`,
  );
  assert.equal(portable.mtk_patches[0].url, `artifacts/${hash('mtk')}.zip`);
  assert.equal(portable.bes_firmware.url, `artifacts/${hash('bes')}.bin`);
  assert.match(readFileSync(join(outputDirectory, 'SHA256SUMS'), 'utf8'), new RegExp(hash('asg')));
  assert.equal(existsSync(join(outputDirectory, 'version.json')), false);

  const finalManifestUrl = 'https://updates.example.com/mentra/v1/version.json';
  const configured = spawnSync(process.execPath, [join(outputDirectory, 'configure.mjs'), finalManifestUrl], {
    encoding: 'utf8',
  });
  assert.equal(configured.status, 0, configured.stderr);
  const configuredManifest = JSON.parse(readFileSync(join(outputDirectory, 'version.json'), 'utf8'));
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
  const labels = {asg: 'ASG APK', mtk: 'MTK patch 0', bes: 'BES firmware'};
  for (const mismatchedKind of Object.keys(labels)) {
    await t.test(mismatchedKind, async () => {
      const root = mkdtempSync(join(tmpdir(), `mentra-ota-bundle-bad-${mismatchedKind}-`));
      const sources = {
        asg: 'https://cdn.example.com/asg.apk',
        mtk: 'https://cdn.example.com/mtk.zip',
        bes: 'https://cdn.example.com/bes.bin',
      };
      const expected = {asg: 'expected-asg', mtk: 'expected-mtk', bes: 'expected-bes'};
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

test('rejects a final URL that does not match the generated manifest filename', () => {
  assert.throws(
    () => configureOtaManifest({apps: {}}, 'https://updates.example.com/manifest.json'),
    /must end with \/version\.json/,
  );
});
