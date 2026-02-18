#!/usr/bin/env zx

import { setBuildEnv } from './set-build-env.mjs';
await setBuildEnv();

console.log('Uploading to Google Play...');

// Prebuild Android platform
await $({ stdio: 'inherit' })`bun expo prebuild --platform android`;

// Run fastlane Google Play upload
await $({ stdio: 'inherit', cwd: 'android' })`bundle exec fastlane google_play`;

console.log('✅ Upload to Google Play completed successfully!');
