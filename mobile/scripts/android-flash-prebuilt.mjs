#!/usr/bin/env zx

import { setBuildEnv } from './set-build-env.mjs';
await setBuildEnv();

console.log('Flashing last built Android release...');

// Install APK on device
await $({ stdio: 'inherit' })`adb install -r android/app/build/outputs/apk/release/app-release.apk`;

console.log('✅ Android release installed successfully!');
