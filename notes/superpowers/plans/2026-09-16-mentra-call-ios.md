---
status: active
owner: philippe
---

# Restore Mentra Call on iOS and qualify a real Teams call

Branch: `codex/enable-mentra-call-ios`, based on dev `c06ccbea30fd961a90253a1f3f46dbe68e77e2e6`. Keep the recorded harness on `codex/mentra-e2e-harness`; integrate this branch there for local Mac testing. Call's external source is `Mentra-Community/Mentra-Call` main, currently `6ab859d499321e7bc394f3113db8e024649e7faa` (2.1.13).

The user requested iOS enablement and fixes, will provide Mentra Live glasses for pairing, and authorized opening the resulting Teams link in a browser to verify the remote participant's experience. Reported failure: the CTO completed the pre-join checklist but joining still failed. No report ID or exact error is available yet; reproduce the failing stage and retain its underlying error. The user confirmed USB `ML396102B` and Bluetooth suffix `03BE`; completing Bluetooth audio pairing is pending. This supersedes the earlier local-Mac-only visibility allowance.

- [x] Create an isolated branch from dev.
- [x] Inspect existing native ACS, media and hotspot paths. Both WHEP and local WHIP exist on iOS; do not rely on the superseded structural-impossibility spike.
- [x] Restore Call install/catalog visibility and migrate the policy-forced hidden flag once. Preserve subsequent user hiding and China restrictions.
- [x] Run focused migration/policy tests and existing Swift media/audio suites; build and install the integrated local iOS-on-Mac app.
- [ ] Identify the user's Mentra Live pair, pair through the real app, record build/firmware/transport identity, and inspect Call's native accessibility surface.
- [ ] Compile and record the English Call routine: home/settings, joining/creating, link retrieval, browser participant, media observation, mute, leave and cleanup.
- [ ] Reproduce reported iOS failures and fix the shared state/media path. Update Call main/version/ZIP only if its source needs changes.
- [ ] Verify a controlled Teams meeting from the browser: live changing glasses video and audio delivery, consistent participant/call state, mute behavior and cleanup. Mere local CONNECTED state is insufficient.
- [ ] Retain failures and qualify deterministic repeatability. Document Mac Mini setup and which checks require a physical iPhone.
- [ ] Publish the separate iOS PR with actual validation and outstanding hardware gates.

Known platform distinction: the iOS hotspot helper currently waits specifically for cellular internet during direct-link calls. A Mac has no cellular interface; the existing cloud/WHEP path is a separate selectable transport. Do not infer iPhone SoftAP results from a Mac cloud-path run, silently switch transports, or disrupt the user's networking to manufacture a pass.

## Current evidence

- The user supplied USB target `ML396102B` and Bluetooth suffix `03BE`. ADB reports model Mentra Live and ASG `3.2.0-dev.206-camera-failure-dev` (`versionCode=100000206`); Wi-Fi is already associated with Mentra. No firmware or network configuration was changed.
- macOS inquiry found exact name `Mentra_Live_03BE`, address `CC:E7:DE:E0:03:BE`. This is the user's confirmed pair; `Mentra_Live_023B` is a different saved device and must not be used.
- The app's semantic scan/selection reached Pair Audio, which explicitly names `Mentra_Live_03BE`. Pairing is not complete. Android's own Bluetooth is off because the audio/BLE connection belongs to the glasses' separate Bluetooth subsystem; do not enable Android Bluetooth to work around this.
- Installed `blueutil` 2.14.0 from Homebrew for reproducible setup without mouse input. The old saved Mac bond failed to connect; refreshing only this target removed that bond, but fresh pairing returned `0x02 (No Connection)`. Subsequent inquiry did not find 03BE. Asked the user to press its power button three times quickly (the product's documented pairing-mode action); awaiting that physical step.
- Integrated harness source `0b1037ad6f` built and installed successfully. Call now appears on the real iOS home page after migration. Its normal glasses-required guard correctly remains until pairing is complete.
- Six Jest visibility/migration tests, 17 Swift media-core tests, 23 Swift audio-policy tests and 205 engine ACS/SoftAP tests passed. Full mobile TypeScript passed in the provisioned integration worktree. The standalone new worktree initially lacked generated dependency artifacts; those errors were not treated as product failures.
- Pairing discovery `2026-09-16T18-54-24-086Z-discovery-ab5b3c` has four observed steps and valid MP4/PNG/AX/chapter evidence, ending at Pair Audio. Call launch discovery `2026-09-16T19-01-55-812Z-discovery-a4be19` retains the unmet glasses fixture as a failed launch, followed by dismissal of the guard. Neither is a successful call test.

- The enabled host availability/search routine passed three deterministic five-step replays on this app build (5.841667, 5.963333 and 5.84 seconds). Screenshots, AX trees, chapters and video liveness passed independent checks. The actual pairing-incomplete fixture was retained; this is not a Call join pass.
