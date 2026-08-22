import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {buildPortableOtaBundle} from './build-bluetooth-sdk-ota-bundle.mjs';

const hash = (data) => createHash('sha256').update(data).digest('hex');

test('builds a host-relative bundle from the canonical manifest', async () => {
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
  const portable = JSON.parse(readFileSync(join(outputDirectory, 'version.json'), 'utf8'));
  assert.equal(
    portable.apps['com.mentra.asg_client'].apkUrl,
    `artifacts/${hash('asg')}.apk`,
  );
  assert.equal(portable.mtk_patches[0].url, `artifacts/${hash('mtk')}.zip`);
  assert.equal(portable.bes_firmware.url, `artifacts/${hash('bes')}.bin`);
  assert.match(readFileSync(join(outputDirectory, 'SHA256SUMS'), 'utf8'), new RegExp(hash('asg')));
});

test('rejects an artifact that does not match the canonical manifest hash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mentra-ota-bundle-bad-'));
  const artifact = join(root, 'asg.apk');
  writeFileSync(artifact, 'tampered');
  const source = 'https://cdn.example.com/asg.apk';
  const manifest = {
    apps: {
      'com.mentra.asg_client': {apkUrl: source, sha256: hash('expected')},
    },
    mtk_patches: [{url: source, sha256: hash('expected')}],
    bes_firmware: {url: source, sha256: hash('expected')},
  };

  await assert.rejects(
    buildPortableOtaBundle({
      manifest,
      outputDirectory: join(root, 'bundle'),
      localArtifacts: {[source]: artifact},
    }),
    /hash mismatch/,
  );
});
