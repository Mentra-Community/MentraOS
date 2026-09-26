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
  └─ SoftapCallSession            (was SoftapCallTransport; open → prepareAgent → start → … → close → leave)
       ├─ AcsMeetingService       (meeting, audio, state)
       ├─ AcsMediaAdapter         (attach: ACS join if not yet joined, then media; detach: media only)
       └─ phoneStreamCoordinator.startLocal(pkg, {adapter: AcsMediaAdapter, uplink: lease, recovery, prepare}) → LocalStreamAttempt → GlassesPhoneStreamService (glasses-media)
             └─ GlassesHotspotService.acquire({consumer: "video_streaming", operationId: "call:<id>"})
```

## Decisions

1. **Same order as today, pin first, and the pin outlives the hotspot.** Today the native
   module establishes the cellular hold before the ACS agent is prepared, keeps it through
   scoped-network leave, and releases it at ACS leave only after checking the default route.
   The sequence stays exactly that: the call session acquires an `UplinkLease` (public surface
   spec, decision 7), creates the attempt with `startLocal({uplink: lease, prepare:
   prepareAgent, ...})`, subscribes, and calls `attempt.start()`, which reserves the hotspot
   session, runs `prepareAgent` over the pinned route, then enables and joins the hotspot; the
   meeting is joined inside the first adapter `attach` that finds it not yet joined, after the
   hotspot is `ready` and before the glasses publish. The lease is released by the call
   session after ACS leave, never by the stream or the hotspot session, so an audio-only call
   after stream exhaustion keeps its Internet route even if a leftover AP lingers. The meeting is never established over station
   Wi-Fi and never has to survive the phone's Wi-Fi moving to the glasses AP. Cancellation
   (`attempt.cancel()`) or failure at any point before `start` resolves runs `attempt.close()`,
   which releases the reservation but not the caller's lease; a meeting already joined is left
   by the call session afterwards, and the lease is released last.
   Meeting-first was considered and rejected for the reason above.
   Platform qualification: on iOS today `prepareAgent` before the hotspot is deliberately a
   no-op and agent creation follows hotspot and default-route readiness, and #4104 adds a
   cancellable local-network access request gate before the join completes, with the
   permission wait excluded from media deadlines. The iOS driver keeps both behaviours
   unchanged when it is extracted; the advisory gateway probe is not a substitute for either.
2. **The miniapp-facing contract does not change.** `MEETING_STATE` keeps `softap: {traceId,
   phase, steps[hotspot, scopedJoin, acsJoin, publish, live], elapsedMs, mediaGeneration}` and
   the `recovery: {active, generation, deadlineAt, phase}` fields, and join failures keep
   `{code, message, step}`. The five step names are no longer real steps; they are derived from
   the stream and hotspot state snapshots by a fixed mapping (below). Miniapp UIs that render
   the progress list keep working unchanged.
3. **One media adapter, two hooks, and confirmed meeting ownership.** `AcsMediaAdapter`
   implements the streaming spec's `StreamAdapter` and keeps one flag, `meetingJoined`, that
   is set only when `acsMeetingService.join` has resolved. `attach(media)` joins the meeting if
   `meetingJoined` is false, then borrows the decoded source from `GlassesMediaRegistry` by
   `MediaRef` and wires `AcsFrameSender` and the glasses PCM path onto the existing outgoing
   streams. The media generation is not evidence of a join: a network loss during the first
   attach can advance to generation 2 before ACS ever joined, and the second attach must join.
   A join interrupted by the attach signal is awaited to its outcome: if it succeeds late the
   adapter marks `meetingJoined` and keeps the meeting; if it fails the flag stays false and the
   error surfaces as `ACS_JOIN_FAILED` on the next attach. The adapter also exposes the
   `DecodedFrameTap` branch immediately before `AcsFrameSender`, which the miniapp page preview
   with `source: "call"` uses (Mentra-Specs `platform/media/miniapp-frame-preview/spec.md`,
   MentraOS #4117); the tap only decides, retains and schedules bounded work, never packs and
   never waits, and cannot delay or throw into the ACS sender. `detach(media)` closes the lease,
   removes the tap generation-checked, and leaves the meeting untouched. The meeting is closed only by the call session's leave or end
   after `stream.close()`. ACS never sees an ingest URL, a network handle or a hotspot again.
4. **Recovery is observed, not driven.** `beginSoftapRecovery`, `transport.recover`,
   `shouldRepublish` and `republish` are deleted. The stream service recovers under the shared
   `RecoveryContext` with Call's defaults (60 s return, 45 s rebuild, three attempts, fresh
   frame), passed as the attempt's `recovery` policy. The call session subscribes to the
   attempt before `start` and maps `recovering` to the existing
   `recovery` fields, `live` after a rebuild to a cleared recovery, and `failed` with
   `recovery_exhausted` to today's `state: "error"`, `error: "SOFTAP_NETWORK_LOST: …"` while
   the meeting stays joined and audio continues.
5. **Teardown is `attempt.close()`, then ACS leave, then the uplink lease.**
   `settleSoftapTeardown`, `forceSoftapCleanup`, `setGlassesHotspotState`, the hotspot-off ack
   race and the ingest-closed wait are deleted: the hotspot session's `release` settles the AP
   and the receiver, and `attempt.close()` reports the `ReleaseResult`; a `blocked` result is
   surfaced in `lastTeardownFailures()` and retried on the next leave or app close.
   `leaveAndAwait` stays for ACS. Leave and end-for-everyone differ only in the ACS call, as
   today.
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

## Progress projection and error mapping

The call session projects the hotspot and stream snapshots into the exact `SoftapProgress`
shape the miniapp parser accepts today (`softap.phase` from the closed set `idle | starting |
recovering | live | stopping | failed`, `steps[]` with `pending | running | done | failed`,
`elapsedMs`, `mediaGeneration`) and into `recovery` (`active`, `generation`, `deadlineAt`,
`phase`). One projection function, driven by every state event, produces all of it.

`softap.phase`:

| Projected phase | When |
|---|---|
| `idle` | no join attempt |
| `starting` | from the moment the runtime accepts the join (before `open`, during permission checks, reservation and agent preparation) until the first `live` |
| `recovering` | stream phase `recovering`, for the whole rebuild until `live` (the stream never reports `listening` or `publishing` during a rebuild; `recovery.step` carries the position) |
| `live` | stream phase `live` |
| `stopping` | stream phase `closing`, and the ACS leave that follows |
| `failed` | stream phase `failed`, or a join failure before the stream opened |

`steps[]`, in order, with `durationMs` from the timestamps of the transitions that start and
end each one, and `detail` from the hotspot or stream error message when a step fails:

| Step | running | done | failed |
|---|---|---|---|
| `hotspot` | hotspot phase `enabling` only; its timer starts here | hotspot phase `joining` or later | hotspot `failed` before `joining`, or a preflight failure (permission, agent preparation) before `start` |
| `scopedJoin` | hotspot phase `joining` or `verifying` | hotspot phase `restoring` or later | hotspot `failed` at `joining` or `verifying` |
| `acsJoin` | an adapter attach has started with `meetingJoined` false and the ACS join promise is pending | ACS join resolved | ACS join rejected (`ACS_JOIN_FAILED`) |
| `publish` | stream phase `listening` after the ACS join, until the glasses acknowledge `start_stream` | stream phase `publishing` (the glasses acknowledged; this is when today's `publish` step completes) | stream `failed` while `listening` (`listener_bind_failed`, `receiver_failed`, `adapter_attach_failed`) or `publish_rejected` |
| `live` | stream phase `publishing` (waiting for the first frame, today's `awaitFirstFrame`) | stream phase `live` | stream `failed` while `publishing` (`first_frame_timeout`) or after a first `live` (`stalled`, `recovery_exhausted`) |

Before `start`, every step is `pending` and the attempt is `starting`: reservation, the cellular
hold and ACS agent preparation are not hotspot work and must not count toward the `hotspot`
step's `durationMs`. As today (`narrateSoftapPreflight`), the runtime may write a `detail` onto
the pending `hotspot` row to narrate the preflight ("asking for nearby devices permission",
"preparing the call agent") without changing its status.

On recovery the steps that are rebuilt (`hotspot` and `scopedJoin` for a hotspot outage,
`publish` and `live` for both kinds) go back to `pending` and run again, driven by
`recovery.step` rather than by the stream phase, with exactly the startup milestones:
`waiting_return` and `rejoining` run `hotspot` then `scopedJoin` (from the hotspot snapshot);
`listening`, `attaching` and `publishing` run `publish` (listener, receiver, adapter attach,
`start_stream` sent); `awaiting_frame` marks `publish` done and runs `live`; the first frame
marks `live` done. A failure during any step fails the row that is running at that moment,
which is therefore always defined. `acsJoin` stays `done` because the meeting is preserved. On failure the step running at that moment becomes `failed`
and later steps stay `pending`. On stop the steps are retained as they were (today's
`keepProgress` default); on a new join they start from `pending`.

`recovery`: `active` is true while the stream phase is `recovering`, which lasts until the
rebuilt generation is live; `generation` is `recovery.nextMediaGeneration` (the `media` field
is absent during a rebuild, so it is never read there); `deadlineAt` is
`RecoveryContext.rebuildDeadlineAt` when set, otherwise `returnDeadlineAt`; `phase` is the
projected `softap.phase` above, which is what the field carries today
(`SoftapRecoveryState.phase` is a `SoftapPhase`). `softap.mediaGeneration` becomes
`recovery.nextMediaGeneration` as soon as recovery starts, which preserves today's raw payload
behaviour where the transport increments its media generation on recovery entry. When recovery ends in
`live` the runtime sends one more `MEETING_STATE` with `recovery.active: false`; when it ends
in `failed` with `recovery_exhausted` the state carries `state: "error"` and
`error: "SOFTAP_NETWORK_LOST: …"` as today.

Join failure codes keep their names and gain a precise source:

| Today (`SoftapCallError`) | After |
|---|---|
| `SOFTAP_WIFI_DISABLED` (step `hotspot`) | `HotspotError` `wifi_disabled` |
| `HOTSPOT_FAILED` (step `hotspot`) | `HotspotError` `ap_start_failed`, `unsupported`, `permission_denied`, `ble_unavailable`; `busy` from another consumer |
| `SCOPED_JOIN_FAILED` (step `scopedJoin`) | `HotspotError` `join_failed`, `address_unavailable`, `user_action_required`, `cellular_unavailable` |
| `ACS_JOIN_FAILED` (step `acsJoin`) | `StreamError` `adapter_attach_failed` whose `cause` is the adapter's `AcsJoinError` (the adapter throws a typed error for a failed `acsMeetingService.join`); the call session classifies by `cause`, never by the wrapper |
| `PUBLISH_FAILED` (step `publish`) | `StreamError` `listener_bind_failed`, `receiver_failed`, `publish_rejected`, and `adapter_attach_failed` whose `cause` is not an `AcsJoinError` (media attach failed) |
| `NO_FIRST_FRAME` (step `live`) | `StreamError` `first_frame_timeout` |
| `NOT_RECOVERABLE`, `REARM_BUDGET` | `StreamError` `recovery_exhausted`, reported through `MEETING_STATE`, never as a join failure |
| `CANCELLED` | `cancelled` from either service, same step derivation |

The call session wraps the underlying error so `step` and the legacy `code` are preserved for
the miniapp while `details` carries the new code for logs and bug reports. Because the ACS join
now runs inside `attach`, the adapter must throw a distinguishable `AcsJoinError` and the
streaming service must pass it through unchanged as `cause`; a test asserts that a failed join
surfaces as `ACS_JOIN_FAILED` on step `acsJoin`, not as `PUBLISH_FAILED`.

## Reshuffle map

### `SoftapCallTransport.ts` → `SoftapCallSession.ts`

| Member | Fate |
|---|---|
| steps `hotspot`, `scopedJoin`, `publish`, `live` | deleted as steps; derived for progress only |
| step `acsJoin` | no longer a transport step: `join` runs inside the adapter's `attach` whenever `meetingJoined` is false; `leaveOrEnd` runs after `stream.close()` |
| the sequence | as in decision 1: `streamService.open(...)` → `prepareAgent` → `stream.start()` → (leave: `close()` then `leaveOrEnd`) |
| `SoftapCallDeps.startHotspot`, `waitUntilHotspotJoinable`, `stopHotspot`, `joinScopedNetwork`, `leaveScopedNetwork`, `cancelScopedNetworkJoin`, `startPublishing`, `stopPublishing`, `awaitFirstFrame`, `waitUntilLive`, `rebindIngest`, `republishRetryDelayMs` | deleted |
| `SoftapCallDeps.isWifiEnabled` | deleted; the hotspot service's preflight reports `wifi_disabled` |
| `SoftapCallDeps.joinMeeting`, `leaveMeeting`, `endMeeting` | kept; `joinMeeting` is called by the adapter's `attach` when not yet joined, no longer takes `bindAddress` and no longer returns an `ingestUrl` |
| `recover`, `republish`, `shouldRepublish`, `mediaOnly`, `preserveMeeting`, `keepProgress`, `mediaGeneration` field | deleted; recovery is the stream's, progress keeps the last snapshot on failure by default |
| `progress()`, `recoveryState()`, `currentPhase()`, `lastTeardownFailures()` | kept, computed from subscriptions |
| `SoftapCallError(step, code, message, cause)` | kept as the miniapp-facing wrapper with the mapping above |
| `createSoftapCallDeps(args).subsystems` | shrinks to `prepareAgent`, `joinMeeting`, `leaveMeeting`, `endMeeting`, `attachMedia`, `detachMedia`, `glassesLc3Uplink`, `onMeetingState`, plus `streamService`; `open` precedes `prepareAgent` so the cellular hold exists first |

### `LocalMiniappRuntime.ts` SoftAP section

| Member | Fate |
|---|---|
| `joinSoftapMeeting`, `createSoftapAttempt`, `checkpointSoftapAttempt`, `emitSoftapProgress`, `softapRecoveryFields`, `narrateSoftapPreflight`, `retireSoftapAttempt`, `handleMeeting*` | kept; the attempt record loses `releaseHotspot`, `scopedLostUnsub`, `recovery*` and gains `stream` |
| `runSoftapAttempt` | kept, shorter: await previous `close()`, LOCAL_WIFI permission, build the session, subscribe, start |
| `acquireGlassesHotspot` call and `GlassesHotspotLease` | deleted |
| `awaitCleanupBarrier`, `softapCleanupError`, `SoftapCleanupBarrier.ts` | deleted (decision 6) |
| `beginSoftapRecovery` | deleted; replaced by the subscription mapping in decision 4 |
| `teardownSoftapAttempt` | kept: `attempt.close()` then `acsMeetingService.leaveAndAwait` then `uplink.release()` |
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

- **Progress fidelity.** The projection must not regress what miniapps see: the phase set,
  the step order, `hotspot` finishing when the join starts, `acsJoin` staying done through
  recovery. The projection tables are the contract; test them against recorded state sequences
  from today's transport, including a hotspot outage, a media-only rebuild, exhaustion and a
  leave during recovery.
- **Attach budget when joining.** An `attach` that has to join ACS can take several seconds.
  On the initial start there is no rebuild deadline, so it is bounded only by the caller's
  signal. On a rejoin where the first join never completed, the join runs inside the shared
  rebuild deadline; if that is too tight in practice the adapter should join outside the
  deadline and only the media reattach inside it. Test interrupted and late initial joins.
- **Projection milestones.** `publish` completes when the glasses acknowledge `start_stream`,
  before the first-frame wait, and a first-frame timeout is a `live` failure. Test the
  projection for the wait, the timeout, a recovery and a cancellation during each, and for the
  preflight: a slow `open` or `prepareAgent`, a preflight failure and a cancellation before
  `start`, each checked through the Miniapp parser with `hotspot` still `pending`; and the
  complete recovery sequence for both outage kinds, asserting `recovery.active` stays true and
  `generation` reports the generation under construction from loss until `live`.
- **Audio through recovery.** With the stream detached during a rebuild, glasses PCM stops but
  BLE LC3 and phone mic continue; the meeting must not mute or switch source on its own.
- **Old and new transport during the switch.** Both reserve the hotspot as `video_streaming`
  through the gate, so they cannot run at once, but the runtime switch must be process-wide.
- **iOS media routing.** ACS's iOS module also constructs `LocalWhipIngestSource` today; the
  adapter must attach through the iOS registry with the same threading guarantees.
