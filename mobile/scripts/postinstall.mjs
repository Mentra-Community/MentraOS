#!/usr/bin/env zx

console.log('Running postinstall...');

// Workspace setup hoists deps to root node_modules — per-module `bun install`
// is no longer needed and re-introduced duplicate react/react-native copies.

await $({ stdio: 'inherit', cwd: 'modules/bluetooth-sdk' })`bun run prepare`;
// jspolyfill emits assets/startup.js and mirrors it into the gitignored
// crust/ios/Resources/startup.js that crust's pod globs for MentraJSRuntime.bundle.
// We invoke its build here (not via workspace `prepare`) because bun skips cached
// workspace prepares on no-change installs, which would leave the mirror missing.
// crust declares @mentra/jspolyfill as a dep so this runs before crust.
await $({ stdio: 'inherit', cwd: 'modules/jspolyfill' })`bun run build`;
await $({ stdio: 'inherit', cwd: 'modules/crust' })`bun run prepare`;
await $({ stdio: 'inherit', cwd: 'modules/miniapp' })`bun run prepare`;
// island depends on bluetooth-sdk + miniapp build outputs, so its prepare
// (renamed to build:module) runs here instead of being auto-triggered by bun
// install in parallel with its workspace deps.
await $({ stdio: 'inherit', cwd: 'modules/island' })`bun run build:module`;

// ignore scripts to avoid infinite loop:
// await $({ stdio: 'inherit' })`bun install --ignore-scripts`;

console.log('✅ Postinstall completed successfully!');
