---
status: draft
owner: philippe
---

# Glasses-to-phone streaming service design

Companion to `2026-09-16-glasses-hotspot-service-design.md`. That spec owns the network. This
one owns the stream that crosses it: glasses publish video (and optionally audio) over the
hotspot to a receiver on the phone, and the phone forwards it to a destination. Today that
path is assembled twice above one shared native receiver:

| Today | Destination | Assembled by |
|---|---|---|
| Managed WHIP stream (`ingest: "whip"`) | Cloudflare live input via `PhoneWhipPublisher` | `ManagedWebRtcRelay` + `GlassesMediaRelayModule` |
| Mentra Call | Azure Communication Calling raw video via `AcsFrameSender` | `SoftapCallTransport` + `AcsMeetingService` + the acs-meeting native session |

Both instantiate glasses-media's `LocalWhipIngestSource` (the WHIP server, peer and decoder)
and both drive the glasses publish through `PhoneStreamCoordinator.startUnmanaged` with
host-only ICE. What is duplicated is everything around the receiver: hotspot setup, ordering,
failure handling, first-frame gating and recovery. Rule from Cayden and Philippe: Mentra Call
is a consumer of video streaming, not a streaming system of its own.

Other routes are unaffected: managed SRT and RTMP send the glasses straight to Cloudflare over
their own Wi-Fi, and `direct` publishes to a caller URL from the glasses. Neither touches the
phone.

## Requirements

- **One glasses-to-phone stream service** that owns: acquiring the hotspot session, binding the
  phone-side listener on the hotspot address, the native receiver lifecycle, telling the glasses
  to publish (BLE `start_stream` with a phone-local URL and host-only ICE), first-frame
  readiness, stall and peer-failure detection, bounded media recovery, and settled close.
- **Destination adapters stay outside it**: the Cloudflare WHIP republisher, the ACS frame sink,
  a future local preview. They attach to the decoded media, they never own the network or the
  glasses publish.
- **Two generations, not one.** A stalled peer must be rebuildable while the Wi-Fi is healthy,
  and a Wi-Fi loss must not be mistaken for a peer stall. Media generation and hotspot
  generation are tracked separately and both are fenced.
- **Mentra Call keeps its semantics** from #4074: the ACS meeting is joined before the stream
  and survives stream recovery and stream failure; recovery is complete only after a fresh
  frame; cellular uplink is held for ACS Internet traffic while on the hotspot.
- **Miniapps can choose the phone route explicitly** through the Miniapp SDK, and a Bluetooth
  SDK integrator can build the same path from public pieces, without either SDK growing a
  second streaming API.

## Decisions

1. **Layering.** `GlassesHotspotService` → `GlassesPhoneStreamService` → adapters. The stream
   service is the only hotspot consumer for video; it acquires with
   `consumer: "video_streaming"` and passes the owner (`call`, `managed_whip`, `local`) as
   diagnostic metadata. `PhoneStreamCoordinator` keeps publisher exclusivity, stream ids, BLE
   status routing and managed cloud provisioning; it does not learn about hotspots.
2. **Media reference, not media objects, across the bridge.** JS holds
   `MediaRef {streamSessionId, mediaGeneration}`. Native adapters borrow the decoded source
   from a registry by that reference; frames, PCM, buffer ownership and backpressure stay
   native. This mirrors `NetworkRef` in the hotspot spec.
3. **The stream service implements the hotspot client, and hotspot restore ends at the
   network.** Its `restore` binds the listener and starts the receiver, then returns: the
   hotspot session is `ready` as soon as the network-bound setup is up. Adapter attach, the
   glasses publish, first-frame readiness and media retries belong to the stream lifecycle and
   never fail the hotspot restore. A receiver or first-frame failure on a healthy network is a
   media failure: only the media generation advances, the AP is never rejoined, and no media
   error is ever translated into a hotspot loss. `quiesce` stops local media only. Destination
   lifetime is the adapter's, so closing a stream never leaves an ACS meeting and hotspot
   exhaustion never closes it either.
4. **One recovery context per outage, one rebuild clock, started when the glasses return.**
   For a network outage the hotspot session owns the `RecoveryContext` (companion spec,
   decision 7): the return deadline starts at loss, the rebuild deadline is created once when
   the return wait completes, and the context reaches the stream service through `quiesce` and
   `restore`. The stream service keeps that same context through attach, publish, first frame
   and any media retries that follow the rejoin, so a 50 s absence that returns inside the 60 s
   return budget still gets the full 45 s to rebuild, exactly as `SoftapCallTransport` waits
   first and starts its rebuild clock afterwards today. For a media-only outage on a healthy
   network the stream service creates its own context with the rebuild deadline set
   immediately. Neither layer holds a second clock and no retry renews a deadline. The stream's
   `returnBudgetMs` and `rebuildBudgetMs` are the values it hands to the hotspot session's
   policy; Call's current 60 s and 45 s become the defaults for `owner: "call"`.
5. **Adapters attach before the glasses publish, through an awaited hook.** `open` takes a
   `StreamAdapter` with `attach(media, signal)` and `detach(media)`. On the initial start and on
   every recovery the service starts the receiver, awaits `attach` for the new `MediaRef`, and
   only then tells the glasses to publish and waits for the first frame. `live` therefore means a
   decoded frame reached the adapter that is attached for that generation. Native `LIVE` in
   `LocalWhipIngestSource` reports the receiver's frame callback; the adapter-level gate is the
   service's, counted from the attached sink. Destination lifetime stays outside the adapter.
6. **Audio is optional media, not audio policy.** The stream can carry glasses microphone audio
   (`captureAudio`), but microphone selection, mute and incoming meeting audio stay in the call
   layer. Call today can take glasses audio over BLE LC3 while WHIP carries video only.
7. **Phone relay is WHIP/WebRTC only in v1.** Republishing over RTMP or SRT from the phone would
   be new functionality; managed SRT and RTMP keep the glasses-direct route.
9. **Terminal failure releases the network at once.** When recovery is exhausted or a
   non-recoverable error occurs, the stream service runs one idempotent terminal cleanup on its
   own, without waiting for `close`: invalidate the media generation, await `adapter.detach`,
   stop the glasses publish and the receiver, then await the hotspot session's `release`. The
   stream reaches `failed` with the error snapshot and the hotspot `ReleaseResult` recorded;
   ownership is retained only while that cleanup is genuinely pending (a `blocked` release
   result). The adapter's destination is untouched, so an audio-only ACS call continues while
   gallery sync or OTA can acquire the hotspot. This matches today's `SoftapCallTransport`,
   which unwinds the publisher, scoped join and AP on exhaustion while preserving ACS. A later
   `close` on a failed stream returns the recorded result when the release settled, and retries
   the hotspot release when the recorded result was `blocked`, so the retry path of the hotspot
   contract is never lost; the stream stays `failed` either way.
10. **SDK surface grows by one option, not one API.** The Miniapp SDK's `startStream` gains
   `route`. The Bluetooth SDK gains no new streaming method: the hotspot session API from the
   companion spec plus the existing `startStream` with host-only ICE already describe the
   glasses side of the path; the phone-side receiver is app code (glasses-media) and stays so.

## TypeScript API (engine, `mobile/modules/engine/src/services/streaming/`)

```ts
export type StreamOwner = "call" | "managed_whip" | "local"

export type StreamPhase =
  | "acquiring"     // hotspot session acquire + start
  | "listening"     // listener bound, receiver up; adapter.attach running for this generation
  | "publishing"    // adapter attached, BLE start_stream acked; waiting for the first decoded frame
  | "live"          // a decoded frame reached the adapter attached for this media generation
  | "recovering"    // media rebuild (peer stall / receiver failure) or hotspot recovery in progress
  | "failed"        // terminal cleanup ran (media detached, publish and receiver stopped, hotspot release attempted); close() retries a blocked release
  | "closing"
  | "closed"

export type MediaRef = {streamSessionId: string; mediaGeneration: number}

export type StreamErrorCode =
  | "hotspot"               // wraps a HotspotError; details.hotspot carries its code
  | "listener_bind_failed"
  | "receiver_failed"       // WHIP server / peer / decoder failure
  | "publish_rejected"      // glasses refused start_stream (see details.glassesError)
  | "first_frame_timeout"
  | "stalled"               // frames stopped for longer than the stall budget
  | "recovery_exhausted"
  | "stale_media"           // an adapter used a MediaRef that is no longer current
  | "adapter_attach_failed" // adapter.attach threw or timed out for this generation
  | "cancelled"

export class StreamError extends Error {
  readonly code: StreamErrorCode
  readonly details?: {hotspot?: HotspotErrorCode; glassesError?: string; mediaGeneration?: number; hotspotGeneration?: number}
}

/** Forwarded to the hotspot session's policy. The rebuild clock starts when the return wait completes (network outage) or at detection (media-only outage), once per outage. */
export type StreamRecoveryPolicy = {returnBudgetMs: number; rebuildBudgetMs: number; maxAttempts: number; stallMs: number}

export interface StreamAdapter {
  /** Called once per media generation, before the glasses are told to publish. Borrow the media by ref and attach sinks. Cancellable. */
  attach(media: MediaRef, signal: AbortSignal): Promise<void>   // media.mediaGeneration > 1 means a rebuild
  /** Called when a media generation is invalidated (media rebuild or hotspot loss). Release the lease; keep destination state. */
  detach(media: MediaRef): Promise<void>
}

export type OpenStreamOptions = {
  owner: StreamOwner
  operationId: string
  adapter: StreamAdapter
  video: StreamVideoConfig            // reuses the Bluetooth SDK type
  audio?: StreamAudioConfig
  captureAudio?: boolean              // default false for "call", true for "managed_whip"
  sound?: boolean
  uplink: "none" | "cellular"         // forwarded to the hotspot session
  recovery: StreamRecoveryPolicy
  signal?: AbortSignal
}

export type StreamState = {
  streamSessionId: string
  sequence: number
  phase: StreamPhase
  media?: MediaRef                    // present from "listening" until the generation is invalidated
  hotspot: {sessionId: string; generation: number; phase: HotspotPhase} | null
  ingestUrl?: string                  // phone-local WHIP URL handed to the glasses
  recovery?: {kind: "media" | "hotspot"} & RecoveryContext   // the hotspot's context for a network outage, the stream's own for a media outage
  stats?: StreamLiveStats             // from the glasses' stream_status
  error?: StreamError
  terminalCleanup?: {hotspot: ReleaseResult | null}   // set once terminal cleanup has run (failed or closed)
}

export type StreamEvent = {type: "state"; state: StreamState}

export interface StreamSession {
  readonly id: string
  snapshot(): StreamState
  subscribe(listener: (event: StreamEvent) => void): () => void
  /** Runs hotspot acquire → listener bind → receiver → adapter.attach → glasses publish → first frame. Resolves on live. */
  start(): Promise<MediaRef>
  /** Consumer-initiated end: detach, stop the glasses publish, close the receiver, release the hotspot session. Never touches the destination. Idempotent: concurrent calls share one cleanup; on a failed stream it returns the settled result or retries a blocked hotspot release. */
  close(): Promise<{hotspot: ReleaseResult | null}>
}

export interface GlassesPhoneStreamService {
  open(options: OpenStreamOptions): Promise<StreamSession>
  current(): {owner: StreamOwner; operationId: string; streamSessionId: string; phase: StreamPhase} | null
}
```

### Recovery

Two triggers, one orchestrator:

- **Hotspot loss** arrives through the hotspot session's `quiesce` with the outage's
  `RecoveryContext` (return deadline set, rebuild deadline still null). The stream service
  invalidates the media generation, awaits `adapter.detach`, and stops the receiver and the
  glasses publish. The hotspot session waits for the glasses within the return budget and, when
  they are reachable, fixes the rebuild deadline and rejoins. Its `restore` then rebinds the
  listener and restarts the receiver and returns, so the hotspot is `ready`. The stream
  lifecycle continues under the same context: `attach` for the new `MediaRef`, publish, first
  frame, and any media retry, all bounded by `recovery.rebuildDeadlineAt`. The hotspot
  generation and the media generation both advance.
- **Media stall, receiver failure or first-frame timeout** with the hotspot `ready`, whether
  on the initial start, after a rejoin, or mid-stream, creates a media context with the rebuild
  deadline set at detection (or reuses the network outage's context if one is still open),
  invalidates the media generation, awaits `detach`, rebuilds the receiver, awaits `attach`,
  and republishes on the same hotspot generation. Only the media generation advances. The AP
  is never rejoined for a media problem, and the hotspot session never learns about it.

The order is always detach → rebuild → attach → publish → first frame, on both paths, so
`live` is never waited for without an attached adapter. The adapter's `attach` and `detach`
hooks are the contract; observers read the state snapshot, whose `media` field and phase say
which generation is current and whether it is live. Stall detection is the service's own
(`stallMs` on the receiver's frame timer); adapters do not report losses. Exhaustion of the
shared deadline or of `maxAttempts` fails the stream with `recovery_exhausted` and runs the
terminal cleanup of decision 9 immediately: the hotspot is released without waiting for the
consumer, the adapter decides what happens to its destination, and a terminal media failure
leaves the ACS meeting joined.

## Native contract

Lives in glasses-media (app code, not the public SDK), on top of the hotspot core in the SDK.

```kotlin
// Android — registry for decoded media, keyed by the JS MediaRef. In-process only.
object GlassesMediaRegistry {
  class Lease(val media: MediaRef, val source: DecodedGlassesMediaSource) : AutoCloseable {
    fun attachVideo(sink: VideoFrameListener)   // libwebrtc decoder thread; sink must not block
    fun attachPcm(sink: PcmListener)
  }
  /** Atomically validates the media generation; onInvalidated fires before JS learns of it. */
  fun borrow(streamSessionId: String, mediaGeneration: Int, onInvalidated: () -> Unit): Lease
}
```

The receiver itself is the existing `LocalWhipIngestSource` driven by `GlassesMediaController`.
The stream service's native side takes the hotspot `Lease` (from `GlassesHotspotRegistry`),
calls `Lease.bindListener` for the WHIP server socket, feeds the `Network` handle to
`ScopedNetworkChangeDetector`, and publishes the resulting `DecodedGlassesMediaSource` into
`GlassesMediaRegistry`. iOS mirrors this with `GlassesMedia.LocalWhipIngestSource` and the iOS
hotspot lease's Wi-Fi-scoped listener parameters.

Adapters:

- **ACS sink** (`acs-meeting`): borrows by `MediaRef`, attaches `AcsFrameSender` and the PCM
  path. It stops constructing `LocalWhipIngestSource` and `ScopedSoftApNetwork` and stops
  installing `ScopedNetworkChangeDetector`; `AcsMeetingService.joinScopedNetwork`,
  `softApIngestUrl`, `rebindSoftApIngest`, `waitForFirstFrame` and `onScopedNetworkLost` are
  deleted from its JS surface.
- **Managed WHIP republisher** (`glasses-media`): borrows by `MediaRef`, attaches
  `PhoneWhipPublisher` to the Cloudflare `webrtcPublishUrl`. `GlassesMediaRelayModule.prepare`
  takes a `MediaRef` instead of credentials and an ingest URL.
- **Local preview** (future): borrows and renders; no network involvement.

## SDK surface

Everything in this section is the last migration step and ships only after the streaming
service exists and Mentra Call and managed WHIP run on it. It is recorded here so the service
API is designed with it in mind, not to be built alongside it.

### Miniapp SDK (`mobile/modules/miniapp/src/modules/stream.ts`)

```ts
export interface StartStreamOptions {
  // existing fields unchanged
  /**
   * Which network the glasses publish over.
   * "glasses_wifi": the glasses publish directly to the destination over their own Wi-Fi.
   * "phone": the glasses publish to the phone over the glasses hotspot; the phone forwards.
   * "auto" (default): managed "whip" → "phone"; managed "srt"/"rtmp" and `direct` → "glasses_wifi".
   */
  route?: "auto" | "glasses_wifi" | "phone"
}

export interface StreamResult {
  // existing fields unchanged
  route: "glasses_wifi" | "phone"
}

export interface StreamStatus {
  // existing fields unchanged
  route?: "glasses_wifi" | "phone"
}
```

Rules: `route: "phone"` with `direct` requires a WHIP (`http`/`https`) destination and
requests the LOCAL_WIFI permission, exactly as managed `whip` does today in
`LocalMiniappRuntime.handleManagedStreamStart`; `route: "phone"` with managed `srt` or `rtmp`
is rejected with a clear error (decision 7). The engine handlers route `"phone"` through
`GlassesPhoneStreamService` with `owner: "managed_whip"` or `owner: "local"` for a direct URL,
and everything else through the existing glasses-direct `startUnmanaged`/`startManaged`.

The public doc page `mintlify-docs/app-devs/core-concepts/stream.mdx` gains the `route`
option, documents that managed `whip` already runs over the phone, and adds `"rtmp"` to the
`ingest` table, which the code accepts and the page omits.

### Bluetooth SDK

No new streaming method. The path is fully expressible with public pieces once the hotspot
session API from the companion spec lands:

1. `glassesHotspotService.acquire(...)` (or the raw `setHotspotState` and
   `hotspot_status_change` pair for integrators on older versions);
2. a WHIP receiver on the phone bound to the hotspot address (integrator-provided; glasses-media
   is the Mentra App's and is not part of the SDK);
3. `startStream({streamUrl: "http://<phoneIpv4>:<port>/whip", ice: {stun: ""}, ...})`, which
   the glasses already treat as a hotspot route (`StreamCommandHandler` checks
   `HotspotNetworkUtils.isEndpointOnActiveHotspot`).

Two additive changes:

- `StreamStatusEvent` gains `route?: "glasses_wifi" | "phone_hotspot"`, set by the glasses from
  the same route detection, so an integrator can see which path a stream took.
- `mintlify-docs/bluetooth-sdk/camera-streaming.mdx` gains a "Streaming to the phone over the
  glasses hotspot" section with the three steps above and the host-only ICE note that today
  lives only in the `StreamIceConfig` doc comment.

### ASG

`StreamCommandHandler` already selects the publisher by URL scheme and records whether the
endpoint is on the active hotspot. Only additions: emit `route` in `stream_status`, and keep
`ice.stun = ""` semantics unchanged.

## Consumers after the change

| Consumer | Sequence |
|---|---|
| Mentra Call | Runtime: acquire ACS agent (Internet) → `acs.join(meeting)` → `streamService.open({owner: "call", uplink: "cellular", captureAudio: false, recovery: callDefaults, adapter: acsAdapter})` → `await stream.start()` resolves on `live`, report ready. `acsAdapter.attach(media)` borrows the `MediaRef` and wires `AcsFrameSender` and PCM before the glasses publish; `detach` releases the lease and keeps the meeting. On `recovery_exhausted` the stream has already released the hotspot; the meeting stays joined (audio continues) until Leave; Leave → `stream.close()` (settled: returns the recorded result; blocked: retries the release) → ACS leave. `SoftapCallTransport` keeps only meeting ordering (`acsJoin`, attach, `live`); `hotspot`, `scopedJoin`, `publish` and `preserveMeeting` disappear. |
| Managed WHIP | `PhoneStreamCoordinator.startManaged` with `ingest: "whip"`: provision Cloudflare → `streamService.open({owner: "managed_whip", uplink: "cellular", captureAudio, adapter: republisher})` → `republisher.attach(media)` borrows the `MediaRef` and starts `PhoneWhipPublisher` toward `webrtcPublishUrl` before the glasses publish → status fans out tagged `route: "phone"`. `ManagedWebRtcRelay`'s attempt/retry loop is replaced by the stream service's recovery. |
| Direct WHIP over the phone (new for miniapps) | Same as managed WHIP with the caller's WHIP URL as the republisher destination and `owner: "local"`. |
| Local preview (future) | `open({owner: "local", uplink: "none"})`, adapter renders. |

## Migration in small PRs

Depends on hotspot spec steps 1 and 2 (native core, reservation gate).

1. **Media registry and stream service core** in glasses-media plus the engine service, wired
   to the hotspot session; no consumer moves. Tests with fake hotspot, receiver and adapter:
   phases, both recovery triggers, generation fencing, `attach` awaited before publish on
   initial start and on both recovery paths, `detach` before rebuild, `live` counted only after
   attach, `adapter_attach_failed`, and close never touching a destination. Healthy-network
   first-frame timeout on the initial start and after a rejoin: only the media generation
   advances, no AP rejoin occurs, the rebuild deadline is not renewed, and the ACS adapter's
   destination survives terminal media failure. Exhaustion on the initial start and after a
   rejoin: the stream releases the hotspot on its own, ACS stays joined, gallery sync or OTA
   can acquire after the release settles, a deferred stop cannot reach the next owner, a later
   Leave or `close` is safe, and `close` after a blocked release retries it and reports the
   new result. Fake-clock cases: glasses return at 50 s of a
   60 s return budget and the rebuild still gets its full 45 s; one expiry shared by the network
   rejoin and the media retries that follow it; duplicate loss events inside one outage renew
   neither deadline.
2. **Managed WHIP** moves onto the service; `ManagedWebRtcRelay` becomes an adapter and its
   retry loop is deleted. Hardware: relay start, Wi-Fi loss, peer stall, stop.
3. **Mentra Call** moves onto the service; ACS becomes a sink; the ACS native join and the JS
   network methods are deleted; `SoftapCallTransport` shrinks to meeting ordering. Keep the
   #4074 tests pointed at the new seams: preserved meeting, fresh frame, cancellation at each
   step, exhaustion leaving the meeting joined.
4. **Miniapp SDK `route`** and the direct-WHIP-over-phone path, with docs.
5. **Bluetooth SDK `route` in `stream_status`** (ASG + SDK types + docs).
6. Delete the remaining duplicate orchestration.

## Risks

- **ACS frame delivery threading.** Decoded callbacks run on libwebrtc threads and ACS sends on
  its own executor; the registry lease must preserve that boundary and never block the decoder.
- **Two-generation bookkeeping.** Adapters that cache a `MediaRef` across a recovery will hit
  `stale_media`; the ACS and republisher adapters need explicit attach/detach tests on the
  initial start, a media rebuild and a hotspot rejoin.
- **Call timing.** The 60 s return and 45 s rebuild budgets and the fresh-frame gate must map
  one to one onto the stream recovery policy; user-visible recovery timing must not change.
- **Miniapp permission surface.** `route: "phone"` extends the LOCAL_WIFI requirement to direct
  WHIP streams; the permission prompt copy must say why.

## Out of scope

- Phone-side RTMP or SRT republishing.
- Shipping glasses-media as a public SDK package so Bluetooth SDK integrators get a ready-made
  phone WHIP receiver. Worth a separate decision once the stream service exists.
