#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

const packagePath = 'mobile/modules/bluetooth-sdk/package.json';

const outputPath = process.env.GITHUB_OUTPUT;
const eventName = process.env.GITHUB_EVENT_NAME || '';
const eventPath = process.env.GITHUB_EVENT_PATH;
const forceRelease = process.env.FORCE_RELEASE === 'true';
const dryRun = process.env.DRY_RUN === 'true';

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', options.allowFailure ? 'ignore' : 'pipe'],
  }).trim();
}

function readJsonAt(ref, path) {
  try {
    return JSON.parse(git(['show', `${ref}:${path}`]));
  } catch {
    return null;
  }
}

function setOutput(name, value) {
  if (!outputPath) {
    console.log(`${name}=${value}`);
    return;
  }
  execFileSync('bash', ['-lc', 'cat >> "$GITHUB_OUTPUT"'], {
    input: `${name}=${value}\n`,
    env: process.env,
  });
}

const currentPackage = JSON.parse(readFileSync(packagePath, 'utf8'));
const currentVersion = currentPackage.version;

if (!currentPackage.name) {
  throw new Error(`Missing name in ${packagePath}`);
}

if (!currentVersion) {
  throw new Error(`Missing version in ${packagePath}`);
}

let beforeSha = process.env.BLUETOOTH_SDK_COMPARE_SHA || '';
if (!beforeSha && eventPath) {
  try {
    const event = JSON.parse(readFileSync(eventPath, 'utf8'));
    beforeSha = event.before || '';
  } catch {
    beforeSha = '';
  }
}

if (!beforeSha || /^0+$/.test(beforeSha)) {
  try {
    beforeSha = git(['rev-parse', 'HEAD^'], {allowFailure: true});
  } catch {
    beforeSha = '';
  }
}

const previousPackage = beforeSha ? readJsonAt(beforeSha, packagePath) : null;
const previousVersion = previousPackage?.version || '';
const versionChanged = previousVersion !== currentVersion;
const runRelease = versionChanged || forceRelease || (eventName === 'workflow_dispatch' && dryRun);

setOutput('package_name', currentPackage.name);
setOutput('version', currentVersion);
setOutput('previous_version', previousVersion);
setOutput('compare_sha', beforeSha);
setOutput('version_changed', String(versionChanged));
setOutput('force_release', String(forceRelease));
setOutput('dry_run', String(dryRun));
setOutput('run_release', String(runRelease));
setOutput('swiftpm_tag', currentVersion);

console.log(`Bluetooth SDK package: ${currentPackage.name}`);
console.log(`Current version: ${currentVersion}`);
console.log(`Previous version: ${previousVersion || '(unavailable)'}`);
console.log(`Compare SHA: ${beforeSha || '(unavailable)'}`);
console.log(`Version changed: ${versionChanged}`);
console.log(`Force release: ${forceRelease}`);
console.log(`Dry run: ${dryRun}`);
console.log(`Run release jobs: ${runRelease}`);
