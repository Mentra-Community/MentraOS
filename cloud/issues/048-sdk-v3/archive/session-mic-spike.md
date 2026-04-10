# Spike: Microphone / Audio Input System — SDK v3

**Issue:** 048
**Related:** [SDK v3 spike](./spike.md), [039 API map](../039-sdk-v3-api-surface/v2-v3-api-map.md), [session.speaker spike](./session-speaker-spike.md), [010 audio manager consolidation](../010-audio-manager-consolidation), [028 phone mic audio quality](../028-phone-mic-audio-quality)
**Status:** Spike
**Date:** 2026-03-18

---

## Overview

**What this doc covers:** The full audio input system for SDK v3 — raw PCM audio chunks, voice activity detection (VAD), the relationship between mic and transcription, the end-to-end audio pipeline from glasses to mini apps, and the v3 `session.mic` API. Covers current architecture audit, known issues, the proposed unified API, and open design questions.

**What this doc does NOT cover:** Audio _output_ (speaker, TTS, streaming) — that's `session.speaker` (see [session-speaker-spike.md](./session-speaker-spike.md)). Also does not cover transcription/translation APIs (see [spike.md](./spike.md) §Transcription Manager / §Translation Manager) or the broader SDK v3 migration plan.

**Key naming change:** In v2, audio input is scattered: `session.events.onAudioChunk()` for raw PCM, `session.events.onVoiceActivity()` for VAD, plus transcription implicitly activates the mic. In v3, `session.mic` is the dedicated audio input surface. Transcription still activates the mic transparently, but `session.mic` gives developers explicit access to the raw audio pipeline.

**Key principle:** The microphone is a shared resource. Multiple apps can receive mic audio simultaneously, and transcription consumes mic audio independently of raw PCM subscriptions. `session.mic` should make this transparent — a developer subscribes to what they want and the system handles mic lifecycle.

---

## Current Architecture (v2)

### End-to-End Audio Pipeline

**Five stages, two transport paths:**

```
Glasses Mic → Phone App → Cloud (UDP or WebSocket) → AudioManager → {
  1. relayAudioToApps()                → subscribed mini apps (binary WS frames)
  2. transcriptionManager.feedAudio()  → Soniox speech-to-text
  3. translationManager.feedAudio()    → translation providers
  4. microphoneManager.onAudioReceived() → mic state keepalive
}
```

#### Stage 1: Glasses → Phone

The glasses hardware mic captures audio. The phone manages the mic lifecycle based on `MICROPHONE_STATE_CHANGE` messages from the cloud. The phone sends either raw **PCM 16-bit** or **LC3-compressed** audio.

#### Stage 2: Phone → Cloud (Two Paths)

**Primary path — UDP (low latency):**

The phone sends UDP packets to port `8000` on the cloud server. Packet format:

```
Unencrypted:
  Bytes 0-3:  userIdHash (FNV-1a 32-bit, big-endian)
  Bytes 4-5:  sequence number (big-endian)
  Bytes 6+:   audio data (PCM or LC3)

Encrypted (XSalsa20-Poly1305):
  Bytes 0-3:  userIdHash
  Bytes 4-5:  sequence number
  Bytes 6-29: nonce (24 bytes)
  Bytes 30+:  encrypted audio + 16-byte Poly1305 auth tag
```

The `UdpReorderBuffer` handles out-of-order packets with a buffer of 10 packets and a 20ms timeout.

Phone registers for UDP via a `UDP_REGISTER` JSON message over the glasses WebSocket, which includes the FNV-1a hash of `userId` for packet routing.

**Legacy path — WebSocket binary frames:**

Phone sends raw binary frames over the main glasses WebSocket. The cloud's `websocket-glasses.service.ts` receives them and passes them to `audioManager.processAudioData(data)`. This path works but has higher latency than UDP.

#### Stage 3: Cloud Processing (`AudioManager`)

The cloud-side `AudioManager` (464 lines, per-session) is the central audio hub. On every incoming audio buffer:

1. **Decode LC3 → PCM** if audio format is LC3 (via `Lc3Service`). Otherwise, use PCM directly.
2. **PCM16 alignment** — ensure the buffer length is a multiple of 2 bytes (16-bit samples).
3. **Fan out** to four consumers:
   - `relayAudioToApps(buf)` — send raw PCM to subscribed mini apps
   - `transcriptionManager.feedAudio(buf)` — feed speech-to-text pipeline
   - `translationManager.feedAudio(buf)` — feed translation pipeline
   - `microphoneManager.onAudioReceived()` — mic state keepalive

#### Stage 4: Relay to Mini Apps

Raw PCM is sent as **binary WebSocket frames** to each subscribed app. No headers, no metadata — just raw bytes. The cloud iterates over all apps subscribed to `StreamType.AUDIO_CHUNK` and writes the buffer to each app's WebSocket.

#### Stage 5: SDK Reception

The SDK's `AppSession` has **two code paths** for receiving binary audio:

**Path A** — In the WebSocket `message` handler (inside `connect()`):

```typescript
// L737-741
const audioChunk: AudioChunk = {
  type: StreamType.AUDIO_CHUNK,
  arrayBuffer: arrayBuf,
  timestamp: new Date(),
}
```

Note: no `sampleRate` set here.

**Path B** — In `handleBinaryMessage()`:

```typescript
// L1808-1812
const audioChunk: AudioChunk = {
  type: StreamType.AUDIO_CHUNK,
  timestamp: new Date(),
  arrayBuffer: buffer,
  sampleRate: 16000, // Default sample rate
}
```

This path adds `sampleRate: 16000`. Both paths eventually call `this.events.emit(StreamType.AUDIO_CHUNK, audioChunk)`.

### Audio Data Format

| Parameter    | Value                                                                    |
| ------------ | ------------------------------------------------------------------------ |
| Sample Rate  | **16,000 Hz** (hardcoded in LC3 service and SDK)                         |
| Encoding     | **PCM 16-bit signed little-endian** (after cloud decoding)               |
| Channels     | **1 (mono)**                                                             |
| LC3 on wire  | 10ms frame duration, 20 bytes/frame = 16kbps (configurable to 32/48kbps) |
| UDP sequence | 16-bit (wraps at 65535)                                                  |

The `AudioChunk` type:

```typescript
interface AudioChunk extends BaseMessage {
  type: StreamType.AUDIO_CHUNK
  arrayBuffer: ArrayBufferLike
  sampleRate?: number // ← optional! Not always present
}
```

### Microphone Lifecycle Management

The cloud-side `MicrophoneManager` is the **mic gatekeeper**. It tells the phone when to enable/disable the hardware microphone based on whether any app needs audio:

**Decision logic:**

```typescript
calculateRequiredData(hasPCM: boolean, hasTranscription: boolean) {
  if (hasPCM || hasTranscription) {
    return ["pcm"]; // turn mic on
  }
  return []; // turn mic off
}
```

Either `audio_chunk` subscriptions (raw PCM) OR `transcription:*` subscriptions enable the mic. The phone doesn't know or care which — it just sends audio.

**Reliability mechanisms:**

| Mechanism                    | What                              | Why                                                                     |
| ---------------------------- | --------------------------------- | ----------------------------------------------------------------------- |
| Debounce (1s)                | Batch rapid subscription changes  | Prevent flapping during app start/stop                                  |
| Keep-alive (10s)             | Re-send mic state periodically    | Prevent phone drift after missed message                                |
| Mic-off holddown (3s)        | Delay before disabling mic        | Avoid turning off during brief unsubscribe/resubscribe                  |
| Force resync                 | Re-send on glasses reconnect      | Ensure consistent state after BLE reconnect                             |
| Unauthorized audio detection | Force mic off if no subscriptions | Safety: audio shouldn't flow if nothing needs it                        |
| VAD bypass                   | `bypassVad: true` for PCM subs    | When raw audio is requested, send continuously (not just during speech) |

The `MicrophoneStateChange` message sent to the phone:

```typescript
interface MicrophoneStateChange {
  type: "microphone_state_change"
  isMicrophoneEnabled: boolean
  requiredData: Array<"pcm" | "transcription" | "pcm_or_transcription">
  bypassVad?: boolean // true when any app subscribes to AUDIO_CHUNK
}
```

### Voice Activity Detection (VAD)

VAD originates on the **phone side** and flows as a JSON message:

```typescript
interface Vad {
  type: "vad"
  status: boolean | "true" | "false" // mixed types — historical quirk
}
```

On the cloud, VAD drives **transcription stream lifecycle**:

- `isSpeaking === true` → `transcriptionManager.ensureStreamsExist()` (start/resume Soniox streams)
- `isSpeaking === false` → `transcriptionManager.finalizePendingTokens()` + `cleanupIdleStreams()` + `translationManager.stopAllStreams()`

VAD is also relayed to subscribed mini apps via `relayMessageToApps()`. Apps can listen with `session.events.onVoiceActivity(handler)`.

**Important interaction:** When an app subscribes to `AUDIO_CHUNK` (raw PCM), the `MicrophoneManager` sets `bypassVad: true`, meaning the phone sends audio **continuously** regardless of VAD state. This is correct — an app that wants raw audio needs all of it, not just speech segments. But the `onVoiceActivity` handler still fires — the app can use VAD to detect speech within the continuous stream.

The `TranscriptionManager` also maintains a **VAD audio buffer** (~2.5s) to avoid losing the first few hundred milliseconds of speech while Soniox streams are starting up.

### What the SDK Exposes Today

| Method                                                     | Type                         | Stream subscription                             |
| ---------------------------------------------------------- | ---------------------------- | ----------------------------------------------- |
| `session.events.onAudioChunk(handler)`                     | `Handler<AudioChunk>`        | `audio_chunk`                                   |
| `session.events.onVoiceActivity(handler)`                  | `Handler<Vad>`               | `vad`                                           |
| `session.events.onTranscription(handler)`                  | `Handler<TranscriptionData>` | `transcription` (implicitly enables mic)        |
| `session.events.onTranscriptionForLanguage(lang, handler)` | `Handler<TranscriptionData>` | `transcription:{lang}` (implicitly enables mic) |

There is no `session.mic` or `MicManager` today. Audio input is accessed through `session.events` alongside unrelated events (button presses, notifications, etc.).

### Transcription vs. Mic — Independent Subscriptions

**Yes, they are independent.** The cloud's `SubscriptionManager.hasPCMTranscriptionSubscriptions()` separately tracks:

- `hasPCM` — any app subscribed to `StreamType.AUDIO_CHUNK`
- `hasTranscription` — any app subscribed to `transcription:*` or `translation:*`

An app can subscribe to:

- `audio_chunk` only → gets raw PCM, no transcription runs
- `transcription:en` only → gets text events, mic is enabled for the transcription pipeline but raw PCM is NOT relayed to the app
- Both → gets both raw PCM and text events

Either subscription type enables the mic (via `hasMedia = hasPCM || hasTranscription`). Subscribing to transcription does NOT automatically give you raw PCM. They are separate data streams with separate subscriptions.

### Multi-App Multiplexing

**Yes, multiple apps can receive mic audio simultaneously.** The cloud's `relayAudioToApps()` iterates over ALL apps subscribed to `AUDIO_CHUNK` and sends each one the same buffer:

```typescript
const subscribedPackageNames = subscriptionManager.getSubscribedApps(StreamType.AUDIO_CHUNK)
for (const packageName of subscribedPackageNames) {
  const connection = appWebsockets.get(packageName)
  if (connection?.readyState === OPEN) {
    connection.send(audioData) // binary frame
  }
}
```

Similarly, transcription results are distributed to all apps with matching language subscriptions. There's no exclusivity — the mic is a shared resource.

---

## Issues

| #   | Issue                                                            | Impact                                                                                                                                                                | Root Cause                                                                                           |
| --- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1   | **Dual binary reception paths in SDK**                           | `sampleRate` is present in one path but missing in the other. Apps can't reliably know the sample rate.                                                               | Two code paths evolved independently — `connect()` handler vs `handleBinaryMessage()`                |
| 2   | **No metadata in binary frames**                                 | Raw PCM arrives as naked bytes. No headers for codec, sample rate, sequence number, or timestamp.                                                                     | Binary frames were designed for minimal latency — headers were considered unnecessary                |
| 3   | **`sampleRate` is optional on `AudioChunk`**                     | Apps must assume 16kHz. If the rate ever changes, existing apps break silently.                                                                                       | Type was defined permissively; default wasn't enforced                                               |
| 4   | **`Vad.status` is `boolean \| "true" \| "false"`**               | Mixed types require coercion: `status === true \|\| status === "true"`. Fragile and confusing.                                                                        | Historical — phone app originally sent string, glasses send boolean, type was widened to accept both |
| 5   | **No `isSpeaking` read-only property**                           | Apps can't check "is the user currently speaking?" without tracking VAD events manually.                                                                              | VAD is event-only, no cached state                                                                   |
| 6   | **No `isActive` property**                                       | Apps can't check "is the mic currently streaming?" without inferring from subscription state.                                                                         | Mic lifecycle is managed by the cloud's `MicrophoneManager`, not visible to the SDK                  |
| 7   | **Transcription implicitly enables mic but this is invisible**   | A developer may not realize that subscribing to transcription activates the hardware microphone.                                                                      | Mic activation is a side effect of subscription, with no explicit API surface                        |
| 8   | **`onAudioChunk` and `onVoiceActivity` are on `session.events`** | Audio input is mixed with unrelated events (buttons, notifications, GPS). No dedicated namespace.                                                                     | v2 design put everything on EventManager                                                             |
| 9   | **No permission surface for mic**                                | There's no `hasPermission` check for microphone access in the SDK.                                                                                                    | Permission checks are cloud-side only (`SimplePermissionChecker`), not exposed to the developer      |
| 10  | **VAD bypass interaction is undocumented**                       | When an app subscribes to `audio_chunk`, VAD bypass is enabled for ALL apps' mic streams (it's a global per-user toggle). Other apps may not expect continuous audio. | `bypassVad` is a global flag on the `MicrophoneStateChange` message, not per-app                     |

---

## Proposed v3 API

### `session.mic`

```typescript
// ─── Raw Audio ──────────────────────────────────
session.mic.onChunk(handler: (chunk: AudioChunk) => void)   // → () => void (cleanup)
session.mic.stop()                                           // stop all mic subscriptions

// ─── Voice Activity ─────────────────────────────
session.mic.onVoiceActivity(handler: (vad: VadEvent) => void) // → () => void (cleanup)

// ─── Read-Only State ────────────────────────────
session.mic.isSpeaking          // → boolean (from VAD, cached)
session.mic.isActive            // → boolean (is mic streaming audio?)
session.mic.hasPermission       // → boolean (from PermissionsManager)
```

### Type Definitions

```typescript
// ─── Audio Chunks ───────────────────────────────

interface AudioChunk {
  /** Raw PCM 16-bit signed little-endian audio data. */
  data: ArrayBuffer

  /** Sample rate in Hz. Always 16000 for current hardware. */
  sampleRate: number

  /** Number of channels. Always 1 (mono) for current hardware. */
  channels: number

  /** Timestamp when this chunk was captured. */
  timestamp: number
}

// ─── Voice Activity ─────────────────────────────

interface VadEvent {
  /** Whether speech is currently detected. */
  isSpeaking: boolean

  /** Timestamp of the VAD state change. */
  timestamp: number
}

// ─── Errors ─────────────────────────────────────

interface MicError {
  code: MicErrorCode
  message: string
}

type MicErrorCode =
  | "PERMISSION_DENIED" // app doesn't have microphone permission
  | "MIC_NOT_AVAILABLE" // hardware mic not available or disabled
  | "STREAM_FAILED" // audio stream error (BLE disconnect, etc.)
```

### Usage Examples

```typescript
// Simple — receive raw PCM audio
const stopChunks = session.mic.onChunk((chunk) => {
  console.log(`Got ${chunk.data.byteLength} bytes at ${chunk.sampleRate}Hz`)
  processAudio(chunk.data)
})

// Voice activity detection
const stopVad = session.mic.onVoiceActivity((vad) => {
  if (vad.isSpeaking) {
    console.log("User started speaking")
  } else {
    console.log("User stopped speaking")
  }
})

// Check state
if (session.mic.isSpeaking) {
  console.log("User is currently speaking")
}

if (!session.mic.hasPermission) {
  console.log("App doesn't have microphone permission")
}

// Stop just raw audio (VAD keeps running)
stopChunks()

// Stop everything
session.mic.stop()
```

---

## Design: Mic ↔ Transcription Relationship

### The Question

How does `session.mic` interact with `session.transcription`? They both consume audio from the same hardware mic. Are they truly independent? Does subscribing to transcription implicitly activate `session.mic`?

### The Answer: Independent Subscriptions, Shared Resource

```
session.mic.onChunk(handler)
  → subscribe("audio_chunk")
  → MicrophoneManager enables mic (bypassVad: true)
  → cloud relays raw PCM to this app

session.transcription.on(handler)
  → subscribe("transcription:auto")
  → MicrophoneManager enables mic (bypassVad: false)
  → cloud feeds audio to Soniox, relays text results to this app
  → raw PCM is NOT relayed to this app (no audio_chunk subscription)
```

Key rules:

1. **Subscribing to transcription does NOT give you raw audio.** If you want both text and raw PCM, subscribe to both:

```typescript
session.transcription.on((data) => {
  /* text */
})
session.mic.onChunk((chunk) => {
  /* raw PCM */
})
```

2. **Subscribing to mic does NOT give you transcription.** If you want both, subscribe to both.

3. **Either subscription enables the hardware mic.** The `MicrophoneManager` calculates `hasMedia = hasPCM || hasTranscription` and enables the mic if either is true.

4. **`session.mic.isActive` reflects whether the hardware mic is streaming**, not whether this app has a `audio_chunk` subscription. If another app subscribed to transcription, the mic is active but this app isn't receiving chunks unless it also subscribed.

Actually — correction. `isActive` should reflect whether **this app** is receiving audio, not the global mic state. The developer wants to know "am I getting chunks?" not "is some other app using the mic." Revised:

- `session.mic.isActive` → `true` if this app has an active `onChunk` subscription (any handler registered)
- `session.mic.isSpeaking` → `true` if VAD reports speech (global — same for all apps)

### VAD Bypass Interaction

When any app subscribes to `audio_chunk`, the cloud sets `bypassVad: true` on the `MicrophoneStateChange` message. This means the phone sends audio **continuously**, not just during speech.

**Problem:** This is a global flag. If App A subscribes to `audio_chunk` (needs continuous audio for, say, ambient sound analysis), the `bypassVad: true` affects ALL apps. App B, which only subscribed to transcription, now gets continuous audio fed to Soniox instead of VAD-gated audio. This wastes Soniox credits and may produce garbage transcription during silence.

**Current behavior (v2):** The `MicrophoneManager` already handles this — `bypassVad` is set based on `hasPCM` (any app has `audio_chunk` subscription). The transcription pipeline itself handles silence gracefully (Soniox sends empty results, the SDK filters them). The cost impact is real but manageable.

**v3 approach:** Don't change this. The interaction is correct — if any app needs continuous audio, the mic must be continuous. Transcription handles it. The cost concern is a cloud-side optimization (e.g., pause Soniox during extended silence even when mic is continuous), not an SDK concern.

---

## Design: Audio Routing for Local Apps

### The Question

Today, mic audio goes: glasses → phone → cloud (UDP) → transcription provider. For local apps, it goes: glasses → phone → on-device Whisper/Sherpa. Does the `MicManager` need to know about this routing?

### The Answer: No. Transport Abstraction Handles It.

The `MicManager` sends and receives messages through the `Transport` interface. It doesn't know or care whether audio comes from a cloud WebSocket or a native bridge:

```
Cloud app:
  Glasses mic → Phone → UDP → Cloud AudioManager → binary WS frame → SDK MicManager

Local app:
  Glasses mic → Phone → native bridge → SDK MicManager
```

The message format is identical — an `AudioChunk` with PCM data. The `MicManager` processes it the same way.

For local apps, the native transport routes `audio_chunk` subscription to the phone's audio pipeline (which already captures audio from the glasses BLE connection). The phone side sends PCM frames through `globalThis.__mentraTransport.onMessage()` using the same `AudioChunk` shape.

**What about transcription?** For local apps, transcription happens on-device (Sherpa-ONNX). The native transport intercepts `transcription:*` subscriptions and routes audio to the local STT engine instead of sending it to a cloud. The `MicManager` doesn't need to know — it just receives `AudioChunk` or `VadEvent` messages through the transport.

---

## Design: AudioChunk Metadata

### The Problem

Today, raw PCM arrives as naked binary WebSocket frames with no headers. The SDK wraps them in an `AudioChunk` object, but `sampleRate` is optional and inconsistently set (16000 in one code path, missing in another). The developer has no reliable way to know the audio format.

### The Fix

The v3 `AudioChunk` always includes metadata:

```typescript
interface AudioChunk {
  data: ArrayBuffer // raw PCM bytes
  sampleRate: number // always present (16000)
  channels: number // always present (1)
  timestamp: number // always present (Date.now())
}
```

The `MicManager` enforces this: when a binary frame arrives (from the transport), the manager wraps it with the known format parameters. The format is currently fixed (16kHz, mono, PCM16), but having the fields present means apps don't hardcode assumptions.

**Wire protocol:** No change needed. Binary frames stay as naked PCM bytes. The `MicManager` adds metadata on the SDK side. If the format ever changes (e.g., the phone starts sending 48kHz), the metadata source would be the initial connection handshake (capabilities or a format negotiation message), and the `MicManager` would populate `AudioChunk` accordingly.

### Renaming `arrayBuffer` → `data`

The v2 type uses `arrayBuffer: ArrayBufferLike` — verbose and imprecise. v3 uses `data: ArrayBuffer` — shorter, concrete type. The legacy shim maps `chunk.arrayBuffer` → `chunk.data` for backward compat.

---

## Design: VAD Type Cleanup

### The Problem

The v2 `Vad` interface has `status: boolean | "true" | "false"` — a union of boolean and string representations of boolean. Every consumer must coerce:

```typescript
const isSpeaking = message.status === true || message.status === "true"
```

### The Fix

The v3 `VadEvent` normalizes to a clean boolean:

```typescript
interface VadEvent {
  isSpeaking: boolean // always a real boolean
  timestamp: number
}
```

The `MicManager` handles the coercion internally when processing incoming VAD messages from the transport. The developer never sees the mixed type.

The `MicManager` also caches the latest VAD state, exposed as `session.mic.isSpeaking` (read-only boolean). This means developers can check the current speech state without tracking events manually.

---

## Design: Permission Surface

### The Problem

Today, there's no SDK-side indication that the app needs microphone permission. The cloud's `SimplePermissionChecker` rejects unauthorized subscriptions server-side, but the SDK developer gets no feedback — their `onAudioChunk` handler silently never fires.

### The Fix

`session.mic.hasPermission` reads from the centralized `PermissionsManager`:

```typescript
// MicManager
get hasPermission(): boolean {
  return this.permissions.has("microphone")
}
```

This is a read-only convenience getter. The actual permission check still happens cloud-side. But the developer can check before subscribing:

```typescript
if (session.mic.hasPermission) {
  session.mic.onChunk(handler)
} else {
  console.log("App needs microphone permission")
}
```

---

## What Changes Where

### SDK

| File / Module              | Change                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| New: `MicManager`          | `session.mic` — `onChunk()`, `onVoiceActivity()`, `stop()`, `isSpeaking`, `isActive`, `hasPermission` |
| `EventManager` (574 lines) | Remove `onAudioChunk()`, `onVoiceActivity()` — now on `MicManager`                                    |
| `AppSession` (2,423 lines) | Remove `handleBinaryMessage()` — binary routing moves to `MicManager`                                 |
| `AppSession` constructor   | Remove duplicate binary handling in `connect()`                                                       |
| `LegacyEventShim`          | `session.events.onAudioChunk()` → `session.mic.onChunk()`                                             |
| `LegacyEventShim`          | `session.events.onVoiceActivity()` → `session.mic.onVoiceActivity()`                                  |
| `AudioChunk` type          | `arrayBuffer` → `data`, `sampleRate` required (not optional), add `channels`                          |

### Cloud

| File / Module              | Change                                       |
| -------------------------- | -------------------------------------------- |
| `AudioManager` (464 lines) | No changes — relay logic stays the same      |
| `MicrophoneManager`        | No changes — mic lifecycle stays the same    |
| `UdpAudioServer`           | No changes — UDP path stays the same         |
| Wire protocol              | No changes — binary frames stay as naked PCM |

### Wire Protocol

| Message                   | Change                                                               |
| ------------------------- | -------------------------------------------------------------------- |
| Binary audio frames       | No change — same naked PCM bytes                                     |
| `VAD` JSON message        | No change — `MicManager` normalizes `status` to `boolean` on receipt |
| `MICROPHONE_STATE_CHANGE` | No change — cloud-to-phone message, SDK never sees this              |
| `SUBSCRIPTION_UPDATE`     | No change — `audio_chunk` and `vad` subscriptions work as before     |

The wire protocol requires **zero changes**. All the v3 work is in the SDK's `MicManager` — wrapping binary frames with metadata, normalizing VAD types, caching state, and providing a clean API surface.

---

## Legacy Shim

```typescript
// v2 code:
session.events.onAudioChunk((chunk) => {
  console.log(chunk.arrayBuffer)
})
// LegacyEventShim maps to:
session.mic.onChunk((chunk) => {
  // chunk.data is the new name; shim provides chunk.arrayBuffer as alias
  handler({ ...chunk, arrayBuffer: chunk.data })
})

// v2 code:
session.events.onVoiceActivity((vad) => {
  if (vad.status === true || vad.status === "true") { ... }
})
// LegacyEventShim maps to:
session.mic.onVoiceActivity((vad) => {
  // vad.isSpeaking is always a boolean; shim provides vad.status for compat
  handler({ ...vad, status: vad.isSpeaking })
})
```

---

## Open Questions

| #   | Question                                                                   | Notes                                                                                                                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Should `onChunk` deliver PCM or allow codec selection?**                 | Today it's always PCM16 16kHz mono. If the phone starts sending LC3 directly to local apps (skipping cloud decoding), should `onChunk` expose an option for codec? Probably not for v3.0 — always PCM. Add codec options in v3.1 if needed.                                            |
| 2   | **Should `session.mic.isActive` be per-app or global?**                    | Recommended: per-app (reflects whether THIS app has a `onChunk` subscription active). The developer cares about their own state, not other apps'. Global mic state is a cloud concern.                                                                                                 |
| 3   | **Multiple apps subscribing to `audio_chunk` — memory/bandwidth concern?** | Each subscribed app gets a copy of every PCM buffer over its WebSocket. 10 apps = 10x bandwidth. In practice, very few apps subscribe to raw PCM (it's mostly transcription). Monitor but don't gate.                                                                                  |
| 4   | **Should `MicManager` buffer audio during reconnection?**                  | If the WebSocket drops and reconnects (TRANSPORT_DOWN state), raw audio chunks are lost. Should the SDK buffer them? Probably not — raw audio is latency-sensitive and buffering stale audio is useless. Accept the gap.                                                               |
| 5   | **VAD bypass scope — should it be per-app?**                               | Currently `bypassVad` is global. If App A wants continuous audio and App B wants VAD-gated transcription, both get continuous. Per-app bypass would require cloud changes (separate mic state per app). Probably not worth it — the transcription pipeline handles silence gracefully. |
| 6   | **Should `session.mic` expose sample rate / format info?**                 | Something like `session.mic.format` → `{ sampleRate: 16000, channels: 1, encoding: "pcm16" }`. Useful for apps that process audio (FFT, etc.). Low effort, high value. Leaning yes.                                                                                                    |
| 7   | **Audio chunk size / timing guarantees?**                                  | The phone sends audio in variable-sized chunks depending on the transport (UDP packets, BLE MTU, etc.). Should the SDK normalize to fixed-size chunks (e.g., 20ms frames)? Adds latency but simplifies audio processing. Probably not for v3.0 — pass through as-is.                   |
| 8   | **Should subscribing to transcription set `session.mic.isActive = true`?** | Transcription enables the hardware mic, but the app doesn't receive raw chunks. Is the mic "active" from the app's perspective? Recommended: no. `isActive` means "I'm receiving chunks," not "the hardware is on."                                                                    |
| 9   | **On-device VAD vs cloud VAD**                                             | For local apps, VAD runs on the phone. For cloud apps, VAD runs on the phone and is relayed. Should the `MicManager` care about the source? No — it's a `VadEvent` either way. Transport abstraction handles it.                                                                       |
| 10  | **Should `MicManager` expose `onError` for mic failures?**                 | If the glasses mic fails, the phone disconnects, or the cloud can't relay audio — should the SDK fire an error event? Currently errors are silent. Probably yes — `session.mic.onError(handler)` for operational awareness.                                                            |
|  |
