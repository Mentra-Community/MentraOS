# Setup and replay

Requires the iOS visibility controls from MentraOS PR #4078. This includes the
iOS app running on Mac; Android availability is unchanged.

- Default: leave `EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS` unset in `mobile/.env`.
  In Settings, tap the version ten times to unlock Debug Mode if needed. Open
  Debug Settings and leave **Show Mentra Call (experimental)** and **Show Notify
  (experimental)** off. Both miniapps are hidden by default on iOS.
- Debug opt-ins: each switch persists only on this device and takes effect immediately.
  Either, both, or neither miniapp can be enabled.
- Build override: set `EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS=true` in `mobile/.env`
  before rebuilding. This forces Call visible and disables its debug switch;
  it does not overwrite the saved switch value. Unset/false follows that value.
  The build override never enables Notify or disables its debug switch.
- Preserve the default build archive/manifest so it can be reinstalled after
  checking the override. Verify Call is hidden again with its saved switch off.

Run from the integration checkout, on English paired home:

```sh
bun tools/mentra-e2e/run.ts run --suite ios-call-visibility --fixture mentra-live-03BE-paired --build-manifest mobile/build/ios-mac/build-manifest.json
# After installing the environment-enabled build:
bun tools/mentra-e2e/run.ts run --suite ios-call-build-override --fixture mentra-live-03BE-paired --build-manifest mobile/build/ios-mac/build-manifest.json
```

Each step saves a screenshot, accessibility evidence and a video chapter. These
routines change miniapp visibility only: they do not open a meeting or start a
camera/microphone stream. A failure retains its evidence and does not silently
reset settings. Run the default routine again after reinstalling the default
build to verify override removal.

# iOS visibility routines

Start on English paired home with Debug Mode unlocked and both saved switches
off. Use the matching default or environment-enabled build. No meeting or stream
is created.

The default routine checks neither enabled, Call only, both enabled, Notify only,
and neither enabled again, with restart persistence and All Apps exclusion. The
build-override routine checks that only Call is forced on; Notify stays hidden
and its switch remains editable.

Generate the exact steps:

```sh
bun tools/mentra-e2e/run.ts describe --suite ios-call-visibility
bun tools/mentra-e2e/run.ts describe --suite ios-call-build-override
```

The expanded two-miniapp routine still needs a device replay. The historical
evidence below records the earlier Call-only routine and does not qualify the
new Notify checks.

## Recorded validation (2026-09-17)

In the provisioned integration checkout, these run folders under
`.test-results/mentra-e2e/` passed with screenshot/AX evidence, English chapters,
video liveness and zero model calls:

- `2026-09-17T17-52-08-414Z-ios-call-visibility-259ea6`: default build, 21 steps,
  41.643 seconds.
- `2026-09-17T17-55-04-292Z-ios-call-build-override-f196c2`: environment override,
  five steps, 11.660 seconds. Saved debug preference remained off.
- `2026-09-17T17-57-23-960Z-ios-call-visibility-bb865a`: restored default archive,
  21 steps, 42.252 seconds, stable-state assertions and no focus changes.

The first restored-default attempt stopped at the recorder's eight-second
reattachment deadline during restart. Its incomplete evidence is preserved in
`2026-09-17T17-55-43-455Z-ios-call-visibility-b93911`; the retry passed without
relaxing the assertion. Earlier implementation failures are also retained.
The final installed app uses the default bundle and saved debug preference off.
No meeting or glasses stream was started by these checks.
