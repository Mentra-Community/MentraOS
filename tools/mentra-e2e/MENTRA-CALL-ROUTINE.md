# Mentra Call routine

Status: Call UI and real-meeting coverage are in development. The user requested a separate iOS enablement branch, supplied Mentra Live glasses, and authorized opening the generated Teams link in a browser to verify the remote experience. See [the iOS enablement PR](https://github.com/Mentra-Community/MentraOS/pull/4078). A host-policy or source-level test pass does not qualify the Call UI routine.

## Target and source

- Host: harness branch merged with `dev` at `e8e1ced74c05705b313769d49dfbf98f8bf5b1d2` on September 16, 2026.
- Call source: [Mentra-Community/Mentra-Call](https://github.com/Mentra-Community/Mentra-Call), `main` at `6ab859d499321e7bc394f3113db8e024649e7faa`.
- Local source adds calendar and participant-state corrections plus capability-gated individual admission; version 2.1.16 has passed a signed build and real browser admission. Publishing it to external `main` still requires repository write access.
- Bundled miniapp: `mobile/assets/miniapps/com.mentra.call-2.1.16.zip`, SHA-256 `fe39832978a067b3c1d2f86a233abbc16b58db7bc1f48f035c3d2cd1a54b7b5f` (product PR; the integration build may advance during qualification).

Latest `dev` explicitly hides Call on iOS in `mobile/src/constants/miniapps.ts`. The host also requires the miniapp's declared camera and speaker capabilities before launch. An unpaired host uses the simulated-glasses profile, which has no camera. Inside Call, Join via Link and New Call are disabled while the Bluetooth link is unknown, disconnected, or reconnecting. Calendar is currently hidden (`SHOW_CALENDAR = false`).

The selected target is the real iOS app on this Mac, with iOS availability restored on `codex/enable-mentra-call-ios`. The old host exclusion described above is the starting dev baseline. The enablement branch removes it and migrates the policy-forced hidden flag once. No hardware or connection-state override is used. The former `mentra-call-ios-availability` exclusion suite is retired. The replacement `mentra-call-availability` verifies the enabled host in five recorded steps. The separate 13-step `mentra-call-ui` covers paired Call screens, settings inspection, empty forms and minimize/reopen. The real meeting has user-assisted glasses video/audio evidence below; full replay and field-editing qualification remain pending.

The selected real-call path is **Direct link through the original 03BE glasses' hotspot**, with Ethernet supplying the Mac's internet. Verify the wired route before moving Wi-Fi onto the glasses hotspot. Direct link is on by default in these ACS Teams bundles; turning it off manually selects cloud relay. There is no automatic fallback between the two. A cloud-relay pass cannot satisfy this hotspot routine.

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
24. Verify **Direct link for Teams is on** and the Mac has a working Ethernet default route while Wi-Fi remains enabled. Record Location state when diagnosing unavailable Wi-Fi information, but do not make Location mandatory: Apple's API also permits SSID access when the app configured the current hotspot. Preserve privacy settings unless a specific need and approval are established. Stop before joining if the Mac still depends on Wi-Fi for internet. Capture every hotspot, local receiver and internet-route checklist stage. The updated native check recognizes Ethernet and cellular; its path result is advisory for ACS, whose actual connection must still succeed. Do not change to cloud relay or label a Mac hotspot pass as an iPhone SoftAP pass.
25. Create one clearly named test meeting from Call. Record the actual generated Teams link and the meeting/join states. If joining fails, retain the checklist stage and original native/backend error, then verify cleanup before retrying.
26. Open that exact link in a browser as the laptop participant. Use the laptop’s built-in camera, microphone and speakers; the Mentra participant owns the glasses camera/microphone. Inspect the selected browser devices again after sign-in or rejoin because Teams can reset them. Preserve the user’s system audio choices; do not automatically redirect input/output. Press **Join now**. If Teams says someone will let you in, open **View participants** in Mentra Call, verify the exact test guest has **Waiting in lobby**, and press **Admit [test guest name]**. This control is present only when Teams grants lobby-management permission. Verify the browser exposes **Leave**, the waiting label disappears, and the miniapp shows **1 in call**. A lobby is not a connected call; record required human authentication separately. Verify both sides report the same active meeting and the Mentra participant list includes the browser participant. Record browser evidence alongside the Mentra App evidence with corresponding English step IDs.
27. Verify the remote participant receives changing video from the glasses. Capture the visible scene plus the video element’s resolution, readyState, paused state and advancing currentTime across two observations. A local CONNECTED label or one frozen frame is insufficient. Do not expect the current miniapp preview to display the other participant: its outgoing-preview feature is explicitly disabled in this bundle.
28. Verify each audio direction separately with distinguishable spoken phrases. Confirm glasses microphone speech is audible at the laptop, then confirm laptop microphone speech is audible through the glasses. Bluetooth Classic must be connected for the latter speaker path; its disconnection does not necessarily stop outgoing glasses audio. Check mute/unmute behavior. The Mac volume keys affect the default system output, which can differ from Teams’ selected speakers. Keep that setup issue separate from a media failure. Packet counts or a nonzero waveform alone do not prove intelligibility or return audio.
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

## First Ethernet / glasses hotspot attempt

Signed integration build `8c840639d1f4b6b42d634cbb17399e406e4af782` contains the Ethernet route fix. The initial two-step UI smoke `2026-09-16T23-12-46-615Z-mentra-call-ui-0408b6` failed at the audio guard while built-in audio was selected; its 11.553333-second recording and artifacts verified. After independently matching the connected 03BE and selecting its input/output, discovery `2026-09-16T23-13-54-664Z-discovery-7d93c2` recorded 11 steps / 180.355 seconds with verified screenshots, AX, chapters and video liveness. Ethernet carried internet; Wi-Fi remained enabled.

The default-named test meeting was created through the production Call backend at 23:15:37 UTC. The glasses announced “starting call” and enabled their hotspot. Native association then failed with `SCOPED_JOIN_FAILED: internal error.`, displayed as **Couldn't link phone to glasses**. No ACS join or browser participant was reached. Preserve this as a failed discovery, not a successful call or a compiled replay qualification.

The app disabled the hotspot on teardown, returned home, and all three Mac audio defaults were restored. The operator retired this exact meeting after matching ID, subject and creation time (DELETE 204, GET 404); `meeting-cleanup.json` records this separately from app cleanup. Private setup/native logs are in `2026-09-16T23-09-37Z-mac-hotspot-setup`. macOS denied Wi-Fi information due to missing Location access despite correct signed entitlements. Global Location Services and Mentra access were both off. Apple's SDK documents that an app-configured current network also permits SSID access, independently of Location. The initial permission-prerequisite interpretation was withdrawn; settings are unchanged and the denied pre-association reads are not an established cause of the join error.

Diagnostic retries `2026-09-16T23-29-37-580Z-discovery-873164` (nine steps / 105.281667 seconds) and `2026-09-16T23-33-50-907Z-discovery-261f81` (nine steps / 145.973333 seconds) also failed association, with verified artifacts and liveness. The latter ran clean integration source `dee7f2e6a0c73f8f5a7f410e64204acafcb366c3` and captured the exact native error: `NEHotspotConfigurationErrorDomain`, code 8, no underlying error; Apple's helper returned 107 immediately after `apply_start ios_on_mac=true`. Dynamic Foundation logs were redacted in the first diagnostic build; the final logger makes only error identifiers public, without exposing credentials. No alternate code path was established.

The authorized foreground comparison is complete. Run `2026-09-16T23-42-30-164Z-discovery-4dfadc` retained 12 steps / 227.74 seconds with verified artifacts and liveness. Mentra was confirmed frontmost before Create & Join and at failure; the same native error 8, helper result 107 and absent underlying error recurred. Foreground focus did not resolve association. Apple separately defines error 14 as application-not-in-foreground; error 8 alone never established that cause. All four Mac hotspot meetings were retired separately after exact identity/time checks, and each attempt verified hotspot/audio cleanup. Location settings stayed off. No ACS or browser media pass exists. These traces remain discovery evidence, not a qualified connected-call cache.

A minimal signed UIKit diagnostic then removed React Native, Teams and Bluetooth from the test. It reused the existing app identity/profile and Wi-Fi entitlements, requested a fresh nonexistent test SSID with `joinOnce = false`, and removed that exact configuration. Run `2026-09-16T23-54-53-913Z-minimal-hotspot-api-probe-8dd363` captured three deterministic steps / 1.493333 seconds with verified screenshots, video and liveness. The API returned `NEHotspotConfigurationErrorDomain` code 8 in 0.006 seconds, with no underlying error. UIKit reported `UIApplicationStateActive` (0) while another desktop app remained frontmost. This distinguishes UIKit state from macOS focus and reproduces the error without the Call flow; it does not establish that physical iPhone SoftAP is unsupported. Cleanup reported the temporary configuration absent, and the exact original Mentra binary was restored in the background. Diagnostic source, signing/build manifest and replay commands are retained in `2026-09-16T23-52-07Z-minimal-hotspot-probe`. The overall run remains failed despite successful observation/cleanup steps because the API request failed.

## September 17 browser media discovery

After normal OTA, the same signed OTA-enabled build first failed with macOS “Local network prohibited,” then passed the media join after the user had accepted local-network access. Setup `2026-09-17T02-56-16Z-call-permission-retry` and recording `2026-09-17T02-56-37-469Z-call-permission-retry-11f617` retain the evidence. Both attempts used native SHA `cbd2419dff595ff2b531f6a2d40eec660fbe3bd83f72843630fcebc7d69e7c7a` and JS SHA `41786720e307dc5deddd2d42ef3f0c32675cfcbf6adf41787bd6ada04d6d5c1b`. This is evidence about effective permission timing; it does not establish that the visible macOS settings list accurately represents every installed build.

The successful attempt received the first glasses frame, connected ACS, exchanged STUN in both directions and DTLS/media traffic. The browser required user-completed Microsoft email verification and a user click on Join now. Its Mentra Live tile showed the actual glasses scene at 960×540, with playback time advancing from 65.146 to 109.747 seconds. `browser/browser-video.mp4` is a 16.56-second screenshot-sampled clip with source timestamps in `browser/clip-frames.json`; the Mentra window has the separate continuous `routine.mp4`. Do not label the sampled browser clip as a continuous recording of the whole routine.

A 13.475-second browser-output WAV was non-silent, and the user subsequently confirmed intelligible glasses speech from the laptop speakers. The temporary virtual capture output initially made the laptop silent; selecting its built-in speakers resolved that setup issue. The user requested that future runs preserve device selections rather than adding audio-route overrides. Return audio was reported silent before the user disconnected Bluetooth Classic; after that disconnection, silence from the glasses is expected. Two-way audio is still unqualified.

The iOS participant sheet displayed zero after the browser joined. Source inspection confirmed the iOS native module omitted remote-roster reporting that Android already implements. This remains a failed check until a rebuilt app reports the actual participant and subsequent removal. The current miniapp preview is disabled deliberately; it is not a renderer for the remote laptop participant. The run involved user actions and a paused controller deadline to allow live testing, so it cannot qualify as zero-model replay. Keep the original failed participant assertion, user actions, setup changes and cleanup status in the evidence.

Successful browser controls observed during this run: role `button` named `Open audio options`; role `listbox` named `Microphone` with option `MacBook Pro Microphone (Built-in)`; listbox `Speaker` with option `MacBook Pro Speakers (Built-in)`; buttons `Mute mic`, `Turn camera off` and `Leave`. Scope options to their listbox, wait for the selected state after changing a device, and inspect fresh DOM state after every action. These are discovery selectors, not a qualified standalone browser runner.


## Browser session and admission setup

A repeatable browser routine should reuse a dedicated test profile, separate
from the user's personal browser. An anonymous guest with explicit host admission
worked without a code. If meeting policy requires sign-in, use Microsoft's normal UI.
Keep that profile local with user-only filesystem permissions; never put its
cookies, tokens, OTPs or profile in Git or the evidence bundle. Reuse normally
avoids email verification on every run, but Microsoft can expire or challenge
the session. Stop with an explicit sign-in-required checkpoint when that
happens; do not repeatedly request codes or report the run as passed.

On September 17 a stale guest session repeatedly stalled at “Just a moment.”
A normal Teams sign-out followed by sign-in reached email verification, which
the user completed. This is a documented recovery procedure, not an automatic
step for every run. The full Teams web loader also stalled separately.

After Join now, classify the actual browser state. “Someone will let you in
shortly” is a lobby, even if Mentra lists the guest. A permitted host must admit
the guest before media checks. The new iOS admission control targets one named
guest and appears only when Teams reports lobby-management permission. Do not
modify meeting/tenant policy to make a test pass. Only a connected browser
state, incoming media and a connected native participant qualify admission.

The proposed standalone browser adapter uses Playwright Core with installed
Google Chrome and a dedicated persistent profile. Playwright supplies semantic
locators, bounded waits, screenshots and recording; Chrome is a supported
Teams browser already installed here. This avoids maintaining a handwritten
CDP client for a changing third-party UI. The [browser companion](TEAMS-BROWSER-ROUTINE.md) is implemented and has recorded
real admission and incoming video, but has not completed a passing standalone
replay. Do not label its diagnostics a qualified full-call replay.

## Rebuilt roster result

`2026-09-17T03-33-41-155Z-mentra-call-ui-7950c6` passed all 13 UI steps in
11.873333 seconds on the rebuilt roster binary, with zero model calls and
verified artifacts. Diagnostic `2026-09-17T03-34-34-888Z-call-roster-check-5bc264`
recorded 27 passing scoped steps in 1548.888333 seconds. Anonymous and verified
email guests changed the iOS roster 0 → 1 on lobby arrival and 1 → 0 on departure.
Neither was admitted during this run. Its passing checks prove roster updates
and cleanup, not a successful media call. The source correction in Call 2.1.15
retains admission state and labels lobby guests accurately.

The browser left, Mentra showed “You left the call,” the owned hotspot stopped,
ADB returned to uid2000, capture copy hashes matched, and the exact meeting was
retired (DELETE204/GET404). All three user-selected audio device UIDs matched
before/after and the controller performed zero audio routing mutations.


## Admission and stable installation qualification, September 17

The Call 2.1.16 signed build (`6dc59afac117…` native, `a7db04379bcb…` JavaScript) admitted the named anonymous browser observer through the new Mentra Call **Admit** control. No email code was needed. In `2026-09-17T04-21-31-860Z-call-prompt-retention-20cfd4`, the UI moved from **0 in call · 1 waiting** to **1 in call**. The browser displayed the glasses' 960×540 video with unpaused playback advancing from 10.912 to 62.516 seconds. Its built-in laptop camera/microphone/speakers were selected. The native recording has 26 steps and 273.785 seconds; artifact and frame-liveness checks passed. The run retains failed status because its departure assertion incorrectly expected a zero-participant button on the main screen.

The corrected departure check opens **View participants**, then requires the heading **0 participants** and **Nobody else is in the call yet.** The main-screen participant strip disappears when empty; its absence alone does not prove a roster count.

The same binary was installed at the stable `~/Applications/Mentra E2E/Mentra.app` path and started another call without a new Local Network denial. `2026-09-17T04-30-06-098Z-call-stable-install-7ce2e2` records 27 passing native steps / 436.315 seconds, including admission and the corrected departure check, with verified artifacts and liveness. Browser qualification remains separate: the standalone browser received real video on one attempt, but rejected its legitimate 848×480 → 960×540 resolution adaptation; that assertion is corrected. A later rejoin reached the meeting but showed no remote participant within 20 seconds, so repeatability is still under investigation. Neither run qualifies duplex audio with Classic disconnected.

Both owned meetings were retired with exact ID/subject/time verification, DELETE 204 and GET 404. Each controller stopped its hotspot, restored ADB to uid 2000, retained scoped packet-capture evidence and made zero audio-device selection changes. The installer archived, extracted and signature/hash-verified all 22 legacy harness-created app wrappers before retiring those copies; the archive migration index preserves restoration paths. See [SETUP.md](SETUP.md) for the stable installation procedure. Cross-rebuild permission retention still requires qualification; no privacy setting was reset or bypassed.

The current miniapp intentionally disables preview (`CALL_PREVIEW_ENABLED = false` and `previewEnabled = false`). **Glasses camera is streaming** is its expected status card. It renders neither outgoing glasses video nor the laptop participant's video; the dormant preview implementation is for the glasses feed. Do not fail this build for a missing in-miniapp preview.


## Same-build permission recurrence and browser readiness

`2026-09-17T04-45-12-373Z-call-compiled-replay-cd1476` ran the native
controller and standalone Chrome companion without model calls. The native
host admitted the anonymous guest and showed one participant. The browser
participant tile appeared before its video element: the first sample was empty,
then five seconds later decoded 960×540 video was playing. The assertion failed
because it had no valid baseline. Replay now waits at most 20 seconds for a
first decoded frame, then independently requires advancing playback; an empty
baseline still cannot pass.

This run also required the user's repeated Local Network approval. The exact
same installed native and JavaScript hashes were reused. The native log reported
`Local network prohibited` at 04:45:53.881 UTC. The earlier stable-path pass
therefore does not establish permission persistence. Nearby macOS `nehelper`
logs show an app-uninstalled notification for the bundle ID, UUID cache removal,
and repeated zero-UUID lookups. Old diagnostic probe registrations remain;
these are investigation evidence, not proof of the cause. No privacy settings,
quarantine flags or security policy were reset. Keep `qualification.json` beside
the original failed report to record the human intervention.

The failed run retains 26 native steps / 116.218333 seconds with verified
screenshots, AX and video liveness. Its browser has a continuous recording with
English chapters calibrated against a recorded marker (49 ms uncertainty).
The browser left, the exact owned meeting was retired (DELETE 204 / GET 404),
the hotspot stopped and ADB returned to shell. Audio device selections were
unchanged. macOS reports the original 03BE link as BLE-only and exposes a USB
Mentra microphone, with no glasses Bluetooth speaker endpoint. This is not a
duplex audio qualification.


## Quota stop and offline follow-through

`2026-09-17T04-51-23-299Z-call-compiled-replay-6d2592` failed before ACS mint
with **Call limit reached**. Production returned HTTP 429 for the test account.
The default is 10 calls per UTC day, resetting at midnight UTC (5 PM PDT).
This did not retest Local Network access or browser video. A supplemental
`qualification.json` corrects the initial metadata's insufficient inference
from zero denial messages. The future controller requires the run itself to
pass before reporting unattended qualification. Known terminal screens can now
be declared with `failOn` so quota errors do not wait out the success timeout.

All 18 native checkpoint artifacts and the 99.93-second recording verified.
The exact meeting created before token mint was retired (DELETE 204 / GET 404),
the hotspot stopped and ADB returned to shell. This iteration gathers setup
logs, helper hashes and browser evidence under its single run directory.
The connected controller is still a private qualification script, not a
portable, qualified public replay command.

Ten additional signed diagnostic probe wrappers left registered under the same
bundle ID were archived, restored and file/signature-verified before unregistering
and removing those owned copies. Each original evidence folder retains its
`probe-archive.json` and restorable ZIP. The TestFlight installation and other
user checkouts were not changed. Whether this resolves the repeated prompt is
unverified; no security or privacy settings were changed.

At the user's request, live streaming stopped for the day. The final read-only
check `2026-09-17T04-57-22Z-end-of-day-stop` verified no active glasses camera
clients, no hotspot IPv4 address, Mentra home, Teams' Rejoin screen and no replay
or recorder processes. The test-owned keep-awake process was released. A standby
WHIP foreground service remained present with no camera client; service presence
alone is not evidence of an active stream. The pending proposal to add the test
account to the existing production QA quota allowlist was not applied.

Offline validation: 24 runner tests passed (68 assertions), with eight hardware
or keep-awake checks intentionally skipped; TypeScript and the browser CLI help
passed. Reprocessing the saved browser WebM produced a verified 16.72-second MP4,
eight calibrated chapters and 49 ms uncertainty. The original failing call report
is unchanged. Live readiness/rejoin, return audio and permission persistence
remain unqualified.

## Portable controller extraction (offline)

The [connected replay](CONNECTED-CALL-REPLAY.md) replaces the private script
with checked-in source and a validated per-machine fixture. It resolves the
current USB transport, pins hardware and boot identity, checks the signed build,
and coordinates native steps with the recorded browser companion under one run
folder. Meeting retirement now additionally requires the exact captured join
link, so a nearby meeting with the same subject cannot establish ownership.
Missing UI evidence fails the report without skipping owned resource cleanup.

This extraction was performed with streams stopped. Configuration parsing,
identity rejection, bounded child shutdown, evidence-failure handling and meeting
ownership have offline tests. They do not qualify live replay, permission
persistence, return audio, or native iPhone hotspot association. The historical
failed and assisted runs above retain their original status.

Extraction validation: 35 offline tests passed (103 assertions), with eight
hardware/keep-awake checks skipped; TypeScript passed. Both the native driver
and separate lease launcher compiled, and fixture-only validation passed. No
live call, recorder, browser or device command was run for this validation.
