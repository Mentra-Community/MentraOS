#!/usr/bin/env zx

import { setBuildEnv } from './set-build-env.mjs';
import { readFile, writeFile, cp, mkdir } from 'fs/promises';
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

function apkPrefix(version) {
  const { major, minor } = parseVersion(version);
  return `MentraOS_${major}p${minor}`;
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
const prefix = apkPrefix(version);
console.log(`Version: ${version} → tag: ${tag}, prefix: ${prefix}`);

// ── Step 2: Bump versionCode in app.config.ts ─────────────────────────────────

console.log('\n━━━ Step 2: Bumping versionCode in app.config.ts ━━━');
const configPath = path.resolve('app.config.ts');
let configContent = await readFile(configPath, 'utf-8');

const versionCodeMatch = configContent.match(/versionCode:\s*(\d+)/);
if (!versionCodeMatch) {
  console.error('Could not find versionCode in app.config.ts');
  process.exit(1);
}

const oldVersionCode = parseInt(versionCodeMatch[1], 10);
const newVersionCode = oldVersionCode + 1;
configContent = configContent.replace(
  /versionCode:\s*\d+/,
  `versionCode: ${newVersionCode}`
);
await writeFile(configPath, configContent);
console.log(`versionCode: ${oldVersionCode} → ${newVersionCode}`);

// ── Step 3: Prebuild + bundle ────────────────────────────────────────────────

console.log('\n━━━ Step 3: Prebuild + bundle ━━━');
process.env.ORG_GRADLE_PROJECT_reactNativeArchitectures = 'arm64-v8a';

// Clean android/ to avoid cached version number issues
await $({ stdio: 'inherit' })`rm -rf android`;
await $({ stdio: 'inherit' })`bun expo prebuild --platform android`;
await $({ stdio: 'inherit' })`bun expo export --platform android`;

// ── Step 4: Copy fastlane config into android/ ────────────────────────────────

console.log('\n━━━ Step 4: Copying fastlane config into android/ ━━━');
const fastlaneSrc = path.resolve('fastlane-android');
const fastlaneDst = path.resolve('android', 'fastlane');
await mkdir(fastlaneDst, { recursive: true });
for (const file of ['Fastfile', 'Appfile', 'Gemfile']) {
  await cp(path.join(fastlaneSrc, file), path.join(fastlaneDst, file));
}
// Also copy Gemfile to android/ root so `bundle exec` works from android/ cwd
await cp(path.join(fastlaneSrc, 'Gemfile'), path.resolve('android', 'Gemfile'));
console.log('Fastlane config copied to android/fastlane/');

// ── Step 5: Build APK ─────────────────────────────────────────────────────────

console.log('\n━━━ Step 5: Building APK ━━━');
await $({ stdio: 'inherit', cwd: 'android' })`./gradlew assembleRelease`;

const apkPath = path.resolve('android/app/build/outputs/apk/release/app-release.apk');
if (!existsSync(apkPath)) {
  console.error('APK not found at expected path:', apkPath);
  process.exit(1);
}
console.log('APK built successfully');

// ── Step 6: Determine beta number & rename APK ───────────────────────────────

console.log('\n━━━ Step 6: Determining beta number ━━━');

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
    const betaNumbers = assets
      .map(a => a.name)
      .filter(name => name.startsWith(prefix) && name.endsWith('.apk'))
      .map(name => {
        const match = name.match(/_Beta_(\d+)\.apk$/);
        return match ? parseInt(match[1], 10) : 0;
      })
      .filter(n => n > 0);
    if (betaNumbers.length > 0) {
      betaNumber = Math.max(...betaNumbers) + 1;
    }
  }
} catch {
  // Release doesn't exist yet
  releaseExists = false;
}

const apkName = `${prefix}_Beta_${betaNumber}.apk`;
const renamedApkPath = path.resolve('android/app/build/outputs/apk/release', apkName);
await $`mv ${apkPath} ${renamedApkPath}`;
console.log(`APK renamed to: ${apkName} (Beta ${betaNumber})`);

// ── Step 7: Upload APK to GitHub release ──────────────────────────────────────

console.log('\n━━━ Step 7: Uploading APK to GitHub release ━━━');

if (!releaseExists) {
  console.log(`Creating new pre-release: ${tag}`);
  await $({ stdio: 'inherit' })`gh release create ${tag} --prerelease --title ${tag} --notes ${'Pre-release ' + tag}`;
}

await $({ stdio: 'inherit' })`gh release upload ${tag} ${renamedApkPath} --clobber`;
console.log(`Uploaded ${apkName} to release ${tag}`);

// ── Step 8: Build AAB ─────────────────────────────────────────────────────────

console.log('\n━━━ Step 8: Building AAB ━━━');
await $({ stdio: 'inherit', cwd: 'android' })`./gradlew bundleRelease`;

const aabPath = path.resolve('android/app/build/outputs/bundle/release/app-release.aab');
if (!existsSync(aabPath)) {
  console.error('AAB not found at expected path:', aabPath);
  process.exit(1);
}
console.log('AAB built successfully');

// ── Step 9: Upload AAB to Google Play ─────────────────────────────────────────

console.log('\n━━━ Step 9: Uploading AAB to Google Play ━━━');

const keyPath = process.env.GOOGLE_PLAY_JSON_KEY || path.join(os.homedir(), '.mentra', 'credentials', 'google-play-key.json');

if (!existsSync(keyPath)) {
  console.log(`⚠️  Google Play key not found at ${keyPath}`);
  console.log('   Skipping Google Play upload.');
  console.log('   To enable: place service account key at ~/.mentra/credentials/google-play-key.json');
  console.log('   or set GOOGLE_PLAY_JSON_KEY env var.');
} else {
  process.env.GOOGLE_PLAY_JSON_KEY = keyPath;
  // Install gems and run fastlane
  await $({ stdio: 'inherit', cwd: 'android' })`bundle install`;
  await $({ stdio: 'inherit', cwd: 'android' })`bundle exec fastlane google_play`;
  console.log('AAB uploaded to Google Play (internal track)');
}

// ── Done ──────────────────────────────────────────────────────────────────────

const repoName = (await $`gh repo view --json nameWithOwner -q .nameWithOwner`).stdout.trim();
const apkUrl = `https://github.com/${repoName}/releases/download/${tag}/${apkName}`;

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`Android release complete!`);
console.log(`  Version: ${version} (versionCode ${newVersionCode})`);
console.log(`  APK: ${apkUrl}`);
if (existsSync(keyPath)) {
  console.log(`  Google Play: AAB uploaded (internal track)`);
}
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
