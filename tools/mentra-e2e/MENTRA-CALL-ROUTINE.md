# Mentra Call routine

Status: Call UI and real-meeting coverage are in development. The user requested a separate iOS enablement branch, supplied Mentra Live glasses, and authorized opening the generated Teams link in a browser to verify the remote experience. See [the iOS enablement PR](https://github.com/Mentra-Community/MentraOS/pull/4078). A host-policy or source-level test pass does not qualify the Call UI routine.

## Target and source

- Host: harness branch merged with `dev` at `c06ccbea30fd961a90253a1f3f46dbe68e77e2e6` on September 16, 2026.
- Call source: [Mentra-Community/Mentra-Call](https://github.com/Mentra-Community/Mentra-Call), `main` at `6ab859d499321e7bc394f3113db8e024649e7faa`.
- Local source adds commit `92149df` (calendar optional), version 2.1.14. Publishing it to external `main` still requires repository write access.
- Bundled miniapp: `mobile/assets/miniapps/com.mentra.call-2.1.14.zip`, SHA-256 `c1c3bf69bcdede1acbffe4c9238a4e463a310c484cbe65c317954cbd7b591c35`.

Latest `dev` explicitly hides Call on iOS in `mobile/src/constants/miniapps.ts`. The host also requires the miniapp's declared camera and speaker capabilities before launch. An unpaired host uses the simulated-glasses profile, which has no camera. Inside Call, Join via Link and New Call are disabled while the Bluetooth link is unknown, disconnected, or reconnecting. Calendar is currently hidden (`SHOW_CALENDAR = false`).

The selected target is the real iOS app on this Mac, with iOS availability restored on `codex/enable-mentra-call-ios`. The old host exclusion described above is the starting dev baseline. The enablement branch removes it and migrates the policy-forced hidden flag once. No hardware or connection-state override is used. The former `mentra-call-ios-availability` exclusion suite is retired. The replacement `mentra-call-availability` verifies the enabled host in five recorded steps. The separate 13-step `mentra-call-ui` covers paired Call screens, settings inspection, empty forms and minimize/reopen. Real meeting and field-editing qualification remain pending.

## Routine in English

Start signed in to the designated test account, in English, with no active meeting. Record the host build, miniapp version/archive hash, OS, device fixture, and any local test-build allowance. Keep the window size fixed. Start the continuous recording before the first UI step; save a screenshot, accessibility tree, expected result, and video chapter for every executed step.

### A. Host availability

1. Verify signed-in home, exactly one **Mentra Call** launcher, and no open miniapp or All Apps sheet.
2. Open **All Apps** and verify its search field and named Close button.
3. Search for **Call**. Verify the query and exactly one result: **Mentra Call**.
4. Clear the search using its named control. Verify the empty query and the return of both Settings and Mentra Call.
5. Close All Apps. Verify home and its Call launcher return, with the search and sheet dismissed.

These five steps are compiled in `flows/mentra-call-availability.ts`; print their exact assertions with `bun tools/mentra-e2e/run.ts describe --suite mentra-call-availability`. They preserve pairing and do not launch a meeting. If the launcher is absent on an older build, record a failure against this enabled-build expectation.

### B. Call without a Bluetooth connection

These steps require a host that permits opening Call. They preserve the miniapp's actual disconnected state.

6. Open Call using its accessible launcher. If the host reports incompatible hardware, retain and dismiss the alert, then stop with a missing-fixture result. Otherwise wait for Call's initial loading state to settle. Verify the Mentra Call home screen and its disconnected-glasses explanation. An unresolved “Looking for your glasses” state is a readiness failure, not a substitute for disconnected behavior.
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

These steps require completed pairing. The supplied device is `Mentra_Live_03BE`, USB `ML396102B`. Pairing completed on September 16 after the iOS-on-Mac audio readiness fix. The user granted camera/microphone permissions and the installed Call UI opened successfully.

19. With a supported connected device and no active call, open Join via Link. Verify the empty form and disabled Join Meeting action.
20. Enter a fixed invalid link and verify the local explanation. Repeat with a Teams-for-home link and a syntactically valid work/school Teams test link. Verify the expected validation state without pressing Join Meeting; clear the field and go back.
21. Open New Call. The observed default name is **Mentra Call**, with Create & Join enabled. Verify this initial state without submitting. In the editing extension, clear the name and verify the action is disabled; enter a temporary name, verify eligibility, restore the original name and go back. Editing is not yet qualified on this Mac.
22. In a separate reversible-settings extension, save the original video preferences, change resolution/frame rate/crop/bitrate one at a time, verify each state through the UI and after reopening, then restore every original value. A failure must retain separate cleanup evidence.

### D. Authorized real Teams meeting with Mentra Live

23. Verify the connected device is the user's `Mentra_Live_03BE` (USB `ML396102B`), record firmware/app identity, and check Bluetooth audio and microphone readiness. Incomplete pairing is a setup failure.
24. Record the selected call transport. For Direct link, capture every hotspot, local receiver and internet-route checklist stage. The iOS helper currently requires cellular during this path; a Mac cloud/WHEP call is a separate transport result. Do not silently fall back or label it an iPhone SoftAP pass.
25. Create one clearly named test meeting from Call. Record the actual generated Teams link and the meeting/join states. If joining fails, retain the checklist stage and original native/backend error, then verify cleanup before retrying.
26. Open that exact link in a browser as a test participant. Join/admit through the observed UI and verify both sides report the same active meeting. Record browser evidence alongside the Mentra App evidence with corresponding English step IDs.
27. Verify the remote participant receives changing video from the glasses. Capture browser media counters and visible frames; a local CONNECTED label or one frozen frame is insufficient.
28. Verify incoming glasses audio using an audible test stimulus and remote audio evidence. Check mute/unmute behavior. Packet counters alone do not prove intelligible audio or the glasses' return-audio path.
29. Exercise the agreed disconnect/rejoin cases with distinct evidence for the failed interval and recovery. Keep the current pairing and call ownership explicit; do not count a different meeting or transport as recovery.
30. Leave the controlled meeting on both sides. Verify Call returns home, camera/microphone publishing stops, the browser participant leaves, and temporary call resources are released. Restore any changed video/transport settings and finish with the glasses still paired.

QR camera use, invitations to other people, iPhone background/screen-off behavior and sustained SoftAP/media recovery need additional explicit steps. Do not infer them from the Mac/browser call.

## Replay implementation

Use the existing Swift accessibility driver and Bun typed steps for the Mac lane. The installed miniapp runs inside the real Mentra App WebView, so named WebView controls and the host capsule can share one recording and action log. This keeps the replay free of model calls and avoids controlling the user's mouse or foreground application.

Use stable host `testID`s and Call's semantic labels/roles. Inspect the actual installed accessibility tree and successfully invoke every action before committing its replay step. Source labels are candidate selectors until observed on the target. Add missing semantics in the owning source repository; do not use coordinates, OCR or injected JavaScript to make a control pass. A selector must also prove its resulting screen/state, not merely return success from AXPress.

For Call source changes, update its `main`, bump the canonical version in `miniapp/miniapp.json`, and package with the MentraOS sync script using `pack:prod`. Rebuild the host after changing its bundled ZIP. Preserve source commit, archive hash and actual host build identity with the run. If using Android instead, retain the same English expectations and artifact contract while implementing the device actions with the repository's Maestro lane.

Output remains `.test-results/mentra-e2e/<timestamp>-<suite>-<suffix>/`: `routine.mp4`, searchable `index.html`, `chapters.json`, `screenshots/`, `accessibility/`, `run.json`, `events.jsonl`, and `checklist.md`. A routine becomes qualified only after real discovery, three successful deterministic replays on the same build, evidence checks, and verified cleanup.

## September 16 pairing and launch findings

The real native pairing flow reached **Success — Mentra Live connected** and returned to paired home. Run `2026-09-16T20-23-15-226Z-discovery-ba137e` retains 11 observed steps, screenshots/AX, and 405.571667 seconds of verified video. Its failed overall status preserves the tutorial-confirmation discovery miss and the Call permission gate. This is successful pairing evidence, not a qualified meeting routine.

Call 2.1.13 required calendar access despite its hidden calendar feature. Local source commit `92149df` marks calendar optional in 2.1.14; the host regression passes with calendar denied. The bundle SHA-256 is `c1c3bf69bcdede1acbffe4c9238a4e463a310c484cbe65c317954cbd7b591c35`. Publishing this external source commit is pending repository write access; the signed local host rebuild uses the saved ZIP. Camera/microphone prompts remain required and must be completed by the user when the automation tool cannot access their system owner.

Updated-build host qualification: `2026-09-16T20-38-10-217Z-mentra-call-availability-41c677`, `2026-09-16T20-38-17-138Z-mentra-call-availability-1412b7`, and `2026-09-16T20-38-23-929Z-mentra-call-availability-cd0b3e`: five steps each, 6.025 / 5.881667 / 5.906667 seconds, zero model calls, artifact/liveness checks passed. Screenshots visually fill the canvas. Camera/microphone permission completion was subsequently confirmed through the working Call UI.

## Paired UI replay and first real join

Print the exact compiled English checks with `bun tools/mentra-e2e/run.ts describe --suite mentra-call-ui`. Start on paired English host home with Call closed, name **Mentra Live**, Direct link on, and video profile **960×540 @ 15 · Auto · 102° bottom**. The suite inspects these preferences without changing them, opens both forms without submitting, and closes Call after minimize/reopen. Every action was observed on the installed app before compilation. This does not qualify the disconnected section above.

Discovery `2026-09-16T21-05-39-830Z-discovery-6bcdc6` retains 18 executed steps and 390.796667 seconds of video, including failed expectations. Creating a Teams meeting succeeded at 21:09:40 UTC. The cloud/WHEP join then failed on three stream-provision attempts: the dev runtime returned `HTTP 500 on POST /api/camera/stream`. Porter runtime revision v202 logs identify the cause as `cloudflare live input create failed: Authentication error`. Read-only probes confirmed the configured token is active (200) but cannot list Stream live inputs for the configured account (403, code 10000). Porter and Doppler `cloud-v2/dev_aws` contain the same account/token pair. This is a server credential gate; ACS connection and remote media were never reached.

Direct link and Mac input/output/system audio were restored. The meeting object survived Back to Home and Call closure; it was separately retired through Graph after verifying the exact creation log, ID, subject and start time (DELETE 204, then GET 404). `meeting-cleanup.json` retains this evidence. That manual cleanup does not qualify app-owned resource cleanup. No invitation was sent and no browser participant joined.

Remaining accessibility/product findings: AXValue text entry reported success without changing the Teams-link field; pressing that field failed, so validation editing is excluded from the compiled pass. The Account row incorrectly displays an opaque `mu_…` ID as an email. All observed radio AXValues read zero, including selected options; the compiled suite verifies the visible profile summary, not individual radio selection. Keep these gaps explicit until owning-source fixes are exercised on the real app.

Paired UI qualification: `2026-09-16T21-22-42-981Z-mentra-call-ui-a9b90f`, `2026-09-16T21-23-09-891Z-mentra-call-ui-613b4a`, and `2026-09-16T21-24-19-512Z-mentra-call-ui-4e9f73`: 13 steps each in 11.855 / 11.75 / 12.196667 seconds, zero model calls. All 39 screenshots/AX snapshots, videos, chapters and frame-liveness checks passed. The installed app, replay code and native driver were unchanged; intervening documentation edits changed the broader harness-directory hash. No step recorded Mentra as foreground. Representative Settings, Join and final-home screenshots were visually inspected. The Settings Teams-status text runs together at this narrow viewport; this is retained as a layout finding, not a visual approval. Ten runner/native checks and harness TypeScript pass.

The exact 13 English steps are also saved in [COMPILED-MENTRA-CALL-ROUTINE.md](COMPILED-MENTRA-CALL-ROUTINE.md).
