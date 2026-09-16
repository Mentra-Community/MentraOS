# Mentra Call routine

Status: planned Call UI coverage; its native discovery is pending the target decision below. The separate five-step `mentra-call-ios-availability` replay verifies only the existing host exclusion and search cleanup. Print its exact English steps with `bun tools/mentra-e2e/run.ts describe --suite mentra-call-ios-availability`. A host-policy or source-level test pass does not qualify the Call UI routine.

## Target and source

- Host: harness branch merged with `dev` at `c06ccbea30fd961a90253a1f3f46dbe68e77e2e6` on September 16, 2026.
- Call source: [Mentra-Community/Mentra-Call](https://github.com/Mentra-Community/Mentra-Call), `main` at `6ab859d499321e7bc394f3113db8e024649e7faa`.
- Bundled miniapp: `mobile/assets/miniapps/com.mentra.call-2.1.13.zip`, SHA-256 `9ade8cca63ddc31a63e337d03ba5026793be049d9e515860a187894aeaeb7987`.
- The bundle and source manifest both identify version 2.1.13. This alone does not prove that all bundled code was built from that source commit.

Latest `dev` explicitly hides Call on iOS in `mobile/src/constants/miniapps.ts`. The host also requires the miniapp's declared camera and speaker capabilities before launch. An unpaired host uses the simulated-glasses profile, which has no camera. Inside Call, Join via Link and New Call are disabled while the Bluetooth link is unknown, disconnected, or reconnecting. Calendar is currently hidden (`SHOW_CALENDAR = false`).

The target decision is between Android with its supported product configuration and a deliberately identified local Mac test build that exposes Call. A Mac test build must document any host-only visibility/launch allowance; it must preserve Call's real disconnected state and disabled call actions. Results from such a build do not qualify normal iOS availability or real calling.

## Routine in English

Start signed in to the designated test account, in English, with no active meeting. Record the host build, miniapp version/archive hash, OS, device fixture, and any local test-build allowance. Keep the window size fixed. Start the continuous recording before the first UI step; save a screenshot, accessibility tree, expected result, and video chapter for every executed step.

### A. Host availability

1. Verify that the Mentra App is on its signed-in home page and that no miniapp or modal is open.
2. Open All Apps. Search for **Call**.
3. On an ordinary iOS build, verify that Call is absent, clear the search, and return home. Report the Call UI portion as unavailable on this target; do not count it as passed.
4. On a target where Call is supported or explicitly enabled for local testing, verify that exactly one Mentra Call result is shown. Open it using its accessible launcher.
5. If the host reports incompatible hardware, record the alert and dismiss it. Report the missing fixture. Do not replace this failure with a simulated successful call or skip ahead into the WebView.

### B. Call without a Bluetooth connection

These steps require a host that permits opening Call. They preserve the miniapp's actual disconnected state.

6. Wait for Call's initial loading state to settle. Verify the Mentra Call home screen and its disconnected-glasses explanation. An unresolved “Looking for your glasses” state is a readiness failure, not a substitute for disconnected behavior.
7. Verify that **Join via Link** and **New Call** are present and disabled. Verify that no meeting is active.
8. Open **Settings** using the button's “Open settings” accessibility label. Verify the Settings title and named Back control.
9. Verify **Name in calls** and the test account identity. Record the existing name; do not edit it in the initial read-only routine.
10. Inspect the Teams connection status and **Direct link for Teams**. Verify its displayed state and whether the host makes it available. Do not toggle it in the initial routine.
11. Verify that **Chat TTS** explains that it is turned off and that its switch is disabled.
12. Scroll through **Glasses video** using a semantic accessibility scroll action. Verify that the Resolution, Frame rate and ROI crop groups expose their option names and selected state. Check that frame-rate availability agrees with the selected resolution.
13. Inspect **Bitrate**. Verify the selected option, including Auto when that is the configured value. Do not assume defaults on an existing installation.
14. Go back to Call home. Verify that the disconnected message and both disabled meeting actions remain consistent.
15. Minimize Call using the Mentra App capsule. Verify that host home returns and that Call is listed as running.
16. Reopen Call from the running-miniapps list. Verify that its home is usable and its disconnected state is preserved.
17. Close Call using the capsule. Verify that host home returns and the running-miniapps list no longer contains Call.
18. Open Call again through home/All Apps. Reopen Settings and verify that the values observed earlier have not changed. Return to Call home, close it, and finish on the Mentra App home page with the search cleared and no test overlay open.

### C. Additional coverage with an appropriate device fixture

These steps are a later extension, not steps that can be reached on the current unpaired fixture.

19. With a supported connected device and no active call, open Join via Link. Verify the empty form and disabled Join Meeting action.
20. Enter a fixed invalid link and verify the local explanation. Repeat with a Teams-for-home link and a syntactically valid work/school Teams test link. Verify the expected validation state without pressing Join Meeting; clear the field and go back.
21. Open New Call. Verify that an empty meeting name prevents Create & Join. Enter a temporary name, check the action's eligibility, then clear it and go back without creating a meeting.
22. In a separate reversible-settings extension, save the original video preferences, change resolution/frame rate/crop/bitrate one at a time, verify each state through the UI and after reopening, then restore every original value. A failure must retain separate cleanup evidence.

Real Teams joins, meeting creation, QR camera use, invitations, microphone/camera transmission, SoftAP recovery and remote media quality require an explicitly provisioned call fixture and their own expected outcomes. They are not covered by the no-call routine.

## Replay implementation

Use the existing Swift accessibility driver and Bun typed steps for the Mac lane. The installed miniapp runs inside the real Mentra App WebView, so named WebView controls and the host capsule can share one recording and action log. This keeps the replay free of model calls and avoids controlling the user's mouse or foreground application.

Use stable host `testID`s and Call's semantic labels/roles. Inspect the actual installed accessibility tree and successfully invoke every action before committing its replay step. Source labels are candidate selectors until observed on the target. Add missing semantics in the owning source repository; do not use coordinates, OCR or injected JavaScript to make a control pass. A selector must also prove its resulting screen/state, not merely return success from AXPress.

For Call source changes, update its `main`, bump the canonical version in `miniapp/miniapp.json`, and package with the MentraOS sync script using `pack:prod`. Rebuild the host after changing its bundled ZIP. Preserve source commit, archive hash and actual host build identity with the run. If using Android instead, retain the same English expectations and artifact contract while implementing the device actions with the repository's Maestro lane.

Output remains `.test-results/mentra-e2e/<timestamp>-<suite>-<suffix>/`: `routine.mp4`, searchable `index.html`, `chapters.json`, `screenshots/`, `accessibility/`, `run.json`, `events.jsonl`, and `checklist.md`. A routine becomes qualified only after real discovery, three successful deterministic replays on the same build, evidence checks, and verified cleanup.
