#!/usr/bin/env zx

import './configure-zx-shell.mjs'

console.log('Running postinstall...');

// Workspace setup hoists deps to root node_modules. Per-module `bun install`
// is no longer needed and re-introduced duplicate react/react-native copies.

await $({ stdio: 'inherit', cwd: 'modules/bluetooth-sdk' })`bun run prepare`;
// crust declares @mentra/jspolyfill as a dep so this runs before crust.
await $({ stdio: 'inherit', cwd: 'modules/jspolyfill' })`bun run build`;
await $({ stdio: 'inherit', cwd: 'modules/crust' })`bun run prepare`;
await $({ stdio: 'inherit', cwd: 'modules/miniapp' })`bun run prepare`;
// Engine compiles source imported from ../cloud-v2/packages/*. TypeScript
// resolves those files' dependencies from cloud-v2/, not mobile/, so provision
// the cloud-v2 workspace deps before the isolated Expo module build.
await $({ stdio: 'inherit', cwd: '../cloud-v2' })`bun install --frozen-lockfile --ignore-scripts`;
// Engine depends on bluetooth-sdk + miniapp build outputs, so its prepare
// (renamed to build:module) runs here instead of being auto-triggered by bun
// install in parallel with its workspace deps.
await $({ stdio: 'inherit', cwd: 'modules/engine' })`bun run build:module`;

// ignore scripts to avoid infinite loop:
// await $({ stdio: 'inherit' })`bun install --ignore-scripts`;

console.log('Postinstall completed successfully!');