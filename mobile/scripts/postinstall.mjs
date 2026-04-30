#!/usr/bin/env zx

console.log('Running postinstall...');

// Patch packages (--error-on-fail to allow version mismatches - patches are iOS-only anyway)
await $({ stdio: 'inherit', nothrow: true })`patch-package`;

console.log('Building core module...');
// Workspace setup hoists deps to root node_modules — per-module `bun install`
// is no longer needed and re-introduced duplicate react/react-native copies.
// Kept commented for reference in case we need to revert.
// await $({ stdio: 'inherit', cwd: 'modules/core' })`bun install --ignore-scripts`;
await $({ stdio: 'inherit', cwd: 'modules/core' })`bun run prepare`;

// await $({ stdio: 'inherit', cwd: 'modules/crust' })`bun install --ignore-scripts`;
await $({ stdio: 'inherit', cwd: 'modules/crust' })`bun run prepare`;

// Build @mentra/miniapp so its dist/ exists before Metro bundling (file: deps
// don't run prepare reliably under bun). Safe no-op when already built.
await $({ stdio: 'inherit', cwd: '../sdk/miniapp' })`bun install --ignore-scripts`;
await $({ stdio: 'inherit', cwd: '../sdk/miniapp' })`bun run build`;

// ignore scripts to avoid infinite loop:
// await $({ stdio: 'inherit' })`bun install --ignore-scripts`;

console.log('✅ Postinstall completed successfully!');
