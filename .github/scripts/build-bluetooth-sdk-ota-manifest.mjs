#!/usr/bin/env node
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

const requiredEnv = [
  'ASG_APK_SHA256',
  'ASG_APK_SIZE',
  'ASG_APK_URL',
  'ASG_VERSION_CODE',
  'ASG_VERSION_NAME',
  'FIRMWARE_MANIFEST',
  'OUTPUT_PATH',
  'RELEASE_VERSION',
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const releaseVersion = process.env.RELEASE_VERSION.trim();
if (!/^\d+\.\d+\.\d+(?:-(?:dev|beta)\.[1-9]\d*)?$/.test(releaseVersion)) {
  throw new Error(`Invalid coordinated release version: ${releaseVersion}`);
}

const versionCode = Number(process.env.ASG_VERSION_CODE);
if (!Number.isSafeInteger(versionCode) || versionCode <= 0) {
  throw new Error(`ASG_VERSION_CODE must be a positive integer, got: ${process.env.ASG_VERSION_CODE}`);
}

const apkSize = Number(process.env.ASG_APK_SIZE);
if (!Number.isSafeInteger(apkSize) || apkSize <= 0) {
  throw new Error(`ASG_APK_SIZE must be a positive integer, got: ${process.env.ASG_APK_SIZE}`);
}

const firmware = JSON.parse(readFileSync(process.env.FIRMWARE_MANIFEST, 'utf8'));
if (!Array.isArray(firmware.mtk_patches) || firmware.mtk_patches.length === 0) {
  throw new Error('Firmware manifest must include non-empty mtk_patches for SDK OTA releases.');
}
if (!firmware.bes_firmware || typeof firmware.bes_firmware !== 'object' || Array.isArray(firmware.bes_firmware)) {
  throw new Error('Firmware manifest must include bes_firmware for SDK OTA releases.');
}

const manifest = {
  releaseVersion,
  apps: {
    'com.mentra.asg_client': {
      versionCode,
      versionName: process.env.ASG_VERSION_NAME,
      apkUrl: process.env.ASG_APK_URL,
      apkSize,
      sha256: process.env.ASG_APK_SHA256,
    },
  },
  mtk_patches: firmware.mtk_patches,
  bes_firmware: firmware.bes_firmware,
};

mkdirSync(dirname(process.env.OUTPUT_PATH), {recursive: true});
writeFileSync(process.env.OUTPUT_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
