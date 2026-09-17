---
status: active
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

- [ ] Restore the iOS Call restriction in
  `mobile/src/constants/miniapps.ts`, with the combined debug/environment policy.
  Preserve the existing regional restrictions and Android behavior.
- [ ] Add the typed local setting in
  `mobile/modules/engine/src/stores/settings.ts`, translated UI copy in
  `mobile/src/i18n/en.ts`, and the iOS-only switch in
  `mobile/src/app/miniapps/settings/debug.tsx`. Use `ToggleSetting` with a stable
  accessibility identifier and make the build override visible in its state/copy.
- [ ] Use the same policy for bundled installation, preinstalled registry sync,
  deployment-managed sync, and previously installed Call entries. Reconcile
  policy before restoring saved running state; later registry sync must not
  expose Call when both controls are off. Wait for settings hydration before
  evaluating the saved opt-in.
- [ ] Replace PR #4078's unconditional migration 5 unhide with behavior gated
  by the current visibility policy. Keep the migration version slot valid for installations
  that already ran it. Test default-to-override and override-to-default build
  transitions without relying on rerunning a one-time migration.
- [ ] Subscribe to debug-setting changes through the existing miniapp
  coordinator. Reuse existing installation and stop paths; serialize
  reconciliation and recheck current policy after asynchronous installation so
  a quick on/off switch cannot leave Call visible. Surface installation errors.
  Preserve normal user hiding after opt-in rather than repeatedly unhiding on
  unrelated registry refreshes.
- [ ] Document the optional variable as a commented example in
  `mobile/.env.example`, so CI copying this file keeps production behavior.
  Keep actual testing overrides in ignored local `.env` files.
- [ ] Document that changing this variable requires reloading the development
  JavaScript bundle or rebuilding an installed release-style app. Editing
  `.env` alone does not change an already installed standalone app.

## Validation and review

- [ ] Focused tests for iOS with each debug-setting value and the environment
  variable absent, empty, `false`, invalid, and `true`; Android remains available
  for every combination; regional restrictions remain effective.
- [ ] Verify environment precedence, override removal restoring the saved
  setting, local persistence across restarts, no server synchronization,
  runtime enable/disable, and disabling during asynchronous installation.
- [ ] Cover fresh installation and cached installed/hidden/running entries,
  including devices that already ran migration 5. Verify both build transitions
  and startup ordering before autostart.
- [ ] Run relevant mobile tests and type checks. Verify Expo's bundled output
  with the variable absent and explicitly enabled, then build the test app.
- [ ] Record the default-build UI routine: hidden -> Debug Settings on ->
  visible -> restart -> still enabled -> Debug Settings off -> hidden. Separately
  verify an environment-enabled build shows Call with the setting off and
  explains the override, then return to a default bundle and verify the saved
  setting controls visibility. No meeting or glasses stream is needed.
- [ ] Update PR #4078's title, description, and evidence, then push to that same
  PR. Suggested title: **Gate iOS Call behind debug controls and fix call integration**.
- [ ] Document both opt-in mechanisms for the iOS/Mac Call harness routine,
  using the environment override for repeatable test builds. Keep harness
  implementation changes separate from #4078.

Implementation is in progress on #4078. Focused policy/lifecycle and UI tests
pass; real-store hydration preserves the preference across restarts. Device
recording and final PR evidence are pending.
