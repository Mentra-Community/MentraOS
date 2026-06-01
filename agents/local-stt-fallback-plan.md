# Local STT Fallback — Execution Plan

## Goal

When a local miniapp subscribes to `transcription:*` and the cloud stops returning transcripts (network flap, provider outage, STT quota), automatically switch to on-device Sherpa-ONNX STT. When cloud recovers, switch back. Local-only, phone-side; no cloud changes.

## Constraints

- **Transcription only**, no translation.
- **No cloud code changes.** All logic lives on the phone.
- **Prioritize cloud.** Local runs only as fallback; when cloud returns a transcript, local stops.
- **Language gated on model availability.** Only fall back if the user has a matching language pack downloaded AND the subscription language matches it. If not, just fail (same as today).
- **iOS and Android identical wiring.** Same control surface, same native entry points.
- **Feature-flag kill switch.** Gated behind `SETTINGS.local_stt_fallback_enabled` (default `false`). When `false`, coordinator is inert — no Sherpa start, no state transitions beyond `IDLE`. Flag is checked on every state-transition entry point so flipping it off mid-session cleanly tears down any active `LOCAL` state.

## Current State (what already works)

- Both platforms have a working `SherpaOnnxTranscriber` (iOS Swift, Android Kotlin, ported 1:1).
- Both emit partial/final results via `Bridge.sendLocalTranscription(...)` → arrives at `MantleManager.handle_local_transcription`.
- Both gate PCM input: Android `SherpaOnnxTranscriber.kt:232-245` drops audio unless `running.get()` is true. iOS has equivalent.
- `STTModelManager.isModelAvailable()` already reports whether files exist on disk.
- `MicStateCoordinator` exists and unions cloud + local mic requirements.
- `LocalMiniappRuntime.forwardEvent(streamType, data)` fans streams out to subscribed miniapps.
- `LocalMiniappRuntime.updateCloudSubscriptions()` sends `PHONE_SUBSCRIPTION_UPDATE` to cloud.

## Current Gap

Today when a miniapp subscribes to `transcription:en-US`, `updateCloudSubscriptions()` tells cloud to pipe transcripts down. If cloud dies, the miniapp gets nothing — Sherpa may technically be initialized but isn't being fed PCM and isn't routed to miniapps (its output is uploaded back to cloud via `socketComms.sendLocalTranscription`).

---

## Design

### The fallback state machine

One class, TS-only: `LocalSttFallbackCoordinator` (singleton). Lives in `src/services/`.

States:

- `IDLE` — no miniapp wants transcription. Everything off.
- `CLOUD` — miniapps subscribed, cloud is healthy, transcripts arriving. Sherpa not running.
- `WAITING_FOR_CLOUD` — subscribed, speech detected, no cloud transcript yet. Sherpa not running. Watchdog timer armed.
- `LOCAL` — cloud timed out, Sherpa running, local output fanning out to miniapps. Separate timer watches for cloud recovery.

Transitions:

| From | Event | To |
|---|---|---|
| `IDLE` | any `transcription:*` subscription appears | `CLOUD` |
| `CLOUD` | VAD `isSpeaking=true` | `WAITING_FOR_CLOUD` (arm `cloudTimeoutMs` timer) |
| `WAITING_FOR_CLOUD` | cloud transcript arrives | `CLOUD` (cancel timer) |
| `WAITING_FOR_CLOUD` | VAD `isSpeaking=false` before timeout | `CLOUD` (cancel timer) |
| `WAITING_FOR_CLOUD` | timer fires + model available for language | `LOCAL` (call `startSherpa`) |
| `WAITING_FOR_CLOUD` | timer fires + no model | `CLOUD` (stay — same as today's failure mode) |
| `LOCAL` | cloud transcript arrives | `CLOUD` (call `stopSherpa` immediately) |
| `LOCAL` | all `transcription:*` subscriptions drop | `IDLE` |
| `CLOUD`/`WAITING`/`LOCAL` | all `transcription:*` subscriptions drop | `IDLE` |

Key constants (defaults, configurable via settings later):

- `cloudTimeoutMs`: 3000ms — if user is speaking and no cloud transcript in 3s, fall back.
- `recoveryGraceMs`: 500ms — when cloud transcript arrives during `LOCAL`, wait this long before fully stopping Sherpa (smooths race at transition).

### Why VAD-gated?

Without VAD, the watchdog would trip on silence (cloud doesn't emit transcripts when nobody's talking, and we'd wrongly conclude it's broken). VAD already flows on every platform and is already a mic-requiring stream — free signal.

### Language gating

On entering `WAITING_FOR_CLOUD`, extract language from the active subscription (`transcription:en-US` → `en-US`). Ask `STTModelManager`:

```ts
const desired = this.extractLanguage(subscription)           // "en-US"
const currentModel = STTModelManager.getCurrentModelId()
const currentLang = STTModelManager.getLanguageForModel(currentModel)  // "en-US"
const available = await STTModelManager.isModelAvailable(currentModel)
const canFallback = available && currentLang === desired
```

If `canFallback === false`: coordinator stays in `WAITING_FOR_CLOUD` forever (or re-arms on next VAD pulse). No fallback. This matches the stated requirement: "only if a language pack is selected and matches."

### Native control surface (add to `CoreModule`)

Two new methods, symmetric iOS/Android, exposed to TS:

```ts
CoreModule.startLocalStt()   // → native: transcriber?.start()
CoreModule.stopLocalStt()    // → native: transcriber?.stop()
```

Internally each platform:

- Flips `running.get()` / equivalent to true and drains the PCM queue when started.
- Flips to false and clears the stream when stopped.
- PCM continues to flow through the mic path regardless — the feed gate is native-side.

The existing `transcriber?.initialize()` stays in `init` (heavy, ~hundreds of ms). `start()` is just the `running` flag plus queue activation — cheap.

### Local output routing

Change `MantleManager.handle_local_transcription(data)` at `MantleManager.ts:871`:

```ts
public async handle_local_transcription(data: any) {
  // Legacy: offline_captions_running setting displays locally
  const offlineStt = await useSettingsStore.getState().getSetting(SETTINGS.offline_captions_running.key)
  if (offlineStt) { /* unchanged */ return }

  // NEW: if fallback coordinator is in LOCAL state, route to local miniapps
  if (localSttFallbackCoordinator.isActive()) {
    const streamType = `transcription:${data.transcribeLanguage || "en-US"}`
    localMiniappRuntime.forwardEvent(streamType, data)
    return
  }

  // Otherwise legacy behavior: upload to cloud
  socketComms.sendLocalTranscription(data)
}
```

The data shape from Sherpa is already compatible (`text`, `isFinal`, `startTime`, `endTime`, `speakerId`, `transcribeLanguage`, `provider: "sherpa-onnx"`). Miniapps receive the same envelope they'd get from cloud.

### Cloud recovery detection

Hook into the one place cloud transcripts already arrive: `SocketComms.ts:818`'s `data_stream` case. Before forwarding, tap the coordinator:

```ts
case "data_stream": {
  const streamType = msg.streamType
  if (streamType.startsWith("transcription:")) {
    localSttFallbackCoordinator.onCloudTranscript()
  }
  localMiniappRuntime.forwardEvent(streamType, msg.data)
  break
}
```

`onCloudTranscript()` resets the watchdog and, if currently `LOCAL`, transitions back to `CLOUD` (after `recoveryGraceMs`).

### VAD signal wiring

`MantleManager.ts:478` already has the VAD listener. Add one line:

```ts
CoreModule.addListener("vad", (event) => {
  localMiniappRuntime.forwardEvent('VAD', event)
  localSttFallbackCoordinator.onVad(event.isSpeaking)   // NEW
})
```

### Subscription lifecycle

Hook `LocalMiniappRuntime.updateCloudSubscriptions()` (line 1127) — already runs every time a miniapp subscribes/unsubscribes:

```ts
private updateCloudSubscriptions(): void {
  const cloudStreams = new Set<string>()
  let hasTranscription = false
  let activeTranscriptionLang: string | null = null
  for (const [stream, subscribers] of this.streamSubscribers) {
    if (subscribers.size === 0) continue
    if (stream.startsWith("transcription:") || stream.startsWith("translation:") || stream === "location_update") {
      cloudStreams.add(stream)
    }
    if (stream.startsWith("transcription:") && subscribers.size > 0) {
      hasTranscription = true
      activeTranscriptionLang = stream.substring("transcription:".length)
    }
  }
  socketComms.updatePhoneSubscriptions(Array.from(cloudStreams))
  localSttFallbackCoordinator.onSubscriptionChange(hasTranscription, activeTranscriptionLang)
}
```

The coordinator starts watching when first `transcription:*` subscription exists, stops completely when none remain.

---

## File-by-file changes

### NEW: `mobile/src/services/LocalSttFallbackCoordinator.ts`

The state machine. ~200 lines. Pure TS, no native.

Exports a singleton. Public API:

- `onSubscriptionChange(active: boolean, language: string | null)` — called by `LocalMiniappRuntime.updateCloudSubscriptions`.
- `onVad(isSpeaking: boolean)` — called by `MantleManager` VAD listener.
- `onCloudTranscript()` — called by `SocketComms.data_stream` handler when `streamType.startsWith("transcription:")`.
- `isActive(): boolean` — true when in `LOCAL`; consumed by `MantleManager.handle_local_transcription`.

Internal:

- State machine per the table above.
- **Feature-flag gate**: every public entry point first reads `useSettingsStore.getState().getSetting(SETTINGS.local_stt_fallback_enabled.key)`. If `false`: force state to `IDLE`, call `stopSherpa()` if currently `LOCAL`, cancel timers, return. A `useSettingsStore.subscribe` listener also watches the flag — when flipped off mid-session, immediately tears down.
- Two timers: `cloudTimeoutTimer` (cloud-to-local), `recoveryGraceTimer` (local-to-cloud).
- Model-availability check (async, cached per-model for ~5s to avoid filesystem hammering).
- Logging at every transition (`[LocalSttFallback] CLOUD → WAITING_FOR_CLOUD (vad start)`).

### `mobile/src/services/MantleManager.ts`

**Line ~478** — add coordinator call inside VAD listener.
**Line ~871 (`handle_local_transcription`)** — route to `LocalMiniappRuntime.forwardEvent` when coordinator is active, else existing behavior.

### `mobile/src/services/SocketComms.ts`

**Line ~818 (`data_stream` case)** — call `localSttFallbackCoordinator.onCloudTranscript()` when streamType is transcription.

### `mobile/src/services/LocalMiniappRuntime.ts`

**Line ~1127 (`updateCloudSubscriptions`)** — compute and pass `(hasTranscription, activeLanguage)` to coordinator.

### `mobile/modules/core/android/src/main/java/com/mentra/core/CoreModule.kt`

Add two exposed functions:

```kotlin
AsyncFunction("startLocalStt") { coreManager?.startLocalStt() }
AsyncFunction("stopLocalStt") { coreManager?.stopLocalStt() }
```

### `mobile/modules/core/android/src/main/java/com/mentra/core/CoreManager.kt`

Add:

```kotlin
fun startLocalStt() {
  transcriber?.start()
}
fun stopLocalStt() {
  transcriber?.stop()
}
```

### `mobile/modules/core/android/src/main/java/com/mentra/core/stt/SherpaOnnxTranscriber.kt`

Verify `start()` / `stop()` exist (they should — `running: AtomicBoolean` at line 46 and worker thread lifecycle at line 248-255). If not, add them:

- `start()`: `running.set(true)`, reset `stream` state.
- `stop()`: `running.set(false)`, drain `pcmQueue`, call `stream?.reset()`.

The existing `restartTranscriber()` (line 422) shows the pattern.

### `mobile/modules/core/ios/Source/CoreModule.swift` (or equivalent module file)

Add matching `startLocalStt` / `stopLocalStt` functions.

### `mobile/modules/core/ios/Source/CoreManager.swift`

Add:

```swift
func startLocalStt() { transcriber?.start() }
func stopLocalStt() { transcriber?.stop() }
```

### `mobile/modules/core/ios/Source/stt/SherpaOnnxTranscriber.swift`

Same as Android: verify `start()`/`stop()` exist, add if not.

### `mobile/src/services/STTModelManager.ts`

One additive helper if it doesn't exist:

```ts
getLanguageForModel(modelId: string): string {
  return this.models[modelId]?.languageCode ?? "en-US"
}
```

(The `languageCode` field is already on `ModelConfig` at line 35.)

### `mobile/src/stores/settings.ts`

Add one `SETTINGS` entry alongside the other offline-stt settings (near line 453):

```ts
local_stt_fallback_enabled: {
  key: "local_stt_fallback_enabled",
  defaultValue: () => false,
  writable: true,
  saveOnServer: true,
  persist: true,
},
```

Then add `SETTINGS.local_stt_fallback_enabled.key` to the `CORE_SETTINGS_KEYS` array at line 556 so it syncs to native.

**Default is `false`** — ships off. Flipped on via developer settings UI or remote config once validated.

### `mobile/src/app/miniapps/settings/developer.tsx` (or similar)

Add a toggle under the dev menu:

```tsx
<ToggleRow
  label="Local STT Fallback"
  subtitle="Use on-device Sherpa-ONNX when cloud transcription fails"
  settingKey={SETTINGS.local_stt_fallback_enabled.key}
/>
```

Also consider remote config: the setting already has `saveOnServer: true`, so it can be flipped server-side via the existing settings sync without a new flag infrastructure.

---

## Test plan

### Unit tests (`mobile/test/services/LocalSttFallbackCoordinator.test.ts`)

- Subscription appears → state becomes `CLOUD`.
- Subscription gone → state becomes `IDLE`, Sherpa stopped.
- VAD start → `WAITING_FOR_CLOUD`; cloud transcript within window → back to `CLOUD`.
- VAD start → `WAITING_FOR_CLOUD`; VAD stop → back to `CLOUD` (no fallback).
- VAD start, timer fires, model available → `LOCAL`, `startLocalStt` called.
- VAD start, timer fires, model NOT available → stays `WAITING_FOR_CLOUD`, no `startLocalStt` call.
- In `LOCAL`, cloud transcript arrives → after `recoveryGraceMs`, `stopLocalStt` called, state `CLOUD`.
- Language mismatch: `transcription:zh-CN` subscribed, only `en-US` model downloaded → no fallback.
- Rapid VAD bounces (on/off/on within 100ms) don't thrash the state.
- **Flag off (default)**: no state transitions, `startLocalStt` never called regardless of inputs.
- **Flag flipped off mid-`LOCAL`**: immediately calls `stopLocalStt`, state drops to `IDLE`, timers cancelled.
- **Flag flipped on with active subscription**: state moves to `CLOUD`, ready to arm on next VAD.

Mock `CoreModule.startLocalStt`/`stopLocalStt`, `STTModelManager.isModelAvailable`, and `useSettingsStore.getState().getSetting`.

### Integration (manual)

- Connect glasses, subscribe a local miniapp to `transcription:en-US`.
- Speak — confirm cloud transcripts arrive and display.
- Kill cloud WS (airplane mode, or kill the cloud dev server).
- Speak — after ~3s, confirm Sherpa transcripts arrive in the miniapp.
- Restore cloud.
- Speak — confirm transcripts return to cloud (check `provider` field: should flip from `"sherpa-onnx"` back to `"azure"`/`"soniox"`).
- Verify Sherpa stops (no CPU burn, no duplicate transcripts).

### Platform parity

Run the same integration flow on iOS and Android. Diff the log output of the coordinator between platforms — state transitions should be identical.

### Edge cases to exercise

- Miniapp subscribed to `transcription:en-US` but user has only `transcription:fr-FR` model → no fallback, verify log message.
- User has no STT model at all → no fallback.
- Two miniapps subscribed to different languages (`en-US`, `es-ES`); only one language pack → only the matching one falls back. (V1 decision: coordinator only supports one active language at a time — if there's a mismatch, pick the model's language and the other miniapp just doesn't get local fallback.)
- Rapid cloud flap (recovery → outage → recovery within 1s) — coordinator shouldn't rapidly toggle Sherpa. Add a minimum `LOCAL` dwell time (e.g., 2s) before re-entering `CLOUD`.

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Dual transcription at recovery (both cloud and local fire for the same utterance) | `recoveryGraceMs` delay before stopping Sherpa; miniapps will see one cloud + one local final with same timestamps. Acceptable — document in SDK. |
| Sherpa warmup latency on first `start()` | Coordinator calls `start()` immediately on entering `LOCAL`; model is already initialized at boot so startup is ~50ms. |
| Cloud health check false positives (e.g., user is silent but we think cloud is broken) | VAD gating solves this — watchdog only arms when user is actually speaking. |
| Miniapp gets dupes if it's also subscribed to other audio streams | Not a concern — the coordinator only routes `transcription:*` to local, all other streams (audio_chunk, vad) continue from their existing sources. |
| User switches language mid-conversation | `updateCloudSubscriptions` fires on every subscription change; coordinator re-evaluates model availability. No special handling needed. |
| iOS vs Android timing differences (VAD latency, mic enablement) | Same coordinator logic, same thresholds; tune `cloudTimeoutMs` if one platform consistently trips faster. |
| Sherpa transcripts degrade quality silently (miniapp doesn't know it's getting local output) | Include `provider: "sherpa-onnx"` in the data (already there); SDK docs mention miniapps can check this if they want to display a "degraded" badge. |

---

## Estimated effort

- Coordinator + unit tests: **1 day**
- Native `start/stop` exposure on both platforms (verify existing methods, add missing): **0.5 day**
- Integration into `MantleManager`, `SocketComms`, `LocalMiniappRuntime`: **0.5 day**
- Integration testing on iOS + Android + edge cases: **1-2 days**

**Total: 3-4 days** for one engineer. No cloud changes, no new protocols, no new native code (just ~20 lines each to expose existing `running` flag).

---

## Out of scope (explicitly deferred)

- Translation fallback (no local model).
- Multi-language simultaneous fallback (pick one, documented).
- User-facing UI to surface "fallback active" state (log-only for V1).
- Proactive cloud health check (poll-based) — we rely on transcript-arrival watchdog only.
- Adjusting `cloudTimeoutMs` per network condition.
- Persisting fallback statistics / telemetry.
