#!/usr/bin/env zx

import { setBuildEnv } from './set-build-env.mjs';
import { withRetry, isSentryTransientError, writeSummary } from './release-utils.mjs';
import { getBuildNumber } from './build-number.mjs';
import { cp, mkdir } from 'fs/promises';
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
  return `Mentra_${major}p${minor}`;
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

// ── Step 2: Derive build number ──────────────────────────────────────────────

// Pin the value via env var so every getBuildNumber() call in this process
// tree (including app.config.ts evaluations during prebuild) returns the
// same number. Without pinning, the summary value can drift from the value
// baked into the native project by a few seconds — small but real.
const versionCode = getBuildNumber();
process.env.MENTRAOS_PINNED_BUILD_NUMBER = String(versionCode);
console.log(`versionCode: ${versionCode}`);

// ── Step 3: Prebuild + bundle ────────────────────────────────────────────────

console.log('\n━━━ Step 3: Prebuild + bundle ━━━');
process.env.ORG_GRADLE_PROJECT_reactNativeArchitectures = 'arm64-v8a';

// Clean android/ to avoid cached version number issues
await $({ stdio: 'inherit' })`rm -rf android`;
await $({ stdio: 'inherit' })`bun expo prebuild --platform android`;
await $({ stdio: 'inherit' })`bun expo export --platform android --clear`;

// Prebuild can leave a stale autolinking.json with the wrong packageName
// (com.mentra instead of com.mentra.mentra), which makes the generated
// ReactNativeApplicationEntryPoint reference a non-existent BuildConfig.
// Delete it so gradle's settings phase regenerates it against the final build.gradle.
await $({ stdio: 'inherit' })`rm -rf android/build/generated/autolinking`;

// ── Step 4: Copy fastlane config into android/ ────────────────────────────────

console.log('\n━━━ Step 4: Copying fastlane config into android/ ━━━');
const fastlaneSrc = path.resolve('ci/fastlane-android');
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
// stdio piped manually so withRetry's predicate can inspect output for transient
// Sentry/network errors; output still streams live to the terminal.
await withRetry(
  'gradlew assembleRelease',
  () => {
    const p = $({ cwd: 'android' })`./gradlew assembleRelease`;
    p.stdout.pipe(process.stdout);
    p.stderr.pipe(process.stderr);
    return p;
  },
  { shouldRetry: isSentryTransientError }
);

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
  await withRetry('gh release create', () =>
    $({ stdio: 'inherit' })`gh release create ${tag} --prerelease --title ${tag} --notes ${'Pre-release ' + tag}`
  );
}

await withRetry('gh release upload (APK)', () =>
  $({ stdio: 'inherit' })`gh release upload ${tag} ${renamedApkPath} --clobber`
);
console.log(`Uploaded ${apkName} to release ${tag}`);

// ── Step 8: Build AAB ─────────────────────────────────────────────────────────

console.log('\n━━━ Step 8: Building AAB ━━━');
await withRetry(
  'gradlew bundleRelease',
  () => {
    const p = $({ cwd: 'android' })`./gradlew bundleRelease`;
    p.stdout.pipe(process.stdout);
    p.stderr.pipe(process.stderr);
    return p;
  },
  { shouldRetry: isSentryTransientError }
);

const aabPath = path.resolve('android/app/build/outputs/bundle/release/app-release.aab');
if (!existsSync(aabPath)) {
  console.error('AAB not found at expected path:', aabPath);
  process.exit(1);
}
console.log('AAB built successfully');

// ── Step 9: Upload AAB to Google Play ─────────────────────────────────────────

console.log('\n━━━ Step 9: Uploading AAB to Google Play ━━━');

const keyPath = process.env.GOOGLE_PLAY_JSON_KEY || path.join(os.homedir(), '.mentra', 'credentials', 'google-play-key.json');

// Track Play Store upload result so we can surface it in the release-status
// JSON consumed by the staging-builds workflow Slack notification.
let playStatus = 'skipped';
let playDetail = null;

if (!existsSync(keyPath)) {
  console.log(`⚠️  Google Play key not found at ${keyPath}`);
  console.log('   Skipping Google Play upload.');
  console.log('   To enable: place service account key at ~/.mentra/credentials/google-play-key.json');
  console.log('   or set GOOGLE_PLAY_JSON_KEY env var.');
  playDetail = 'credentials missing on runner';
} else {
  process.env.GOOGLE_PLAY_JSON_KEY = keyPath;
  // Install gems and run fastlane
  await $({ stdio: 'inherit', cwd: 'android' })`bundle install`;
  try {
    await withRetry('fastlane google_play', () =>
      $({ stdio: 'inherit', cwd: 'android' })`bundle exec fastlane google_play`
    );
    console.log('AAB uploaded to Google Play (internal track)');
    playStatus = 'success';
  } catch (err) {
    // Same philosophy as iOS TestFlight: Play upload is a publish-side
    // concern. The signed APK + AAB are already on the GH release. Don't
    // fail the build over a transient Play API outage or a previously-
    // uploaded versionCode collision; warn loud and continue.
    console.warn('\n⚠️  Google Play upload failed — continuing because the signed APK + AAB');
    console.warn('   were still published to the GitHub release.');
    console.warn('   Original error:', err?.message || err);
    playStatus = 'failure';
    const msg = String(err?.message || err || '');
    if (/wrong key|signed with the wrong/i.test(msg)) {
      playDetail = 'AAB signed with wrong key (check upload-keystore)';
    } else if (/version code|already.+used/i.test(msg)) {
      playDetail = 'versionCode already used (bump build number)';
    } else {
      playDetail = msg.split('\n')[0].slice(0, 200);
    }
  }
}

// ── Done ──────────────────────────────────────────────────────────────────────

const repoName = (await $`gh repo view --json nameWithOwner -q .nameWithOwner`).stdout.trim();
const apkUrl = `https://github.com/${repoName}/releases/download/${tag}/${apkName}`;

const summaryLines = [
  'Android release complete!',
  `  Version: ${version} (versionCode ${versionCode})`,
  `  APK: ${apkUrl}`,
];
if (playStatus === 'success') {
  summaryLines.push('  Google Play: AAB uploaded (internal track)');
} else if (playStatus === 'failure') {
  summaryLines.push(`  Google Play: FAILED (${playDetail || 'see logs'})`);
} else {
  summaryLines.push('  Google Play: skipped (no credentials on runner)');
}
await writeSummary('android', summaryLines);

// Structured status file for the staging-builds workflow's Slack notification.
const statusPath = path.resolve('build/release-status.json');
const { writeFile: writeStatusFile, mkdir: mkdirP } = await import('fs/promises');
await mkdirP(path.dirname(statusPath), { recursive: true });
await writeStatusFile(
  statusPath,
  JSON.stringify(
    {
      platform: 'android',
      version,
      versionCode,
      beta_number: betaNumber,
      apk_name: apkName,
      apk_url: apkUrl,
      tag,
      google_play: playStatus, // 'success' | 'failure' | 'skipped'
      google_play_detail: playDetail,
    },
    null,
    2,
  ),
);
console.log(`Wrote release status: ${statusPath}`);
