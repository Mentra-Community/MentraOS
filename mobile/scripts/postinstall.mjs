#!/usr/bin/env zx

console.log('Running postinstall...');

// Patch packages (--error-on-fail to allow version mismatches - patches are iOS-only anyway)
await $({ stdio: 'inherit', nothrow: true })`patch-package`;

console.log('Building core module...');
// Install core module dependencies first (needed for expo-module CLI)
await $({ stdio: 'inherit', cwd: 'modules/core' })`bun install --ignore-scripts`;
// Now run prepare (expo-module will be available in node_modules/.bin)
await $({ stdio: 'inherit', cwd: 'modules/core' })`bun run prepare`;
// ignore scripts to avoid infinite loop:
await $({ stdio: 'inherit' })`bun install --ignore-scripts`;

console.log('✅ Postinstall completed successfully!');
