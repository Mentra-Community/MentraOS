#!/usr/bin/env zx

console.log('Running postinstall...');

// Patch packages (--error-on-fail to allow version mismatches - patches are iOS-only anyway)
// await $({ stdio: 'inherit', nothrow: true })`patch-package`;
// Workspace setup hoists deps to root node_modules — per-module `bun install`
// is no longer needed and re-introduced duplicate react/react-native copies.

await $({ stdio: 'inherit', cwd: 'modules/bluetooth-sdk' })`bun run prepare`;
await $({ stdio: 'inherit', cwd: 'modules/crust' })`bun run prepare`;
await $({ stdio: 'inherit', cwd: 'modules/miniapp' })`bun run prepare`;
// island depends on bluetooth-sdk + miniapp build outputs, so its prepare
// (renamed to build:module) runs here instead of being auto-triggered by bun
// install in parallel with its workspace deps.
await $({ stdio: 'inherit', cwd: 'modules/island' })`bun run build:module`;

// ignore scripts to avoid infinite loop:
// await $({ stdio: 'inherit' })`bun install --ignore-scripts`;

console.log('✅ Postinstall completed successfully!');
