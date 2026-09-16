---
status: draft
owner: philippe
---

# Glasses hotspot service design

One owner for glasses hotspot (SoftAP) sessions in the Mentra App. Today four independent
join stacks exist on `dev`, all driven by the same BLE pair `BluetoothSdk.setHotspotState`
and `hotspot_status_change`:

| Today | Used by | Becomes |
|---|---|---|
| `MentraLocalNetworkModule` (bluetooth-sdk, Android) behind engine `localNetworkTransport`; iOS falls back to `react-native-wifi-reborn` | gallery sync, hotspot OTA | the native core, extended; `localNetworkTransport` becomes a thin adapter, then goes |
| `AcsMeetingService.joinScopedNetwork` over the acs-meeting native join | Mentra Call (`SoftapCallTransport`) | deleted; ACS borrows the network from the native registry |
| `ScopedSoftApNetwork` (glasses-media, Android) | managed WebRTC relay | connection lifecycle moves into the core; only the libwebrtc inventory glue stays |
| `GlassesHotspotNetwork` (glasses-media, iOS) | managed WebRTC relay | becomes the iOS implementation of the core |
| `GlassesHotspotLease` (in-process mutex, Call and relay only) | Call, relay | deleted once every consumer reserves through the service |

This spec merges two independent proposals (Claude and local Codex, 2026-09-16) and the
cross-review of each. Where they disagreed the decision is recorded with its reason.
Related: `2026-09-08-ios-softap-spike.md`, the Mentra Call SoftAP recovery merged in #4074,
and the companion `2026-09-16-glasses-phone-streaming-service-design.md`, which owns the video
stream that crosses the hotspot. Layering: hotspot service → glasses-to-phone streaming
service → destination adapters (ACS for Mentra Call, the Cloudflare republisher for managed
WHIP, local preview). Mentra Call and the managed relay are therefore not direct hotspot
consumers; the streaming service is.

## Requirements

- **Exclusive ownership across every consumer**: gallery sync, hotspot OTA, and video
  streaming (which serves Mentra Call and the managed WHIP relay). Fail fast on conflict naming
  the owner. No preemption, no sharing.
- **Lifecycle owned in one place**: enable the AP over BLE and wait for credentials and
  broadcast; scoped join (one native `Network` on Android, `NEHotspotConfiguration` on iOS);
  address resolution (phone IPv4, glasses gateway, prefix, interface); readiness and gateway
  probing; loss detection; bounded rejoin fenced by a generation; cancellation; settled release
  including the hotspot-off ack.
- **Three consumers with different needs**:
  - gallery sync: network-bound HTTP fetch and download of many files; a one-time join
    explanation before the system Wi-Fi prompt; must tolerate an unreadable SSID on iOS when
    Location permission is denied (`gallerySyncService.ts`, SSID verification); resumes its
    queue after loss.
  - hotspot OTA: phone-hosted HTTP server bound to the phone IPv4 whose address is baked into
    the manifest the glasses already hold (`HotspotOtaTransport.ts`); the AP and the session
    must survive the intentional ASG APK restart (ASG preserves the AP during replacement,
    `OtaSessionManager.java`); glasses activity is refreshed by the existing ping heartbeat
    (`PingCommandHandler.java`), not by probing.
  - video streaming (Mentra Call, managed WHIP): libwebrtc needs the native `Network` handle
    in-process; the WHIP listener binds on the phone address and the glasses publish to it;
    the receiver rebinds on recovery; recovery completes only after a fresh frame; the gateway
    probe is advisory because the stream needs glasses-to-phone connectivity; Internet traffic
    (ACS, Cloudflare) keeps its cellular uplink while the phone is on the hotspot. Destination
    lifetime (the ACS meeting, the Cloudflare live input) is never the hotspot service's
    concern; it belongs to the streaming service's adapters.

## Decisions

1. **The session is the reservation.** `acquire` is the only entry point; it reserves
   natively and, when `uplink: "cellular"` is requested, establishes the cellular hold, before
   any BLE command and before `start`. A consumer can therefore do Internet work that must
   already be routed over cellular (Mentra Call's ACS agent preparation) between `acquire` and
   `start`. `release` drops the hold. Reservation is held until native cleanup settles, never
   freed by `failed` alone.
2. **Explicit generation references.** Every network-bound operation and every native
   attachment takes a `NetworkRef {sessionId, generation}`. Loss invalidates the generation
   immediately, natively first, so late work can never attach to a successor network.
3. **Awaited restoration callbacks plus observer events.** Consumers hand the session a
   client with `quiesce`, `restore`, `close`. `ready` means the network is bound *and* the
   consumer's `restore` completed. Observers read the state snapshot, which carries the phase
   and the binding; there is no second readiness channel.
4. **Independent health dimensions.** BLE control path, local network, and cellular uplink
   are tracked separately. A BLE drop is not proof the Wi-Fi went away; the service waits for
   BLE only when the next required operation needs it (AP enable or disable).
5. **Stable OTA endpoint.** A recovery that would change the phone address fails the OTA
   restore explicitly; the OTA coordinator reconciles the existing glasses transaction before
   starting another. No transparent server rebind.
6. **Structured release.** Release reports whether the hotspot-off ack was confirmed and
   whether native cleanup settled. An unconfirmed ack does not block the next owner (matches
   today's Call behaviour); pending native work does, and is retried with a bound, after which
   the service performs local forced cleanup and records it. No `leaveHotspotOn` until there is
   a handoff use case. **No deferred glasses command may run against the next owner**: a BLE
   `stopStream` or `setHotspotState(false)` that a session defers because the BLE link is down
   (today `PhoneStreamCoordinator.flushPendingBleStop`, sent whenever the link returns) is
   owned by that session, carries its id, and is retired when the session's release settles or
   when another session acquires. Release does not report `released` while such a command is
   still pending and unretired.
7. **Per-operation recovery policy**, `none` or `auto` with separate return and rebuild
   budgets (Call's current 60 s return, 45 s rebuild, at most three transient attempts). No
   `manual` mode: a second lifecycle driver is not worth it. Each outage gets one
   `RecoveryContext`: the return deadline is set when loss is detected; the rebuild deadline is
   set once, when the return wait completes (the glasses are reachable again), never earlier
   and never renewed. The context is passed to `quiesce` and `restore` and shown in
   `HotspotState.recovery`, so a client that continues work after `restore` (the streaming
   service publishing and waiting for a frame) bounds that work by the same rebuild deadline.
   Duplicate loss events within an outage do not create a new context.
8. **Join hook on every join**, initial and rejoin, with the reason and a cancellation signal.
   Gallery keeps its one-time explanation and no-UI-listener fallback inside the hook.
9. **Native core in the Bluetooth SDK.** Hotspot OTA is part of the published SDK, and the
   media code names the missing SDK dependency as its reuse barrier. glasses-media and
   acs-meeting, both in-app modules, gain a dependency on the SDK Android library. Bare-SDK
   packaging is preserved: Expo stays compile-only on Android and adapter sources stay
   conditional on iOS. A separate `glasses-network` library was rejected as extra publication
   and version coordination without a demonstrated benefit.
10. **Native session tracking on both platforms.** iOS has no `Network` handle to hand out,
    but pending `NEHotspotConfiguration` callbacks must stay fenced through release, so the
    iOS driver tracks session and generation too.
11. **Reservation gate migrates first, deferred teardown included.** All four consumers reserve
    through the service before any join moves, and every deferred BLE teardown is tied to its
    session and retired on release or on a new acquire, so a legacy path can never enable or
    disable the AP under a new owner. Reservation alone does not fence commands queued after an
    owner releases: the managed relay releases its lease after offline cleanup has deferred the
    stop, and the coordinator would later send hotspot-off into a gallery or OTA session.
12. **No owner waiting in the first version.** `acquire` fails fast with `busy`. A bounded wait
    can be added later behind an option if a real flow needs it.
13. **Join hook on both platforms.** Gallery's explanation is shown on Android and iOS today and
    keeps that behaviour inside `beforeJoin`.
14. **Exhaustion does not close the client.** When recovery is exhausted or a non-recoverable
    loss occurs, the service quiesces the client, tears down the hotspot, and moves the session
    to `failed` with the error; it never calls `client.close`. `close` runs only from `release`.
    Hotspot teardown and higher-level ownership are separate: Call keeps its ACS meeting after a
    failed media rebuild, exactly as `SoftapCallTransport` does today with `stop({preserveMeeting})`
    on budget exhaustion, until the user leaves and the runtime calls `release`.
15. **Listener binding is a native helper, not a consumer concern.** Binding a local listener on
    the hotspot address while the process is pinned to cellular requires lifting the pin for the
    duration of the bind (today `AcsMeetingModule.withIngestUnpinned`, on join and on recovery
    rebind). The core exposes a generation-validated `bindLocalListener` that serializes with
    `detach`/`release` and restores the pin in `finally`; consumers never touch the process route.

## TypeScript API (engine, `mobile/modules/engine/src/services/hotspot/`)

```ts
export type HotspotConsumer = "gallery_sync" | "hotspot_ota" | "video_streaming"
// operationId convention: "<owner>:<id>", for example "call:abc123" or "managed_whip:s-42";
// the owner prefix is diagnostic metadata only, never a reservation key.

export type HotspotPhase =
  | "reserved"      // native reservation held, nothing sent to the glasses yet
  | "enabling"      // BLE setHotspotState(true) sent; waiting for credentials + broadcast
  | "joining"       // native scoped join in progress
  | "verifying"     // addresses resolved; gateway probe (required or advisory)
  | "restoring"     // client.restore running for this generation
  | "ready"         // network bound and restore completed
  | "recovering"    // loss detected; quiesce → wait → rejoin → verify → restore
  | "failed"        // client quiesced, hotspot torn down, error recorded; client.close not called; release frees ownership
  | "releasing"
  | "release_blocked" // hotspot-off settled or unconfirmed, but native cleanup still pending
  | "released"

export type HotspotHealth = {
  ble: "up" | "down"
  localNetwork: "bound" | "lost" | "none"
  uplink: "held" | "unavailable" | "not_requested"
}

/** Opaque generation-bound reference. Never an Android Network object. */
export type NetworkRef = {sessionId: string; generation: number}

export type HotspotBinding = NetworkRef & {
  ssid: string
  phoneIpv4: string
  glassesIpv4: string          // AP gateway; ASG HTTP APIs live here
  prefixLength: number
  interfaceName?: string
}

export type HotspotErrorCode =
  | "busy"                     // details.owner names the consumer and operation
  | "unsupported"              // glasses report no hotspot capability
  | "wifi_disabled"
  | "permission_denied"        // NEARBY_WIFI_DEVICES / local network
  | "user_action_required"     // iOS system prompt declined
  | "cellular_unavailable"     // uplink "cellular" requested and not available
  | "ble_unavailable"          // AP control needed and the BLE path did not return in budget
  | "ap_start_failed"          // hotspot_error or no enabled status in time
  | "join_failed"
  | "address_unavailable"
  | "gateway_unreachable"      // only when gatewayProbe === "required"
  | "network_lost"             // recovery "none", or loss during a non-recoverable phase
  | "recovery_exhausted"
  | "stale_generation"         // I/O or attachment with a NetworkRef that is no longer current
  | "client_restore_failed"
  | "cancelled"
  | "cleanup_pending"          // release_blocked after the retry bound; local forced cleanup done

export class HotspotError extends Error {
  readonly code: HotspotErrorCode
  readonly details?: {owner?: {consumer: HotspotConsumer; operationId: string}; sessionId?: string; generation?: number; native?: string}
}

export type HotspotRecoveryPolicy =
  | {mode: "none"}
  | {mode: "auto"; returnBudgetMs: number; rebuildBudgetMs: number; maxAttempts: number}

/** One per outage. rebuildDeadlineAt is null until the return wait completes, then fixed for the outage. */
export type RecoveryContext = {
  outageId: string
  attempt: number
  returnDeadlineAt: number
  rebuildDeadlineAt: number | null
}

export interface HotspotClient {
  /** On loss: stop work bound to this generation, keep higher-level state (ACS meeting, download ledger). recovery.rebuildDeadlineAt is still null here. */
  quiesce(binding: HotspotBinding, recovery: RecoveryContext, signal: AbortSignal): Promise<void>
  /** Initial join and every successful rejoin. `ready` is reported only after this resolves. On rejoin, recovery.rebuildDeadlineAt is set and bounds any work the client continues afterwards. */
  restore(binding: HotspotBinding, recovery: RecoveryContext | null, signal: AbortSignal): Promise<void>   // recovery null = initial join
  /** Final teardown of consumer-owned work, including a partial restore. Idempotent. Called only from release(), never on recovery exhaustion. */
  close(): Promise<void>
}

export type HotspotSessionOptions = {
  consumer: HotspotConsumer
  operationId: string
  /** "cellular": hold an Internet route over cellular for the life of the session (Call). */
  uplink: "none" | "cellular"
  recovery: HotspotRecoveryPolicy
  /** Default "advisory": a failed probe is recorded, not fatal. Gallery and OTA may set "required". */
  gatewayProbe?: "required" | "advisory"
  /** Before every join, initial and rejoin, on both platforms. Gallery shows its one-time explanation here. */
  beforeJoin?: (info: {ssid: string | null; reason: "initial" | "rejoin"}, signal: AbortSignal) => Promise<void>
  signal?: AbortSignal
}

export type HotspotState = {
  sessionId: string
  sequence: number            // monotonic; every event carries a full snapshot
  phase: HotspotPhase
  generation: number
  health: HotspotHealth
  binding?: HotspotBinding    // present only while the generation is usable
  recovery?: RecoveryContext
  error?: HotspotError
}

export type HotspotEvent =
  | {type: "state"; state: HotspotState}
  | {type: "downloadProgress"; jobId: string; bytesWritten: number; totalBytes?: number}

export type ReleaseResult =
  | {status: "released"; hotspotOff: "confirmed" | "unconfirmed"}
  | {status: "blocked"; hotspotOff: "confirmed" | "unconfirmed"; error: HotspotError}

export interface HotspotSession {
  readonly id: string
  snapshot(): HotspotState
  /** Delivers the current snapshot immediately, then ordered updates. */
  subscribe(listener: (event: HotspotEvent) => void): () => void

  /** Runs enable → join → verify → restore. Resolves with the first ready binding; rejoins are delivered through client.restore. */
  start(client: HotspotClient): Promise<HotspotBinding>

  /** Network-bound HTTP to the glasses. Rejects with stale_generation if ref is not current. */
  fetch(ref: NetworkRef, url: string, init?: RequestInit & {timeoutMs?: number}): Promise<Response>
  download(ref: NetworkRef, opts: {jobId: string; url: string; destination: string; headers?: Record<string, string>; connectionTimeoutMs?: number; readTimeoutMs?: number; signal?: AbortSignal}): Promise<{statusCode: number; bytesWritten: number}>

  /**
   * Cancels start/recovery, drains the client, disables the AP with bounded retries, releases
   * native ownership. If the BLE link is down the hotspot-off is deferred, tied to this session,
   * and retired if another session acquires first; release then reports hotspotOff "unconfirmed".
   * Repeated calls share one cleanup; a blocked result is retryable.
   */
  release(): Promise<ReleaseResult>
}

export interface GlassesHotspotService {
  /** Rejects with busy (details.owner) while any session is not released. No waiting, no preemption. */
  acquire(options: HotspotSessionOptions): Promise<HotspotSession>
  current(): {consumer: HotspotConsumer; operationId: string; sessionId: string; phase: HotspotPhase} | null
  capabilities(): {supported: boolean; hotspotOtaVersion: number}
  /** Bounded, credential-redacted lifecycle log for bug reports. */
  timeline(): ReadonlyArray<{at: number; sessionId: string; generation: number; event: string; detail?: string}>
}

export const glassesHotspotService: GlassesHotspotService
```

### State machine

```text
reserved → enabling → joining → verifying → restoring → ready
ready → recovering → (wait for glasses if AP control is needed) → joining → verifying → restoring → ready
any active phase → failed → releasing
any active phase + cancel → releasing
releasing → released | release_blocked → (retry) → released | cleanup_pending
```

Recovery on loss, in order: native invalidates the generation and notifies native borrowers;
JS aborts that generation's fetches, downloads and any running restore; `quiesce` is awaited;
the service waits for a BLE control path only if it must re-enable the AP, reusing an AP that
is still enabled; rejoin, resolve addresses, probe, then `restore` with the new generation.
On exhaustion the service tears down the hotspot and fails the session with
`recovery_exhausted`; the client stays open and the consumer decides what to do with its
higher-level state before calling `release`. Duplicate loss events do not renew budgets.
Media-level failures (a stalled WebRTC peer, a receiver crash) are not hotspot losses: the
streaming service handles them on the same hotspot generation and never asks this service to
cycle a healthy AP.

## Native contract

One Expo module, `MentraGlassesHotspot`, in `mobile/modules/bluetooth-sdk`. It absorbs
`MentraLocalNetworkModule` (HTTP and download over the bound network), the join, readiness and
loss lifecycle of `ScopedSoftApNetwork`, and `GlassesHotspotNetwork.swift` as the iOS driver.
Credentials cross this private bridge and never appear in events, `timeline`, or logs. BLE
commands stay in the engine service.

```kotlin
// Android Expo surface (promises wrap these)
suspend fun reserve(sessionId: String, uplink: String)
suspend fun preflight(sessionId: String)                       // Wi-Fi on, permissions, cellular if requested
suspend fun join(sessionId: String, ssid: String, passphrase: String, gateway: String?): BindingDto   // new generation
suspend fun probe(ref: NetworkRefDto): ProbeDto                // TCP to gateway; refusal counts as reachable
suspend fun detach(sessionId: String)                          // drain the generation, keep reservation + uplink
suspend fun release(sessionId: String): NativeReleaseDto       // {settled: Boolean, pending: String?}
/** Bind a local TCP listener on binding.phoneIpv4 for this generation. Lifts the cellular pin only
 *  for the bind and restores it in finally; serialized with detach/release; rejects stale refs. */
suspend fun bindLocalListener(ref: NetworkRefDto, req: ListenerDto): ListenerReplyDto   // {port, generation}
suspend fun request(ref: NetworkRefDto, jobId: String, req: HttpRequestDto): HttpReplyDto
suspend fun download(ref: NetworkRefDto, jobId: String, req: DownloadDto): DownloadReplyDto
suspend fun cancelJob(sessionId: String, jobId: String)
suspend fun snapshot(): NativeStateDto?
// Events: networkState {sessionId, generation, state, reason?, binding?}, downloadProgress
```

```kotlin
// In-process registry for libwebrtc and ACS, exported from the SDK AAR. Versioned.
object GlassesHotspotRegistry {
  class Lease(val binding: Binding, val network: android.net.Network) : AutoCloseable {
    /** Same pin-lifting, generation-validated bind for in-process consumers (WHIP ingest). */
    fun bindListener(port: Int, backlog: Int = 50): java.net.ServerSocket
  }
  /** Atomically validates the generation; onInvalidated fires before JS learns of the loss. */
  fun borrow(sessionId: String, generation: Int, onInvalidated: () -> Unit): Lease
}
```

```swift
// iOS: same Expo surface; the registry tracks session/generation and fences pending
// NEHotspotConfiguration callbacks through release. No Network handle; the lease exposes
// verified addresses and Wi-Fi-scoped connection/listener parameters for local sockets.
final class GlassesHotspotRegistry {
  func borrow(sessionId: String, generation: Int, onInvalidated: @escaping () -> Void) async throws -> Lease
}
```

The cellular pin that `AcsMeetingModule` applies and lifts around listener binding moves behind
`bindLocalListener` / `Lease.bindListener`; consumers stop touching the process route. Tests:
initial bind, recovery rebind, bind failure restores the pin, bind racing a concurrent release
or detach is rejected with `stale_generation`.
`MentraOtaServer.start` takes the phone address from the binding instead of polling
`waitForWifiAddress`.

## Consumers

| Consumer | Sequence |
|---|---|
| Gallery sync | `acquire({consumer: "gallery_sync", uplink: "none", recovery: auto, gatewayProbe: "required", beforeJoin: explainOnce})` → `start(client)`; `restore`: fetch manifest, continue unverified files with `fetch/download(ref)`; `quiesce`: cancel transfers, keep the ledger; `close`; `release`. Requests are not replayed transparently; gallery keeps ownership of acknowledgements and integrity. The two-minute queue age guard stays because the glasses idle-disable the AP. |
| Hotspot OTA | Download artifacts over the normal network first → `acquire({consumer: "hotspot_ota", uplink: "none", recovery: auto, gatewayProbe: "required"})` → `restore` on `initial`: start `otaServer` bound to `binding.phoneIpv4`, publish the immutable manifest; `ota_start` once; on `rejoin` with a different `phoneIpv4`, throw so the restore fails explicitly and the coordinator reconciles; the ASG APK restart does not close the server or cycle the AP; `release` after the outcome is known. |
| Video streaming (Mentra Call, managed WHIP, direct WHIP over the phone) | The streaming service is the hotspot client: `acquire({consumer: "video_streaming", operationId: "call:<id>", uplink: "cellular", recovery: {auto, 60 s return, 45 s rebuild, 3 attempts}, gatewayProbe: "advisory"})` (ACS agent setup happens in the call layer before the stream opens) → `restore` on the initial join and on every rejoin: `Lease.bindListener` on `binding.phoneIpv4`, start the receiver, hand the `Network` to libwebrtc, then return, so the hotspot is `ready` once the network-bound setup is up; adapter attach, the glasses publish, the first frame and media retries run in the stream lifecycle afterwards, bounded by `recovery.rebuildDeadlineAt` from the same `RecoveryContext`, and never fail this restore; `quiesce`: stop local media only; `close`: stop the receiver. Destination adapters (ACS sink, Cloudflare republisher) attach to decoded media by `MediaRef` and never touch this session. See the companion streaming spec for the full contract. |

## Migration in small PRs

1. **Native core and registry** in the SDK, extracted from the existing lifecycle code, old
   modules untouched. Tests: reservation, generation invalidation, late callbacks, settled
   cancellation, iOS pending-configuration fencing.
2. **Shared reservation gate**: all four consumers reserve through the service before their
   joins move, so old and new owners never mix. `GlassesHotspotLease` becomes a wrapper (Call and the relay reserve as
   `video_streaming` with their owner tag until the streaming service exists). In the
   same PR, `PhoneStreamCoordinator`'s deferred `stopStream` / hotspot-off is keyed by the
   session that deferred it and retired when that session's release settles or when another
   session acquires; `ManagedWebRtcRelay.stop` releases only after the deferral is registered
   with the service. Tests: relay releases with BLE down, gallery acquires and enables the AP,
   BLE returns, the deferred hotspot-off must not be sent.
3. **Engine service plus gallery sync**: state machine, budgets, structured release; gallery
   keeps its explanation, SSID-unreadable tolerance, and transfer ledger. `localNetworkTransport`
   becomes a session-bound adapter.
4. **Hotspot OTA**: server borrows the binding; `HotspotShutdown.disableHotspotWithRetry` folds
   into `release`. Hardware qualification of the intentional APK restart with the same live
   endpoint, and of a real Wi-Fi loss separately, before merge.
5. **Video streaming service** (companion spec, its steps 1 to 3): the streaming service
   becomes the single video consumer of this service; Mentra Call and the managed WHIP relay
   move onto it as adapters; the ACS native join, `LocalMiniappRuntime.settleSoftapTeardown`
   and `ManagedWebRtcRelay`'s retry loop are deleted. Keep the #4074 tests and point them at the
   new seams: preserved meeting, fresh frame, cancellation at every step, and recovery
   exhaustion leaving the meeting joined until explicit Leave.
6. **Delete** legacy ownership paths, adapters, `GlassesHotspotLease`, and the
   `react-native-wifi-reborn` join.

## Risks

- **Late iOS association callbacks**: a pending `NEHotspotConfiguration.apply` must keep the
  reservation until its callback is cleaned up, as `GlassesHotspotNetwork.swift` does today.
- **OTA endpoint continuity** across the APK restart; qualified on Mentra Live before step 4.
- **Call cancellation and recovery races**: cancellation wins over recovery; test every
  restoration step under cancellation.
- **AP inactivity**: the glasses disable the AP after idle; OTA's ping heartbeat is the
  existing refresh. The service must not claim a gateway probe keeps the AP alive; if gallery
  or Call need a refresh, reuse the heartbeat rather than inventing one.
- **Dependency direction**: glasses-media and acs-meeting now depend on the SDK Android
  library; the SDK depends on neither.

## Deferred

- Bounded waiting for the current owner (`waitForOwner`): omitted from the first version;
  every consumer fails fast with `busy`.
- `leaveHotspotOn` on release: omitted until there is a handoff use case.
