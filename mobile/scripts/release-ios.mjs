#!/usr/bin/env zx

import { setBuildEnv } from './set-build-env.mjs';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseVersion(version) {
  const [major, minor] = version.split('.');
  return { major, minor };
}

function ghTag(version) {
  const { major, minor } = parseVersion(version);
  return `v${major}.${minor}`;
}

function ipaPrefix(version) {
  const { major, minor } = parseVersion(version);
  return `MentraOS_iOS_${major}p${minor}`;
}

// ── Load App Store Connect credentials ────────────────────────────────────────

function loadASCConfig() {
  const configPath = path.join(os.homedir(), '.mentra', 'credentials', 'appstore-connect.env');
  if (!existsSync(configPath)) {
    return null;
  }
  const content = require('fs').readFileSync(configPath, 'utf-8');
  const config = {};
  for (const line of content.split('\n')) {
    const match = line.match(/^(\w+)=(.+)$/);
    if (match) {
      config[match[1]] = match[2].replace(/^~/, os.homedir());
    }
  }
  return config;
}

// ── Step 1: Read version from .env ────────────────────────────────────────────

console.log('\n━━━ Step 1: Reading version from .env ━━━');
await setBuildEnv();

const version = process.env.EXPO_PUBLIC_MENTRAOS_VERSION;
if (!version) {
  console.error('EXPO_PUBLIC_MENTRAOS_VERSION not found in .env');
  process.exit(1);
}

const tag = ghTag(version);
const prefix = ipaPrefix(version);
console.log(`Version: ${version} → tag: ${tag}, prefix: ${prefix}`);

// ── Step 2: Prebuild iOS ──────────────────────────────────────────────────────

console.log('\n━━━ Step 2: Prebuild iOS ━━━');
await $({ stdio: 'inherit' })`bun expo prebuild --platform ios`;

// Copy .env to ios/.xcode.env.local so build env vars are available
await $({ stdio: 'inherit' })`cp .env ios/.xcode.env.local`;

// ── Step 3: Archive ───────────────────────────────────────────────────────────

console.log('\n━━━ Step 3: Archiving ━━━');

const archivePath = path.resolve('build/MentraOS.xcarchive');

await $({ stdio: 'inherit' })`xcodebuild archive -workspace ios/MentraOS.xcworkspace -scheme MentraOS -configuration Release -destination generic/platform=iOS -archivePath ${archivePath}`;

if (!existsSync(archivePath)) {
  console.error('Archive not found at:', archivePath);
  process.exit(1);
}
console.log('Archive created successfully');

// ── Step 4: Export IPA ────────────────────────────────────────────────────────

console.log('\n━━━ Step 4: Exporting IPA ━━━');

const exportPath = path.resolve('build/ios-export');
const exportOptionsPlist = path.resolve('ios-export/ExportOptions.plist');

await $({ stdio: 'inherit' })`xcodebuild -exportArchive -archivePath ${archivePath} -exportOptionsPlist ${exportOptionsPlist} -exportPath ${exportPath} -allowProvisioningUpdates`;

// Find the exported IPA
const ipaFiles = (await $`ls ${exportPath}/*.ipa`).stdout.trim().split('\n').filter(Boolean);
if (ipaFiles.length === 0) {
  console.error('No IPA found in export path:', exportPath);
  process.exit(1);
}
const ipaPath = ipaFiles[0];
console.log('IPA exported:', ipaPath);

// ── Step 5: Upload to App Store Connect (TestFlight) ──────────────────────────

console.log('\n━━━ Step 5: Uploading to App Store Connect ━━━');

const ascConfig = loadASCConfig();

if (!ascConfig || !ascConfig.ASC_API_KEY_ID || !ascConfig.ASC_API_ISSUER_ID || !existsSync(ascConfig.ASC_API_KEY_PATH || '')) {
  console.log('⚠️  App Store Connect credentials not found at ~/.mentra/credentials/appstore-connect.env');
  console.log('   Skipping TestFlight upload.');
  console.log('   To enable: create ~/.mentra/credentials/appstore-connect.env with ASC_API_KEY_ID, ASC_API_ISSUER_ID, ASC_API_KEY_PATH');
} else {
  // altool looks for AuthKey_<id>.p8 in $API_PRIVATE_KEYS_DIR
  const keyDir = path.dirname(ascConfig.ASC_API_KEY_PATH);
  await $({ stdio: 'inherit', env: { ...process.env, API_PRIVATE_KEYS_DIR: keyDir } })`xcrun altool --upload-app -f ${ipaPath} -t ios --apiKey ${ascConfig.ASC_API_KEY_ID} --apiIssuer ${ascConfig.ASC_API_ISSUER_ID}`;
  console.log('IPA uploaded to App Store Connect (TestFlight)');
}

// ── Step 6: Upload IPA to GitHub release ──────────────────────────────────────

console.log('\n━━━ Step 6: Uploading IPA to GitHub release ━━━');

// Check gh CLI is available and authenticated
try {
  await $`gh auth status`;
} catch {
  console.error('gh CLI is not authenticated. Run `gh auth login` first.');
  process.exit(1);
}

let betaNumber = 1;
let releaseExists = false;

try {
  const assetsJson = (await $`gh release view ${tag} --json assets -q .assets`).stdout.trim();
  releaseExists = true;
  if (assetsJson && assetsJson !== 'null') {
    const assets = JSON.parse(assetsJson);
    // Find the latest APK beta number and use the same number for iOS
    const apkBetas = assets
      .map(a => a.name)
      .filter(name => name.endsWith('.apk'))
      .map(name => {
        const match = name.match(/_Beta_(\d+)\.apk$/);
        return match ? parseInt(match[1], 10) : 0;
      })
      .filter(n => n > 0);
    if (apkBetas.length > 0) {
      betaNumber = Math.max(...apkBetas);
    }
  }
} catch {
  releaseExists = false;
}

const ipaName = `${prefix}_Beta_${betaNumber}.ipa`;
const renamedIpaPath = path.resolve('build/ios-export', ipaName);
await $`mv ${ipaPath} ${renamedIpaPath}`;
console.log(`IPA renamed to: ${ipaName} (Beta ${betaNumber})`);

if (!releaseExists) {
  console.log(`Creating new pre-release: ${tag}`);
  await $({ stdio: 'inherit' })`gh release create ${tag} --prerelease --title ${tag} --notes ${'Pre-release ' + tag}`;
}

await $({ stdio: 'inherit' })`gh release upload ${tag} ${renamedIpaPath} --clobber`;
console.log(`Uploaded ${ipaName} to release ${tag}`);

// ── Done ──────────────────────────────────────────────────────────────────────

const repoName = (await $`gh repo view --json nameWithOwner -q .nameWithOwner`).stdout.trim();
const ipaUrl = `https://github.com/${repoName}/releases/download/${tag}/${ipaName}`;

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('iOS release complete!');
console.log(`  Version: ${version}`);
console.log(`  IPA: ${ipaUrl}`);
if (ascConfig && existsSync(ascConfig.ASC_API_KEY_PATH || '')) {
  console.log('  TestFlight: uploaded');
}
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
