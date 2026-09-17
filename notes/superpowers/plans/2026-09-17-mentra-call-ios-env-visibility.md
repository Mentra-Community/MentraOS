---
status: complete
owner: philippe
---

# Keep Mentra Call on iOS behind a debug setting and optional build override

Target: PR #4078, branch `codex/enable-mentra-call-ios`.

This supersedes the default iOS enablement in the existing
[Call investigation plan](2026-09-16-mentra-call-ios.md), and the proposed
Mac-specific default. The final requested design includes both a debug setting
and an environment override, applying only to iOS, including the iOS app running
on a Mac. Android is the release qualification priority.

## Intended behavior

Add an iOS-only **Show Mentra Call (experimental)** switch to the existing Debug
Settings screen. Store `show_mentra_call_ios` in the existing settings system:
default `false`, locally persisted, and not synchronized to the server.

Also support this optional Expo environment variable in `mobile/.env`:

```dotenv
EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS=true
```

- On iOS, Call is enabled when the environment variable is exactly `true` OR
  the saved debug setting is `true`. A fresh/default installation therefore
  keeps Call hidden unless explicitly enabled through either mechanism.
- Unset, empty, `false`, and unrecognized environment values mean **no build
  override**: use the saved debug setting, whose default is off. In particular,
  `false` does not prevent a tester from enabling Call through Debug Settings.
- The environment override takes precedence: when it is `true`, show the debug
  switch as on and disabled, with copy explaining that the build configuration
  enables Call. Do not persist the environment value into the debug setting;
  removing the override restores the user's previous setting.
- The switch and both visibility controls apply only to iOS, including Mac.
  Ignore their values for Android availability; do not add an Android switch.
- The variable is optional. Missing it must not cause a configuration error,
  build failure, or startup warning.
- Use Expo's standard static reference
  `process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS === "true"`, so the value is
  included in the JavaScript bundle. Combine it with the hydrated debug setting
  in the shared miniapp policy without introducing constants/engine import cycles.
- Enabling either mechanism installs/shows bundled Call, including previously
  policy-hidden entries. Turning the debug switch off, when no build override
  applies, hides Call and stops it through normal miniapp/call cleanup. The
  runtime switch takes effect without a rebuild or restart.
- Returning to a bundle without the override hides Call if the saved debug
  setting is off, and prevents saved running state from restarting it.
- No server flag or Mac detection bridge is needed. Development mode, Debug
  Mode, and Super Mode alone do not enable Call.
- Retain the bundled ZIP and existing iOS call fixes. This is test availability,
  not a claim that iOS calling is release-qualified.

## Implementation checklist

- [x] Restore the iOS Call restriction in
  `mobile/src/constants/miniapps.ts`, with the combined debug/environment policy.
  Preserve the existing regional restrictions and Android behavior.
- [x] Add the typed local setting in
  `mobile/modules/engine/src/stores/settings.ts`, translated UI copy in
  `mobile/src/i18n/en.ts`, and the iOS-only switch in
  `mobile/src/app/miniapps/settings/debug.tsx`. Use `ToggleSetting` with a stable
  accessibility identifier and make the build override visible in its state/copy.
- [x] Use the same policy for bundled installation, preinstalled registry sync,
  deployment-managed sync, and previously installed Call entries. Reconcile
  policy before restoring saved running state; later registry sync must not
  expose Call when both controls are off. Wait for settings hydration before
  evaluating the saved opt-in.
- [x] Replace PR #4078's unconditional migration 5 unhide with behavior gated
  by the current visibility policy. Keep the migration version slot valid for installations
  that already ran it. Test default-to-override and override-to-default build
  transitions without relying on rerunning a one-time migration.
- [x] Subscribe to debug-setting changes through the existing miniapp
  coordinator. Reuse existing installation and stop paths; serialize
  reconciliation and recheck current policy after asynchronous installation so
  a quick on/off switch cannot leave Call visible. Surface installation errors.
  Preserve normal user hiding after opt-in rather than repeatedly unhiding on
  unrelated registry refreshes.
- [x] Document the optional variable as a commented example in
  `mobile/.env.example`, so CI copying this file keeps production behavior.
  Keep actual testing overrides in ignored local `.env` files.
- [x] Document that changing this variable requires reloading the development
  JavaScript bundle or rebuilding an installed release-style app. Editing
  `.env` alone does not change an already installed standalone app.

## Validation and review

- [x] Focused tests for iOS with each debug-setting value and the environment
  variable absent, empty, `false`, invalid, and `true`; Android remains available
  for every combination; regional restrictions remain effective.
- [x] Verify environment precedence, override removal restoring the saved
  setting, local persistence across restarts, no server synchronization,
  runtime enable/disable, and disabling during asynchronous installation.
- [x] Cover fresh installation and cached installed/hidden/running entries,
  including devices that already ran migration 5. Verify both build transitions
  and startup ordering before autostart.
- [x] Run relevant mobile tests and type checks. Verify Expo's bundled output
  with the variable absent and explicitly enabled, then build the test app.
- [x] Record the default-build UI routine: hidden -> Debug Settings on ->
  visible -> restart -> still enabled -> Debug Settings off -> hidden. Separately
  verify an environment-enabled build shows Call with the setting off and
  explains the override, then return to a default bundle and verify the saved
  setting controls visibility. No meeting or glasses stream is needed.
- [x] Update PR #4078's title, description, and evidence, then push to that same
  PR. Suggested title: **Gate iOS Call behind debug controls and fix call integration**.
- [x] Document both opt-in mechanisms for the iOS/Mac Call harness routine,
  using the environment override for repeatable test builds. Keep harness
  implementation changes separate from #4078.

Implementation is on #4078. The focused test run passes 108 tests across
13 suites; the real settings-store hydration test passes four assertions. Full
mobile TypeScript passes. The first complete signed default-build replay passed
21 steps in 41.643 seconds, including both restarts. Artifact completeness and
frame liveness passed; no model calls or streams were used.

The device run exposed a startup subscription ordering bug, now covered by the
MantleManager regression test. It also exposed an obsolete grid-level policy
check from harness PR #4069; that duplicate was removed so the product's reactive
hook owns Home and All Apps visibility. The initial failed runs are retained.
The environment-enabled build passed all five steps in 11.660 seconds, including
the on/disabled switch and override explanation. Its artifacts and frame liveness
also passed. After reinstalling the default archive, the saved switch was off
and Call was hidden. A complete follow-up replay passed 21 steps in 42.252
seconds with stable-state assertions and zero foreground-focus changes. All 47
steps across the three successful runs have verified screenshots, chapters and
live video; none started a meeting or stream. The default build is installed,
the local override is removed, and the saved switch is off.

The first restoration replay stopped at recorder reattachment after restart;
its eight-second matching-window deadline expired. The current window retained
its original size, and the retry passed without changing the assertion. That
failed run (`2026-09-17T17-55-43-455Z-ios-call-visibility-b93911`) remains intact.
Fresh-setting/install paths are covered by focused tests; the physical app tests
used an existing installation with cached Call versions and migration 5.


## Evidence

Recorded runs are beneath the integration checkout's ignored
`.test-results/mentra-e2e/` directory. Each folder contains `index.html`,
`routine.mp4`, `chapters.json`, `run.json`, screenshots and accessibility snapshots.

- Default: `2026-09-17T17-52-08-414Z-ios-call-visibility-259ea6`.
- Environment override: `2026-09-17T17-55-04-292Z-ios-call-build-override-f196c2`.
- Restored default: `2026-09-17T17-57-23-960Z-ios-call-visibility-bb865a`.

Both signed Release builds contain the same product source (`cc4cff3cfe`). The
integration source differs only by the harness's added stable-state assertions.
Default bundle SHA-256:
`3b48fbb0122f572b95c188739acecc76639bea08573ef1c80168ea9be0f32c27`.
Override bundle SHA-256:
`9a088e0cc44791348ad733ba338d5fd8d64de2c2652cf0823bc6473bf9a7611a`.
Exact archive hashes, signing requirements and source commits are preserved in
`ios-call-visibility-builds/default-grid-fixed-manifest.json` and
`ios-call-visibility-builds/env-final-manifest.json`.

![Debug opt-in](../assets/mentra-call/ios-debug-visibility.png)

![Build override](../assets/mentra-call/ios-build-override.png)


Harness PR #4069 includes the English routine, deterministic flows, and explicit
child-process test stdio. Its offline suite passes 45 tests / 160 assertions;
10 tests requiring hardware or Chrome are skipped. Harness TypeScript passes.

CI on product commit `cc4cff3cfe` compiled the Android Release APK successfully,
but GitHub's release upload returned HTTP 500 / fetch failed in run
`35254050558`. This is an artifact-publication failure, not a compile failure;
the latest PR checks remain authoritative. Existing live-call qualification
limits and external miniapp publication requirements are unchanged.
