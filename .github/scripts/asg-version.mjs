#!/usr/bin/env node
import {appendFileSync, readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

export const ASG_ANDROID_VERSION_CODE = 1_000_000_000;
export const ASG_VERSION_BASELINE = 100_000;
export const ASG_VERSION_EPOCH_SECONDS = 1_735_689_600;

export function assertTransportVersionCodeSafe(publishedVersionCodes) {
  for (const value of publishedVersionCodes) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid published Android versionCode: ${value}`);
    }
    if (value > ASG_ANDROID_VERSION_CODE) {
      throw new Error(
        `Fixed Android versionCode ${ASG_ANDROID_VERSION_CODE} is not above published value ${value}`,
      );
    }
  }
}

export function calculateModifiedEpochVersion(epochSeconds) {
  if (!Number.isSafeInteger(epochSeconds) || epochSeconds < ASG_VERSION_EPOCH_SECONDS) {
    throw new Error(`Invalid ASG build epoch seconds: ${epochSeconds}`);
  }
  return ASG_VERSION_BASELINE + epochSeconds - ASG_VERSION_EPOCH_SECONDS;
}

export function resolveAsgVersion(epochSeconds, lastPublishedVersion = 0) {
  if (!Number.isSafeInteger(lastPublishedVersion) || lastPublishedVersion < 0) {
    throw new Error(`Invalid last published ASG version: ${lastPublishedVersion}`);
  }
  return Math.max(calculateModifiedEpochVersion(epochSeconds), lastPublishedVersion + 1);
}

function positiveSafeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

/** Reads release identity without ever mistaking the fixed Android transport code for ASG. */
export function readPublishedAsgMetadata(manifest) {
  const app = manifest?.apps?.['com.mentra.asg_client'] ?? {};
  const versionCode = positiveSafeInteger(app.versionCode);
  const explicitAsgVersion = positiveSafeInteger(app.asgVersion);
  return {
    asgVersion:
      explicitAsgVersion ||
      (versionCode !== ASG_ANDROID_VERSION_CODE ? versionCode : 0),
    versionCode,
  };
}

export function formatAsgVersionName(epochSeconds, shortSha, prefix = '') {
  if (!/^[0-9a-f]{7,40}$/i.test(shortSha)) {
    throw new Error(`Invalid ASG source SHA: ${shortSha}`);
  }
  const date = new Date(epochSeconds * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  const datePart = `${date.getUTCFullYear()}.${pad(date.getUTCMonth() + 1)}.${pad(date.getUTCDate())}`;
  const timePart = `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
  const normalizedPrefix = prefix.trim() ? `${prefix.trim()}.` : '';
  return `${normalizedPrefix}${datePart}.${timePart}-${shortSha.slice(0, 12)}`;
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  } else {
    console.log(`${name}=${value}`);
  }
}

function main() {
  if (process.argv[2] === '--read-manifest') {
    const metadata = readPublishedAsgMetadata(JSON.parse(readFileSync(0, 'utf8')));
    process.stdout.write(`${metadata.asgVersion}\t${metadata.versionCode}\n`);
    return;
  }
  const epochSeconds = Number(process.env.ASG_BUILD_EPOCH_SECONDS || Math.floor(Date.now() / 1000));
  const lastPublishedVersion = Number(process.env.LAST_PUBLISHED_ASG_VERSION || 0);
  const shortSha = process.env.ASG_SOURCE_SHA || process.env.GITHUB_SHA || '';
  const prefix = process.env.ASG_VERSION_NAME_PREFIX || '';
  const publishedVersionCodes = (process.env.PUBLISHED_ASG_VERSION_CODES || '')
    .split(',')
    .filter(Boolean)
    .map(Number);
  assertTransportVersionCodeSafe(publishedVersionCodes);
  const asgVersion = resolveAsgVersion(epochSeconds, lastPublishedVersion);

  setOutput('asg_version', asgVersion);
  setOutput('version_code', ASG_ANDROID_VERSION_CODE);
  setOutput('version_name', formatAsgVersionName(epochSeconds, shortSha, prefix));
  setOutput('short_sha', shortSha.slice(0, 12));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
