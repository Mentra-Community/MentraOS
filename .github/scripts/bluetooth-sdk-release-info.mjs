#!/usr/bin/env node
// Release decision for the Bluetooth SDK under the channel-promotion scheme
// (npm-channel.mjs): git holds one prerelease base version (X.Y.Z-dev.N, only
// edited on dev) and the branch derives what publishes —
//   dev                 -> X.Y.Z-dev.N   (npm dev tag,   direct publishes)
//   staging             -> X.Y.Z-beta.N  (npm beta tag,  staged/approved)
//   main-bluetooth-sdk  -> X.Y.Z         (npm latest tag, staged/approved)
// Merging up the chain IS the promotion; no version edits ride the branches.
// Note the SDK's prod branch is main-bluetooth-sdk, NOT main — SDK prod
// releases trigger independently of the monorepo's main promotions.
//
// The SDK ships to THREE stores, so detection is registry-state across all of
// them: the release runs when the derived version is missing from ANY of npm
// (@mentra/bluetooth-sdk), Maven Central (com.mentraglass:bluetooth-sdk +
// lc3Lib), or the SwiftPM mirror's tags — each publish job still re-checks and
// skips its own store, so a partially-complete release heals per store.
// Fail-closed rules match the sibling pipelines: npm absence is E404-only, a
// partial Maven release (one of the two artifacts) is a hard error, and any
// network failure fails the run rather than being read as "absent".
import {readFileSync, appendFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {channelFor, deriveVersion, publishedVersions, BLUETOOTH_SDK_CHANNELS} from './npm-channel.mjs';

const packagePath = 'mobile/modules/bluetooth-sdk/package.json';
const SWIFTPM_REPO = 'https://github.com/Mentra-Community/mentra-bluetooth-sdk-ios.git';

const outputPath = process.env.GITHUB_OUTPUT;
const eventName = process.env.GITHUB_EVENT_NAME || '';
const branch = process.env.GITHUB_REF_NAME || '';
const forceRelease = process.env.FORCE_RELEASE === 'true';
const dryRun = process.env.DRY_RUN === 'true';

function setOutput(name, value) {
  if (!outputPath) {
    console.log(`${name}=${value}`);
    return;
  }
  appendFileSync(outputPath, `${name}=${value}\n`);
}

const currentPackage = JSON.parse(readFileSync(packagePath, 'utf8'));
if (!currentPackage.name) throw new Error(`Missing name in ${packagePath}`);
if (!currentPackage.version) throw new Error(`Missing version in ${packagePath}`);

const {tag} = channelFor(branch, BLUETOOTH_SDK_CHANNELS); // throws on non-channel branches (including main)
const derived = deriveVersion(currentPackage.version, branch, BLUETOOTH_SDK_CHANNELS); // validates the base is a prerelease

// npm: E404-strict via the shared helper.
const npmVersions = publishedVersions(currentPackage.name);
const npmExists = Boolean(npmVersions?.includes(derived));

// Maven Central: HEAD both poms. 200 = exists, 404 = absent, anything else
// (or exactly one of the two present) fails — never guess registry state.
async function mavenState(version) {
  const base = 'https://repo.maven.apache.org/maven2/com/mentraglass';
  const urls = [
    `${base}/bluetooth-sdk/${version}/bluetooth-sdk-${version}.pom`,
    `${base}/lc3Lib/${version}/lc3Lib-${version}.pom`,
  ];
  const states = [];
  for (const url of urls) {
    const response = await fetch(url, {method: 'HEAD'});
    if (response.status === 200) states.push(true);
    else if (response.status === 404) states.push(false);
    else throw new Error(`Unexpected HTTP ${response.status} checking ${url} — refusing to guess Maven state.`);
  }
  if (states[0] !== states[1]) {
    throw new Error(`Maven Central has only one of the two Android artifacts for ${version}; refusing to continue over a partial release.`);
  }
  return states[0];
}
const mavenExists = await mavenState(derived);

// SwiftPM mirror: the derived version IS the tag; ls-remote is anonymous.
const lsRemote = execFileSync('git', ['ls-remote', SWIFTPM_REPO, `refs/tags/${derived}`], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const swiftpmExists = lsRemote.length > 0;

const allExist = npmExists && mavenExists && swiftpmExists;
const runRelease = !allExist || forceRelease || (eventName === 'workflow_dispatch' && dryRun);

setOutput('package_name', currentPackage.name);
setOutput('version', derived);
setOutput('base_version', currentPackage.version);
setOutput('dist_tag', tag);
setOutput('swiftpm_tag', derived);
setOutput('npm_exists', String(npmExists));
setOutput('maven_exists', String(mavenExists));
setOutput('swiftpm_exists', String(swiftpmExists));
setOutput('force_release', String(forceRelease));
setOutput('dry_run', String(dryRun));
setOutput('run_release', String(runRelease));

console.log(`Bluetooth SDK package: ${currentPackage.name}`);
console.log(`Base version: ${currentPackage.version}`);
console.log(`Derived version for ${branch}: ${derived} (npm dist-tag ${tag})`);
console.log(`Already released — npm: ${npmExists}, maven: ${mavenExists}, swiftpm tag: ${swiftpmExists}`);
console.log(`Run release jobs: ${runRelease}. Force: ${forceRelease}. Dry run: ${dryRun}.`);
