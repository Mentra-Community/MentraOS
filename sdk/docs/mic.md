# `session.mic`

Low-level audio-input subscriptions for miniapps. Houses raw audio chunks
and voice-activity detection (VAD), plus imperative controls for glasses-side
microphone gates (VAD and the loudness "Barrier"). Mirrors cloud SDK v3's
`MicManager` naming for the listen APIs.

Transcription and translation are **not** on this module — they live at
`session.transcription` and `session.translation` so authors don't have to
mentally model "transcription is a microphone thing." Audio *output* (TTS,
file playback) lives on `session.speaker`.

> Before the v3-alignment round this module was called `MicrophoneModule` /
> `session.microphone`.

Source: [mobile/modules/miniapp/src/modules/mic.ts](../../mobile/modules/miniapp/src/modules/mic.ts)

---

## Quick start

```ts
import {MiniappSession, createTransport} from "@mentra/miniapp"

const session = new MiniappSession({transport: createTransport()})
await session.connect()

const unsubVad = session.mic.onVoiceActivity((data) => {
  console.log(data.status ? "speaking" : "silent")
})

const unsubAudio = session.mic.onAudioChunk((data) => {
  // data.data is base64-encoded PCM or LC3 depending on phone's mic mode
  decodeAndProcess(data.data, data.format, data.sampleRate)
})

// Optional: control glasses-side mic gates (Mentra Live)
await session.mic.setVoiceActivityDetectionEnabled(true)
await session.mic.setLoudnessGateEnabled(true)

// later — either tear down individually:
unsubVad()
unsubAudio()
// …or tear down everything this module owns at once:
session.mic.stop()
```

---

## Manifest

Mic subscriptions and gate setters require `MICROPHONE` in the miniapp
manifest. Without it, the phone runtime rejects every subscribe / set call on
this module with `PERMISSION_NOT_DECLARED`.

```json
{
  "permissions": ["MICROPHONE"]
}
```

---

## API

### `hasPermission` — `boolean`

True iff `MICROPHONE` is declared in the miniapp's manifest. Synchronous;
reads the cached manifest record populated at `CONNECT_ACK`.

```ts
if (!session.mic.hasPermission) {
  // mic subscriptions / gate setters will be rejected by the phone runtime
}
```

---

### `onVoiceActivity(handler)` — `UnsubscribeFn`

Subscribes to voice activity detection (VAD) events. `data.status` is
`true` while the user is speaking, `false` when silent.

**Handler signature:** `(data: VadData) => void`

```ts
interface VadData {
  /** True while the user is speaking (voice detected), false when silent. */
  status: boolean
}
```

**Returns:** `UnsubscribeFn` — call to detach. The returned unsubscribe is
tracked by the module so `stop()` can tear it down too.

---

### `onAudioChunk(handler)` — `UnsubscribeFn`

Subscribes to raw audio chunks. Format depends on the phone's mic mode (PCM
or LC3, base64-encoded).

**Handler signature:** `(data: AudioChunkData) => void`

```ts
interface AudioChunkData {
  /** PCM or LC3, base64-encoded. Format depends on phone's mic mode. */
  data: string
  sampleRate?: number
  format?: string
}
```

**Returns:** `UnsubscribeFn` — call to detach. The returned unsubscribe is
tracked by the module so `stop()` can tear it down too.

---

### `setVoiceActivityDetectionEnabled(enabled)` — `Promise<void>`

Explicitly enable or disable glasses-side voice activity detection (GX8002).
Mirrors the toggle in the Mentra App's microphone settings.

When VAD is disabled, mic gating falls back to the loudness gate only (if
that gate is enabled). Mentra Live only today; other models no-op.

**Requires:** `MICROPHONE` in the miniapp manifest.

```ts
await session.mic.setVoiceActivityDetectionEnabled(false)
```

---

### `setLoudnessGateEnabled(enabled)` — `Promise<void>`

Explicitly enable or disable the center-mic loudness gate ("Barrier"), which
blocks quiet / self-talk audio independent of VAD. Mentra Live only today;
other models no-op.

**Requires:** `MICROPHONE` in the miniapp manifest.

```ts
await session.mic.setLoudnessGateEnabled(false)
```

---

### `stop()` — `void`

Tears down every subscription this module owns in one shot. Useful when a
component is unmounting and wants to free everything without tracking
individual unsubscribe functions.

Does **not** change glasses-side VAD / loudness-gate settings — those are
sticky device settings, not subscription state.

**Side effects:**
- Invokes every tracked unsubscribe; errors from individual unsubs are
  swallowed.
- Clears the module's internal tracking set.

Calling an individually-returned `UnsubscribeFn` after `stop()` is safe — it
becomes a no-op.

---

## Errors

| Code | Where | Meaning |
| --- | --- | --- |
| `PERMISSION_NOT_DECLARED` | Phone-side rejection of `SUBSCRIBE` or gate setters | `MICROPHONE` missing from miniapp manifest. |
| `INTERNAL` | Phone-side rejection of a gate setter | Native Bluetooth / settings apply failed. |

Subscribe permission gating happens at the phone runtime when the `SUBSCRIBE`
is processed. Gate setters reject with the same code when the manifest is
missing `MICROPHONE`.

---

## Wire-level reference

For host implementors — this module has stream subscriptions plus two
imperative setters.

| Subscribe / call | Stream / request type | Payload |
| --- | --- | --- |
| `onVoiceActivity` | `VAD` | `VadData` |
| `onAudioChunk` | `AUDIO_CHUNK` | `AudioChunkData` |
| `setVoiceActivityDetectionEnabled` | `MIC_SET_VAD_ENABLED` (`miniapp_mic_set_vad_enabled`) | `{enabled: boolean}` |
| `setLoudnessGateEnabled` | `MIC_SET_LOUDNESS_GATE_ENABLED` (`miniapp_mic_set_loudness_gate_enabled`) | `{enabled: boolean}` |

---

## Tests

See [mobile/modules/miniapp/src/modules/mic.test.ts](../../mobile/modules/miniapp/src/modules/mic.test.ts).
