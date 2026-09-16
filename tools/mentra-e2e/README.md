# Mentra App E2E harness

Start with the [English coverage checklist](ROUTINE.md), [exact compiled routine](COMPILED-ROUTINE.md), [design and technology choices](../../notes/superpowers/specs/2026-09-15-mentra-app-e2e-harness.md), [accessibility contract](ACCESSIBILITY.md), and [Mac Mini setup](SETUP.md).

The [Mentra Call English routine](MENTRA-CALL-ROUTINE.md) is being developed separately. Latest `dev` hides Call on iOS, and the unpaired host lacks its required camera capability. `mentra-call-ios-availability` checks that existing host policy through Home and All Apps; it does **not** qualify the Call UI or meetings. The target for the Call UI routine is still pending.

This harness drives the real iOS app on an Apple Silicon Mac. A Swift helper invokes native accessibility actions; Bun executes typed steps with zero model calls. Every executed step saves a screenshot, accessibility snapshot, English instruction and timestamp in a continuous MP4. The static report lets a person search descriptions and jump to the corresponding video moment.

Three consecutive **70-step** replays passed in **91.0, 93.3 and 90.8 seconds** on the same clean local Release build and identical harness code. All 210 screenshots and accessibility snapshots, three MP4s and their chapter timestamps passed independent artifact checks, including frame liveness. Each replay used zero model calls; no step recorded Mentra as foreground. Earlier failed runs remain preserved.

## Build and run

```sh
# One-time app/dependency/signing setup is documented in SETUP.md.
cd mobile
bun install --frozen-lockfile
bun ios:mac
cd ..
bun run tools/mentra-e2e/run.ts doctor
bun run tools/mentra-e2e/run.ts run --suite no-glasses --fixture unpaired --build-manifest mobile/build/ios-mac/build-manifest.json
```

Start on English, signed-in, unpaired home. The routine verifies account identity before logout, exercises navigation and account forms, cancels pairing, checks Gallery/Captions guards, validates authentication locally, signs back in, handles the observed onboarding path, and verifies session restoration after normal relaunch. It neither submits feedback nor changes credentials, downloads models, installs miniapps or changes preferences. Appearance, a paired-disconnected fixture and a separate store surface are explicitly not applicable.

Credentials are prompted without echo. For unattended use, inject `MENTRA_E2E_EMAIL` and `MENTRA_E2E_PASSWORD` through an existing secret manager. No credential is committed or passed as a command argument. Omit `--build-manifest` only for TestFlight, where the executable/JS identity is recorded but source provenance may be unknown.

The driver uses no mouse/keyboard injection or foreground activation. Per-step evidence records the foreground app. Human focus changes are recorded without attributing them to automation. Keep Mentra open at the same size; window capture follows its position, so you may move it out of the way. Only one harness run can own Mentra at a time.

Each recording automatically holds macOS keep-awake assertions through `caffeinate`, preventing idle system/display sleep and declaring user activity without injecting input. They are released on success, failure or runner exit, with a four-hour maximum. No persistent lock settings are changed. Start with the Mac unlocked; manually locking it still stops the run. `run.json` records the keep-awake process and normal cleanup.

A failure stops ordinary steps and retains its evidence. Recovery has separate steps and status, uses only recognized screens, and attempts to restore signed-in unpaired home. A successful recovery never turns the failed run into a pass.

## Other commands

```sh
bun run tools/mentra-e2e/run.ts inspect
bun run tools/mentra-e2e/run.ts describe
# From signed-out welcome:
bun run tools/mentra-e2e/run.ts run --suite driver-proof
# From onboarding welcome:
bun run tools/mentra-e2e/run.ts run --suite onboarding
# From signed-in unpaired home:
bun run tools/mentra-e2e/run.ts run --suite lifecycle-proof
# Call's current iOS exclusion, from signed-in unpaired home:
bun run tools/mentra-e2e/run.ts run --suite mentra-call-ios-availability --build-manifest mobile/build/ios-mac/build-manifest.json
bun run tools/mentra-e2e/run.ts describe --suite mentra-call-ios-availability
# With a miniapp open, read-only capsule contract check:
bun run tools/mentra-e2e/run.ts run --suite accessibility-preflight
```

`login` is a small probe expecting home directly. This account reaches onboarding after logout, so use the full routine or follow that probe with `onboarding`. `discover` accepts one JSON Step per line and the literal `stop` to finalize. It is interactive exploration, not a deterministic pass; never send credentials through discovery input.

Regenerate the exact English routine after changing the flow:

```sh
bun run tools/mentra-e2e/run.ts describe > tools/mentra-e2e/COMPILED-ROUTINE.md
```

## Evidence

Each run prints a unique folder under `.test-results/mentra-e2e/`. `index.html` contains the video player and searchable English chapters. `chapters.json` is the portable timestamp index; `run.json`, `events.jsonl`, `checklist.md`, `summary.md`, `screenshots/` and `accessibility/` contain results. Artifacts are local, ignored by Git, and may contain the test account's email. Password values remain masked/redacted.

Open a run's `index.html` locally to browse its English steps, or open `routine.mp4` directly in a video player. Keep the run folder together: the report links to its adjacent video and screenshots. Nothing is uploaded automatically.

Evidence version 2 records the latest window-server observation time for every screenshot. A complete frame or an explicit idle observation confirms the stream is live; blank, suspended, stopped or stale capture cannot produce a passing screenshot. Idle observations retain the last complete image, so an unchanged screen remains valid without inventing a new image timestamp.

New reports also record `bundledMiniappArtifacts`: SHA-256 hashes of ZIPs in the running binary's `assets/assets/miniapps` directory. This distinguishes archives even when their filename/version is unchanged. An unavailable directory is reported explicitly. These are packaged assets, not proof of which runtime-extracted or subsequently updated miniapp is active. Incremental Xcode products may retain an older unreferenced archive alongside the current one; do not select the runtime version by directory order.

| Run folder | Result |
| --- | --- |
| `2026-09-16T18-44-23-699Z-no-glasses-f84f75` | After merging dev and fixing Clear Search activation: all 70 steps passed in 85.86 seconds. All screenshot/video/chapter and liveness checks passed; zero model calls and no step recorded Mentra as foreground. This build includes the recorded local source diff. |
| `2026-09-16T18-43-54-655Z-mentra-call-ios-availability-a19d83` | Five host-policy/search steps passed in 6.465 seconds after fixing Clear Search. Artifact checks passed. This is not Call UI or meeting coverage. |
| `2026-09-16T00-12-31-228Z-lifecycle-proof-6b13b6` and `2026-09-16T00-12-52-266Z-accessibility-preflight-4619a3` | Keep-awake follow-up: recorded relaunch passed; intentionally running the miniapp preflight from home failed as expected. Both runs passed artifact checks and released their own macOS power assertions. The nine native checks also verify assertion creation and cleanup. |
| `2026-09-15T23-34-29-745Z-no-glasses-0d7ee5` | Qualification 1: 70 passed, 3 exclusions, 90.998333-second video; all evidence and frame-liveness checks passed. |
| `2026-09-15T23-36-01-585Z-no-glasses-2cdbc6` | Qualification 2: 70 passed, 3 exclusions, 93.303333-second video; all evidence and frame-liveness checks passed. |
| `2026-09-15T23-37-35-919Z-no-glasses-e9b5c0` | Qualification 3: 70 passed, 3 exclusions, 90.773333-second video; all evidence and frame-liveness checks passed. |
| `2026-09-15T23-17-28-530Z-no-glasses-55881c` | Complete 70-step replay: 70 passed, 3 declared exclusions, zero model calls, 95.846667-second H.264 video. Clean app source `f336af5`; harness `cba7332`. No step recorded Mentra as the foreground app. |
| `2026-09-15T23-19-05-171Z-no-glasses-bb784f` | Incomplete repetition: capture stopped and old frames were reused; a later Back action also failed. Preserved as incomplete. This exposed the missing stream delegate and freshness check. |
| `2026-09-15T22-54-39-726Z-no-glasses-c34c5b` | First full replay: 68 passed, 3 declared exclusions, zero model calls; 68 PNG/AX pairs; 98.376667-second H.264 video, 576×1090. Both relaunches passed. Dirty local build recorded honestly. |
| `2026-09-15T22-53-25-301Z-onboarding-41117c` | Four onboarding/setup/relaunch steps passed on the local Release build. |
| `2026-09-15T23-01-08-675Z-discovery-ce816d` | All-apps open, scroll down/up and close verified through accessibility. |
| `2026-09-15T22-36-38-571Z-discovery-9639da` and `2026-09-15T22-48-36-217Z-discovery-1d68b3` | Recorded discovery, including failed expectations and the native serializer failure. Preserved as failures, not relabeled as passes. |
| `2026-09-15T21-43-42-280Z-accessibility-preflight-045bcd` | Old TestFlight build correctly failed the new capsule contract; nonzero exit and finalized screenshot/video evidence. |

The three qualification runs share harness SHA-256 `5e654b1779569a72384aea5e33cfdd2efe92fdf93ab23b9637fae5009ae3666e`, the `f336af5` clean app build and identical executable/JavaScript hashes. They ran after harness commit `2105697`; the only intervening commit added the representative walkthrough image outside the harness. Later documentation updates do not change replay code. Three passes establish an initial baseline, not a statistical reliability guarantee.

Browser automation verification of the local HTML viewer remains pending: the browser tool rejected its local-file URL under its security policy. No alternate browser or localhost workaround was used. MP4 metadata, screenshots and timestamp consistency are checked independently; this does not claim that browser seeking was manually verified.

Accessibility visibility checks use native element frames intersecting the app window, not pixel recognition. Ancestor clipping or underlying screens can still leave an AX element exposed, so the routine uses distinct destination markers and captures screenshots for human review. A semantic assertion alone is not a visual-layout approval.

## Failure and artifact checks

`failure-proof` deliberately opens Settings, attempts a nonexistent identifier, stops ordinary execution, and records recovery. Expect exit code **1**, `FAILURE-not-run: not-run`, and a separate successful recovery ending on home:

```sh
bun run tools/mentra-e2e/run.ts run --suite failure-proof --build-manifest mobile/build/ios-mac/build-manifest.json
```

Run `bun tools/mentra-e2e/verify-run.ts <run-folder>` with FFmpeg/ffprobe installed to independently check the MP4, PNG dimensions, secure-value redaction, chapter timestamps, unique IDs, viewer links and version 2 frame liveness. Older recordings explicitly report that liveness was not recorded. This validates artifact structure, not browser playback interaction. The deliberate failure run `2026-09-15T23-05-20-659Z-failure-proof-bdb364` exited 1, retained the failure, restored home, and passed these artifact checks (9 screenshots, 16.98-second video).

## Development validation

```sh
cd tools/mentra-e2e
bun install --frozen-lockfile
bun run typecheck
MENTRA_E2E_NATIVE_CHECKS=1 bun test runner
```

Mobile checks:

```sh
cd mobile
bun run compile
bun run test --runInBand --runTestsByPath src/components/home/AppSwitcherButton.accessibility.test.tsx src/constants/miniapps.test.ts
```

The native rejection checks, redaction test, mobile type check, four mobile tests, and signed local Release build have passed during development. See the [implementation plan](../../notes/superpowers/plans/2026-09-15-mentra-app-e2e-harness.md) for remaining qualification and known limits. This lane does not qualify physical glasses, Phone Mode, iPhone background operation, or a headless Mac Mini.

For three unattended repetitions with one hidden credential prompt:

```sh
bun tools/mentra-e2e/qualify.ts --build-manifest mobile/build/ios-mac/build-manifest.json
```

After an interrupted run, `run --suite restore-unpaired` records recovery from recognized home, authentication-start or onboarding state. It uses the designated credentials and normal navigation; it does not reset storage.
