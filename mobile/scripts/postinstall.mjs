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

// Dependency patches (incl. the Supabase fix that strips a dynamic
// import('@opentelemetry/api') Hermes can't parse) are applied by bun
// itself via the `patchedDependencies` map in package.json — no
// patch-package step here. patch-package eagerly applied every file in
// patches/, including stale orphans (expo+55.0.5, react-native+0.83.2)
// whose versions no longer match, and exited 1 under CI.

// ignore scripts to avoid infinite loop:
// await $({ stdio: 'inherit' })`bun install --ignore-scripts`;

console.log('✅ Postinstall completed successfully!');
