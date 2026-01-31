#!/usr/bin/env zx

import { setBuildEnv } from './set-build-env.mjs';
await setBuildEnv();

console.log('Building Android release...');

// Prebuild Android
await $({ stdio: 'inherit' })`bun expo prebuild --platform android`;

// bundle js code:
await $({stdio: "inherit"})`bun expo export --platform android`

// Build release APK
await $({ stdio: 'inherit', cwd: 'android' })`./gradlew assembleRelease`;

// Get list of connected devices
const devicesOutput = await $`adb devices`;
const lines = devicesOutput.stdout.trim().split('\n').slice(1); // Skip header
const devices = lines
  .filter(line => line.includes('\tdevice'))
  .map(line => line.split('\t')[0]);

if (devices.length === 0) {
  console.error('❌ No devices connected. Please connect a device and try again.');
  process.exit(1);
}

const apkPath = 'android/app/build/outputs/apk/release/app-release.apk';

if (devices.length === 1) {
  // Single device - install directly
  console.log(`📱 Installing to device: ${devices[0]}`);
  await $({ stdio: 'inherit' })`adb install -r ${apkPath}`;
} else {
  // Multiple devices - use the first physical device (non-emulator) or first device
  const physicalDevice = devices.find(d => !d.startsWith('emulator-'));
  const targetDevice = physicalDevice || devices[0];
  
  console.log(`📱 Multiple devices detected: ${devices.join(', ')}`);
  console.log(`📱 Installing to: ${targetDevice}`);
  await $({ stdio: 'inherit' })`adb -s ${targetDevice} install -r ${apkPath}`;
}

console.log('✅ Android release built and installed successfully!');
