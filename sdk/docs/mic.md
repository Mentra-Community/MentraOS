# `session.mic`

Low-level audio-input subscriptions for miniapps. Houses raw audio chunks
and voice-activity detection (VAD). Mirrors cloud SDK v3's `MicManager`
naming.

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

// later — either tear down individually:
unsubVad()
unsubAudio()
// …or tear down everything this module owns at once:
session.mic.stop()
```

---

## Manifest

Mic subscriptions require `MICROPHONE` in the miniapp manifest. Without it,
the phone runtime rejects every subscribe on this module with
`PERMISSION_NOT_DECLARED`.

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
  // mic subscriptions will be rejected by the phone runtime
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

### `stop()` — `void`

Tears down every subscription this module owns in one shot. Useful when a
component is unmounting and wants to free everything without tracking
individual unsubscribe functions.

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
| `PERMISSION_NOT_DECLARED` | Phone-side rejection of the underlying `SUBSCRIBE` | `MICROPHONE` missing from miniapp manifest. |

This module has no synchronous throws — permission gating happens at the
phone runtime when the `SUBSCRIBE` is processed.

---

## Wire-level reference

For host implementors — this module is stream-only.

| Subscribe | Stream type | Payload |
| --- | --- | --- |
| `onVoiceActivity` | `VAD` | `VadData` |
| `onAudioChunk` | `AUDIO_CHUNK` | `AudioChunkData` |

---

## Tests

_no integration tests yet_
