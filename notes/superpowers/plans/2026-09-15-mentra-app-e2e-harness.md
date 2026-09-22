---
status: active
owner: Philippe
---

# Mentra App E2E harness implementation

Design: [TestFlight-on-Mac harness](../specs/2026-09-15-mentra-app-e2e-harness.md).
English checklist: [ROUTINE.md](../../../tools/mentra-e2e/ROUTINE.md).

## Current state

- [x] Inspect the real TestFlight app, source, and native accessibility tree.
- [x] Isolate work on `codex/mentra-e2e-harness` from `origin/dev` at `95dfa6c4b2f341917b687798ff7b0065365d3115`.
- [x] Write the justified design and 40-step English routine.
- [x] Implement the Swift accessibility driver, Bun runner, snapshots and failure reporting.
- [x] Pass the original seven-step login/validation proof twice from a terminal.
- [x] Prove AXValue reaches real validation and authorized sign-in; redact secure values.
- [x] Add continuous target-window video, timestamped English chapters and per-step PNGs from the same stream.
- [x] Observe unpaired home, Gallery guard, Settings, Profile, account forms, logout cancellation and Feedback.
- [x] Confirm Settings/Profile interactions can run while another app retains desktop focus.
- [x] Remove coordinate/visual fallbacks, global input and foreground activation from the driver, per the user's direction.
- [x] Add labels, IDs and accessible activation to the missing app controls; add mobile tray activation tests.
- [x] Write Mac Mini provisioning, permission, credential, transfer and troubleshooting instructions.
- [x] Verify the old binary fails the new capsule accessibility preflight, exits nonzero and retains screenshot/video evidence.
- [x] Verify this Mac's Xcode iOS-on-Mac destination and valid development signing identity; add a local `bun ios:mac` build/launch command and setup instructions.
- [x] Install isolated worktree dependencies and pass the full mobile TypeScript check; resolve the initial stale CocoaPods catalog via `pod repo update`.
- [x] Complete and qualify the local signed Release build and background launch.
- [x] Verify app accessibility source changes in an installed build.
- [x] Finish all required English walkthrough steps and encode the observed behavior.
- [x] Qualify recording reattachment after normal app relaunch and fixture cleanup.
- [ ] Verify the HTML chapter viewer in a browser and final screenshot/video timing across a complete run. Browser automation rejected opening the local file under its URL policy; no workaround was attempted.
- [x] Qualify three complete no-glasses replays with no model calls or manual corrections.
- [ ] Complete failure-path coverage for permission denial, target ambiguity and cleanup.

## Current state and remaining qualification

The real local Release build runs through an immutable outer Mac wrapper with its signed contents unchanged. Its executable and bundled JavaScript are verified against the local build manifest. The first complete 68-step replay passed in 98.4 seconds, with 68 PNG/AX pairs and two successful relaunches. The current 70-step routine adds verified all-apps page scrolling. The app's all-apps list also now honors its existing platform exclusion policy for Mentra Call.

- Clean-source build and three complete replays passed; README records all runs and matching app/harness hashes.
- Deliberate missing-target failure and separate cleanup evidence passed; native rejection checks and a real recording interruption were also verified.
- Final MP4/PNG/AX/chapter checks passed for all 210 executed steps. PR #4069 includes the results and representative screenshots.
- Browser chapter interaction remains unverified because the browser tool rejected the local file URL. Do not use another surface or localhost as a workaround.
- Fresh OS permission dialogs, actual permission denial, and a headless/second Mac are provisioning qualification gaps; do not reset the current machine's TCC database to manufacture them.

No messages, feedback, account changes, model downloads, media mutations, device scans or pairings were submitted by the routine. Signed-in unpaired home is the required final state.

## Findings fixed during the walkthrough

- BottomSheet grouped its descendants into one accessibility element; its backdrop's default activation hit content beneath it. Expose its children and bind the named close action explicitly.
- Running-miniapp cards had a zero-height parent, so native accessibility omitted visible cards. Give the parent its actual card height.
- Detached native views briefly report infinite frames during logout; exclude those frames instead of crashing JSON serialization.
- Copied development `.env` values displayed v2.8.0 in Settings despite native v3.2.0. The local Mac build now supplies the canonical repository version to both prebuild and bundling.
- All Apps bypassed platform exclusions and surfaced Mentra Call on iOS. Apply the existing platform policy before the user-hidden-app override.
- ScreenCaptureKit stream termination was not forwarded to the recorder, so stale images could accompany later AX checks. Observe stream errors and require a recent complete/idle frame observation for each screenshot. The OS log identified disk cache purges (`cacheDeleteUrgencyHigh`) at both failed capture times; only 3.3 GiB of disk space remained. Remove this task's disposable Xcode caches, retain every run, and fail preflight below 5 GiB. A real interrupted restore run now fails immediately with error `-3821`, without claiming fresh evidence.
- At the user's request, recording now holds scoped macOS keep-awake assertions. They release on report completion or process exit and expire after four hours. The native assertion test and a recorded relaunch probe pass; normal lock preferences and pointer/focus behavior are unchanged. This follow-up changes recording lifecycle management, not the qualified 70-step routine or app binary.

## Completion criterion

The first Mac lane requires reproducible semantic actions, meaningful assertions, per-step evidence, verified cleanup, zero-model terminal replay and three successful full runs on the same final build. Keep platform/setup gaps and unverified viewer interaction explicit; neither a compile nor a historical partial run substitutes for full replay evidence.

The first clean-build qualification attempt was interrupted when the user moved Mentra between displays. The old display crop lost the target, and position-constrained recovery failed. That run remains incomplete (`2026-09-15T23-09-13-256Z-no-glasses-b4a4ef`). The recorder now uses window-independent capture and temporarily parks on an empty allowlist across relaunch. A 14-step restore run, including three relaunches, passed with the new mechanism (`2026-09-15T23-15-01-836Z-restore-unpaired-257191`); its 25.08-second video and screenshots passed independent artifact checks. Position changes are allowed, size changes remain explicit failures, and human focus changes are recorded without automatically blaming the harness.

A complete clean-build 70-step replay passed in 95.846667 seconds (`2026-09-15T23-17-28-530Z-no-glasses-55881c`), with 70 screenshot/AX pairs. No step recorded Mentra as foreground. A later repetition exposed the disk-pressure capture termination described above. After adding liveness checks, seven-step navigation and idle-screen recording probes passed; a real system-stopped capture failed immediately. About 4 GiB was recovered from this task's generated Xcode caches. Further qualification reached a locked desktop, so no routine actions ran. The runner now identifies that precondition explicitly. After the user unlocked the desktop, three consecutive final-code runs passed: `2026-09-15T23-34-29-745Z-no-glasses-0d7ee5` (90.998333 seconds), `2026-09-15T23-36-01-585Z-no-glasses-2cdbc6` (93.303333 seconds), and `2026-09-15T23-37-35-919Z-no-glasses-e9b5c0` (90.773333 seconds). All three share the same harness, executable and JavaScript hashes; all 210 executed steps passed independent evidence checks. No step recorded Mentra as foreground. Browser chapter interaction and fresh-machine provisioning remain unqualified.
