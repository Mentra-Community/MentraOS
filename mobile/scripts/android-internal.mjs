#!/usr/bin/env zx

import { setBuildEnv } from './set-build-env.mjs';
await setBuildEnv();

process.env.ORG_GRADLE_PROJECT_reactNativeArchitectures = 'arm64-v8a';
process.env.EXPO_PUBLIC_ENABLE_E2E_METRICS = 'true';

console.log('Building Android internal...');

await $({ stdio: 'inherit' })`bun expo prebuild --platform android`;
await $({ stdio: 'inherit', cwd: 'android' })`./gradlew assembleInternal`;

console.log('Android internal APK built at android/app/build/outputs/apk/internal/app-internal.apk');
