#!/usr/bin/env node

// The portable archive cannot know its eventual hostname. Convert its relative template into the
// absolute artifact URLs required by public ASG build 39 before the directory is hosted.

import {existsSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

function requireManifestUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Manifest URL is invalid: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Manifest URL must use HTTP(S): ${value}`);
  }
  if (url.hash) {
    throw new Error('Manifest URL must not contain a fragment.');
  }
  if (!url.pathname.endsWith('/version.json')) {
    throw new Error('Manifest URL path must end with /version.json.');
  }
  return url;
}

function resolveField(entry, field, manifestUrl) {
  const reference = typeof entry?.[field] === 'string' ? entry[field].trim() : '';
  if (!reference) {
    return;
  }
  const resolved = new URL(reference, manifestUrl);
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    throw new Error(`Artifact URL must resolve to HTTP(S): ${reference}`);
  }
  entry[field] = resolved.toString();
}

export function configureOtaManifest(manifest, finalManifestUrl) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('OTA manifest must be a JSON object.');
  }
  const manifestUrl = requireManifestUrl(finalManifestUrl);
  const configured = structuredClone(manifest);

  for (const app of Object.values(configured.apps ?? {})) {
    resolveField(app, 'apkUrl', manifestUrl);
    resolveField(app, 'download', manifestUrl);
  }
  for (const patch of configured.mtk_patches ?? []) {
    resolveField(patch, 'url', manifestUrl);
    resolveField(patch, 'firmwareUrl', manifestUrl);
  }
  if (configured.bes_firmware) {
    resolveField(configured.bes_firmware, 'url', manifestUrl);
    resolveField(configured.bes_firmware, 'firmwareUrl', manifestUrl);
  }

  return configured;
}

function main() {
  const finalManifestUrl = process.argv[2];
  if (!finalManifestUrl || process.argv.length !== 3) {
    throw new Error('Usage: node configure.mjs https://updates.example.com/path/version.json');
  }

  const bundleDirectory = dirname(fileURLToPath(import.meta.url));
  const templatePath = join(bundleDirectory, 'version.template.json');
  const outputPath = join(bundleDirectory, 'version.json');
  const template = JSON.parse(readFileSync(templatePath, 'utf8'));
  const configured = configureOtaManifest(template, finalManifestUrl);
  writeFileSync(outputPath, `${JSON.stringify(configured, null, 2)}\n`);
  process.stdout.write(`Wrote ${outputPath} for ${finalManifestUrl}\n`);
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  main();
}
