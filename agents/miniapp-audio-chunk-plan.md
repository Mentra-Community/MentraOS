# Plan: deliver glasses PCM audio to local miniapps (`session.mic.onAudioChunk`)

## Problem (verified)

`session.mic.onAudioChunk(...)` in the local-miniapp SDK subscribes to the
`audio_chunk` stream, but no code on the phone ever produces that stream, so the
handler is silent. `session.mic.onVoiceActivity` (`vad`) is in the same state.
Transcription works because its audio path is entirely separate (see below).

## How the audio pipeline actually works (verified, file:line)

Glasses send **LC3 over BLE**. The native BT SDK decodes it to PCM **once** and
forks the PCM three ways:

- `mobile/modules/bluetooth-sdk/{ios/Source/DeviceManager.swift, android/.../DeviceManager.kt}`
  - `handleGlassesMicData` → `lc3Converter.decode(...)` → `handlePcm(pcm)`
  - `handlePcm` →
    1. `handleSendingPcm(pcm)`:
       - `if (shouldSendPcm) Bridge.sendMicPcm(pcm)` → JS `"mic_pcm"` event
       - `if (shouldSendLc3) convertAndSendMicLc3(pcm)` → JS `"mic_lc3"` event
       - **independent `if`s — both fire in the same frame**
    2. `if (shouldSendTranscript || offlineCaptionsRunning || localSttFallbackActive) transcriber.acceptAudio(pcm)`
       — **on-device Sherpa STT is fed PCM natively, never via JS.**
  - `setMicState`: `willSendPcm = shouldSendPcm || shouldSendLc3` — PCM is decoded
    whenever LC3 is wanted anyway. **iOS and Android are verified identical.**

Three consumers, three fates:

| Consumer | Format | Path | Status |
| --- | --- | --- | --- |
| Cloud transcription | LC3 | `mic_lc3` → `MantleManager` (~ln 976) → `socketComms.sendBinary`/`udp` | ✅ wired |
| On-device Sherpa STT | PCM | fed **natively** in Swift/Kotlin (`transcriber.acceptAudio`) | ✅ wired (this is why transcripts work) |
| Miniapp `audio_chunk` | PCM | `mic_pcm` → `MantleManager` (~ln 998) → **dead end** | ❌ **the gap** |

So **"make the BT SDK send both PCM and LC3" is already done at the native
layer.** No native change is needed. The only missing piece is a JS forwarding
hop.

### The gap, exactly

`mobile/src/services/MantleManager.ts` ~ln 997–1013: the `mic_pcm` listener body
does nothing with the audio — it doesn't even read the `event` arg
(`addListener("mic_pcm", () => {...})`). It only pokes a debug flag. Its comment
*claims* "local miniapps consume raw PCM via the audio_chunk listener" — that
wiring was never built.

There's also a commented-out block at ~ln 927–931 that listened for a
BluetoothSdk `"audio_chunk"` event — **but no such native event exists** (the
native events are `mic_pcm` / `mic_lc3`). That was an incorrect first attempt
against a phantom event, **not** something disabled for a perf/correctness
reason. Same applies to the commented `"vad"` block at ~ln 920–925.

## Key facts that make this safe & cheap (verified)

- **Subscriber-gated.** `LocalMiniappRuntime.forwardEvent` (~ln 1902) returns
  early if `matchedSubs.size === 0`. PCM is only delivered to apps that
  subscribed to `audio_chunk`. No subscribers → the `mic_pcm` forward is a
  near-no-op.
- **Mic requirement auto-toggles.** `recomputeMicRequirements` (~ln 1852) sets
  `pcm: true` when any app subscribes to `audio_chunk`, `false` when all
  unsubscribe → `MicStateCoordinator.applyUnion` → `setMicRequirements` hook →
  `BluetoothSdk.updateBluetoothSettings({should_send_pcm})`. The native flag is
  already correctly driven; nothing to add there.
- **No double work.** PCM is already decoded for LC3+Sherpa; emitting `mic_pcm`
  is "also hand over the bytes we already have." LC3 re-encode for cloud is
  independent and unaffected. Cloud still gets LC3 only.
- **`Buffer` is available** in this RN context (used in `UdpManager.ts`,
  `UdpCrypto.ts`) → use `Buffer.from(...).toString("base64")`, NOT
  `btoa(String.fromCharCode.apply(...))` (stack-unsafe on large buffers).

## Payload contract (verified)

SDK side, `mobile/modules/miniapp/src/modules/events.ts`:

```ts
export interface AudioChunkData {
  /** PCM or LC3, base64-encoded. */
  data: string
  sampleRate?: number
  format?: string
}
```

Native `mic_pcm` event (`bluetooth-sdk/src/BluetoothSdk.types.ts`):
`{ pcm: ArrayBuffer, sampleRate: 16000, bitsPerSample: 16, channels: 1, encoding: "pcm_s16le", voiceActivityDetectionEnabled }`.

**`ArrayBuffer` does NOT survive `JSON.stringify`** (the bridge serializes via
`serializeEnvelope` = `JSON.stringify`, `miniapp/src/envelope.ts:18`) → must
base64-encode before `forwardEvent`.

## Frequency / backpressure (the one real risk)

- 16 kHz mono PCM16. Frame cadence ~10 ms → **~100 events/sec**, ~3.2 KB/event
  raw (~4.3 KB base64). Per subscriber ≈ **~430 KB/s across the RN bridge**, each
  event JSON+base64 then `injectJavaScript`-eval'd into the JSContext.
- `forwardEvent` has **no throttling/batching**. This is the part to watch — at
  100 evals/sec into the JSContext it could become a CPU/GC hotspot, especially
  with the display/transcription traffic already flowing.

## Implementation

### Step 1 — Forward `mic_pcm` to miniapps (the core change)

`mobile/src/services/MantleManager.ts`, the `mic_pcm` listener (~ln 998).
Keep the existing debug-timeout logic; add forwarding:

```ts
BluetoothSdk.addListener("mic_pcm", (event: MicPcmEvent) => {
  // ...existing micDataTimeout / debug-flag logic unchanged...

  const data = Buffer.from(event.pcm).toString("base64")
  localMiniappRuntime.forwardEvent("audio_chunk", {
    data,
    sampleRate: event.sampleRate,
    format: event.encoding, // "pcm_s16le"
  })
})
```

- Stream name is `"audio_chunk"` (matches `MiniappStreamType.AUDIO_CHUNK`;
  `normalizeStreamType` leaves it unchanged).
- `localMiniappRuntime` is already imported in MantleManager (`@mentra/engine`,
  ~ln 33) and used for other `forwardEvent` calls (button_press, head_up, …) —
  this follows the established template exactly.
- Delete the stale commented `"audio_chunk"` block (~ln 927–931) to avoid
  confusion.

### Step 2 — (decide) throttle/batch to bound bridge cost

Given ~100 evals/sec/subscriber, pick one before shipping:

- **Ship as-is first, measure.** Subscriber-gated, so zero cost unless a miniapp
  opens the mic tester. Acceptable for the SDK-tester use case; revisit if a
  real always-on audio miniapp appears.
- **Batch N frames** (e.g. coalesce ~50–100 ms of PCM per `audio_chunk`) in the
  `mic_pcm` listener before forwarding → ~10–20 events/sec. Changes the chunk
  size the SDK delivers; `AudioChunkData` already carries `sampleRate`/`format`
  so consumers can handle larger chunks. **Recommended** if we expect real audio
  apps.

Recommendation: implement Step 1, **ship behind the natural subscriber gate**,
add a `// PERF:` note about batching, and only build batching when a non-tester
audio consumer lands.

### Step 3 — (optional, same shape) wire `vad`

If we want `session.mic.onVoiceActivity` live too: confirm a native `"vad"`
event is actually emitted (the commented block at ~ln 920 assumed one — verify
`Bridge`/module emits `"vad"`), then:
`BluetoothSdk.addListener("vad", (e) => localMiniappRuntime.forwardEvent("VAD", e))`
(`normalizeStreamType` maps `"VAD"` → `vad`). Out of scope unless requested.

### Step 4 — verify

- Unit: extend `LocalMiniappRuntime` tests — subscribing to `audio_chunk` sets
  `pcm` requirement; `forwardEvent("audio_chunk", …)` reaches only subscribers;
  no subscriber → no-op.
- Manual: open example miniapp → SDK Tester → `session.mic` page; confirm
  `.onAudioChunk` rows update; confirm transcription still works simultaneously
  (LC3 to cloud unaffected); confirm `should_send_pcm` flips true on subscribe
  and false on unsubscribe.
- Watch CPU/JSContext while audio flows (Step 2 trigger).

## What NOT to do

- Don't touch the native BT SDK — it already emits both PCM and LC3.
- Don't change the cloud path — cloud stays LC3-only.
- Don't route PCM through the Sherpa path — that's native and separate.
- Don't re-enable the commented `"audio_chunk"` BluetoothSdk listener — that
  event doesn't exist; the live source is `mic_pcm`.

## Files

- Edit: `mobile/src/services/MantleManager.ts` (mic_pcm listener; remove stale block)
- (No change) `mobile/modules/engine/src/services/LocalMiniappRuntime.ts` — `forwardEvent` + mic-requirement recompute already handle the rest
- (No change) native BT SDK, `MicStateCoordinator`, SDK `mic.ts`/`events.ts`
- Tests: `mobile/modules/engine/src/services/__tests__/` (audio_chunk forwarding + gating)
```
