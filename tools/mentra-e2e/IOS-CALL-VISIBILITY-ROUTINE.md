# Setup and replay

Requires the iOS visibility controls from MentraOS PR #4078. This includes the
iOS app running on Mac; Android availability is unchanged.

- Default: leave `EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS` unset in `mobile/.env`.
  In Settings, tap the version ten times to unlock Debug Mode if needed. Open
  Debug Settings and leave **Show Mentra Call (experimental)** off.
- Debug opt-in: the switch persists only on this device and takes effect immediately.
- Build override: set `EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS=true` in `mobile/.env`
  before rebuilding. This forces Call visible and disables its debug switch;
  it does not overwrite the saved switch value. Unset/false follows that value.
- Preserve the default build archive/manifest so it can be reinstalled after
  checking the override. Verify Call is hidden again with its saved switch off.

Run from the integration checkout, on English paired home:

```sh
bun tools/mentra-e2e/run.ts run --suite ios-call-visibility --fixture mentra-live-03BE-paired --build-manifest mobile/build/ios-mac/build-manifest.json
# After installing the environment-enabled build:
bun tools/mentra-e2e/run.ts run --suite ios-call-build-override --fixture mentra-live-03BE-paired --build-manifest mobile/build/ios-mac/build-manifest.json
```

Each step saves a screenshot, accessibility evidence and a video chapter. These
routines change Call visibility only: they do not open a meeting or start a
camera/microphone stream. A failure retains its evidence and does not silently
reset settings. Run the default routine again after reinstalling the default
build to verify override removal.

# iOS Call visibility routine

Start on English paired home with Debug Mode unlocked and the saved Call switch off. Use the matching default or environment-enabled build. No meeting or stream is created.

1. **VIS-01-default** Check Call availability on home. Expected: Home is ready and Mentra Call is hidden.
2. **VIS-02-default-search-open** Open All Apps. Expected: The miniapp search field is available.
3. **VIS-02-default-search-search** Search All Apps for Call. Expected: The search reads Call and Mentra Call is absent, including previously installed entries.
4. **VIS-02-default-search-clear** Clear the miniapp search. Expected: The search field is empty.
5. **VIS-02-default-search-close** Close All Apps. Expected: Home is restored without Mentra Call.
6. **VIS-03-enable-settings** Open Settings from home. Expected: Account settings and Profile are visible.
7. **VIS-03-enable-scroll** Scroll Settings down to the advanced settings section. Expected: Debug settings is available.
8. **VIS-03-enable-debug** Open Debug Settings and inspect the Mentra Call switch. Expected: The Call debug switch is off and editable.
9. **VIS-04-enable** Turn on Show Mentra Call (experimental). Expected: The switch is on.
10. **VIS-05-enabled-home** Close Settings and check the Call launcher. Expected: Home is ready and Mentra Call is visible.
11. **VIS-06-enabled-restart** Restart the Mentra App and check Call availability. Expected: Home is ready and Mentra Call is visible.
12. **VIS-07-disable-settings** Open Settings from home. Expected: Account settings and Profile are visible.
13. **VIS-07-disable-scroll** Scroll Settings down to the advanced settings section. Expected: Debug settings is available.
14. **VIS-07-disable-debug** Open Debug Settings and inspect the Mentra Call switch. Expected: The Call debug switch is on and editable.
15. **VIS-08-disable** Turn off Show Mentra Call (experimental). Expected: The switch is off.
16. **VIS-09-disabled-home** Close Settings and check the Call launcher. Expected: Home is ready and Mentra Call is hidden.
17. **VIS-10-disabled-restart** Restart the Mentra App and check Call availability. Expected: Home is ready and Mentra Call is hidden.
18. **VIS-11-disabled-search-open** Open All Apps. Expected: The miniapp search field is available.
19. **VIS-11-disabled-search-search** Search All Apps for Call. Expected: The search reads Call and Mentra Call is absent, including previously installed entries.
20. **VIS-11-disabled-search-clear** Clear the miniapp search. Expected: The search field is empty.
21. **VIS-11-disabled-search-close** Close All Apps. Expected: Home is restored without Mentra Call.
# iOS build override routine

Start on English paired home with Debug Mode unlocked and the saved Call switch off. Use the matching default or environment-enabled build. No meeting or stream is created.

1. **ENV-01-visible** Check Call availability on home. Expected: Home is ready and Mentra Call is visible.
2. **ENV-02-override-settings** Open Settings from home. Expected: Account settings and Profile are visible.
3. **ENV-02-override-scroll** Scroll Settings down to the advanced settings section. Expected: Debug settings is available.
4. **ENV-02-override-debug** Open Debug Settings and inspect the Mentra Call switch. Expected: Call is enabled by the build override; the switch is on and disabled.
5. **ENV-03-home** Close Settings and check the Call launcher. Expected: Home is ready and Mentra Call is visible.

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
