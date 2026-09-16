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
Related: `2026-09-08-ios-softap-spike.md`, the Mentra Call SoftAP recovery merged in #4074.

## Requirements

- **Exclusive ownership across every consumer**: gallery sync, hotspot OTA, Mentra Call, the
  managed relay. Fail fast on conflict naming the owner. No preemption, no sharing.
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
  - Mentra Call: libwebrtc and ACS need the native `Network` handle in-process; the WHIP
    listener binds on the phone address and the glasses publish to it; ingest rebinds on
    recovery; the ACS meeting is preserved; recovery completes only after a fresh frame; the
    gateway probe is advisory because Call needs glasses-to-phone connectivity; Internet
    traffic for ACS keeps its cellular uplink while the phone is on the hotspot.

## Decisions

1. **The session is the reservation.** `acquire` is the only entry point and reserves
   natively before any BLE command. Reservation is held until native cleanup settles, never
   freed by `failed` alone.
2. **Explicit generation references.** Every network-bound operation and every native
   attachment takes a `NetworkRef {sessionId, generation}`. Loss invalidates the generation
   immediately, natively first, so late work can never attach to a successor network.
3. **Awaited restoration callbacks plus observer events.** Consumers hand the session a
   client with `prepare`, `quiesce`, `restore`, `close`. `ready` means the network is bound
   *and* the consumer's `restore` completed; `networkReady` is reported separately for
   observers. `whenReady` is snapshot-aware for callers that only observe.
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
   a handoff use case.
7. **Per-operation recovery policy**, `none` or `auto` with separate return and rebuild
   budgets (Call's current 60 s return, 45 s rebuild, at most three transient attempts). No
   `manual` mode: a second lifecycle driver is not worth it.
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
11. **Reservation gate migrates first.** All four consumers reserve through the service before
    any join moves, so a legacy path can never enable or disable the AP under a new owner.

## TypeScript API (engine, `mobile/modules/engine/src/services/hotspot/`)

```ts
export type HotspotConsumer = "gallery_sync" | "hotspot_ota" | "call" | "relay"

export type HotspotPhase =
  | "reserved"      // native reservation held, nothing sent to the glasses yet
  | "preparing"     // client.prepare (for example ACS agent setup over the Internet)
  | "enabling"      // BLE setHotspotState(true) sent; waiting for credentials + broadcast
  | "joining"       // native scoped join in progress
  | "verifying"     // addresses resolved; gateway probe (required or advisory)
  | "restoring"     // client.restore running for this generation
  | "ready"         // network bound and restore completed
  | "recovering"    // loss detected; quiesce → wait → rejoin → verify → restore
  | "failed"        // terminal error recorded; release still required to free ownership
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

export interface HotspotClient {
  /** Once, before the AP is enabled. Cancellable. */
  prepare?(signal: AbortSignal): Promise<void>
  /** On loss: stop work bound to this generation, keep higher-level state (ACS meeting, download ledger). */
  quiesce(binding: HotspotBinding, signal: AbortSignal): Promise<void>
  /** Initial join and every successful rejoin. `ready` is reported only after this resolves. */
  restore(binding: HotspotBinding, reason: "initial" | "rejoin", signal: AbortSignal): Promise<void>
  /** Final teardown of consumer-owned work, including partial prepare/restore. Idempotent. */
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
  /** Before every join, initial and rejoin. Gallery shows its one-time explanation here. */
  beforeJoin?: (info: {ssid: string | null; reason: "initial" | "rejoin"}, signal: AbortSignal) => Promise<void>
  /** Wait for the current owner instead of failing with busy. Re-checked with `stillWanted` before proceeding. */
  waitForOwner?: {timeoutMs: number; stillWanted: () => boolean}
  signal?: AbortSignal
}

export type HotspotState = {
  sessionId: string
  sequence: number            // monotonic; every event carries a full snapshot
  phase: HotspotPhase
  generation: number
  health: HotspotHealth
  binding?: HotspotBinding    // present only while the generation is usable
  recovery?: {attempt: number; returnDeadlineAt: number; rebuildDeadlineAt?: number}
  error?: HotspotError
}

export type HotspotEvent =
  | {type: "state"; state: HotspotState}
  | {type: "networkReady"; binding: HotspotBinding}       // before restore; for observers
  | {type: "downloadProgress"; jobId: string; bytesWritten: number; totalBytes?: number}

export type ReleaseResult =
  | {status: "released"; hotspotOff: "confirmed" | "unconfirmed"}
  | {status: "blocked"; hotspotOff: "confirmed" | "unconfirmed"; error: HotspotError}

export interface HotspotSession {
  readonly id: string
  snapshot(): HotspotState
  /** Delivers the current snapshot immediately, then ordered updates. */
  subscribe(listener: (event: HotspotEvent) => void): () => void

  /** Runs prepare → enable → join → verify → restore. Resolves with the first ready binding. */
  start(client: HotspotClient): Promise<HotspotBinding>
  /** Resolves on the next ready at or after `afterGeneration`; rejects on terminal failure. */
  whenReady(opts?: {afterGeneration?: number; signal?: AbortSignal}): Promise<HotspotBinding>

  /** Network-bound HTTP to the glasses. Rejects with stale_generation if ref is not current. */
  fetch(ref: NetworkRef, url: string, init?: RequestInit & {timeoutMs?: number}): Promise<Response>
  download(ref: NetworkRef, opts: {jobId: string; url: string; destination: string; headers?: Record<string, string>; connectionTimeoutMs?: number; readTimeoutMs?: number; signal?: AbortSignal}): Promise<{statusCode: number; bytesWritten: number}>

  /** A transport error asks the service to verify the network; it never cycles the AP directly. */
  reportSuspectedLoss(ref: NetworkRef): void

  /** Cancels start/recovery, drains the client, disables the AP with bounded retries, releases native ownership. Repeated calls share one cleanup; a blocked result is retryable. */
  release(): Promise<ReleaseResult>
}

export interface GlassesHotspotService {
  /** Rejects with busy (details.owner) unless waitForOwner is set and the owner releases in time. */
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
reserved → preparing → enabling → joining → verifying → restoring → ready
ready → recovering → (wait for glasses if AP control is needed) → joining → verifying → restoring → ready
any active phase → failed → releasing
any active phase + cancel → releasing
releasing → released | release_blocked → (retry) → released | cleanup_pending
```

Recovery on loss, in order: native invalidates the generation and notifies native borrowers;
JS aborts that generation's fetches, downloads and any running restore; `quiesce` is awaited;
the service waits for a BLE control path only if it must re-enable the AP, reusing an AP that
is still enabled; rejoin, resolve addresses, probe, then `restore` with the new generation;
on exhaustion, `close` the client and release. Duplicate loss events do not renew budgets.

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
suspend fun request(ref: NetworkRefDto, jobId: String, req: HttpRequestDto): HttpReplyDto
suspend fun download(ref: NetworkRefDto, jobId: String, req: DownloadDto): DownloadReplyDto
suspend fun cancelJob(sessionId: String, jobId: String)
suspend fun snapshot(): NativeStateDto?
// Events: networkState {sessionId, generation, state, reason?, binding?}, downloadProgress
```

```kotlin
// In-process registry for libwebrtc and ACS, exported from the SDK AAR. Versioned.
object GlassesHotspotRegistry {
  class Lease(val binding: Binding, val network: android.net.Network) : AutoCloseable
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

The cellular pin that `AcsMeetingModule` applies and temporarily lifts around listener binding
moves behind the same serialized native operation; consumers stop touching the process route.
`MentraOtaServer.start` takes the phone address from the binding instead of polling
`waitForWifiAddress`.

## Consumers

| Consumer | Sequence |
|---|---|
| Gallery sync | `acquire({consumer: "gallery_sync", uplink: "none", recovery: auto, gatewayProbe: "required", beforeJoin: explainOnce})` → `start(client)`; `restore`: fetch manifest, continue unverified files with `fetch/download(ref)`; `quiesce`: cancel transfers, keep the ledger; `close`; `release`. Requests are not replayed transparently; gallery keeps ownership of acknowledgements and integrity. The two-minute queue age guard stays because the glasses idle-disable the AP. |
| Hotspot OTA | Download artifacts over the normal network first → `acquire({consumer: "hotspot_ota", uplink: "none", recovery: auto, gatewayProbe: "required"})` → `restore` on `initial`: start `otaServer` bound to `binding.phoneIpv4`, publish the immutable manifest; `ota_start` once; on `rejoin` with a different `phoneIpv4`, throw so the restore fails explicitly and the coordinator reconciles; the ASG APK restart does not close the server or cycle the AP; `release` after the outcome is known. |
| Mentra Call | `acquire({consumer: "call", uplink: "cellular", recovery: {auto, 60 s return, 45 s rebuild, 3 attempts}, gatewayProbe: "advisory"})` → `prepare`: ACS agent; `restore` on `initial`: ACS borrows the network by `NetworkRef`, WHIP binds on `binding.phoneIpv4`, glasses are told to publish there, await a fresh frame; `quiesce`: stop local media only; `restore` on `rejoin`: rebind ingest, republish, fresh frame; `close`: leave ACS, dispose media; `release`. `SoftapCallTransport` keeps `acsJoin`, `publish`, `live` and drops `hotspot`, `scopedJoin`, `preserveMeeting`. |
| Managed relay | `acquire({consumer: "relay", ...})`; `GlassesMediaRelayModule.prepare` takes a `NetworkRef` instead of credentials and borrows from the registry. |

## Migration in small PRs

1. **Native core and registry** in the SDK, extracted from the existing lifecycle code, old
   modules untouched. Tests: reservation, generation invalidation, late callbacks, settled
   cancellation, iOS pending-configuration fencing.
2. **Shared reservation gate**: all four consumers reserve through the service before their
   joins move, so old and new owners never mix. `GlassesHotspotLease` becomes a wrapper.
3. **Engine service plus gallery sync**: state machine, budgets, structured release; gallery
   keeps its explanation, SSID-unreadable tolerance, and transfer ledger. `localNetworkTransport`
   becomes a session-bound adapter.
4. **Hotspot OTA**: server borrows the binding; `HotspotShutdown.disableHotspotWithRetry` folds
   into `release`. Hardware qualification of the intentional APK restart with the same live
   endpoint, and of a real Wi-Fi loss separately, before merge.
5. **Mentra Call and the managed relay**: native borrowing, media restoration, deletion of the
   ACS native join and of `LocalMiniappRuntime.settleSoftapTeardown`. Keep the #4074 tests and
   point them at the new seams: preserved meeting, fresh frame, cancellation at every step.
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

## Open questions

- Whether gallery's Android join explanation should also route through `beforeJoin`
  (it is shown on both platforms today).
- Whether `waitForOwner` is wanted at all in the first version, or every consumer fails fast.
