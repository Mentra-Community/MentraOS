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
   direct stream and a phone-route stream can never both be started.
7. **Frames never cross the JavaScript bridge.** In React Native the sinks are a native view
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
`otaServer.start` takes the phone address from a session binding, as the hotspot spec says.

### `@mentra/bluetooth-sdk/streaming`: the publisher slot

```ts
export interface GlassesPublisher {
  /** Rejects with publisher_busy (details.owner) while another stream is active. */
  start(request: StreamStartRequest & {owner: string}): Promise<{streamId: string; status: StreamStatusEvent}>
  stop(streamId: string): Promise<void>
  /** If the BLE link is down, queue the stop; `hotspotSessionId` ties it to that session so it is retired with it. */
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

## Engine: `@mentra/engine`

```ts
import {glassesHotspot} from "@mentra/engine/hotspot"         // re-export of the SDK service
import {glassesPhoneStream} from "@mentra/engine/streaming"    // re-export of the glasses-media service
import {phoneStreamCoordinator} from "@mentra/engine"

// Flows on the coordinator. It publishes through the SDK's glassesPublisher slot like everyone
// else and keeps cloud provisioning, per-package subscriber refcounting and miniapp status fanout.
await phoneStreamCoordinator.startUnmanaged(pkg, {streamUrl, route: "phone", authToken, video})  // phone relay to a WHIP URL
await phoneStreamCoordinator.startManaged(pkg, {ingest: "whip"})                                    // already the phone route; unchanged
await phoneStreamCoordinator.startLocal(pkg, {
  adapter, video, captureAudio, uplink,
  /** Runs between the stream's open (hotspot reserved, cellular held) and start. Mentra Call prepares its ACS agent here. */
  prepare?: (signal: AbortSignal) => Promise<void>,
})
await phoneStreamCoordinator.stop(pkg)
```

`startUnmanaged` with `route: "phone"` and a non-WHIP URL is rejected, matching the streaming
spec's decision that phone relay is WHIP only in v1. `startLocal` preserves the Call spec's
`open → prepareAgent → start` sequence through the `prepare` hook, so the call session never
touches the stream service directly. Gallery sync, hotspot OTA and Mentra Call
keep their engine entry points and run on the SDK hotspot service and the glasses-media stream
service underneath, so an embedder gets the same behaviour the Mentra App has.

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
   one release after step 1; `otaServer` stays.
6. The publisher slot lands with hotspot spec step 2 (the reservation gate), because the
   deferred-stop fencing that step introduces belongs to the slot; the coordinator moves its
   glasses-direct and managed starts onto the slot in the same PR, with tests for standalone
   consumption without the engine, a direct start competing with a phone-route start, status
   correlation by stream id, and a deferred stop retired with its hotspot session.

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
- **Two published services.** Moving the services out of the engine means their tests and
  their release gates live in the SDK and glasses-media packages; the engine's suites keep only
  the flow tests.
