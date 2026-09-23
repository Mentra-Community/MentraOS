# Frame preview gate runbook

How to produce and check the numbers for the Phase 0 screening runs and the release gates.
Every run writes one NDJSON file (see the module [README](../README.md#what-gets-measured-and-where-it-lands));
`preview-run.ts` in this folder turns one file into a summary and two files into a PASS/FAIL table.
Phase 0 and the release gates use the same script, so their numbers are directly comparable.

Tolerances live in one object, `TOLERANCES`, at the top of [`preview-run.ts`](preview-run.ts). They are
proposed defaults: confirm or edit them **before** the first run, then commit the change so the
limits are fixed before anyone sees a result.

## The script

```sh
cd mobile/modules/frame-preview/tools
bun preview-run.ts summarize <run.ndjson>           # meta, quarters, percentiles, counters, events, thermal, memory
bun preview-run.ts soak <run.ndjson>                # Phase 0 soak criteria for one synthetic run
bun preview-run.ts diff <off.ndjson> <on.ndjson> [--send-fps N] [--gate phase0|release]
bun preview-run.ts retained <first.ndjson> [...] <last.ndjson>   # release memory gate, retained part
bun test                                            # the script's own tests
```

- `diff` picks the release criteria when both runs are at least 20 minutes long, otherwise the
  Phase 0 screening criteria. Use `--gate` to force one.
- `--send-fps` is the call's target send rate (the ACS preset frame rate). Without it the
  script uses a target recorded in the log, or else the off run's median as the reference, and
  says which it used.
- Add `--json` to any command for machine-readable output.
- Exit codes: `0` PASS, `1` FAIL, `2` INCOMPLETE (a criterion had no data in the log), `64` usage,
  `66` unreadable file. **INCOMPLETE is not a pass.** It usually means tap telemetry was off or the
  build predates a counter.
- The first 2 status lines and any line written after the pacer stopped are excluded from the
  per-second analysis. The first tick drains tap metrics accumulated before the run started.
- Send rate is read from `acsSendFps` when present, else `tapFramesOffered` (frames the decoder
  handed to the call's sender in that second).

## Getting the NDJSON off the device

Note the `runId` shown in the preview panel at the end of each run: it is the file name.

**Android** (debug or release, no root needed):

```sh
adb shell pm list packages | grep -i mentra                  # find <app-id>
adb shell ls /sdcard/Android/data/<app-id>/files/frame-preview/
adb pull /sdcard/Android/data/<app-id>/files/frame-preview/<runId>.ndjson runs/
```

**iOS** (the path is also logged as `FRAME-PREVIEW ios run log <path>` at start):

```sh
xcrun devicectl list devices
xcrun devicectl device copy from --device <device-id> \
  --domain-type appDataContainer --domain-identifier <bundle-id> \
  --source "Library/Application Support/frame-preview" --destination runs/ios/
```

Or in Xcode: Window > Devices and Simulators > the app > Download Container, then open
`AppData/Library/Application Support/frame-preview/`. Container access needs a
development-signed build; for release-configuration gate runs, build Release with development
signing rather than installing from TestFlight.

## Phase 0: screening (before implementation)

1. **Android soak.** Physical device, debug build, synthetic source, mode `render`, 1280x720 at
   30 fps, grain on. Run 20 minutes, the same length as the iOS soak. Then:

   ```sh
   bun preview-run.ts soak runs/android-soak.ndjson
   ```

   Pass: delivered fps within 2% of target in every quarter; delivery gap p95 at or below 1.2x the
   period; zero ack timeouts and zero transport errors. Report `mainQueueWaitMsP95` (printed as a
   note) next to the iOS soak's numbers, and run `soak` on the iOS file too.

2. **Real-call screening, both platforms.** Join a call from glasses at the planned shipping
   preset. In the same session:
   - 5 minutes with the preview **off**: start a run with mode `off` so the status ticker and
     tap telemetry run with no sink attached (on hardened builds, enable tap telemetry in the
     hidden developer setting instead).
   - 5 minutes with the preview **on**: source `call`, mode `render`, the shipping size tier.

   ```sh
   bun preview-run.ts diff runs/call-off.ndjson runs/call-on.ndjson --send-fps <preset fps>
   ```

   Pass: send rate on within 2% of off; no 1-second send bucket below 90% of target;
   `tapOfferMeanUs` at or below 50 µs and its per-second p99 at or below 500 µs;
   `tapCadenceMaxMs` p99 grows by no more than 5 ms.

3. Archive the iOS soak NDJSON and the screening files with the spec's gate evidence (not in this
   repository), together with the script output.

Implementation starts only if the screening passes.

## Release gates (before shipping)

Release builds on both platforms, tap telemetry and the run log enabled through the hidden
developer setting.

1. **Sustained real call.** Same session and preset: 20 minutes preview off, then 20 minutes on.

   ```sh
   bun preview-run.ts diff runs/rel-off.ndjson runs/rel-on.ndjson --send-fps <preset fps>
   ```

   Checks: send rate within 2%; `tapCadenceMaxMs` p99 growth at most 5 ms; delivery gap p95 at
   or below 1.2x the period (worst quarter); thermal no worse than the off run and never above
   `fair` (iOS) or `moderate` (Android); memory slope with preview on minus off at most
   0.2 MB/min; zero ack timeouts, transport errors, tap sink exceptions and pack failures;
   `installReloads` is 0.

2. **Memory after toggles.** 50 hide/show toggles, 10 dismiss/reopen cycles of the UI, 3 page
   reloads, using the Maestro preview flow under `mobile/.maestro/flows/` once it exists. Each
   start writes a new file; pass the first and last files in order:

   ```sh
   bun preview-run.ts retained runs/toggle-first.ndjson runs/toggle-last.ndjson
   ```

   Pass: retained memory (median of the last run's final 5 seconds) within 2 MB of the baseline
   (median of the first run's first 5 seconds). Memory is iOS physical footprint and Android JVM
   heap; compare within one platform only.

3. **Audio continuity (manual).** Over A2DP, no new gaps over 100 ms compared with the off run.
   Use the audio underrun counters where available plus a listening check with timestamps noted
   against the run's `atMs` events. The script does not evaluate this.

4. **Functional acceptance and observability.** Every spec acceptance criterion, the refusal and
   lease cases, the race cases, declared-error isolation on both platforms, and the fault-injection
   cases are covered by the unit, integration and device tests. Confirm them on the release build,
   and check that a bug report filed during a preview session contains the `PREVIEW_TRACE`
   lifecycle with no tokens.

Record each gate's script output (text or `--json`) with the spec's gate evidence. Do not paste
device identifiers or meeting details into public PRs.
