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

// Install APK on device
await $({ stdio: 'inherit' })`adb install -r android/app/build/outputs/apk/release/app-release.apk`;

console.log('✅ Android release built and installed successfully!');
