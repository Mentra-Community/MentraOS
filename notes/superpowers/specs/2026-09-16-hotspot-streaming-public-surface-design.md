---
status: draft
owner: philippe
---

# Public surface for hotspot sessions and glasses-to-phone streaming

Fourth of four specs. The hotspot spec owns the network, the streaming spec owns the stream,
the Call spec owns Mentra Call. This one says what the published packages expose so that an
integrator, not only the Mentra App, can use both: a Bluetooth SDK user building their own
phone app in React Native, Kotlin or Swift, and an app that embeds the Mentra engine (the
pattern in `sdk/example-oem-app`, which depends on `@mentra/engine`, `@mentra/bluetooth-sdk`,
`@mentra/glasses-media` and `@mentra/acs-meeting`).

It supersedes the "SDK surface" section of the streaming spec, which said the phone-side
receiver was app code and the Bluetooth SDK needed no new streaming method. That was wrong on
the facts: `@mentra/glasses-media` is a published package in the release family, and the
engine is published and embedded. What was missing is not a package but the primitives and
flows inside them.

## Audiences and what each needs

| Audience | Installs | Needs |
|---|---|---|
| Bluetooth SDK integrator, own app | `@mentra/bluetooth-sdk` (npm, Maven AAR, CocoaPod) | a hotspot session primitive with network-bound HTTP; the glasses `startStream` command it already has |
| Bluetooth SDK integrator who wants glasses video on the phone | `@mentra/glasses-media` in addition | a stream primitive that receives the glasses' WHIP publish over the hotspot and hands decoded media to a sink, a view or a republisher, with recovery built in |
| Engine embedder (OEM app) | `@mentra/engine` | the same two services re-exported, plus ready-made flows: relay to a WHIP destination, render locally, custom sink; gallery sync and OTA keep working on top of them |
| Miniapp developer | Miniapp SDK | the `route` option already specified in the streaming spec |

## Decisions

1. **The hotspot service ships in the Bluetooth SDK, TypeScript included.** The hotspot spec put
   the native core in the SDK and the TypeScript service in the engine. The service depends on
   nothing but the SDK's native module and BLE commands, so it moves to
   `@mentra/bluetooth-sdk/hotspot` and the engine re-exports it. One implementation serves
   integrators and the Mentra App; gallery sync and OTA in the engine become its first callers.
   The engine's `HotspotConsumer` closed union becomes an open `purpose: string` in the SDK;
   the engine reserves `gallery_sync`, `hotspot_ota` and `video_streaming`, and `busy` names
   the purpose that holds the hotspot so an integrator's UI can say why.
2. **The streaming service ships in `@mentra/glasses-media`.** That package already holds the
   receiver, the libwebrtc dependency and the native registries the streaming spec introduces.
   `GlassesPhoneStreamService` moves there from the engine, with three adapters in the box:
   a WHIP republisher, a render adapter with a native view, and a native frame sink for Kotlin
   and Swift integrators. The ACS adapter stays in `@mentra/acs-meeting`. Keeping streaming out
   of the base SDK keeps libwebrtc out of apps that only need BLE, photos or OTA.
3. **One call for the common case.** Each package exposes a convenience that does open, start
   and the obvious adapter, and returns the session for state, recovery and close. The full
   session API stays available underneath for anyone who needs the hooks.
4. **The engine exposes flows, not only services.** Embedders get `route: "phone"` on the
   coordinator's unmanaged and managed starts, a `startLocal` for a custom sink, and the two
   services on engine subpaths that mirror the existing `./bluetooth-sdk/*` re-export pattern.
5. **Permissions come from the SDK config plugin.** `@mentra/bluetooth-sdk/app.plugin` already
   exists; it gains the Android `NEARBY_WIFI_DEVICES` permission and the iOS hotspot
   configuration entitlement plus local-network usage description, so an integrator does not
   discover them at runtime.
6. **One glasses publisher slot, in the SDK, shared by everyone.** The glasses can run one
   stream at a time, and today the engine's `PhoneStreamCoordinator` enforces that with stream
   ids, status routing and deferred stops. Once the stream service can run without the engine
   that enforcement must sit below both, so `@mentra/bluetooth-sdk/streaming` exposes a
   `GlassesPublisher` port and its single implementation, `glassesPublisher`: one slot per
   process, `start` rejects with `publisher_busy` naming the owner while another stream is
   active (the coordinator's current policy, no preemption), `stop` by stream id, status
   subscription correlated by stream id, and a deferred stop that registers with the active
   hotspot session so it is fenced by the hotspot spec's deferred-command rule. The stream
   service publishes only through this port. The coordinator becomes a consumer of the same
   slot for its glasses-direct and managed streams and keeps what is genuinely its own: cloud
   provisioning, per-package subscriber refcounting and status fanout to miniapps. A standalone
   integrator and an embedder using the engine therefore contend for the same slot, and a
   direct stream and a phone-route stream can never both be started. Dispatch through the slot
   is serialized and ordered: because the glasses' `stop_stream` is untargeted, a deferred stop
   left by a publisher that a recovery has already replaced within the same hotspot session is
   drained before the successor starts when the link is up, or retired when the successor's
   `start_stream` will replace the stream on the glasses anyway; a reconnect never dispatches a
   stop older than the newest admitted command for that session.
7. **The Internet uplink is its own lease.** `@mentra/bluetooth-sdk/hotspot` exposes
   `acquireUplink({kind: "cellular"})` returning an `UplinkLease` with `release()`. It is the
   SDK home of today's `InternetHold`: it pins the process to cellular, is reference counted
   per process, and on final release restores the default route only when the default network
   is validated Internet, retaining the pin while a leftover local-only AP is still the default.
   A hotspot session or a stream that is given a lease never releases it; a session or stream
   given `uplink: "cellular"` acquires and releases its own. Mentra Call holds the lease from
   before agent preparation until ACS leave, exactly the native module's current lifetime.
8. **Frames never cross the JavaScript bridge.** In React Native the sinks are a native view
   and the republisher; decoded frames are reachable only from Kotlin and Swift through the
   native frame sink. This is the same rule the streaming spec applies to `MediaRef`.

## Bluetooth SDK: `@mentra/bluetooth-sdk/hotspot`

```ts
import {glassesHotspot} from "@mentra/bluetooth-sdk/hotspot"

// Full session API: the HotspotSession of the hotspot spec, with `purpose: string`.
const session = await glassesHotspot.acquire({
  purpose: "my_app_sync",
  operationId: "sync:42",
  uplink: "none",
  recovery: {mode: "auto", returnBudgetMs: 30_000, rebuildBudgetMs: 20_000, maxAttempts: 2},
  beforeJoin: async ({ssid}) => showMyJoinExplanation(ssid),
})
const binding = await session.start({
  quiesce: async () => cancelMyTransfers(),
  restore: async (binding) => resumeMyTransfers(binding),
  close: async () => {},
})
const res = await session.fetch(binding, `http://${binding.glassesIpv4}:8089/api/gallery`)
await session.release()

// Convenience for a one-shot transfer: acquire, start with a no-op client, run, release.
await glassesHotspot.withSession({purpose: "my_app_sync"}, async (session, binding) => {
  await session.download(binding, {jobId: "1", url, destination})
})

glassesHotspot.current()   // {purpose, operationId, sessionId, phase} | null

// Internet uplink, independent of any session (see decision 7).
const uplink = await glassesHotspot.acquireUplink({kind: "cellular"})
const call = await glassesHotspot.acquire({purpose: "video_streaming", uplink, ...})
// ... later, after the destination is gone:
await uplink.release()
```

`@mentra/bluetooth-sdk/react` gains `useGlassesHotspot()` returning the current owner and
phase for UI.

`@mentra/bluetooth-sdk/ota-transport` is two things and they are treated differently. Its
`otaServer` (`start`, `stop`, `downloadArtifact`, `onArtifactDownloadProgress`, the phone-hosted
manifest server) stays a supported public export: the engine's `HotspotOtaTransport` needs it,
including Internet artifact staging before any hotspot session exists, and the public OTA
design requires supported SDK imports. Only its `otaLocalNetwork` half (`connect`, `request`,
`download`, `cancel`, `disconnect`, `onNetworkLost`) becomes a deprecated facade over a hotspot
session for one release and is then removed together with the engine's `localNetworkTransport`.
`otaServer.start` takes the session binding's `NetworkRef` and creates its listener through the
SDK core's `bindLocalListener`, as the hotspot spec says, so it is reachable from the glasses
even while another consumer's uplink lease pins the process to cellular.

### `@mentra/bluetooth-sdk/streaming`: the publisher slot

```ts
export interface GlassesPublisher {
  /** Rejects with publisher_busy (details.owner) while another stream is active. */
  start(request: StreamStartRequest & {owner: string}): Promise<{streamId: string; status: StreamStatusEvent}>
  stop(streamId: string): Promise<void>
  /**
   * If the BLE link is down, queue the stop; `hotspotSessionId` ties it to that session so it is retired with it.
   * Dispatch is serialized: one glasses command in flight at a time. Because the BLE stop_stream carries no
   * stream id, a deferred stop is never sent after a later start has been admitted: `start` first drains an
   * outstanding deferred stop when the link is up (send, await ack), or retires it when the link is down or the
   * new start would replace the stream on the glasses anyway. A link reconnect only dispatches a deferred stop
   * that is still the newest command for its session.
   */
  deferStop(streamId: string, opts: {hotspotSessionId?: string}): void
  owns(streamId: string): boolean
  subscribe(listener: (event: StreamStatusEvent & {streamId: string}) => void): () => void
  current(): {streamId: string; owner: string} | null
}
export const glassesPublisher: GlassesPublisher
```

Native, same shape (the publisher slot has the same Kotlin and Swift surface):

```kotlin
// Android (SDK AAR)
val session = GlassesHotspot.acquire(context, HotspotOptions(purpose = "my_app_sync", uplink = Uplink.NONE, recovery = ...))
val binding = session.start(client)          // suspend; client has quiesce/restore/close
val network: Network = session.borrow(binding.ref).use { it.network }   // GlassesHotspotRegistry lease
session.release()
```

```swift
// iOS (pod)
let session = try await GlassesHotspot.acquire(HotspotOptions(purpose: "my_app_sync", uplink: .none, recovery: ...))
let binding = try await session.start(client: client)
let lease = try await session.borrow(binding.ref)   // Wi-Fi-scoped connection parameters
await session.release()
```

## Streaming: `@mentra/glasses-media`

```ts
import {glassesPhoneStream, whipRepublishAdapter, renderAdapter, GlassesStreamView} from "@mentra/glasses-media"

// Full session API: the StreamSession of the streaming spec.
const stream = await glassesPhoneStream.open({
  owner: "relay",
  operationId: "relay:7",
  video: {width: 1280, height: 720, bitrate: 2_500_000, fps: 30},
  captureAudio: true,
  uplink: "cellular",
  recovery: {returnBudgetMs: 60_000, rebuildBudgetMs: 45_000, maxAttempts: 3, stallMs: 5_000},
  adapter: whipRepublishAdapter({url: "https://example.com/whip/abc", authToken}),
  // publisher defaults to the SDK's glassesPublisher; the engine passes the same instance
})
await stream.start()          // resolves on live
await stream.close()

// Convenience: relay the glasses to any WHIP destination over the phone.
const relay = await glassesPhoneStream.relayTo({url, authToken, video})

// Convenience: show the glasses on the phone. The view renders decoded frames natively.
const preview = await glassesPhoneStream.preview({video})
<GlassesStreamView stream={preview} style={styles.video} />
```

Adapters in the package:

| Adapter | Attach | Detach | Platforms |
|---|---|---|---|
| `whipRepublishAdapter({url, authToken, bitrate?})` | borrows the `MediaRef`, starts `PhoneWhipPublisher` toward the URL | stops the publisher, keeps nothing | all |
| `renderAdapter()` + `GlassesStreamView` | borrows and attaches the view's renderer | detaches the renderer, the view shows its last frame or a placeholder | all |
| `FrameSinkAdapter` (native) | borrows and delivers `VideoFrame` / PCM on the decoder thread; the sink must not block | releases the lease | Kotlin, Swift |

Native:

```kotlin
val stream = GlassesPhoneStream.open(context, StreamOptions(owner = "relay", video = ..., uplink = Uplink.CELLULAR, recovery = ...),
  adapter = FrameSinkAdapter(onFrame = { frame -> ... }, onPcm = { pcm, rate, ch -> ... }))
val media = stream.start()
stream.close()
```

```swift
let stream = try await GlassesPhoneStream.open(options, adapter: FrameSinkAdapter(onFrame: { ... }, onPcm: { ... }))
let media = try await stream.start()
await stream.close()
```

The glasses side is unchanged: the stream service sends `startStream({streamUrl: <phone WHIP URL>, ice: {stun: ""}, ...})`, and `stream_status` gains `route: "glasses_wifi" | "phone_hotspot"` as the streaming spec says.

## `startStream` destination union: the stream stays on the phone

`takePhoto` had the same problem and #3619 fixed it with a destination union: an app that
wanted the photo on the phone had to give a webhook URL that pointed back at itself. Streaming
has the twin today. The Bluetooth SDK Starter Kit's Stream tab starts its own WHIP receiver
(`mentra-video-stream-receiver`, `startWebRtcReceiver()`), gets a URL back, and passes that URL
to `BluetoothSdk.startStream`; the glasses then publish to the phone across the home Wi-Fi both
are on, which is why that tab is gated on the glasses being on Wi-Fi. `startStream` gains the
same shape of union `PhotoDestination` has, with a `phone` arm that takes no URL:

```ts
// @mentra/bluetooth-sdk
export type StreamDestination =
  | {
      kind: "url"                  // today's behaviour: the glasses publish to a URL over their own Wi-Fi
      streamUrl: string
      authToken?: string
      ice?: StreamIceConfig
    }
  | {
      kind: "phone"                // the stream ends on this phone over the glasses hotspot: no URL, no loopback, no shared network needed
    }

export type StreamStartRequest = {
  /** Where the stream ends up. Preferred over the deprecated flat `streamUrl`. */
  destination?: StreamDestination
  /** @deprecated Use `destination: {kind: "url", streamUrl}`. Mixing it with `destination` throws at request time, as PhotoRequestParams does. */
  streamUrl?: string
  video?: StreamVideoConfig
  audio?: StreamAudioConfig
  captureAudio?: boolean
  sound?: boolean
  // authToken and ice move into the "url" arm; the flat fields stay accepted with the flat streamUrl only.
}

const started = await BluetoothSdk.startStream({destination: {kind: "phone"}, video})
// started: StreamStatusEvent & {phone?: {streamSessionId: string}}
<GlassesStreamView streamSessionId={started.phone.streamSessionId} style={styles.preview} />
await BluetoothSdk.stopStream()
```

The `phone` arm is the SDK-level front door of `glassesPhoneStream.preview()`: it opens the
hotspot session, starts the receiver with the render adapter, publishes through the glasses
publisher slot with host-only ICE, and resolves on the first frame. Recovery, first-frame
gating and cleanup are the stream service's. `stream_status` reports `route: "phone_hotspot"`.
Nothing changes on the glasses: they already accept a phone-local URL and detect the hotspot
route.

The `phone` arm is hotspot only in this version. A same-LAN route, where phone and glasses
share a Wi-Fi network and no hotspot is involved, would need the stream service to take a
network source other than a hotspot session: LAN address and interface selection, loss
invalidation and recovery that never touch the glasses AP, and cleanup to match. None of that
exists in the streaming spec, whose `open` always acquires a hotspot and whose receiver setup
and recovery are built on the hotspot lease. It is deferred rather than half-specified; until
then same-LAN streaming to the phone keeps working the way it does today, through the `url`
arm with a receiver the app runs.

Stopping is the other half of the contract. Today `BluetoothSdk.stopStream()` binds straight to
native and only sends the BLE stop and awaits its acknowledgement; it knows nothing about a
phone receiver or a hotspot. With a `phone` destination the public stop must close the whole
operation, so the provider owns one:

```ts
// SDK-internal provider contract, implemented by glasses-media
export interface PhoneStreamProvider {
  /** Called on admission, before anything starts. Returns synchronously so stop() can reach it during startup. */
  begin(request: StreamStartRequest): PhoneStreamOperation
}
export interface PhoneStreamOperation {
  readonly streamSessionId: string
  /** open → start; resolves on the first frame with the status the public startStream returns. */
  started: Promise<StreamStatusEvent & {phone: {streamSessionId: string}}>
  /** Cancels a start or a recovery in flight, closes the stream session (which stops the glasses through the publisher slot's own low-level stop), and awaits the close. Idempotent; retries a blocked hotspot release. */
  stop(): Promise<{status: StreamStatusEvent; hotspot: ReleaseResult | null}>
}
```

`BluetoothSdk.startStream` with `kind: "phone"` registers the operation before it awaits
`started`, and `BluetoothSdk.stopStream()` routes by what is active: with a phone operation
registered, including one still starting or recovering, it calls `operation.stop()` and
resolves with the final `stopped` status once the session has closed; with a `url` stream it
does exactly what it does today. The stream service stops the glasses through
`glassesPublisher.stop(streamId)`, never through the public `stopStream`, so there is no
recursive dispatch. A blocked cleanup leaves the operation registered in a `closing` state:
`stream_status` carries `cleanup: "blocked"`, a second `stopStream()` retries the release, and
`startStream` rejects with `publisher_busy` until the close settles, so a late completion from
the old operation can never attach to a successor. With the BLE link down the glasses stop is
deferred through the publisher slot as already specified, while the receiver and the hotspot
session close immediately.

Placement follows the libwebrtc rule. Photo phone delivery lives entirely in the SDK because
BLE file transfer does. A stream receiver needs libwebrtc, which stays in
`@mentra/glasses-media`. The union and the call live in the SDK; glasses-media registers itself
as the provider of the `phone` arm when it is imported
(`registerPhoneStreamProvider(provider)` on an SDK-internal registry). Without glasses-media
installed, `startStream` with `kind: "phone"` rejects with `phone_stream_unavailable` and a
message naming the package. The native SDKs get the same union (`StreamDestination.Phone`,
`.url(...)`) with the same provider registration from the glasses-media AAR and pod.

### Starter kit: a hotspot option on the Stream tab

The Starter Kit's React Native example has a Camera tab and a Stream tab. The Camera tab
already uses the glasses hotspot: its saved-photo preview shows a "Glasses hotspot" panel with
the SSID and password, a "Connect glasses hotspot" action, and the gallery server status. The
Stream tab has one switch today, computer or cloud URL versus the on-phone receiver, and the
on-phone mode requires the glasses to be on Wi-Fi. It gains the hotspot the same way:

- In on-phone mode a two-way selector, **Glasses hotspot** (new, default) and **Same Wi-Fi**
  (today's behaviour). Glasses hotspot uses `destination: {kind: "phone"}`; the Wi-Fi gate on
  the start button does not apply to it, so the button is enabled as soon as the glasses are
  connected. Same Wi-Fi is unchanged: the kit's `mentra-video-stream-receiver` module starts
  its receiver and the app passes the returned URL through the `url` arm, still gated on the
  glasses being on Wi-Fi.
- With the hotspot selected the preview pane renders `GlassesStreamView`, and the first-frame
  and status lines come from `stream_status` and the returned session; with Same Wi-Fi the
  pane and events stay the local module's.
- While the hotspot route is starting the tab shows the same kind of panel the Camera tab does,
  driven by `useGlassesHotspot()`: enabling, joining, ready, and the owner when busy (for
  example the Camera tab's own saved-photo session), so the two tabs explain the hotspot
  identically. The Camera tab's manual join helper moves onto the SDK hotspot session in the
  same change, so the example has one hotspot code path.
- The "SDK call" box the tab displays shows the three-line version above for the hotspot
  option, and today's `startWebRtcReceiver()` plus `startStream` with the `url` arm for Same
  Wi-Fi.
- `examples/react-native/modules/mentra-video-stream-receiver` stays, serving Same Wi-Fi only.
  It is a third WHIP receiver implementation beside the two that share glasses-media, and it is
  deleted when the same-LAN network source above is designed and the `phone` arm can cover
  that mode; not before.
- Computer or cloud mode is unchanged and uses the `url` arm for RTMP, SRT and remote WHIP.
- Docs: `docs/api-reference.md`, `docs/troubleshooting.md` and the README's streaming section
  describe the destination union, the hotspot route and its permissions.

The Kotlin and Swift examples in the Starter Kit get the same option with the native union.

## Engine: `@mentra/engine`

```ts
import {glassesHotspot} from "@mentra/engine/hotspot"         // re-export of the SDK service
import {glassesPhoneStream} from "@mentra/engine/streaming"    // re-export of the glasses-media service
import {phoneStreamCoordinator} from "@mentra/engine"

// Flows on the coordinator. It publishes through the SDK's glassesPublisher slot like everyone
// else and keeps cloud provisioning, per-package subscriber refcounting and miniapp status fanout.
await phoneStreamCoordinator.startUnmanaged(pkg, {streamUrl, route: "phone", authToken, video})  // phone relay to a WHIP URL
await phoneStreamCoordinator.startManaged(pkg, {ingest: "whip"})                                    // already the phone route; unchanged

// Custom sink with a full lifecycle: this is what Mentra Call uses.
const attempt = phoneStreamCoordinator.startLocal(pkg, {
  adapter, video, captureAudio,
  uplink,                                   // "none" | "cellular" | an UplinkLease the caller keeps
  recovery,                                 // StreamRecoveryPolicy, forwarded unchanged
  /** Runs between the stream's open (hotspot reserved, uplink held) and start. Mentra Call prepares its ACS agent here. */
  prepare?: (signal: AbortSignal) => Promise<void>,
})
const unsubscribe = attempt.subscribe(e => project(e.state))   // available before start(); first event is the "acquiring" snapshot
const media = await attempt.start()                             // open → prepare → stream.start; resolves on live
attempt.cancel()                                                // aborts prepare, start or recovery through the same signal
const result = await attempt.close()                            // {hotspot: ReleaseResult | null}; retries a blocked release on a failed attempt
await phoneStreamCoordinator.stop(pkg)                          // refcounted stop for subscribers; a Call attempt closes itself
```

```ts
export interface LocalStreamAttempt {
  readonly id: string
  snapshot(): StreamState                    // the streaming spec's StreamState, from creation
  subscribe(listener: (event: StreamEvent) => void): () => void
  start(): Promise<MediaRef>
  cancel(): void
  close(): Promise<{hotspot: ReleaseResult | null}>
}
```

`startUnmanaged` with `route: "phone"` and a non-WHIP URL is rejected, matching the streaming
spec's decision that phone relay is WHIP only in v1. `startLocal` returns the attempt
synchronously with nothing started, so the caller can subscribe first and project every step
from the `acquiring` snapshot on, and it preserves the Call spec's `open → prepareAgent →
start` sequence through the `prepare` hook; the call session never touches the stream service
directly. Facade tests: preflight progress before `start`, cancel during `prepare` and during
recovery, a blocked `close` followed by a successful retry, and the attempt's state matching
the underlying stream snapshot event for event. Gallery sync, hotspot OTA and Mentra Call
keep their engine entry points and run on the SDK hotspot service and the glasses-media stream
service underneath, so an embedder gets the same behaviour the Mentra App has.

### Engine hotspot facade: `@mentra/engine/hotspot`

The engine owns three hotspot flows today, gallery sync, hotspot OTA and the video stream,
each with its own service and its own notion of progress. The facade makes them one
observable surface for an embedder, with the hotspot session state attached, without adding
behaviour or a fourth owner: every action delegates to the existing flow controller and every
snapshot is composed from the controllers' existing state plus the SDK hotspot service's
`current()` and session snapshot. For OTA the existing controller is the one the public OTA
design and `mintlify-docs/bluetooth-sdk/software-update.mdx` already direct custom UIs to,
`MentraLiveOtaController` (`@mentra/engine/ota`, today produced by `useMentraLiveOta`): it
owns battery admission, artifact staging, `ota_start`, APK-to-firmware chaining, restart
reconciliation and dismissal policy above `OtaInstallCoordinator`, which by itself only stores
a check and runs staging and start together. The facade reuses that controller's semantic
state and idempotent actions verbatim; it defines no OTA sequence of its own.

```ts
import {engineHotspot} from "@mentra/engine/hotspot"

export interface EngineHotspotSnapshot {
  /** The SDK hotspot session, if any consumer holds one. */
  session: HotspotState | null
  owner: {purpose: "gallery_sync" | "hotspot_ota" | "video_streaming" | string; operationId: string} | null
  uplink: {held: boolean; holders: number}
  flows: {
    gallerySync: GallerySyncFlowState        // the gallery store's status, queue progress, last error, plus `hotspot: HotspotState | null`
    ota: MentraLiveOtaState & {hotspot: HotspotState | null}   // the controller's semantic state (screen, transport, hotspotPhase, step, error) plus the session
    stream: StreamState | null               // the active phone-route stream, if any
  }
}

export interface EngineHotspotFacade {
  snapshot(): EngineHotspotSnapshot
  /** Delivers the current snapshot immediately, then one event per change in any flow or in the session. */
  subscribe(listener: (snapshot: EngineHotspotSnapshot) => void): () => void

  gallerySync: {
    /** Starts a sync: acquires the hotspot as gallery_sync, downloads the queue, releases. Rejects with busy naming the owner if another flow holds it. */
    start(): Promise<void>
    /** Resumes the saved queue after a loss or an app restart, reusing the session if still ready. */
    resume(): Promise<void>
    cancel(): Promise<void>
    snapshot(): GallerySyncFlowState
    subscribe(listener: (state: GallerySyncFlowState) => void): () => void
  }

  /**
   * The existing MentraLiveOtaController, unchanged, with the hotspot session attached to its state.
   * The actions are the controller's own idempotent actions with their existing semantics; there is no
   * cancel: an accepted glasses transaction is never cancelled and its serving endpoint is never released
   * early. `discard` keeps the controller's meaning (dismiss a not-yet-accepted update or a finished flow).
   */
  ota: Pick<MentraLiveOtaController, "check" | "retryCheck" | "install" | "retryInstall" | "finish" | "discard"> & {
    snapshot(): MentraLiveOtaState & {hotspot: HotspotState | null}
    subscribe(listener: (state: MentraLiveOtaState & {hotspot: HotspotState | null}) => void): () => void
  }
}
export const engineHotspot: EngineHotspotFacade
```

`useEngineHotspot()` in the engine's React exports returns the composed snapshot for UI: an
embedder can show "Gallery sync is using the glasses hotspot" or block an OTA button while a
call holds the session from one place. The facade is the ownership and progress projection an
embedder needs for hotspot features; the SDK service stays available for anything custom, and
`useMentraLiveOta` and `MentraLiveOtaFlow` remain the OTA UI surface.

One extraction is required and it is the only new code the facade needs: today the controller
exists only as a React hook. Extract its logic once into a non-React
`createMentraLiveOtaController(options)` in `@mentra/engine/ota`, make `useMentraLiveOta` a
thin subscription over it, and have `engineHotspot.ota` delegate to the same instance. Parity
tests run the extracted controller and the hook through the same cases: low battery admission,
APK-to-firmware chaining across the ASG restart, restart reconciliation, and `discard` before
and after the glasses accept the transaction.

### Miniapp handlers

Two capabilities reach miniapps. Relay needs no new handler; preview needs one.

**Relay to the miniapp's own WHIP destination over the phone.** Already covered by the
streaming spec's `route` option:

```ts
// Miniapp SDK, StreamModule
session.stream.startStream({direct: "https://example.com/whip/abc", authToken, route: "phone", video})
```

The glasses publish to the phone over the hotspot and the phone republishes to the URL. The
engine handler for `miniapp_stream_start` maps `route: "phone"` onto
`phoneStreamCoordinator.startUnmanaged(pkg, {route: "phone", ...})`, requires the CAMERA
manifest permission and the LOCAL_WIFI runtime permission, and rejects a non-WHIP URL. Status
arrives as today's `StreamStatus` with `route: "phone"`.

**Preview the glasses on the phone.** A miniapp runs as a background JS context with an
on-demand UI WebView, so it cannot host a native video view. The preview is a host-rendered
surface that the Mentra App shows on the miniapp's behalf:

```ts
// Miniapp SDK, StreamModule
/**
 * Show live glasses video on the phone. The host opens the glasses hotspot, receives the stream on the
 * phone and renders it in a surface it owns: "pip" floats over the miniapp UI and can be dragged, "sheet"
 * fills the miniapp's UI area. Resolves once the first frame is on screen. Only one preview can be active;
 * a second call while one is active rejects. Requires the CAMERA manifest permission and the nearby-devices
 * permission, and fails with `hotspot_busy` if gallery sync, OTA or a call holds the hotspot.
 */
preview(options?: {placement?: "pip" | "sheet"; video?: StreamVideoConfig}): Promise<PreviewHandle>

export interface PreviewHandle {
  readonly previewId: string
  /** Progress and recovery of the underlying phone-route stream: the StreamStatus the miniapp already knows, with route "phone". */
  onStatus(handler: (status: StreamStatus) => void): () => void
  /** Move the surface without restarting the stream. */
  setPlacement(placement: "pip" | "sheet"): Promise<void>
  /** Stops the stream and closes the surface. The host also stops it when the miniapp is closed or backgrounded. */
  stop(): Promise<void>
}
```

Wire: `miniapp_stream_preview_start` with `{placement?, video?}` returning `{previewId,
streamId}`, `miniapp_stream_preview_set_placement` with `{previewId, placement}`, and
`miniapp_stream_preview_stop` with `{previewId}`. The engine handler calls
`phoneStreamCoordinator.startLocal(pkg, {adapter: renderAdapter(hostSurface), ...})`, owns the
surface lifecycle, and forwards stream status to the miniapp as `StreamStatus` with
`route: "phone"`. Preview and a miniapp stream are mutually exclusive through the publisher
slot, as they must be: the glasses publish once.

Rendering the preview inside the miniapp's own WebView (a local WHEP endpoint the WebView could
play) is deliberately out of scope; it would add a phone-side WHEP server to glasses-media.

## Reconciliation with the other specs

| Spec | Change |
|---|---|
| Hotspot spec | the TypeScript service's home is `mobile/modules/bluetooth-sdk/src/hotspot/`, not the engine; `HotspotConsumer` is `purpose: string` at the SDK boundary with the engine's three reserved values; nothing else changes |
| Streaming spec | the TypeScript service's home is `mobile/modules/glasses-media/src/`, not the engine; it publishes through the SDK's `GlassesPublisher` port instead of calling `startStream` itself; `PhoneStreamCoordinator` is a consumer of the same slot, not the service's caller; the "SDK surface" section is superseded by this spec except the Miniapp SDK `route` option and `stream_status.route`, which stand |
| Call spec | `AcsMediaAdapter` implements the same `StreamAdapter` interface the packaged adapters implement; `SoftapCallSession` calls the coordinator's `startLocal` |

## Packaging and release

- `@mentra/glasses-media` gains a dependency on `@mentra/bluetooth-sdk` (npm, and the Android
  library plus the pod for the native registries). Add the edge in `.github/release-family.json`
  before the first publish; the missing-edge failure on #4049 is the precedent.
- The Android AAR and the pod of `@mentra/glasses-media` must be published wherever the SDK's
  are, so a Kotlin or Swift integrator can depend on them without the monorepo. Verify the
  current publication of glasses-media's native artifacts during step 1; if they are not yet
  published, that is the first task.
- Version lock: glasses-media pins the SDK at the same family version, as the engine does.

## Documentation

- `mintlify-docs/bluetooth-sdk/camera-streaming.mdx`: a "Streaming to the phone over the
  glasses hotspot" section with the React Native, Kotlin and Swift snippets above, the
  permission and entitlement notes, and the `route` field of `stream_status`.
- `mintlify-docs/bluetooth-sdk/api-reference.mdx`: the `hotspot` subpath and `useGlassesHotspot`.
- A new `mintlify-docs/bluetooth-sdk/glasses-media.mdx` for the streaming package and its
  adapters.
- Engine docs: the two subpaths and the three coordinator flows.
- `sdk/example-oem-app`: a screen that previews the glasses with `GlassesStreamView` and a
  button that relays to a WHIP URL, so the public path is exercised in CI builds.

## Migration

These are placements for the steps already listed in the hotspot and streaming specs, not new
steps:

1. Hotspot spec steps 1 and 2 build the native core and the TypeScript service inside the SDK
   (`hotspot` subpath) and add `useGlassesHotspot` and the config plugin permissions.
2. Streaming spec step 1 builds the media registry and the stream service inside glasses-media
   with the republish and render adapters and the native frame sink; the engine re-exports both
   services in the same PR.
3. Streaming spec step 2 moves managed WHIP onto `startManaged`'s new path; `startUnmanaged`
   gains `route: "phone"` and `startLocal` appears at the same time.
4. The Call spec's steps use `startLocal`.
5. Docs and the OEM example screen land with step 3; the `otaLocalNetwork` facade is removed
   one release after step 1; `otaServer` stays. The `StreamDestination` union and the provider
   registration land with step 3 too, and the Starter Kit's Stream tab hotspot option ships in
   that repo as soon as the SDK release containing them is published.
6. The publisher slot lands with hotspot spec step 2 (the reservation gate), because the
   deferred-stop fencing that step introduces belongs to the slot; the coordinator moves its
   glasses-direct and managed starts onto the slot in the same PR, with tests for standalone
   consumption without the engine, a direct start competing with a phone-route start, status
   correlation by stream id, a deferred stop retired with its hotspot session, and the
   same-session races: link drops during a media rebuild, reconnect arriving after the
   successor started (the old stop must not be sent), reconnect arriving before it (the old stop
   is drained, then the successor starts).

## Risks

- **libwebrtc in integrator apps.** Anyone installing glasses-media takes the same libwebrtc
  build the Mentra App uses; apps that already bundle another WebRTC library can conflict. The
  package README must state the version and the dedupe rule glasses-media's Gradle file already
  documents.
- **iOS entitlement.** `NEHotspotConfiguration` needs an entitlement Apple grants per app; the
  config plugin can declare it but the integrator must request it. Document it up front.
- **Native view lifecycle.** `GlassesStreamView` must survive a media generation change without
  a black flash; the render adapter reattaches on the new generation before the old surface is
  released.
- **OTA listener under a foreign pin.** Tests: Call exhausts with its lease still held, OTA
  acquires and its manifest server is reachable from the glasses; bind failure restores the
  pin; a release racing the bind is rejected with `stale_generation`; ACS stays connected
  throughout.
- **Uplink release timing.** `UplinkLease` must reproduce `InternetHold`'s default-route
  check on final release; a premature unpin while a leftover AP is still the default strands
  the call. Tests: exhaustion with an unconfirmed hotspot-off, then gallery or OTA acquiring
  the hotspot, with ACS connectivity intact throughout.
- **Facade coupling.** `engineHotspot` composes three services' state; it must stay a
  projection with no state of its own, or it becomes a fourth owner. Tests assert that every
  facade snapshot equals the composition of the underlying snapshots.
- **Preview surface lifecycle.** The host-owned surface must close when the miniapp is closed
  or backgrounded, and the underlying stream must close with it; tests cover both and a
  placement change mid-recovery.
- **Provider registration and stop routing.** The `phone` arm depends on glasses-media being
  imported before the first `startStream`; the rejection when it is not must be immediate and
  named, never a hang. Tests cover the SDK alone (the `url` arm and `stopStream` behave exactly
  as today), the SDK plus glasses-media, the deprecated flat `streamUrl` mixed with
  `destination`, start then stop, stop during start and during recovery, stop with the BLE link
  down, and a blocked close followed by a successful retry.
- **Two published services.** Moving the services out of the engine means their tests and
  their release gates live in the SDK and glasses-media packages; the engine's suites keep only
  the flow tests.
