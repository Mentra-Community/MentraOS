#!/usr/bin/env zx

import { setBuildEnv } from './set-build-env.mjs';
import { withRetry, isSPMOrSentryTransientError, writeSummary } from './release-utils.mjs';
import {
  appendXcodeEnvironment,
  validateReleaseArchive,
  xcodeBuildSettings,
} from './release-bundle-config.mjs';
import { getBuildNumber } from './build-number.mjs';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';

// Expo's export:embed command sets production mode after the CLI starts, which
// is too late for its Babel transform to inline inherited EXPO_PUBLIC_* values.
// Start every release subprocess in production mode instead.
process.env.NODE_ENV = 'production';

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
  return `Mentra_iOS_${major}p${minor}`;
}

// ── Load App Store Connect credentials ────────────────────────────────────────

function loadASCConfig() {
  // CI injects credentials from secrets into a temp dir and points here via
  // MENTRA_ASC_CONFIG_PATH; local dev falls back to ~/.mentra/credentials.
  const configPath =
    process.env.MENTRA_ASC_CONFIG_PATH ||
    path.join(os.homedir(), '.mentra', 'credentials', 'appstore-connect.env');
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

// ── Step 2: Derive build number ──────────────────────────────────────────────

// Pin the value via env var so every getBuildNumber() call in this process
// tree (including app.config.ts evaluations during prebuild + Xcode's later
// reads) returns the same number. Without pinning, the summary value can
// drift from the value baked into the IPA by a few seconds.
const buildNumber = getBuildNumber();
process.env.MENTRAOS_PINNED_BUILD_NUMBER = String(buildNumber);
console.log(`buildNumber: ${buildNumber}`);

// ── Step 3: Prebuild iOS ──────────────────────────────────────────────────────

console.log('\n━━━ Step 3: Prebuild iOS ━━━');
await $({ stdio: 'inherit' })`bun expo prebuild --platform ios`;

// Copy .env for tools that load it directly, then explicitly export public
// runtime values for child processes launched by Xcode. Plain KEY=value lines
// become shell variables when sourced by React Native's with-environment.sh,
// but are not inherited by the Expo/Metro bundling process.
await $({ stdio: 'inherit' })`cp .env ios/.xcode.env.local`;

// Pin NODE_BINARY to THIS node (the one running release:ios, i.e. the Node 20
// from setup-node). Xcode's "[CP-User] Generate app.config" build phase sources
// .xcode.env(.local) and otherwise resolves `command -v node` against Xcode's
// minimal PATH, which on the self-hosted runners hits the SYSTEM node symlink
// (/usr/local/bin/node → Node 18). Node 18 lacks util.parseEnv, so @expo/env
// throws "parseEnv is not a function" and the archive fails with exit 65.
// .xcode.env.local is sourced after .xcode.env, so this overrides it.
const exportedXcodeVariables = await appendXcodeEnvironment(
  'ios/.xcode.env.local',
  process.env,
  process.execPath,
);
const archiveBuildSettings = xcodeBuildSettings(process.env, process.execPath);
console.log(`Pinned NODE_BINARY=${process.execPath} (node ${process.version}) for Xcode build phases`);
console.log(`Exported ${exportedXcodeVariables - 1} build variables for Xcode child processes`);
console.log(`Passing ${archiveBuildSettings.length - 1} build variables as Xcode archive settings`);

// In CI, switch the Mentra app target's Release config to MANUAL signing
// with the fastlane match-installed AppStore profile. Without this,
// Expo's prebuild leaves the project in Automatic mode which on a CI
// runner picks a lingering Apple Development cert from the login keychain
// (instead of the match-installed Apple Distribution cert) and fails
// with "conflicting code signing identity" when we try to override.
//
// We mutate ONLY the Mentra app target's Release config, identified by
// the unique line "13B07F951A680F5B00A75B9A /* Release */" in pbxproj.
// Static libs and Debug configs are untouched.
const isCIForSigning = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
if (isCIForSigning) {
  const pbxprojPath = path.resolve('ios/Mentra.xcodeproj/project.pbxproj');
  let pbxproj = await (await import('fs/promises')).readFile(pbxprojPath, 'utf-8');

  // Insert manual-signing keys into the Mentra Release config (13B07F95...).
  // We use a string-replace anchored on a unique marker in that config.
  const releaseConfigStart = 'CODE_SIGN_ENTITLEMENTS = Mentra/Mentra.entitlements;';
  // We'll prepend manual signing keys to the first occurrence within
  // the Release config block. Find that block specifically.
  const releaseAnchor = '13B07F951A680F5B00A75B9A /* Release */ = {';
  const releaseIdx = pbxproj.indexOf(releaseAnchor);
  if (releaseIdx === -1) {
    console.error('Could not find Mentra Release config in pbxproj');
    process.exit(1);
  }
  const before = pbxproj.slice(0, releaseIdx);
  const after = pbxproj.slice(releaseIdx);
  // Inject our signing keys into the Release block, after the entitlements line.
  const updatedAfter = after.replace(
    releaseConfigStart,
    `${releaseConfigStart}
\t\t\t\tCODE_SIGN_STYLE = Manual;
\t\t\t\tCODE_SIGN_IDENTITY = "Apple Distribution";
\t\t\t\t"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "Apple Distribution";
\t\t\t\tPROVISIONING_PROFILE_SPECIFIER = "match AppStore com.mentra.mentra";`,
  );
  pbxproj = before + updatedAfter;
  await (await import('fs/promises')).writeFile(pbxprojPath, pbxproj);
  console.log('Patched pbxproj: Mentra Release → Manual signing with match profile');
}

// ── Step 3.5: Resolve Mapbox SPM + make archive retry the build-order race ─────
//
// Why this exists: the `Crust` pod (`modules/crust/ios`) does `import
// MapboxDirections` / `MapboxNavigationCore`, but those are Swift Package
// products linked to the APP target (see plugins/mapbox-nav-ios.ts), NOT a
// CocoaPods dependency. Crust only gets COMPILE-TIME visibility via search
// paths pointing at ${PODS_CONFIGURATION_BUILD_DIR}, where SPM drops the
// .swiftmodule. For that to resolve, the Mapbox swiftmodules must already exist
// in the build-products dir *before* Crust compiles.
//
// In an incremental `bun ios` build they're already on disk, so it works. But a
// clean archive builds targets in parallel against a fresh ArchiveIntermediates
// dir, and Crust can get scheduled BEFORE SPM emits MapboxDirections.swiftmodule
// → `error: no such module 'MapboxDirections'` → ARCHIVE FAILED. The crust-link
// plugin only *claims* to guarantee order; it actually just scrubs link-deps.
//
// Fix (two parts):
//   1. Resolve SPM packages up front so the package graph is fully checked out
//      before the archive starts (a partially-resolved graph is one way Crust
//      races ahead of the Mapbox products).
//   2. Make the archive itself RETRY on this specific "no such module" error.
//      The race is non-deterministic, and a failed partial build still emits the
//      Mapbox .swiftmodule into DerivedData — so the retry almost always finds it
//      present and succeeds. Previously this error aborted immediately because
//      the retry predicate only matched Sentry/network errors.

// Per-workspace DerivedData. By DEFAULT xcodebuild uses
// ~/Library/Developer/Xcode/DerivedData — which is MACHINE-GLOBAL and shared by
// every runner process on a self-hosted Mac (bigbob runs 3). Concurrent iOS
// builds then share the same DerivedData + ModuleCache.noindex / SDKStatCaches,
// which corrupts/locks the module cache and makes a build hang mid-compile then
// fail ~30min later with no error (the recurring staging iOS failure). Pinning
// DerivedData inside the runner workspace makes each build fully isolated. The
// path is absolute under cwd (mobile/), i.e. under RUNNER_WORKSPACE in CI.
const derivedDataPath = path.resolve('build/DerivedData');

console.log('\n━━━ Step 3.5: Resolving Mapbox SPM packages ━━━');

await withRetry(
  'xcodebuild resolve packages',
  () => $({ stdio: 'inherit' })`xcodebuild -resolvePackageDependencies -workspace ios/Mentra.xcworkspace -scheme Mentra -derivedDataPath ${derivedDataPath}`,
  { shouldRetry: isSPMOrSentryTransientError },
);

// ── Step 4: Archive ───────────────────────────────────────────────────────────

console.log('\n━━━ Step 4: Archiving ━━━');

const teamId = process.env.APPLE_TEAM_ID;
if (!teamId) {
  console.error('APPLE_TEAM_ID not found in .env — add it to your .env file');
  process.exit(1);
}

const archivePath = path.resolve('build/Mentra.xcarchive');

// stdio:'pipe' so withRetry's predicate can inspect output for transient
// Sentry/network errors; we still pipe to the terminal so progress is visible.
//
// In CI, the project file was patched above to declare manual signing
// against the match profile, so xcodebuild just uses that. On a laptop
// the project is left in Automatic mode and -allowProvisioningUpdates
// lets Xcode fetch a profile on-demand.
//
// Pass the public runtime environment as command-line build settings as well as
// writing .xcode.env.local above. Xcode exports command-line settings before it
// starts every build phase. This is necessary because Sentry's wrapper around
// "Bundle React Native code and images" does not reliably preserve variables
// sourced from .xcode.env.local before it launches Expo/Metro.
await withRetry(
  'xcodebuild archive',
  () => {
    const p = $`xcodebuild archive -workspace ios/Mentra.xcworkspace -scheme Mentra -configuration Release -destination generic/platform=iOS -archivePath ${archivePath} -derivedDataPath ${derivedDataPath} -allowProvisioningUpdates DEVELOPMENT_TEAM=${teamId} SWIFT_STRICT_CONCURRENCY=minimal ${archiveBuildSettings}`;
    p.stdout.pipe(process.stdout);
    p.stderr.pipe(process.stderr);
    return p;
  },
  { shouldRetry: isSPMOrSentryTransientError }
);

if (!existsSync(archivePath)) {
  console.error('Archive not found at:', archivePath);
  process.exit(1);
}
console.log('Archive created successfully');

// ── Step 5: Export IPA ────────────────────────────────────────────────────────

console.log('\n━━━ Step 5: Exporting IPA ━━━');

const exportPath = path.resolve('build/ios-export');
// Clean previous export to avoid picking up stale IPAs
await $`rm -rf ${exportPath}`;
const exportOptionsPlist = isCIForSigning
  ? path.resolve('ci/ios-export/ExportOptions-Match.plist')
  : path.resolve('ci/ios-export/ExportOptions.plist');

// NOTE: -exportArchive does NOT take -derivedDataPath (xcodebuild errors:
// "The flag -scheme, -testProductsPath, or -xctestrun is required when
// specifying -derivedDataPath", exit 64). Export works from the archive itself,
// so it needs no DerivedData isolation. Keep -derivedDataPath on resolve+archive only.
await $({ stdio: 'inherit' })`xcodebuild -exportArchive -archivePath ${archivePath} -exportOptionsPlist ${exportOptionsPlist} -exportPath ${exportPath} -allowProvisioningUpdates`;

// Find the exported IPA
const ipaFiles = (await $`ls ${exportPath}/*.ipa`).stdout.trim().split('\n').filter(Boolean);
if (ipaFiles.length === 0) {
  console.error('No IPA found in export path:', exportPath);
  process.exit(1);
}
const ipaPath = ipaFiles[0];
console.log('IPA exported:', ipaPath);

// Validate the artifact, not only the parent shell. A green archive can still
// contain stale or missing Expo public configuration if Xcode did not pass the
// build environment into Metro. Refuse to publish that binary anywhere.
validateReleaseArchive(ipaPath, 'iOS');
console.log('Verified iOS release JS bundle configuration');

// ── Step 6: Upload to App Store Connect (TestFlight) ──────────────────────────

console.log('\n━━━ Step 6: Uploading to App Store Connect ━━━');

const ascConfig = loadASCConfig();

// Track TestFlight result so we can surface it in the summary file
// release-status.json (consumed by the workflow's Slack notification).
let testflightStatus = 'skipped';
let testflightDetail = null;

if (!ascConfig || !ascConfig.ASC_API_KEY_ID || !ascConfig.ASC_API_ISSUER_ID || !existsSync(ascConfig.ASC_API_KEY_PATH || '')) {
  console.log('⚠️  App Store Connect credentials not found at ~/.mentra/credentials/appstore-connect.env');
  console.log('   Skipping TestFlight upload.');
  console.log('   To enable: create ~/.mentra/credentials/appstore-connect.env with ASC_API_KEY_ID, ASC_API_ISSUER_ID, ASC_API_KEY_PATH');
  testflightDetail = 'credentials missing on runner';
} else {
  // altool looks for AuthKey_<id>.p8 in $API_PRIVATE_KEYS_DIR
  const keyDir = path.dirname(ascConfig.ASC_API_KEY_PATH);
  try {
    await withRetry('altool TestFlight upload', () =>
      $({ stdio: 'inherit', env: { ...process.env, API_PRIVATE_KEYS_DIR: keyDir } })`xcrun altool --upload-app -f ${ipaPath} -t ios --apiKey ${ascConfig.ASC_API_KEY_ID} --apiIssuer ${ascConfig.ASC_API_ISSUER_ID}`
    );
    console.log('IPA uploaded to App Store Connect (TestFlight)');
    testflightStatus = 'success';
  } catch (err) {
    // TestFlight upload is a publish-side concern, not a build-correctness
    // check. The signed IPA itself is valid and has already been published
    // to the GitHub release at this point. Common failure modes — version
    // already approved/closed, network blip, transient ASC outage — should
    // not fail the workflow because the artifact is fine and re-uploadable.
    // Print a clear warning so the user can investigate.
    console.warn('\n⚠️  TestFlight upload failed — continuing because the signed IPA');
    console.warn('   was still published to the GitHub release.');
    console.warn('   Common cause: EXPO_PUBLIC_MENTRAOS_VERSION matches a previously');
    console.warn('   approved/closed TestFlight train. Bump it to enable TestFlight.');
    console.warn('   Original error:', err?.message || err);
    testflightStatus = 'failure';
    // Heuristic: if the error mentions the closed-train pattern, surface that;
    // otherwise show the first line of the error.
    const msg = String(err?.message || err || '');
    if (/closed for new build submissions|must contain a higher version|Invalid Pre-Release Train/i.test(msg)) {
      testflightDetail = 'version closed (bump EXPO_PUBLIC_MENTRAOS_VERSION)';
    } else {
      testflightDetail = msg.split('\n')[0].slice(0, 200);
    }
  }
}

// ── Step 7: Upload IPA to GitHub release ──────────────────────────────────────

console.log('\n━━━ Step 7: Uploading IPA to GitHub release ━━━');

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
  await withRetry('gh release create', () =>
    $({ stdio: 'inherit' })`gh release create ${tag} --prerelease --title ${tag} --notes ${'Pre-release ' + tag}`
  );
}

await withRetry('gh release upload (IPA)', () =>
  $({ stdio: 'inherit' })`gh release upload ${tag} ${renamedIpaPath} --clobber`
);
console.log(`Uploaded ${ipaName} to release ${tag}`);

// ── Done ──────────────────────────────────────────────────────────────────────

const repoName = (await $`gh repo view --json nameWithOwner -q .nameWithOwner`).stdout.trim();
const ipaUrl = `https://github.com/${repoName}/releases/download/${tag}/${ipaName}`;

const summaryLines = [
  'iOS release complete!',
  `  Version: ${version} (buildNumber ${buildNumber})`,
  `  IPA: ${ipaUrl}`,
];
if (testflightStatus === 'success') {
  summaryLines.push('  TestFlight: uploaded');
} else if (testflightStatus === 'failure') {
  summaryLines.push(`  TestFlight: FAILED (${testflightDetail || 'see logs'})`);
} else {
  summaryLines.push('  TestFlight: skipped (no credentials on runner)');
}
await writeSummary('ios', summaryLines);

// Structured status file for the staging-builds workflow's Slack notification.
// Consumed by the "Build Mobile App (iOS)" job's post-script step which emits
// these values as job outputs that slack-notify reads.
const statusPath = path.resolve('build/release-status.json');
const { writeFile: writeStatusFile } = await import('fs/promises');
await writeStatusFile(
  statusPath,
  JSON.stringify(
    {
      platform: 'ios',
      version,
      buildNumber,
      beta_number: betaNumber,
      ipa_name: ipaName,
      ipa_url: ipaUrl,
      tag,
      testflight: testflightStatus, // 'success' | 'failure' | 'skipped'
      testflight_detail: testflightDetail,
    },
    null,
    2,
  ),
);
console.log(`Wrote release status: ${statusPath}`);
