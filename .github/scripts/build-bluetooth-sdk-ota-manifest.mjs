#!/usr/bin/env node
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

const requiredEnv = [
  'ASG_APK_SHA256',
  'ASG_APK_SIZE',
  'ASG_APK_URL',
  'ASG_VERSION',
  'ASG_VERSION_CODE',
  'ASG_VERSION_NAME',
  'FIRMWARE_MANIFEST_URL',
  'OUTPUT_PATH',
  'SDK_VERSION',
  'SOURCE_COMMIT',
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const sdkVersion = process.env.SDK_VERSION.trim();
if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(sdkVersion)) {
  throw new Error(`Refusing unsafe SDK version for OTA path: ${sdkVersion}`);
}

const versionCode = Number(process.env.ASG_VERSION_CODE);
if (versionCode !== 1_000_000_000) {
  throw new Error(`ASG_VERSION_CODE must be the fixed transport value 1000000000, got: ${process.env.ASG_VERSION_CODE}`);
}

const apkSize = Number(process.env.ASG_APK_SIZE);
if (!Number.isSafeInteger(apkSize) || apkSize <= 0) {
  throw new Error(`ASG_APK_SIZE must be a positive integer, got: ${process.env.ASG_APK_SIZE}`);
}

if (!/^[0-9a-f]{64}$/i.test(process.env.ASG_APK_SHA256)) {
  throw new Error('ASG_APK_SHA256 must be a 64-character hex digest.');
}

const apkUrl = new URL(process.env.ASG_APK_URL);
if (!['http:', 'https:'].includes(apkUrl.protocol)) {
  throw new Error(`ASG_APK_URL must use http(s), got: ${apkUrl}`);
}

const asgVersion = Number(process.env.ASG_VERSION);
if (!Number.isSafeInteger(asgVersion) || asgVersion <= 0) {
  throw new Error(`ASG_VERSION must be a positive safe integer, got: ${process.env.ASG_VERSION}`);
}

const firmwareManifestUrl = new URL(process.env.FIRMWARE_MANIFEST_URL);
if (!['http:', 'https:'].includes(firmwareManifestUrl.protocol)) {
  throw new Error(`FIRMWARE_MANIFEST_URL must use http(s), got: ${firmwareManifestUrl}`);
}

if (!/^[0-9a-f]{7,64}$/i.test(process.env.SOURCE_COMMIT)) {
  throw new Error(`SOURCE_COMMIT must be a Git commit SHA, got: ${process.env.SOURCE_COMMIT}`);
}

const manifest = {
  sdkVersion,
  sourceCommit: process.env.SOURCE_COMMIT,
  apps: {
    'com.mentra.asg_client': {
      versionCode,
      versionName: process.env.ASG_VERSION_NAME,
      asgVersion,
      apkUrl: apkUrl.toString(),
      apkSize,
      sha256: process.env.ASG_APK_SHA256,
    },
  },
  firmwareManifestUrl: firmwareManifestUrl.toString(),
};

mkdirSync(dirname(process.env.OUTPUT_PATH), {recursive: true});
writeFileSync(process.env.OUTPUT_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
