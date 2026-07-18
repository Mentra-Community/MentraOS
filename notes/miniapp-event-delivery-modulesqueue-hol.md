# Miniapp event delivery freezes behind blocking Expo AsyncFunctions (OS-1714)

**Status:** root cause confirmed on device; Android fix implemented in PR #3474
and verified on device 2026-07-17 (transcripts flowed through a live photo
window, 20 events, max gap 657ms, no burst).
**Platforms:** Android only. iOS is not affected (see "Why iOS is fine").
**Ticket:** OS-1714 (sub-issue of OS-1687). Related: OS-1701, OS-1712, the BGCAP
"captions fall behind then flood in waves" investigation in
`mobile/modules/engine/src/services/LocalMiniappRuntime.ts`.

## Symptom

While a `camera.takePhoto()` request is in flight, ALL pushed events
(transcription, request results, everything delivered into a miniapp's
background JS context) stop arriving for the exact lifetime of the capture,
then flush in a single FIFO burst the moment the photo response lands. No
data is lost; delivery is delayed by the full duration of whatever blocking
call is in flight. For photo capture that is about 4s for a warm WiFi-direct
capture, bounded by the 15s default request timeout when the glasses never
respond (BLE-fallback transfers finish under that bound or time out at it).
Other blocking calls wait far longer: WiFi scan 20s, stream start 30s, and
`stopVideoRecording()` with webhook upload up to 10 minutes
(`VIDEO_UPLOAD_STOP_TIMEOUT_MS`), so the worst-case app-wide delivery freeze
is 10 minutes, not 15s.

## On-device proof (2026-07-16, Pixel 8 + Mentra Live, dev build)

Continuous laptop TTS gave transcript events a steady, known cadence; a
visual query fired a real capture mid-stream; `adb logcat` captured every
layer at once. Full capture attached to OS-1714. Per-second event counts
around the photo window (16:33:41 request sent, 16:33:45 photo_response):

| layer | evidence | during the window |
|---|---|---|
| glasses mic over BLE | `MentraBleTrace layer=sdk_event_dispatch type=mic_lc` | steady 20 pkts/s, zero interruption |
| RN JS thread, cloud receive | `LocalMiniappRuntime: transcript cloud_recv` | steady ~5/s |
| RN JS thread, miniapp fan-out | `LocalMiniappRuntime: transcript fanout` | steady ~15/s, **kept flowing** |
| delivery into miniapp QuickJS | miniapp `[TRANSCRIPT]` console lines | **zero for 16:33:42 to :44**, 50-line burst at :45 |

So the freeze sits strictly between `LocalMiniappRuntime.sendToMiniapp()`
(which ran on time) and the QuickJS `__deliver` execution (which ran 4s
late, in order). The only components in between are
`Crust.mentraJsDispatchToJs` (an Expo `AsyncFunction`) and the per-context
QuickJS executor.

## Root cause

Expo modules on Android run every plain (non-suspend) `AsyncFunction` body
of EVERY module in the app on one shared single-threaded queue:

- `expo-modules-core/android/.../AppContext.kt`: `modulesQueue` is a
  `CoroutineScope` over a single `HandlerThread("expo.modules.AsyncFunctionQueue")`.

Two of our functions collide on that thread:

1. `BluetoothSdkModule.kt` (`SdkAsyncFunction("requestPhoto")`, line ~555)
   calls `MentraBluetoothSdk.requestPhoto()`, which parks the calling thread
   on a `CountDownLatch` (`PendingResponse.await()`,
   `MentraBluetoothSdk.kt:162`) until the glasses send the terminal
   `photo_response`, with `DEFAULT_REQUEST_TIMEOUT_MS = 15_000`.

2. `CrustModule.kt` (`AsyncFunction("mentraJsDispatchToJs")`, line ~220) is
   the ONLY path that pushes envelopes (events, request results) into a
   miniapp background JS context.

While (1) holds the thread, every (2) call queues behind it. When the latch
releases, the queue drains in order: exactly the observed gap + burst.

`MentraBluetoothSdk.kt` has **17 blocking `PendingResponse.await(...)` sites
across 16 functions** (lines 468, 659, 665, 701, 724, 747, 773, 797, 816,
845, 872, 895, 926, 958, 977, 1042, 1071 as of `origin/dev` e8f7e7936):
settings commands, WiFi scan/connect/forget, hotspot, photo, camera warm-up,
gallery status, stream start/stop, RGB LED, video recording start/stop,
version info, and the OTA query/start pair. (An earlier revision of this doc
listed only the 12 zero-arg `pending.await()` sites; the `await(timeoutMs)`
variants in `requestWifiScan`, `startStream`, `stopStream`, and
`stopVideoRecording` block the same thread and are in scope.) Any of them
freezes all miniapp event delivery app-wide for its duration. Photo capture
is the most frequent offender; the longest-running are `stopVideoRecording`
with upload (10 minutes), stream start (30s), and WiFi scan (20s), all well
past photo's 15s default timeout.

### Why iOS is fine

`BluetoothSdkModule.swift` uses `try await sdk.requestPhoto(req)`: Swift
concurrency suspends the task without holding a thread, so other async
functions keep executing. Only the Kotlin side blocks a real thread.

### What this explains

- The OS-1701 family: an in-flight capture delaying an unrelated
  `location.getOnce()`. The LOCATION_POLL result is delivered back to the
  miniapp through `mentraJsDispatchToJs`, i.e. through the blocked queue.
  The merged OS-1701 fixes (SDK `timeoutMs` + the miniapp's 1.2s bound on
  speculative captures) settle the JS promise early, but the NATIVE latch
  keeps blocking the queue until photo_response or the 15s native timeout,
  so event delivery still freezes for the capture's full duration.
- Live captions freezing during any visual query (worst case: a BLE-fallback
  photo capture approaches the 15s native request timeout before failing).
- Plausibly part of the BGCAP "captions flood in waves" reports whenever a
  capture or another blocking SDK call overlaps captioning (distinct from
  the OS-level background-throttle hypothesis BGCAP was instrumented for,
  and distinct from OS-1712's dead-stream wedge, which has no burst
  recovery).

## Fix design (Android, `mobile/modules/bluetooth-sdk`)

Goal: no Expo AsyncFunction body may block the shared queue thread.
Preferred shape, keeping the public JS API identical:

1. **Make `PendingResponse` suspendable.** Replace `CountDownLatch` with
   `CompletableDeferred<T>`:
   - `resolve(value)` -> `deferred.complete(value)`
   - `reject(error)` -> `deferred.completeExceptionally(error)`
   - `suspend fun await(timeoutMs: Long)` ->
     `withTimeoutOrNull(timeoutMs) { deferred.await() } ?: throw BluetoothSdkException("request_timeout", ...)`
   Callers that resolve from BLE listener threads are unchanged
   (`complete*` is thread-safe).

2. **Convert the blocking SDK entry points to `suspend fun`** (all 17
   `pending.await()` call sites listed above). Kotlin will force the
   transitive callers in `BluetoothSdkModule.kt` to adapt, which is the
   audit mechanism.

3. **Switch the module bindings to coroutine AsyncFunctions.** Expo's Kotlin
   API: `AsyncFunction("requestPhoto") Coroutine { params: Map<String, Any?> -> ... }`.
   Coroutine bodies are launched on the same modulesQueue scope but SUSPEND
   at the deferred await instead of holding the thread, so
   `mentraJsDispatchToJs` (and every other module) keeps flowing. Extend the
   local `SdkAsyncFunction` helpers with suspending variants so
   `withExpoSdkError` wrapping is preserved.

4. **Guardrail:** add a lint/grep CI check (or at minimum a comment ban) for
   `latch.await(`/`.get()`/`Thread.sleep(` inside `AsyncFunction` bodies in
   `mobile/modules/*/android`, so the queue cannot silently regain blockers.
   `Crust.mentraJsDispatchToJs` itself is already non-blocking (it submits
   to the per-context executor and returns); it is the victim here, not the
   culprit.

### Concurrency after the conversion

The blocked single-threaded queue used to serialize every SDK call as a side
effect. Once the entry points suspend, calls from different callers can
genuinely overlap and reach the glasses concurrently. That is intentional,
not a race to guard against on the phone:

- The glasses firmware owns a photo request queue and decides wait vs
  camera_busy itself (Philippe's review on PR #3474). The SDK must NOT add
  client-side serialization (no camera mutex) on top of that; it would
  re-implement firmware policy at the wrong layer.
- Request ids are assumed unique at the SDK interface (they are mostly
  timestamp-derived). That assumption is accepted to keep complexity in
  check, so the SDK does not add duplicate-id rejection either. (An earlier
  revision of PR #3474 added both guards in response to bot review; both
  were reverted per the above.)
- `startStream` is last-request-wins on the glasses: every new start stops the
  previous stream. Pending starts carry a sequence assigned in the same
  critical section as the BLE hand-off, so an id-bearing status for a newer
  start proves every earlier pending start was preempted. Those earlier
  callers now reject immediately with `stream_preempted` instead of waiting
  for the 30s timeout; the newest start resolves through its echoed stream id.

Suspending awaits are also cancellation-aware where the old latch waits were
not, which surfaced two rules (both applied in PR #3474):

- Broad `catch (Throwable)` fallbacks must rethrow `CancellationException`,
  or a cancelled caller can continue into side effects (the OTA start path
  did exactly this).
- A pending that multiple callers join (WiFi scan) must not be rejected by
  one waiter's cancellation; cancellation detaches only that waiter, and
  the last waiter out clears the shared entry.

### Public Android SDK impact

`MentraBluetoothSdk` ships as the published Maven artifact
`com.mentraglass:bluetooth-sdk`. Converting the entry points to
`suspend fun` keeps the public JS API identical, but for native Android
consumers it is a source- and binary-incompatible change for Kotlin callers
and removes the Java-callable signatures (a suspend method exposes only a
Continuation-shaped JVM signature). Shipping this requires a major version
bump of the artifact plus a migration note, and the Android examples in
`mintlify-docs/` (quickstart, mentra-live/android, camera-streaming) must be
updated to call these methods from a coroutine scope. That docs/migration
work is tracked as a follow-up to PR #3474 and is not part of this doc's
scope beyond flagging it.

Verification plan (same rig as the OS-1714 evidence): continuous TTS
markers, fire a visual query, confirm the miniapp `[TRANSCRIPT]` console
cadence stays continuous through the photo window with no burst, on both a
WiFi-direct and a forced-BLE (`transferMethod: "ble"`) capture.

## Repro recipe

1. Mentra-AI-Miniapp `bun run dev:localhost` (`MENTRA_AUTH_JWKS_URL=""` so
   the multi-env JWKS fallback verifies the token) + `adb reverse tcp:3131
   tcp:3131`, connect the phone via Miniapp Developer Settings.
2. Loop `say "test marker number $i, the quick brown fox jumps over the
   lazy dog"` near the glasses.
3. Submit a visual query ("What do you see in front of me") via the chat
   text input.
4. Compare per-second counts: `LocalMiniappRuntime: transcript fanout` in
   logcat (stays steady) vs the miniapp's own `[TRANSCRIPT]` console lines
   (gap + burst bracketing the `photo_response`).
