#!/usr/bin/env zx

import { setBuildEnv } from './set-build-env.mjs';
await setBuildEnv();

console.log('Building AAB for Google Play...');

// Prebuild Android
await $({ stdio: 'inherit' })`bun expo prebuild --platform android`;

// Bundle JS code
await $({ stdio: 'inherit' })`bun expo export --platform android`;

// Build release AAB
await $({ stdio: 'inherit', cwd: 'android' })`./gradlew bundleRelease`;

console.log('✅ AAB built successfully!');
console.log('📦 Output: android/app/build/outputs/bundle/release/app-release.aab');
