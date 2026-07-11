# Move local-miniapp streaming to phone (OS-1437)

**Status:** Approved — ready to implement
**Linear:** https://linear.app/mentralabs/issue/OS-1437/v2-move-streaming-to-phone-new-cloud-handler-for-managed-streams
**Scope:** Local JS miniapps only. Third-party cloud SDK apps and the existing cloud-1 streaming code are untouched.

---

## Why

Local JS miniapps currently send `stream_request` / `managed_stream_request` envelopes through the phone WebSocket to cloud. Cloud holds the entire streaming state machine (registry, lifecycle controller, keep-alive timers, Cloudflare integration) and round-trips status back to the phone, which forwards to the miniapp. This is:

1. Heavy on cloud for something that doesn't need cloud (unmanaged streams need zero cloud; managed streams only need the Cloudflare provisioning call).
2. Awkward for cloud-2 migration — the streaming logic is interwoven with cloud-1 session state and would need to be ported wholesale.

Target end state: phone owns streaming orchestration end-to-end. Cloud exposes a single thin, stateless endpoint for Cloudflare provisioning and gets out of the way.

## Guiding principles

1. **Don't touch cloud-1 streaming code.** Existing handlers, lifecycle controllers, Cloudflare service, REST routes — all stay. Cloud-SDK apps keep working.
2. **All new mobile code lives in self-contained files** with clear names so cloud-2 port is a copy job.
3. **One new cloud surface, and only one** — a stateless Cloudflare proxy. No registry, no timers, no WebSocket emission. Lives in `cloud/packages/cloud/src/api/hono/client/v2/streams.api.ts` as one file you can lift verbatim. Mounted at `/api/v2/client/streams/managed`.
4. **Keep `session.stream.*` SDK surface byte-identical.** Miniapp authors don't notice the re-plumb.
5. **Status events stay first-class.** Miniapps subscribed to `stream_status` keep receiving updates whether they came from glasses or from Cloudflare.

> **Where heartbeat lives.** OS-1437 talks about keep-alive/heartbeat; in this design it lives entirely on the phone — `PhoneStreamCoordinator` instantiates a `StreamLifecycleController` per active stream and exchanges `keep_stream_alive` / `keep_alive_ack` frames with the glasses over BLE. Cloud has no heartbeat responsibility because cloud no longer owns the stream lifecycle.
>
> **Why provision doesn't take `packageName`.** Cloud-1 routes used `packageName` to fan responses back to the originating app via its WebSocket session. The v2 route is REST-only and the phone owns response routing: the phone tracks which `packageName`(s) are subscribed to each `liveInputId` locally. Cloud only needs to know who's authorized (via JWT email) to provision/teardown.

## Architecture

### Unmanaged streams — zero cloud

```
miniapp → SDK → LocalMiniappRuntime.handleStreamStart
       → phoneStreamCoordinator.startUnmanaged({streamUrl, video, audio})
           ├── claims the single-stream slot (rejects if busy)
           ├── assigns local streamId
           ├── CoreModule.startStream({...}) → BLE → glasses publishes RTMP/SRT/WHIP
           ├── starts keepalive timer (15s heartbeat → glasses, 3-miss → auto-stop)
           └── relays inbound glasses stream_status → miniapp via EVENT
       → resolves request to miniapp with {streamId}
```

### Managed streams — one thin cloud call, then phone-driven

```
miniapp → SDK → LocalMiniappRuntime.handleManagedStreamStart
       → phoneStreamCoordinator.startManaged({restreamDestinations})
           ├── if a managed stream is already running for this user:
           │       hand the existing {streamId, hlsUrl, dashUrl, webrtcUrl} to miniapp B
           │       (Cloudflare muxes; multiple miniapps watch the same playback URLs)
           ├── else:
           │       POST /api/v2/client/streams/managed/provision (NEW, stateless)
           │       → cloud: CloudflareStreamService.createLiveInput + createOutputs
           │       → returns {cfLiveInputId, ingestUrl, hlsUrl, dashUrl, webrtcUrl, outputIds}
           │       CoreModule.startStream({streamUrl: ingestUrl, ...}) → BLE → glasses
           │       starts keepalive
           │       starts HLS-readiness poller (HEAD on hlsUrl until 200 OK)
           └── on stop (when last subscribing miniapp releases):
                   DELETE /api/v2/client/streams/managed/:cfLiveInputId → Cloudflare teardown
                   stops glasses publishing
```

Multi-miniapp managed-stream sharing is **read-mostly**: only the first caller's `restreamDestinations` actually take effect. If miniapp B passes restream destinations and a managed stream is already running, we surface that as an error (or warning + ignore — see "Open questions"). Refcount the consumers; teardown only when the last one releases.

## What I verified against the codebase (second pass)

### 0. Glasses BLE protocol for streams is already complete

`asg_client/.../service/utils/ServiceConstants.java`:
- `COMMAND_KEEP_STREAM_ALIVE = "keep_stream_alive"` (line 48)
- `RESPONSE_KEEP_ALIVE_ACK = "keep_alive_ack"` (line 77)

`asg_client/.../service/core/handlers/StreamCommandHandler.java`:
- Accepts `keep_stream_alive` payload with `{streamId, ackId}` (line 378-388).
- Calls `RtmpStreamingService.resetStreamTimeout(streamId)` → if valid, ACKs back via BLE.
- Each publisher service (`RtmpStreamingService.java:1234-1264`) has its OWN local timeout timer (`mRtmpStreamTimeoutTimer`). If keep-alives don't arrive in time, glasses auto-stop the publisher locally.

**Implication:** the phone MUST send keep-alives at the agreed cadence (default 15s per `StreamRequest.keepAliveIntervalSeconds`). Today, cloud sends `keep_stream_alive` envelopes through the phone WebSocket; phone's `SocketComms.handle_keep_stream_alive` (line 585) forwards to `CoreModule.keepStreamAlive(msg)`. After our change, phone owns the cadence — the cloud-emitted heartbeats go away for local-miniapp streams.

### 1. Cloudflare status updates → do they flow today?

**Answer: yes, but only inbound to cloud, never re-emitted to phone for local miniapps.**

`cloud/packages/cloud/src/services/streaming/CloudflareStreamService.ts` has:

- `getLiveInputStatus(cfLiveInputId)` — polls Cloudflare's REST API for the live input connection state (connected / disconnected).
- `waitForStreamLive(cfLiveInputId)` — polls every 2s up to 30 attempts until HLS is ready.
- `startPlaybackUrlPolling()` (in `ManagedStreamingExtension.ts`) — polls for HLS/DASH URLs after stream starts.

These results are consumed by `ManagedStreamingExtension` to drive its internal state machine, and the resulting `phone_managed_stream_status` envelope sent to the phone contains `status` (initializing / active / stopping / stopped / error). The phone forwards that as `EVENT { streamType: "stream_status" }` to the miniapp.

So today, the miniapp DOES receive a `status` field that ultimately reflects Cloudflare state. To preserve parity we need the **phone** to poll Cloudflare's live-input status itself, OR ask the new cloud route to do it on the phone's behalf.

**Decision:** put a `GET /api/v2/client/streams/managed/:cfLiveInputId/status` on the new route. Phone calls it on a slow interval (every 5s) while a managed stream is active. Keeps Cloudflare API tokens server-side (no credential leak to phone), keeps the new cloud surface stateless (just a Cloudflare passthrough), and means status events to the miniapp look identical to today.

Note: this `GET` is a single Cloudflare API call wrapped in a thin route. Still zero in-memory state on cloud. Still trivially portable to cloud-2.

### 2. Multi-miniapp sharing of one managed stream

The user's ask: if miniapp A starts a managed stream and miniapp B starts one later, give miniapp B the same playback URLs (Cloudflare muxes; one ingest, many viewers).

**Verified feasible.** Cloud's `StreamRegistry.ManagedStreamState` already tracks `activeViewers: Set<string>`, indicating this is how the cloud-1 path handles it today. We replicate the same pattern in `PhoneStreamCoordinator`:

```ts
interface ManagedStreamEntry {
  streamId: string
  cfLiveInputId: string
  ingestUrl: string        // RTMP/SRT/WHIP — only the first caller uses this
  hlsUrl: string
  dashUrl: string
  webrtcUrl?: string
  subscribers: Set<string> // packageNames
  startedAt: number
}
```

`subscribers` is the refcount. Each `startManaged(packageName)` adds to the set. Each `stop(packageName)` removes. When `subscribers.size === 0`, tear down (BLE stop_stream + DELETE to cloud).

### 3. WebRTC viewer URL for the example tester page

User asked: "for managed streams if we can somehow display the webrtc viewer that'd be sick."

Verified: `phone_managed_stream_status` already carries `webrtcUrl` (per cloud's `ManagedStreamingExtension`). The Cloudflare `createLiveInput` response includes a WHEP playback URL. We surface it on the new provision response too and route it into `ManagedStreamResult`.

In the example tester page, we can embed it via either:
- An `<iframe>` to Cloudflare's hosted player, or
- A small WHEP-pull client using the browser `RTCPeerConnection` API.

Easiest is iframe to Cloudflare's hosted player URL (`https://customer-<account>.cloudflarestream.com/<videoId>/iframe`). Verified this URL is already constructible from `cfLiveInputId` — `CloudflareStreamService` builds the HLS URL from the same ID with the same pattern.

### 4. One-stream-per-user vs one-stream-per-package

User confirmed: **one stream in general, period.** Either one unmanaged OR one managed at a time, system-wide on this phone.

So the coordinator enforces:
- At most one active stream of any kind across all miniapps.
- Exception: multiple miniapps can join an already-running managed stream (refcounted, share URLs).

If miniapp B tries to start an unmanaged while a managed is running (or vice versa), reject with a clear error and surface it back to the miniapp's promise.

### 5. Glasses-side coexistence

Verified: glasses' `StreamCommandHandler.java` accepts plain JSON `start_stream` over BLE with no cloud-binding, no signature, no sessionId validation. Phone can drive it directly.

Single-stream constraint on the glasses side: also fine — `RtmpStreamingService` / `SrtStreamingService` / `WhipStreamingService` are services (one instance, replace-on-start). New start while one is active will stop the previous. We avoid relying on that and gate it in `PhoneStreamCoordinator` instead.

### 6. Existing `StreamLifecycleController` is portable as-is

`cloud/packages/cloud/src/services/streaming/StreamLifecycleController.ts` is a clean class with **zero cloud dependencies in its core** — it takes callbacks (`sendKeepAlive`, `onAckTimeout`, etc.) and runs a synthetic-clock-friendly state machine. We don't need to write a new `PhoneStreamKeepalive` from scratch. **We extract it into a shared location** (or copy it; see Open questions) and reuse it on the phone with phone-side callbacks. Behavior parity comes free, the cloud tests stay valid, and the cloud-2 port is one file.

### 7. Status routing: phone-owned vs cloud-owned streams must be distinguishable

Today, `MantleManager.ts:903-908` blindly forwards every `stream_status` event from glasses to cloud via `socketComms.sendStreamStatus`. After our change, if a stream was started by a local miniapp (no cloud session involved), forwarding to cloud is wasted bandwidth and would confuse the cloud-1 state machine.

`StreamStatusEvent` (`mobile/modules/bluetooth-sdk/src/BluetoothSdk.types.ts:254`) always carries `streamId`. The coordinator's local registry maps `streamId → {kind: 'phone-owned' | 'cloud-owned'}`. The `MantleManager` forwarder consults the registry: if phone-owned, route to `phoneStreamCoordinator.handleGlassesStatus`; if not in registry, forward to cloud (preserves cloud-SDK app behavior). Same gating for `keep_alive_ack` (line 911-914).

### 8. `session.events.subscribe("stream_status", ...)` is a real surface

`mobile/modules/miniapp/src/session.ts:147` exposes `public readonly events: EventManager`. `EventManager.subscribe(streamType, handler)` accepts arbitrary stream names. The example tester page can use it for the `stream_status` stream — no SDK change needed.

## Concrete work, in order

### Phase 1 — new cloud route

**New file:** `cloud/packages/cloud/src/api/hono/client/v2/streams.api.ts` (matches existing `/api/hono/client/*.api.ts` naming + mount convention)

Routes (auth: bearer coreToken, same as existing routes):

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v2/client/streams/managed/provision` | Body: `{restreamDestinations?: string[]}`. Calls `CloudflareStreamService.createLiveInput` + `createOutputs`. Returns `{cfLiveInputId, ingestUrl, hlsUrl, dashUrl, webrtcUrl, outputIds}`. |
| `GET` | `/api/v2/client/streams/managed/:cfLiveInputId/status` | Calls `CloudflareStreamService.getLiveInputStatus`. Returns `{status, errorDetails?}`. |
| `DELETE` | `/api/v2/client/streams/managed/:cfLiveInputId` | Calls `CloudflareStreamService.deleteLiveInput`. Idempotent. |

What it does NOT do:
- No `StreamRegistry` interaction.
- No `ManagedStreamingExtension` / `UnmanagedStreamingExtension` interaction.
- No WebSocket messages emitted.
- No state held between requests.

**New file:** `cloud/packages/cloud/src/api/hono/client/v2/streams.api.test.ts`

- Happy path provision (mock Cloudflare service)
- Happy path status poll
- Happy path teardown (idempotent on missing id)
- Auth failure → 401
- Cloudflare 5xx pass-through

### Phase 2 — phone-side coordinator

**New file:** `mobile/src/services/streaming/PhoneStreamCoordinator.ts`

```ts
type StreamKind = "unmanaged" | "managed"

interface UnmanagedEntry {
  kind: "unmanaged"
  streamId: string
  packageName: string
  streamUrl: string
  startedAt: number
}

interface ManagedEntry {
  kind: "managed"
  streamId: string
  cfLiveInputId: string
  ingestUrl: string
  hlsUrl: string
  dashUrl: string
  webrtcUrl?: string
  subscribers: Set<string>     // packageNames
  startedAt: number
  hlsReady: boolean
}

class PhoneStreamCoordinator {
  private current: UnmanagedEntry | ManagedEntry | null = null

  async startUnmanaged(packageName, opts): Promise<{streamId}>
  async startManaged(packageName, opts): Promise<{streamId, hlsUrl, dashUrl, webrtcUrl?}>
  async stop(packageName, streamId?): Promise<void>

  // Internal
  private emitStatusToSubscribers(payload): void   // routes via runtime hook
  private startKeepalive(): void
  private startCloudflareStatusPolling(): void
  private startHlsReadinessPolling(): void
}
```

Constraints enforced inside `startUnmanaged` / `startManaged`:
- If `current` is an unmanaged stream → reject any new start with `STREAM_ALREADY_ACTIVE`.
- If `current` is a managed stream and a new managed start arrives:
  - If `restreamDestinations` is empty/absent → join existing (add to subscribers, resolve with same URLs).
  - If `restreamDestinations` is non-empty → reject with `STREAM_DESTINATIONS_LOCKED` (the existing stream's destinations are immutable for this PR; can revisit later).
- If `current` is a managed stream and a new unmanaged start arrives → reject.
- If miniapp calls `startManaged` twice → idempotent (already in subscribers, return same URLs).

**Reuse via copy:** `mobile/src/services/streaming/StreamLifecycleController.ts` (+ `.test.ts`)

The cloud's `StreamLifecycleController.ts` is a pure class with callback injection — no cloud-specific imports, uses only `console`, timers, and plain types. Per decision 5: copy verbatim into mobile rather than promoting to a shared package.

Phone constructs it with phone-side callbacks:
- `sendKeepAlive(ackId)` → `CoreModule.keepStreamAlive({streamId, ackId, keepAliveIntervalSeconds: 15})`
- `onKeepAliveMissed` / `onAckTimeout` → coordinator auto-stops, fires status event with `kind: "error"`.

**`PhoneStreamKeepaliveBridge`** (small adapter file): wires `keep_alive_ack` events from `CoreModule.addListener("keep_alive_ack", ...)` into `controller.handleAck(ackId)`. Single instance, multiplexes by `streamId` (matches the active stream's controller).

Behavior parity with cloud is automatic — same class, same tests.

**New file:** `mobile/src/services/streaming/PhoneStreamStatusBridge.ts`

Subscribes to native `stream_status` BLE events (already emitted today by `CoreModule` and currently relayed to cloud). Routes them to `PhoneStreamCoordinator.handleGlassesStatus(streamId, status, errorDetails?)`.

For managed streams, the coordinator also:
- Polls `GET /api/v2/client/streams/managed/:cfLiveInputId/status` every 5s, normalizes to the same shape, fans out to subscribers (deduped against the most-recent status).
- Polls HEAD on the HLS URL every 2s for up to 60s after stream start. On first 200, marks `hlsReady = true` and emits an `EVENT { streamType: "stream_status", data: {status: "active", streamId, hlsUrl, dashUrl, webrtcUrl} }` so the miniapp's `startManaged()` Promise resolves with the playback URLs.

**New file:** `mobile/src/services/streaming/v2StreamApi.ts`

Thin fetch wrapper for the three new cloud routes. Reuses existing auth helper (bearer coreToken). Exports `provisionManaged`, `getManagedStatus`, `teardownManaged`. Single place to retarget when cloud-2 lands.

**New tests:**

- `PhoneStreamCoordinator.test.ts` — mocked `CoreModule`, mocked `v2StreamApi`:
  - happy path unmanaged
  - happy path managed (single subscriber)
  - happy path managed with two subscribers; second's `stop()` doesn't kill stream; first's `stop()` does
  - second subscriber passing `restreamDestinations` → rejected
  - conflict: unmanaged active, attempt managed → reject
  - conflict: managed active, attempt unmanaged → reject
  - keepalive timeout auto-stops; status event fired
  - cloud provision failure → reject with mapped error
- `PhoneStreamKeepalive.test.ts` — synthetic clock; mirror shape of `StreamLifecycleController.test.ts` for behavior-parity confidence.

### Phase 3 — re-wire `LocalMiniappRuntime`

**Edit:** `mobile/modules/engine/src/services/LocalMiniappRuntime.ts`

- `handleStreamStart` (line ~1741): replace `socketComms.sendMessage({type: "stream_request", ...})` + pending-cloud-request bookkeeping with `streaming.startUnmanaged(packageName, payload)`. On resolve, `sendResult(packageName, requestId, true, {streamId})`.
- `handleStreamStop` (line ~1755): replace with `streaming.stop(packageName, payload.streamId)`.
- `handleManagedStreamStart` (line ~1764): replace with `streaming.startManaged(packageName, payload)`. The Promise resolves with playback URLs once HLS is ready.
- `handleManagedStreamStop` (~1778): replace with `streaming.stop(...)`.
- In `handleCloudMessage` (line ~340): remove the local-miniapp routing for `phone_stream_status` and `phone_managed_stream_status`. Cloud-SDK apps still need them, so leave the SocketComms dispatch (line 818-822) in place — it just no longer hits any local miniapp because the new path never registers a pending cloud request for streaming.

**Edit:** `mobile/src/services/MantleManager.ts`

Gate the existing forwarders so phone-owned streams stay on-phone:

```ts
// line ~903 (stream_status forwarder) — gate by registry
CoreModule.addListener("stream_status", (event) => {
  if (event.streamId && phoneStreamCoordinator.owns(event.streamId)) {
    phoneStreamCoordinator.handleGlassesStatus(event)
    return  // do NOT forward to cloud
  }
  socketComms.sendStreamStatus(event)  // unchanged — cloud-SDK app path
})

// line ~911 (keep_alive_ack forwarder) — same gating
CoreModule.addListener("keep_alive_ack", (event) => {
  if (event.streamId && phoneStreamCoordinator.owns(event.streamId)) {
    phoneStreamKeepaliveBridge.handleAck(event)
    return
  }
  socketComms.sendKeepAliveAck(event)
})
```

Add a `streaming` runtime-hook in `configureRuntime({...})`:

```ts
streaming: {
  startUnmanaged: (pkg, opts) => phoneStreamCoordinator.startUnmanaged(pkg, opts),
  startManaged: (pkg, opts) => phoneStreamCoordinator.startManaged(pkg, opts),
  stop: (pkg, streamId) => phoneStreamCoordinator.stop(pkg, streamId),
  subscribeStatus: (cb) => phoneStreamCoordinator.subscribe(cb),
}
```

Preserves the island module's dependency-direction discipline (island stays decoupled from the host service layer, same as `audioPlayback` / `socketComms` / `navigation`).

**Edit:** `mobile/modules/engine/src/runtime/config.ts`

Add the `StreamingAdapter` interface and field in `RuntimeHooks`. Match the existing adapter pattern.

### Phase 4 — example tester pages

**New page:** `sdk/example-miniapp/src/ui/pages/tester/CameraPage.tsx`

- Already-wired `takePhoto()` flow. Buttons for size variants. Renders the returned `photoUrl` as an `<img>` thumbnail (24h Cloudflare R2 TTL). Surfaces errors.

**New page:** `sdk/example-miniapp/src/ui/pages/tester/StreamingPage.tsx`

- Text input for RTMP URL → "Start unmanaged" button.
- "Start managed" button (no input needed).
- "Stop" button.
- Status timeline pulled from the `stream_status` event channel (`kind: "status"` in the tester pattern).
- For managed: when `hlsReady`, render an `<iframe>` to the Cloudflare hosted player (constructed from `webrtcUrl` or `hlsUrl`'s parent path). User-requested.

**Edit:** `sdk/example-miniapp/src/background/controllers/TesterController.ts`

Add cases:

```ts
case "stream": {
  const s = this.session.events.subscribe("stream_status", (data) => emit("status", data))
  return () => s()
}
case "camera": {
  return () => {}  // no event surface; fire("takePhoto") returns via kind: "result"
}
```

For `dispatchAction`, both `camera.takePhoto(...)` and `stream.startUnmanaged/startManaged/stop(...)` resolve into `kind: "result"` (already supported by the generic dispatcher).

**Edit:** `sdk/example-miniapp/src/ui/pages/tester/TesterMenu.tsx`

Add two rows:

```ts
{emoji: "📸", title: "session.camera", subtitle: "takePhoto, FOV", path: "/tester/camera"},
{emoji: "🎬", title: "session.stream", subtitle: "unmanaged + managed + viewer", path: "/tester/stream"},
```

**Edit:** `sdk/example-miniapp/src/ui/pages/tester/ComingSoonPage.tsx`

Remove `Camera` and `Streaming` items. Keep `Dashboard` as the single placeholder, as confirmed.

**Edit:** `sdk/example-miniapp/src/ui/App.tsx`

Add `/tester/camera` and `/tester/stream` routes.

### Phase 5 — manual E2E

Once Phases 1-4 land, on-device verification:

- Unmanaged stream to a local RTMP server (e.g. `nginx-rtmp` running locally) — confirm phone never opens a `stream_request` envelope to cloud, BLE traffic carries the start, glasses publish, status events flow.
- Managed stream — confirm the only cloud hit is the v2 provision/status/teardown route. Open the WHEP viewer in the example app's iframe and see glass output.
- Two miniapps both calling `startManaged()` — confirm second one gets the same URLs and doesn't double-provision.
- Cross-conflict (unmanaged while managed active) → confirm rejection surface.
- Keepalive timeout (simulate BLE drop) → confirm auto-stop and status event.

## What this PR does NOT do

- No changes to cloud-1 `ManagedStreamingExtension`, `UnmanagedStreamingExtension`, `StreamRegistry`, `StreamLifecycleController`, the existing `streams.routes.ts`, `glasses-message-handler.ts`'s phone-stream handlers, or `app-message-handler.ts`. All cloud-SDK app paths unchanged.
- No changes to `asg_client/` (glasses code).
- No changes to `@mentra/miniapp` SDK module surface. `session.stream.*` API preserved.
- No moving of Cloudflare credentials to phone.
- No mid-stream restream destination management for v1 (immutable after `provision`). Can revisit.
- No touching the photo flow — separate "move to phone" candidate, out of scope.

## Cloud-2 port story

Files to copy verbatim into cloud-2:

- `cloud/packages/cloud/src/api/hono/client/v2/streams.api.ts` (+ test)
- `cloud/packages/cloud/src/services/streaming/CloudflareStreamService.ts` (unchanged — already self-contained)

Phone-side files have no cloud-1 dependency; they keep working as soon as cloud-2 serves the same `/api/v2/client/streams/managed/*` routes.

When cloud-2 lands: delete cloud-1 streaming directory in one commit. Phone keeps working because it's only hitting v2.

## Decisions

1. **Cloudflare status: poll, 5s.** Rejected WebSocket because the goal is a stateless cloud surface that ports cleanly to cloud-2; a WS would either drag cloud-1 session machinery into the new code or stand up new infra for a small payoff. Poll volume is tiny (~10-60 requests per stream lifetime), Cloudflare's status itself only updates at second-granularity, and the primary stream-status signal comes from the glasses publisher over BLE in real time — the Cloudflare poll is the secondary "what does the other end see" confirmation.
2. **Reject `restreamDestinations` from non-owner with `STREAM_DESTINATIONS_LOCKED`.** Silent ignore would lie to the caller; appending mid-stream introduces an unsolved output-ownership/cleanup question. Reject gives a clear, debuggable signal and matches cloud-1's `checkStreamConflict` pattern. Output-management endpoints can land later as a separate feature.
3. **WHEP viewer:** iframe to `https://iframe.videodelivery.net/{cfLiveInputId}`. URL is already constructible from provision response. Simpler than building a WHEP `RTCPeerConnection` client.
4. **Cloud route base path:** `/api/v2/client/streams/managed/*`, file at `cloud/packages/cloud/src/api/hono/client/v2/streams.api.ts`. Matches existing `/api/client/*` convention (verified — see `client/photo.api.ts`, `client/location.api.ts`, etc.) with v2 prefix for the new surface.
5. **`StreamLifecycleController`:** copy the file (+ tests) into `mobile/src/services/streaming/`. Verified `@mentra/types` is not a mobile workspace dep; promoting it across packages is scope creep for this PR. Drift risk is low (cloud-1 streaming is in maintenance mode). If we later discover broader code-sharing needs, promoting to `@mentra/types` is a one-file follow-up PR.

## Phase order

| Phase | Scope | Reviewer time |
|---|---|---|
| 1 | New cloud route + test | ~30 min |
| 2 | Phone coordinator + keepalive + status bridge + tests | ~90 min |
| 3 | Re-wire `LocalMiniappRuntime` + `MantleManager` hook + runtime config | ~30 min |
| 4 | Example tester pages + remove Camera/Streaming from Coming Soon | ~30 min |
| 5 | Manual E2E on device | TBD |

Total: ~800-1200 LOC of new code across ~7 new files + ~150 LOC of edits across ~4 existing files. Cloud-1 streaming code: untouched.
