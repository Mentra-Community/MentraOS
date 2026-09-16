---
status: active
owner: philippe
---

# Restore Mentra Call on iOS and qualify a real Teams call

Branch: `codex/enable-mentra-call-ios`, based on dev `c06ccbea30fd961a90253a1f3f46dbe68e77e2e6`. Keep the recorded harness on `codex/mentra-e2e-harness`; integrate this branch there for local Mac testing. Call's external source is `Mentra-Community/Mentra-Call` main, at published `6ab859d499321e7bc394f3113db8e024649e7faa`; local main adds `92149df` (2.1.14; publication currently lacks write access).

The user requested iOS enablement and fixes, will provide Mentra Live glasses for pairing, and authorized opening the resulting Teams link in a browser to verify the remote participant's experience. Reported failure: the CTO completed the pre-join checklist but joining still failed. No report ID or exact error is available yet; reproduce the failing stage and retain its underlying error. The user confirmed USB `ML396102B` and Bluetooth suffix `03BE`; Bluetooth audio and app pairing are now complete. This supersedes the earlier local-Mac-only visibility allowance.

- [x] Create an isolated branch from dev.
- [x] Inspect existing native ACS, media and hotspot paths. Both WHEP and local WHIP exist on iOS; do not rely on the superseded structural-impossibility spike.
- [x] Restore Call install/catalog visibility and migrate the policy-forced hidden flag once. Preserve subsequent user hiding and China restrictions.
- [x] Run focused migration/policy tests and existing Swift media/audio suites; build and install the integrated local iOS-on-Mac app.
- [x] Identify and pair the user's Mentra Live through the real app; record build/firmware/transport identity.
- [x] Inspect Call's native accessibility surface after first-launch permissions.
- [ ] Compile and record the English Call routine: home/settings, joining/creating, link retrieval, browser participant, media observation, mute, leave and cleanup.
- [ ] Reproduce reported iOS failures and fix the shared state/media path. Update Call main/version/ZIP only if its source needs changes.
- [ ] Verify a controlled Teams meeting from the browser: live changing glasses video and audio delivery, consistent participant/call state, mute behavior and cleanup. Mere local CONNECTED state is insufficient.
- [ ] Retain failures and qualify deterministic repeatability. Document Mac Mini setup and which checks require a physical iPhone.
- [ ] Publish the separate iOS PR with actual validation and outstanding hardware gates.

Known platform distinction: the iOS hotspot helper currently waits specifically for cellular internet during direct-link calls. A Mac has no cellular interface; the existing cloud/WHEP path is a separate selectable transport. Do not infer iPhone SoftAP results from a Mac cloud-path run, silently switch transports, or disrupt the user's networking to manufacture a pass.

## Current evidence

- The user supplied USB target `ML396102B` and Bluetooth suffix `03BE`. ADB reports model Mentra Live and ASG `3.2.0-dev.206-camera-failure-dev` (`versionCode=100000206`); Wi-Fi is already associated with Mentra. No firmware or network configuration was changed.
- macOS inquiry found exact name `Mentra_Live_03BE`, address `CC:E7:DE:E0:03:BE`. This is the user's confirmed pair; `Mentra_Live_023B` is a different saved device and must not be used.
- The app's semantic scan/selection reached Pair Audio, which explicitly names `Mentra_Live_03BE`. This early run stopped before pairing completed; the subsequent native fix and successful run are recorded below. Android's own Bluetooth is off because the audio/BLE connection belongs to the glasses' separate Bluetooth subsystem; do not enable Android Bluetooth to work around this.
- Installed `blueutil` 2.14.0 from Homebrew for reproducible setup without mouse input. The old saved Mac bond failed to connect; refreshing only this target removed that bond, but fresh pairing returned `0x02 (No Connection)`. Subsequent inquiry did not find 03BE. The user subsequently entered pairing mode. Fresh bonding succeeded, followed by a target-only reconnect to recover an initial A2DP failure (20722); macOS then exposed both the glasses microphone and speakers.
- Integrated harness source `0b1037ad6f` built and installed successfully. Call now appears on the real iOS home page after migration. Its normal glasses-required guard correctly remains until pairing is complete.
- Six Jest visibility/migration tests, 17 Swift media-core tests, 23 Swift audio-policy tests and 205 engine ACS/SoftAP tests passed. Full mobile TypeScript passed in the provisioned integration worktree. The standalone new worktree initially lacked generated dependency artifacts; those errors were not treated as product failures.
- Pairing discovery `2026-09-16T18-54-24-086Z-discovery-ab5b3c` has four observed steps and valid MP4/PNG/AX/chapter evidence, ending at Pair Audio. Call launch discovery `2026-09-16T19-01-55-812Z-discovery-a4be19` retains the unmet glasses fixture as a failed launch, followed by dismissal of the guard. Neither is a successful call test.

- The enabled host availability/search routine passed three deterministic five-step replays on this app build (5.841667, 5.963333 and 5.84 seconds). Screenshots, AX trees, chapters and video liveness passed independent checks. The actual pairing-incomplete fixture was retained; this is not a Call join pass.

## Audio pairing follow-up

The September 16 run `2026-09-16T20-06-18-365Z-discovery-e575e5` retains two app readiness failures after Bluetooth audio profiles connected, including a same-build relaunch. Six observed steps and the 356.56-second video passed artifact/liveness verification. The original Mac input, output and system-alert devices were restored and verified with `SwitchAudioSource` 1.2.2.

The native route observer now belongs to DeviceManager rather than depending on PhoneMic initialization. A first probe build still failed (`2026-09-16T20-18-00-690Z-discovery-624eac`, three steps, 122.768333 seconds, valid artifacts). Selecting the connected target produced an explicit native diagnostic: `Mentra_Live_03BE (type: Bluetooth)`, rejected by the iPhone-only profile matcher; availableInputs was empty. This is an iOS-on-Mac port representation, not evidence that the device is unpaired.

Commit `de31f7b9d2` also accepts this observed generic port only on iOS-on-Mac and still requires the selected-device name. Six Swift tests pass for observer lifecycle, normal iPhone ports, the Mac port, and rejection of wrong/empty identity and non-Bluetooth devices. Both native builds succeeded. On the full fix, run `2026-09-16T20-23-15-226Z-discovery-ba137e` reached “Success — Mentra Live connected,” continued past the development-build notice without OTA, skipped both optional tutorials, and returned to paired home. ASG telemetry confirms USB `ML396102B`, Bluetooth `CC:E7:DE:E0:03:BE`, BES `26.9.9.1`, MTK `MentraLive_20260908.4`, and ASG `3.2.0-dev.206-camera-failure-dev`. Its 11 executed steps and 405.571667-second video have verified PNG/AX/chapter/liveness evidence. Overall discovery status remains failed: an initially guessed tutorial destination missed its confirmation, and first Call launch stopped at the required-permissions explanation. These setup misses are retained rather than overwritten with the later success. Pairing used ordinary UI/Bluetooth state, without a simulated hardware override.

## First Call launch and permission fix

Call requested camera, microphone and calendar before opening. Camera and microphone are required by the current ACS implementation. Calendar is unrelated to New Call or Join via Link, and `SHOW_CALENDAR` is false in the miniapp. Mark its manifest permission `required: false` so denied calendar access cannot prevent calling. The host already supports optional declarations. A new host regression proves launch succeeds with camera/microphone granted and calendar denied; all 19 permission tests pass. The existing external CalendarManager test also passes.

Local external Call main commit `92149df` bumps the canonical manifest to 2.1.14. Packaged with `pack:prod` through `scripts/sync-miniapp.mjs`; ZIP SHA-256 `c1c3bf69bcdede1acbffe4c9238a4e463a310c484cbe65c317954cbd7b591c35`. The embedded manifest was checked directly. The first package attempt lacked installed CLI dependencies; `bun install` resolved it without lockfile changes.

Computer Use rejected access to `com.apple.UserNotificationCenter` “for safety reasons.” Do not bypass that restriction using another automation route. The user completed camera/microphone grants, and 2.1.14 now opens. The first controlled meeting was subsequently created; cloud provisioning failed before ACS join, as recorded below. The CTO's exact original failure is still not established.

External publication gate: `git push origin main` was rejected with “Write access to repository not granted.” GitHub confirms account `PhilippeFerreiraDeSousa` has `pull: true`, `push: false` on Mentra-Community/Mentra-Call. The local source commit and bundled ZIP are retained; do not report it as published. Repository write access or a maintainer applying the commit is required.

The 2.1.14 signed Release build and background launch succeeded (integration source `16e8d35c08078ddba678c61a356ca24f52fad7b8`, app build `302005351`). Run `2026-09-16T20-34-52-490Z-discovery-09285e` verified the actual prompt lists only Camera and Microphone: three steps / 39.885 seconds, artifact/liveness checks passed. Native and JS hashes match the build manifest. No calendar grant was made. The user subsequently confirmed the prompts and the working Call UI verifies completion. The normal Mac input/output/system devices were restored and checked; the paired glasses remain connected to the app.

A separate harness fix explicitly scales captured frames to fill the video canvas on lower-density displays. The earlier pairing recording is preserved with its original padding. Fresh recordings prove the corrected layout. All ten runner/native checks ultimately passed after transient subprocess-launch failures; no speculative subprocess changes were retained.

## Real Call UI and failed cloud join — September 16

The installed build `302005351` opens Call with paired `Mentra_Live_03BE`. Thirteen recorded UI steps now cover home, settings, the saved name/transport/video profile, empty Join and default New Call forms, minimize/reopen and close. Three deterministic replays passed in 11.855, 11.75 and 12.196667 seconds; all 39 PNG/AX pairs, videos, chapter timestamps and capture liveness passed independent checks, with zero model calls and no observed Mentra foreground activation. The harness owns these routines and evidence; this product PR does not include the harness.

The real create-and-join run `2026-09-16T21-05-39-830Z-discovery-6bcdc6` successfully created one Teams meeting through the separate production Call backend at 21:09:40 UTC. The MentraOS dev runtime then failed its three Cloudflare stream-provision attempts with `Authentication error`, surfaced to the app as `HTTP 500 on POST /api/camera/stream`. Porter `cloud-dev` runtime revision v202 confirms the stack in `cloudflare-stream.provider.ts`. Read-only Cloudflare probes returned active-token verification (200) but Stream live-input listing failed (403/code 10000). The merged Porter account/token pair matches Doppler `cloud-v2/dev_aws`, and root `cloud-v2/dev` contains the same values. Switching those Doppler configs would not fix the failure. No credential or deployment changes were made.

This blocks the cloud/WHEP meeting lane before ACS and does not qualify iPhone Direct link/SoftAP behavior. The user was asked to have the Cloudflare credential owner correct Stream access for the configured account. Calendar and macOS permission gates are resolved; external Call repository write access remains unresolved.

Cleanup verified: Direct link returned to its original on state; Mac input/output/system defaults restored; pairing retained. Back to Home and miniapp closure did not retire the created Graph meeting. After matching the exact backend creation log, ID, subject and start timestamp, the harness operator deleted that one test object (204) and verified GET returned 404. This is cleanup evidence, not an app cleanup pass. No invitations were sent; no browser participant joined.

Remaining findings are tracked separately from the passing navigation routine: AXValue did not edit the link input despite reporting success; individual radio AXValues all read zero despite the selected visual profile; the Account row labels an opaque user ID as an email; the Settings Teams status copy runs together at the narrow Mac viewport. These require source fixes and installed-app verification. The routine asserts the actual profile summary and excludes editing, individual radio selection and connected media until qualified.
