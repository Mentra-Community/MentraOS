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
//
// NON-FATAL: island's compiled build/ is NOT consumed by the app or CI — both
// metro (metro.config.js) and tsconfig resolve `@mentra/island` to src/, not
// build/. Its isolated expo-module build can't resolve the cloud-v2 packages it
// imports (`@mentra/cloud-client`, `@mentra/cloud-runtime/protocol`) because the
// generated standalone tsconfig has no metro/tsconfig path aliases. So let it warn
// rather than fail the whole install — same precedent as the root @mentra/miniapp
// postinstall build. (The standalone build only matters for Phase-2 publishing.)
try {
  await $({ stdio: 'inherit', cwd: 'modules/island' })`bun run build:module`;
} catch {
  console.warn('\n[postinstall] WARNING: @mentra/island build:module failed (non-fatal — the app and CI resolve @mentra/island from src/, not build/).\n');
}

// Apply the Supabase patch via patch-package from its OWN directory
// (patches-runtime/, holding only this one patch). It strips a dynamic
// import('@opentelemetry/api') that Metro/Hermes can't parse — without
// it the release bundle fails at `createBundleReleaseJsAndAssets`.
//
// Why patch-package here instead of bun's native `patchedDependencies`:
// the CI bun (1.3.14) does NOT apply the native patch on a fresh
// install, so the bundle shipped unpatched and the Android release build
// failed. patch-package runs every postinstall and writes the file
// deterministically, independent of bun version.
//
// Why a separate dir: a bare `patch-package` scans all of patches/ and
// chokes on the stale orphan patches there (expo+55.0.5,
// react-native+0.83.2) whose installed versions have moved —
// --error-on-fail (default in CI) then fails the whole install.
// --patch-dir isolates this to the one patch we own; the patches/ dir
// stays bun-native-only.
await $({ stdio: 'inherit' })`bunx patch-package --patch-dir patches-runtime`;

// ignore scripts to avoid infinite loop:
// await $({ stdio: 'inherit' })`bun install --ignore-scripts`;

console.log('✅ Postinstall completed successfully!');
