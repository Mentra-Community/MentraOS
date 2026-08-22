#!/usr/bin/env node

import {createHash} from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import {basename, extname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ASG_PACKAGE = 'com.mentra.asg_client';
const FIXED_MTIME = new Date('1980-01-01T00:00:00.000Z');

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function requireSha256(entry, label) {
  const value = typeof entry?.sha256 === 'string' ? entry.sha256.trim().toLowerCase() : '';
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} is missing a valid sha256.`);
  }
  return value;
}

function artifactExtension(source) {
  let extension = '';
  try {
    extension = extname(new URL(source).pathname).toLowerCase();
  } catch {
    extension = extname(source).toLowerCase();
  }
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.bin';
}

function collectArtifactReferences(manifest) {
  const references = [];
  const app = manifest.apps?.[ASG_PACKAGE];
  if (!app || typeof app.apkUrl !== 'string' || app.apkUrl.length === 0) {
    throw new Error(`Manifest is missing apps["${ASG_PACKAGE}"].apkUrl.`);
  }
  references.push({entry: app, key: 'apkUrl', label: 'ASG APK', sha256: requireSha256(app, 'ASG APK')});

  if (!Array.isArray(manifest.mtk_patches) || manifest.mtk_patches.length === 0) {
    throw new Error('Manifest must contain at least one MTK patch.');
  }
  manifest.mtk_patches.forEach((entry, index) => {
    const key = typeof entry?.url === 'string' && entry.url.length > 0 ? 'url' : 'firmwareUrl';
    if (typeof entry?.[key] !== 'string' || entry[key].length === 0) {
      throw new Error(`MTK patch ${index} is missing a URL.`);
    }
    references.push({entry, key, label: `MTK patch ${index}`, sha256: requireSha256(entry, `MTK patch ${index}`)});
  });

  const bes = manifest.bes_firmware;
  const besKey = typeof bes?.url === 'string' && bes.url.length > 0 ? 'url' : 'firmwareUrl';
  if (!bes || typeof bes[besKey] !== 'string' || bes[besKey].length === 0) {
    throw new Error('Manifest is missing a BES firmware URL.');
  }
  references.push({entry: bes, key: besKey, label: 'BES firmware', sha256: requireSha256(bes, 'BES firmware')});
  return references;
}

async function readSource(source, localArtifacts) {
  const localPath = localArtifacts[source];
  if (localPath) {
    return readFileSync(localPath);
  }
  const url = new URL(source);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Artifact source must be HTTP(S) or supplied locally: ${source}`);
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Artifact download failed with HTTP ${response.status}: ${source}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function buildPortableOtaBundle({manifest, outputDirectory, localArtifacts = {}}) {
  const portableManifest = structuredClone(manifest);
  const references = collectArtifactReferences(portableManifest);
  const artifactsDirectory = join(outputDirectory, 'artifacts');
  mkdirSync(artifactsDirectory, {recursive: true});

  const bundledByHash = new Map();
  for (const reference of references) {
    const source = reference.entry[reference.key];
    let fileName = bundledByHash.get(reference.sha256);
    if (!fileName) {
      const data = await readSource(source, localArtifacts);
      const actualSha256 = sha256(data);
      if (actualSha256 !== reference.sha256) {
        throw new Error(`${reference.label} hash mismatch: expected ${reference.sha256}, got ${actualSha256}.`);
      }
      fileName = `${reference.sha256}${artifactExtension(source)}`;
      const destination = join(artifactsDirectory, fileName);
      writeFileSync(destination, data);
      utimesSync(destination, FIXED_MTIME, FIXED_MTIME);
      bundledByHash.set(reference.sha256, fileName);
    }

    const relativePath = `artifacts/${fileName}`;
    reference.entry[reference.key] = relativePath;
    if (reference.key === 'url' && typeof reference.entry.firmwareUrl === 'string') {
      reference.entry.firmwareUrl = relativePath;
    }
    if (reference.key === 'firmwareUrl' && typeof reference.entry.url === 'string') {
      reference.entry.url = relativePath;
    }
  }

  const manifestPath = join(outputDirectory, 'version.json');
  writeFileSync(manifestPath, `${JSON.stringify(portableManifest, null, 2)}\n`);
  utimesSync(manifestPath, FIXED_MTIME, FIXED_MTIME);

  const sums = [...bundledByHash.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([hash, fileName]) => `${hash}  artifacts/${fileName}`)
    .join('\n');
  const sumsPath = join(outputDirectory, 'SHA256SUMS');
  writeFileSync(sumsPath, `${sums}\n`);
  utimesSync(sumsPath, FIXED_MTIME, FIXED_MTIME);
  utimesSync(artifactsDirectory, FIXED_MTIME, FIXED_MTIME);
  utimesSync(outputDirectory, FIXED_MTIME, FIXED_MTIME);

  return {artifactCount: bundledByHash.size, manifest: portableManifest};
}

async function readManifest(source) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`Manifest download failed with HTTP ${response.status}: ${source}`);
    }
    return await response.json();
  }
  return JSON.parse(readFileSync(source, 'utf8'));
}

async function main() {
  const manifestSource = process.env.MANIFEST_SOURCE;
  const outputDirectory = process.env.OUTPUT_DIRECTORY;
  if (!manifestSource || !outputDirectory) {
    throw new Error('MANIFEST_SOURCE and OUTPUT_DIRECTORY are required.');
  }
  const localArtifacts = process.env.LOCAL_ARTIFACTS_JSON
    ? JSON.parse(process.env.LOCAL_ARTIFACTS_JSON)
    : {};
  const manifest = await readManifest(manifestSource);
  const result = await buildPortableOtaBundle({manifest, outputDirectory, localArtifacts});
  process.stdout.write(
    `Built portable OTA bundle ${basename(outputDirectory)} with ${result.artifactCount} unique artifacts.\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
