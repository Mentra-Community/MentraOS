---
status: draft
owner: philippe
---

# Mentra Call on the streaming service

Third of three specs. `2026-09-16-glasses-hotspot-service-design.md` owns the network,
`2026-09-16-glasses-phone-streaming-service-design.md` owns the glasses-to-phone stream. This
one says what Mentra Call becomes once it is a consumer of that stream, and lists the reshuffle
the other consumers go through so the whole move is visible in one place.

Rule: Mentra Call is a call layer. It owns the ACS meeting, audio policy and the miniapp-facing
call state. It does not own the hotspot, the scoped join, the WHIP receiver, the glasses
publish, first-frame gating or media recovery. Every one of those exists in Call today and moves
out.

## What Call is today

`LocalMiniappRuntime.joinSoftapMeeting` → `SoftapCallTransport` (five steps: `hotspot`,
`scopedJoin`, `acsJoin`, `publish`, `live`) → `AcsMeetingService` → the acs-meeting native
session, which constructs glasses-media's `LocalWhipIngestSource` behind a
`GlassesMediaController`, binds the WHIP listener with the cellular pin lifted
(`withIngestUnpinned`), and feeds decoded frames to `AcsFrameSender` and a
`VirtualOutgoingVideoStream`. The runtime adds the hotspot mutex, the cleanup barrier, scoped
network loss handling, mid-call recovery (`beginSoftapRecovery` → `transport.recover`), and a
settled teardown that races the ingest-closed and hotspot-off acks and force-cleans on timeout.

## Target shape

```text
LocalMiniappRuntime (MEETING_* requests, MEETING_STATE fanout)
  └─ SoftapCallSession            (was SoftapCallTransport; two steps: acsJoin, stream)
       ├─ AcsMeetingService       (meeting, audio, state) + AcsMediaAdapter (attach/detach by MediaRef)
       └─ GlassesPhoneStreamService.open({owner: "call", adapter: AcsMediaAdapter, ...})
             └─ GlassesHotspotService.acquire({consumer: "video_streaming", operationId: "call:<id>"})
```

## Decisions

1. **Meeting first, stream second.** The ACS agent is prepared and the meeting joined before
   the stream opens, on the Internet route. This is the order the runtime uses today
   (`prepareAgent` then `joinMeeting` before the SoftAP media hop) and it is what lets the
   meeting survive every stream failure.
2. **The miniapp-facing contract does not change.** `MEETING_STATE` keeps `softap: {traceId,
   phase, steps[hotspot, scopedJoin, acsJoin, publish, live], elapsedMs, mediaGeneration}` and
   the `recovery: {active, generation, deadlineAt, phase}` fields, and join failures keep
   `{code, message, step}`. The five step names are no longer real steps; they are derived from
   the stream and hotspot state snapshots by a fixed mapping (below). Miniapp UIs that render
   the progress list keep working unchanged.
3. **One media adapter, two hooks.** `AcsMediaAdapter` implements the streaming spec's
   `StreamAdapter`. `attach(media)` borrows the decoded source from `GlassesMediaRegistry` by
   `MediaRef` and wires `AcsFrameSender` and the glasses PCM path onto the existing outgoing
   streams; `detach(media)` closes the lease and leaves the meeting untouched. ACS never sees an
   ingest URL, a network handle or a hotspot again.
4. **Recovery is observed, not driven.** `beginSoftapRecovery`, `transport.recover`,
   `shouldRepublish` and `republish` are deleted. The stream service recovers under the shared
   `RecoveryContext` with Call's defaults (60 s return, 45 s rebuild, three attempts, fresh
   frame). The call session subscribes to stream state and maps `recovering` to the existing
   `recovery` fields, `live` after a rebuild to a cleared recovery, and `failed` with
   `recovery_exhausted` to today's `state: "error"`, `error: "SOFTAP_NETWORK_LOST: …"` while
   the meeting stays joined and audio continues.
5. **Teardown is `stream.close()` then ACS leave.** `settleSoftapTeardown`,
   `forceSoftapCleanup`, `setGlassesHotspotState`, the hotspot-off ack race and the
   ingest-closed wait are deleted: the hotspot session's `release` settles the AP and the
   receiver, and the stream's `close` reports the `ReleaseResult`. `leaveAndAwait` stays for
   ACS. Leave and end-for-everyone differ only in the ACS call, as today.
6. **The cleanup barrier becomes a wait on the previous attempt's close.** `SoftapCleanupBarrier`
   existed to keep a new join from starting while the previous media hop was still unwinding.
   The hotspot service's reservation now makes that a `busy` error; the runtime avoids it by
   awaiting the previous attempt's `close()` promise before acquiring, and surfaces a `busy`
   from another consumer (gallery sync, OTA) as a join failure with `step: "hotspot"`, which
   is the step a hotspot conflict maps to today.
7. **Audio policy stays in Call unchanged.** Glasses microphone audio reaches ACS either as
   PCM from the stream (`captureAudio: true`) or over BLE LC3 through `pushOutgoingPcm`; phone
   microphone capture, mute, audio source selection and incoming mixed audio playback are
   untouched. The stream is opened with `captureAudio: false` whenever the LC3 uplink is active,
   which is the `glassesLc3Uplink` decision the transport makes today.
8. **The WHEP video source and its recovery are unaffected.** `updateVideoSource(whepUrl)`,
   `CloudflareWhepSource`, the phone-network watcher (`watchPhoneNetwork`,
   `unwatchPhoneNetwork`) that restarts the WHEP subscription when the phone switches between
   Wi-Fi and cellular (`restartMediaSource` → native `restartVideoSource`), and the watcher's
   explicit no-restart rule for the SoftAP kind stay in ACS exactly as they are. They are
   destination-side video recovery, not hotspot ownership.

## Step and error mapping

Progress steps are derived, in order, from the snapshots the call session subscribes to:

| Miniapp step | Derived from |
|---|---|
| `hotspot` | hotspot phase `reserved`, `enabling` (running); `joining` or later (done); hotspot `failed` before `joining` (failed) |
| `scopedJoin` | hotspot phase `joining`, `verifying` (running); `restoring` or later (done); hotspot `failed` at those phases (failed) |
| `acsJoin` | the call session's own ACS join promise |
| `publish` | stream phase `listening` (running, adapter attaching), `publishing` (running); `live` (done) |
| `live` | stream phase `live` for the current media generation |

`mediaGeneration` is the stream's `media.mediaGeneration`. `recovery.generation` is the same
number; `recovery.deadlineAt` is `RecoveryContext.rebuildDeadlineAt` when set, otherwise
`returnDeadlineAt`; `recovery.phase` is the derived step currently running.

Join failure codes keep their names and gain a precise source:

| Today (`SoftapCallError`) | After |
|---|---|
| `SOFTAP_WIFI_DISABLED` (step `hotspot`) | `HotspotError` `wifi_disabled` |
| `HOTSPOT_FAILED` (step `hotspot`) | `HotspotError` `ap_start_failed`, `unsupported`, `permission_denied`, `ble_unavailable`; `busy` from another consumer |
| `SCOPED_JOIN_FAILED` (step `scopedJoin`) | `HotspotError` `join_failed`, `address_unavailable`, `user_action_required`, `cellular_unavailable` |
| `ACS_JOIN_FAILED` (step `acsJoin`) | unchanged, raised by the call session |
| `PUBLISH_FAILED` (step `publish`) | `StreamError` `listener_bind_failed`, `receiver_failed`, `publish_rejected`, `adapter_attach_failed` |
| `NO_FIRST_FRAME` (step `live`) | `StreamError` `first_frame_timeout` |
| `NOT_RECOVERABLE`, `REARM_BUDGET` | `StreamError` `recovery_exhausted`, reported through `MEETING_STATE`, never as a join failure |
| `CANCELLED` | `cancelled` from either service, same step derivation |

The call session wraps the underlying error so `step` and the legacy `code` are preserved for
the miniapp while `details` carries the new code for logs and bug reports.

## Reshuffle map

### `SoftapCallTransport.ts` → `SoftapCallSession.ts`

| Member | Fate |
|---|---|
| steps `hotspot`, `scopedJoin`, `publish`, `live` | deleted as steps; derived for progress only |
| step `acsJoin` | kept: `prepareAgent` + `join` before the stream, `leaveOrEnd` after `stream.close()` |
| new step `stream` | `streamService.open(...)` + `start()`; `close()` on the way down |
| `SoftapCallDeps.startHotspot`, `waitUntilHotspotJoinable`, `stopHotspot`, `joinScopedNetwork`, `leaveScopedNetwork`, `cancelScopedNetworkJoin`, `startPublishing`, `stopPublishing`, `awaitFirstFrame`, `waitUntilLive`, `rebindIngest`, `republishRetryDelayMs` | deleted |
| `SoftapCallDeps.isWifiEnabled` | deleted; the hotspot service's preflight reports `wifi_disabled` |
| `SoftapCallDeps.joinMeeting`, `leaveMeeting`, `endMeeting` | kept; `joinMeeting` no longer takes `bindAddress` or returns an `ingestUrl` |
| `recover`, `republish`, `shouldRepublish`, `mediaOnly`, `preserveMeeting`, `keepProgress`, `mediaGeneration` field | deleted; recovery is the stream's, progress keeps the last snapshot on failure by default |
| `progress()`, `recoveryState()`, `currentPhase()`, `lastTeardownFailures()` | kept, computed from subscriptions |
| `SoftapCallError(step, code, message, cause)` | kept as the miniapp-facing wrapper with the mapping above |
| `createSoftapCallDeps(args).subsystems` | shrinks to `prepareAgent`, `joinMeeting`, `leaveMeeting`, `endMeeting`, `glassesLc3Uplink`, `onMeetingState`, plus `streamService` |

### `LocalMiniappRuntime.ts` SoftAP section

| Member | Fate |
|---|---|
| `joinSoftapMeeting`, `createSoftapAttempt`, `checkpointSoftapAttempt`, `emitSoftapProgress`, `softapRecoveryFields`, `narrateSoftapPreflight`, `retireSoftapAttempt`, `handleMeeting*` | kept; the attempt record loses `releaseHotspot`, `scopedLostUnsub`, `recovery*` and gains `stream` |
| `runSoftapAttempt` | kept, shorter: await previous `close()`, LOCAL_WIFI permission, build the session, subscribe, start |
| `acquireGlassesHotspot` call and `GlassesHotspotLease` | deleted |
| `awaitCleanupBarrier`, `softapCleanupError`, `SoftapCleanupBarrier.ts` | deleted (decision 6) |
| `beginSoftapRecovery` | deleted; replaced by the subscription mapping in decision 4 |
| `teardownSoftapAttempt` | kept: `session.stop()` = `stream.close()` then `acsMeetingService.leaveAndAwait` |
| `settleSoftapTeardown`, `forceSoftapCleanup`, `setGlassesHotspotState` | deleted |
| `ensureMeetingStateBridge` republish trigger | deleted; the stream service handles a `failed` glasses media source through its own recovery |
| `MEETING_STATE` payload | unchanged |

### `AcsMeetingService.ts`

| Group | Fate |
|---|---|
| Meeting: `prepareAgent`, `join`, `leave`, `leaveAndAwait`, `endForEveryone`, `setMuted`, `setAudioSource`, `updateVideoSource`, `readState`, `leaveIfOwner`, state handler, ownership | kept |
| WHEP recovery: `watchPhoneNetwork`, `unwatchPhoneNetwork`, `restartMediaSource` (native `restartVideoSource`) | kept; the SoftAP kind is simply never watched, as today |
| Audio: `startGlassesMicUplink`, `stopGlassesMicUplink`, `pushOutgoingPcm`, PCM playback, incoming audio | kept |
| SoftAP network: `isWifiEnabled`, `joinScopedNetwork`, `onScopedNetworkLost`, `beginScopedTeardown`, `awaitValidatedDefaultNetwork`, `awaitDefaultNetworkAfterHotspot`, `cancelScopedNetworkJoin`, `probeScopedGateway`, `leaveScopedNetwork` | deleted |
| Media/ingest: `softApIngestUrl`, `awaitIngestClosed`, `forceCloseIngest`, `rebindSoftApIngest`, `invalidateDecodedMedia`, `waitForFirstFrame`, `waitUntilMediaLive` | deleted |
| New: `attachMedia(media: MediaRef)`, `detachMedia(media: MediaRef)` | the `AcsMediaAdapter` implementation, calling native `attachMedia` / `detachMedia` |

### acs-meeting native module (Android and iOS)

| Item | Fate |
|---|---|
| Expo functions `isWifiEnabled`, `joinScopedNetwork`, `joinScopedNetworkWithGateway`, `leaveScopedNetwork`, `cancelScopedNetworkJoin`, `awaitValidatedDefaultNetwork`, `awaitDefaultNetworkAfterHotspot`, `scopedNetworkInfo`, `probeScopedGateway`, `awaitIngestClosed`, `forceCloseIngest`, `rebindSoftApIngest` | deleted |
| Expo function `restartVideoSource` | kept for the WHEP source; it never applied to the SoftAP kind |
| Event `onScopedNetworkLost` | deleted |
| New functions `attachMedia(mediaRef)`, `detachMedia(mediaRef)` | borrow from `GlassesMediaRegistry`, wire `AcsFrameSender` + PCM, release on detach |
| `join(options)` with `videoSource.type === "softap"` | no longer takes `ssid`, `passphrase`, `bindAddress`; the video source is attached later by `attachMedia` |
| `LocalWhipIngestSource` construction, `GlassesMediaController` for the SoftAP kind, `ScopedSoftApNetwork` parameter, `ScopedNetworkChangeDetector.install`, `InternetHold`, `withIngestUnpinned` / `bindIngestUnpinned` | deleted from acs-meeting; the streaming native side and the hotspot core own them |
| `AcsFrameSender`, `VirtualOutgoingVideoStream`, `RawOutgoingAudioStream`, `feedOutgoingPcm`, `PhoneMicCapturer`, `pushOutgoingPcm` (LC3), `IncomingAudioPump`, `CloudflareWhepSource` | kept |
| `beginTrace` and `SoftApTrace` stages that describe the network hop | move with the code they trace; ACS keeps the meeting and media-attach stages |

### The other consumers, for completeness

| Consumer | Reshuffle |
|---|---|
| Managed WHIP | `ManagedWebRtcRelay` becomes `CloudflareRelayAdapter` (attach starts `PhoneWhipPublisher`, detach stops it); its attempt/retry loop and `deferredStop` handling are deleted; `PhoneStreamCoordinator.startManaged` with `ingest: "whip"` calls `streamService.open({owner: "managed_whip"})`; `GlassesMediaRelayModule.prepare` takes a `MediaRef`; `ScopedSoftApNetwork` keeps only the libwebrtc inventory glue. |
| `PhoneStreamCoordinator` | keeps publisher exclusivity, stream ids, `start_stream`/`stop_stream` and status routing; the streaming service is its caller for the phone route; its deferred BLE stop is keyed by hotspot session per the hotspot spec. |
| Gallery sync | hotspot request, join, address probe, download and `closeHotspot` move onto a hotspot session with `consumer: "gallery_sync"`; `resumeSync` resumes the queue on `restore` instead of re-running setup; the join explanation lives in `beforeJoin`. |
| Hotspot OTA | `HotspotOtaTransport.prepare` becomes: artifacts first, then a session with `consumer: "hotspot_ota"`, server bound to `binding.phoneIpv4` in `restore`; `teardown` becomes `release`; `HotspotShutdown.disableHotspotWithRetry` folds into the hotspot service. |
| `localNetworkTransport` | thin session-bound adapter for any remaining caller, then deleted with `react-native-wifi-reborn`'s join. |

## Tests

| Today | After |
|---|---|
| `SoftapCallTransport.test.ts`, 97 cases | the `hotspot`, `scopedJoin`, `publish`, `live`, `recover`, `republish` cases move to the streaming and hotspot service suites as behaviour of those services; the remaining cases cover ACS ordering, step derivation from snapshots, error mapping, and teardown order |
| `SoftapCleanupBarrier.test.ts`, 5 cases | replaced by "join while previous close pending waits" and "busy from gallery/OTA maps to step hotspot" in the runtime suite |
| `AcsMeetingService.test.ts`, 134 cases | SoftAP network and ingest cases deleted; the WHEP network-switch restart regression and the SoftAP-never-restarts case stay; adapter cases added: attach before publish, detach on invalidation, stale `MediaRef` rejected, meeting untouched by detach and by stream failure |
| `LocalMiniappRuntime.softap.test.ts`, 27 cases | adapted to the subscription mapping: progress steps, recovery fields, `SOFTAP_NETWORK_LOST` with the meeting joined, leave and end paths |
| native SoftAP tests in glasses-media and asg_client | unchanged |

Hardware qualification before the Call migration ships, on Mentra Live with both phone
platforms: join, Wi-Fi loss with return under 60 s, peer stall on a healthy network, exhaustion
leaving audio up, leave and end-for-everyone, and a gallery sync started during a call being
refused with a clear message.

## Migration

Depends on hotspot spec steps 1 and 2 and streaming spec steps 1 and 2 (managed WHIP moves
first as the simpler consumer).

1. **`AcsMediaAdapter` and native `attachMedia` / `detachMedia`**, added beside the existing
   SoftAP path; unit tests for the adapter on both platforms.
2. **`SoftapCallSession`** with the two-step shape, step derivation and error mapping, behind a
   runtime switch so the old transport stays selectable for one release.
3. **Runtime cutover**: `runSoftapAttempt` on the new session; delete recovery, settle and
   force-cleanup code, the barrier and the lease; adapt the runtime suite.
4. **Delete** the network and ingest surface of `AcsMeetingService` and the acs-meeting native
   module, and the old transport and its tests.

## Risks

- **Progress fidelity.** Derived steps must not regress the timing miniapps see, in particular
  `hotspot` finishing when the join starts, not when the AP is enabled. The derivation table is
  the contract; test it against recorded state sequences from today's transport.
- **Audio through recovery.** With the stream detached during a rebuild, glasses PCM stops but
  BLE LC3 and phone mic continue; the meeting must not mute or switch source on its own.
- **Old and new transport during the switch.** Both reserve the hotspot as `video_streaming`
  through the gate, so they cannot run at once, but the runtime switch must be process-wide.
- **iOS media routing.** ACS's iOS module also constructs `LocalWhipIngestSource` today; the
  adapter must attach through the iOS registry with the same threading guarantees.
