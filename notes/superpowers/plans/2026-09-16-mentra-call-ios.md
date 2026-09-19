---
status: active
owner: philippe
---

# Mentra Call integration and qualification

Product PR: [#4078](https://github.com/Mentra-Community/MentraOS/pull/4078).
Harness, English routines and recordings: [#4069](https://github.com/Mentra-Community/MentraOS/pull/4069).
Android is the release qualification target. iOS, including iOS-on-Mac, remains
hidden by default with explicit testing opt-ins described in
[the visibility setup](2026-09-17-mentra-call-ios-env-visibility.md).

## Final implementation

- One shared visibility policy combines the local iOS debug setting with the
  optional Expo build override. Installation, Home/All Apps, autostart and saved
  glasses menus apply the policy. Android availability is unchanged.
- `IosMiniappVisibility` serializes installation and teardown, immediately hides
  disabled Call, and rechecks policy after asynchronous installation. Its last
  effective-policy marker clears an old forced hide once while preserving later
  user hiding. Migration slot 5 remains reserved for existing test installations.
- `MantleManager` installs one bundled asset through a single operation that
  propagates errors. Startup catches per-asset failures and continues; explicit
  Call opt-in surfaces failure through the visibility controller.
- The iOS ACS session owns roster, mute and audio-source state on one queue.
  Android and iOS expose runtime lobby capability and admission for one selected
  waiting guest. Admission checks call ownership/state and rejects stale results.
- Bluetooth readiness belongs to DeviceManager, independent of microphone
  initialization. A cancellable settling window reconciles delayed input arrival
  and removal; Mac Bluetooth route names remain supported. No audio routing
  override is added.
- Hotspot internet may use cellular or Ethernet. Mac local media uses the
  verified hotspot address. Native configuration errors retain useful error codes.
  Android listener teardown waits for the accept thread to release its socket.
- Audio diagnostics retain bounded first-event and final counters. PCM peak
  analysis is compiled only with `MENTRA_E2E` for diagnostic test builds.
- Mac prejoined-network reuse and the expiring E2E lease belong to harness PR4069,
  alongside its explicit build flag and launcher. They do not qualify native
  association. Normal product builds continue through native hotspot association.

## Bundled source and backend

Call 2.1.18 is repacked from merged Mentra-Call PR35, main commit
`1bdbfdb4f66ca4e03d1df5db833d4615a180b5de`. All seven payload files match the
reviewed source bundle; only ZIP metadata changed after repacking.

```sh
bun scripts/sync-miniapp.mjs --repo /path/to/merged/Mentra-Call \
  --pack-script pack:prod --no-bump
```

ZIP SHA-256: `2f732716335832cf3a1852cc22adb411fd482767ec3b63848a25e835bee7a444`.
The effective BACKEND_URL assignment is
`https://mentra-call-miniapp-prod.mentraglass.com`; use `pack:prod` because the
plain pack script selects dev. ACS and authentication remain enabled. Permissions
are exactly CAMERA, PHONE_CAMERA and MICROPHONE. Calendar retrieval and its
miniapp permission are deferred to 3.3. The native host has no incoming-video
renderer and the miniapp preview is deliberately disabled.

## Reproducible qualification

The harness includes separate OTA and Call routines. Run mandatory OTA first;
Call's firmware gate then verifies the pinned ASG/MTK/BES targets without updating.
Use the exact candidate APK, its packaged OTA manifest and actual glasses identity.
For Android hotspot calls, use a phone with validated cellular internet. The phone
owns glasses Bluetooth Classic; the Teams browser uses the laptop's devices.

Use the generated Teams meeting link directly. A guest prejoin screen or lobby is
not admission. `lobbyBypassSettings.scope=everyone` does not establish the separate
tenant policy allowing anonymous callers to start meetings. Check actual roster
and MANAGE_LOBBY capability before attempting admission; don't infer a Microsoft
account requirement or claim a client change overrides server policy.

Each live attempt reserves budget before starting. A failed start counts. Record
screenshots, semantic controls, native logs and video chapters. Verify changing
remote glasses video, human-confirmed speech in both directions, mute/unmute,
roster departure/rejoin, then owned cleanup. Packet counters are supporting
evidence, not proof of audible delivery. Leave the browser, stop glasses capture
and hotspot, restore normal networking and verify exact owned meeting retirement.
Use text to speech when a listener or other user action is needed.

## Evidence and remaining gates

| Area | Evidence | Remaining qualification |
| --- | --- | --- |
| iOS visibility | Three deterministic default/override/restored-default runs, 47 steps with screenshots/video and stable focus | Recheck if visibility behavior changes |
| Native code | 223 Android tests; 116 Bluetooth Swift tests; two native session concurrency tests under Thread Sanitizer | New device build after source changes |
| Call bundle | Merged-source typecheck and 473 miniapp tests, 1,355 assertions; ZIP/permissions/backend verified; named Android mute/unmute controls exercised on eaaa568 | Audible mute/unmute still requires admitted peer |
| Android OTA | Recorded ASG update and independent up-to-date replay on earlier fixture | User explicitly deferred the separate OTA routine until after merge; current instrumented fixture is not a release-OTA qualification |
| Android Call | eaaa568 on Razr/SIM + 03BE: hotspot association, first glasses frame, ACS CONNECTED, named mute/unmute controls | Selected guest admission failed: UI roster showed IN_LOBBY but lookup through CallLobby.participants rejected it. Resolve selection from the same live remoteParticipants roster, retaining state/capability checks. New APK and complete media routine still required |
| Mac Call | Recorded admission, roster changes and advancing browser video; user confirmed glasses speech at laptop | Audible return path, Local Network permission persistence, physical iPhone behavior and app-owned retirement remain unqualified |

Do not merge before Android device qualification. Prior successful tests and
recordings describe their captured builds, not later artifacts. At the last live
checkpoint, 13 of 20 authorized attempts were consumed; seven remain. The user
released the hardware hold and requested continued Call testing despite another
USB drop; leave that failure state for the separate USB investigation. Preserve
the instrumented MTK `MentraLive_20260917.1` and ASG `302016752`; no OTA during Call.

Cleanup validation: 49 focused mobile tests and full mobile TypeScript passed.
Product media-core tests passed (22); the harness branch passed 20, including the
three relocated Mac cases. Hotspot code typechecked for iOS with and without
`MENTRA_E2E` in both branches. Diagnostics typechecked in both modes; compiled
Swift confirms PCM peak analysis is absent from normal builds.

The review hub is `.test-results/pr-4078-android-qualification-01f22fc/index.html`
in the integration checkout. It links the separate OTA installation, OTA replay,
Call preparation, live attempt and browser reports. Each report owns its MP4,
chapters, screenshots, commands and explicit pass/fail results. Full chronological
notes were preserved beside those reports in `investigation-notes/`; they also
remain in Git at commit `fb4aaf3a0e`. Private logs, credentials and meeting links
are excluded from the repository.
