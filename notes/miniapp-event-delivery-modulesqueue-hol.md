# Miniapp event delivery freezes behind blocking Expo AsyncFunctions (OS-1714)

**Status:** root cause confirmed on device, fix design proposed, not yet implemented.
**Platforms:** Android only. iOS is not affected (see "Why iOS is fine").
**Ticket:** OS-1714 (sub-issue of OS-1687). Related: OS-1701, OS-1712, the BGCAP
"captions fall behind then flood in waves" investigation in
`mobile/modules/engine/src/services/LocalMiniappRuntime.ts`.

## Symptom

While a `camera.takePhoto()` request is in flight, ALL pushed events
(transcription, request results, everything delivered into a miniapp's
background JS context) stop arriving for the exact lifetime of the capture,
then flush in a single FIFO burst the moment the photo response lands. No
data is lost; delivery is delayed by the full capture duration (about 4s for
a warm WiFi-direct capture, tens of seconds for a BLE-fallback transfer, and
up to the native 15s request timeout when the glasses never respond).

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
is just the most frequent and longest-running offender.

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
- Live captions freezing during any visual query (worst case: BLE-fallback
  photo transfers, which take tens of seconds).
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
