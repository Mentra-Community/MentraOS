# `session.speaker`

Phone-side audio output for miniapps. The miniapp calls
`session.speaker.play({audioUrl})` to play an arbitrary URL or
`session.speaker.speak(text)` to render text via the cloud TTS pipeline; the
phone fetches and plays the resulting audio through its
`AudioPlaybackService`.

Audio *input* (transcription, audio chunks, VAD) lives on `session.mic` — the
split is by I/O direction. Naming mirrors cloud SDK v3's `SpeakerManager`.

Source: [mobile/modules/miniapp/src/modules/speaker.ts](../../mobile/modules/miniapp/src/modules/speaker.ts)

---

## Quick start

```ts
import {MiniappSession, createTransport} from "@mentra/miniapp"

const session = new MiniappSession({transport: createTransport()})
await session.connect()

const unsub = session.speaker.onStateChange((event) => {
  switch (event.state) {
    case "loading":
      console.log("fetching audio…")
      break
    case "playing":
      console.log("playback started")
      break
    case "stopped":
      console.log(`done after ${event.durationMs ?? "?"}ms`)
      break
    case "error":
      console.error(event.errorCode, event.errorMessage)
      break
  }
})

try {
  const result = await session.speaker.speak("Hello world")
  console.log("completed?", result.completed)
} catch (e) {
  if (e && typeof e === "object" && "code" in e && e.code === "TTS_TEXT_TOO_LONG") {
    // user-visible: text exceeded TTS limits
  }
}

// later
session.speaker.stop()
unsub()
```

---

## State machine

Per miniapp:

```
idle ─── speak()/play() ──► loading ──► playing ──► stopped
                                │            │           │
                                └── error ───┴── stop ───┘
```

`error` is transient — it fires once with `errorCode` set, then the state
settles to `stopped` so `isPlaying` reads `false` correctly.

---

## API

### `state` — `SpeakerState`

Current speaker playback state (synchronous getter).

```ts
type SpeakerState = "idle" | "loading" | "playing" | "stopped" | "error"
```

---

### `isPlaying` — `boolean`

True iff `state === "playing"`. Convenience getter.

---

### `play(options)` — `Promise<void>`

Play an arbitrary audio URL through the phone's audio playback service.
Resolves when playback completes on the phone.

**Parameters:** `PlayAudioOptions`

```ts
interface PlayAudioOptions {
  audioUrl: string
  volume?: number
  stopOtherAudio?: boolean
}
```

`stopOtherAudio` defaults to `false` on the wire.

---

### `speak(text, options?)` — `Promise<SpeakResult>`

Speak text via cloud TTS. The phone constructs the TTS URL (the miniapp SDK
has no `cloudUrl`), fetches the MP3, and plays it through the phone audio
output.

**Parameters:**
- `text: string`
- `options: SpeakOptions` (optional)

```ts
interface SpeakOptions {
  voice_id?: string
  voice_settings?: Record<string, unknown>
  volume?: number
  stopOtherAudio?: boolean
}
```

`stopOtherAudio` defaults to `false` on the wire.

**Returns:** `SpeakResult`

```ts
interface SpeakResult {
  /** True if playback completed; false if playback was interrupted. */
  completed: boolean
}
```

When the host returns `null`, the SDK falls back to `{completed: true}`.

**Rejects with:** a `MiniappRequestError`-shaped object carrying a `code`
field on cloud-side TTS failures:
- `TTS_TEXT_TOO_LONG`
- `TTS_INVALID_VOICE`
- `TTS_UPSTREAM_ERROR`

Any other thrown value is normalized into `{code: "INTERNAL", message:
String(err)}` so callers can branch on `err.code` uniformly.

---

### `stop()` — `void`

Stop any audio this miniapp is currently playing. Fire-and-forget — sends
`STOP_AUDIO` as a one-shot, no ack.

---

### `onStateChange(handler)` — `UnsubscribeFn`

Subscribe to speaker state transitions. Fires for every change. Does **not**
fire immediately with the current value — read `state` separately if you
want the seed.

**Handler signature:** `(event: SpeakerStateEvent) => void`

```ts
interface SpeakerStateEvent {
  state: SpeakerState
  /** When state === "error", the underlying error code (TTS_*, INTERNAL). */
  errorCode?: string
  errorMessage?: string
  /** When state === "stopped", how many ms the playback ran (best-effort). */
  durationMs?: number
}
```

**Returns:** `UnsubscribeFn`.

**Dedup behavior:** state transitions are idempotent — same-state events are
dropped, except `error`, which is always delivered (it's transient and the
phone immediately follows up with `stopped`).

---

### `_applyState(event)` — `void`

**@internal.** Applied by `MiniappSession` on the inbound `SPEAKER_STATE`
envelope. Not for app code.

---

### `_getLastEvent()` — `SpeakerStateEvent`

**@internal — for tests.** Returns a shallow copy of the last applied
`SpeakerStateEvent`.

---

## Errors

| Code | Where | Meaning |
| --- | --- | --- |
| `TTS_TEXT_TOO_LONG` | `speak` (rejected Promise) | Text exceeds the cloud TTS limit. |
| `TTS_INVALID_VOICE` | `speak` (rejected Promise) | `voice_id` not recognized. |
| `TTS_UPSTREAM_ERROR` | `speak` (rejected Promise) | Cloud TTS returned a non-2xx response. |
| `INTERNAL` | `speak` (rejected Promise) | Non-object throw normalized by the SDK. Check `message`. |
| `SpeakerStateEvent {state: "error", errorCode, errorMessage}` | `onStateChange` stream | Asynchronous playback-side failure surfaced via the state stream. The same event also drives the `error → stopped` transient. |

---

## Wire-level reference

For host implementors — request/response message types this module emits:

| Method | Request type | Response |
| --- | --- | --- |
| `play` | `PLAY_AUDIO` (`{audioUrl, volume, stopOtherAudio}`) | `REQUEST_RESULT` (resolves when playback completes) |
| `speak` | `SPEAK` (`{text, voice_id, voice_settings, volume, stopOtherAudio}`) | `REQUEST_RESULT` with `data: SpeakResult \| null` |
| `stop` | `STOP_AUDIO` (one-shot, no `requestId`) | — |

Streams (push-only, not subscribed via `SUBSCRIBE`):

| Subscribe | Response type | Payload |
| --- | --- | --- |
| `onStateChange` | `SPEAKER_STATE` | `SpeakerStateEvent` |

The runtime sends `SPEAKER_STATE` to the owning miniapp only.

---

## Tests

Integration tests covering speaker state envelopes live at
[mobile/modules/miniapp/src/speaker-state-and-dismissed.test.ts](../../mobile/modules/miniapp/src/speaker-state-and-dismissed.test.ts).
Run with `bun test` from `mobile/modules/miniapp/`.
