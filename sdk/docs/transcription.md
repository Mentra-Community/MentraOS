# `session.transcription`

Speech-to-text for miniapps. Wraps the phone's cloud STT pipeline as a
top-level domain — `session.mic` still exposes the lower-level audio
chunks + VAD, but if all you want is "give me text from speech", use this
module.

Mirrors cloud SDK v3's `TranscriptionManager`:

```
session.transcription.on(handler)                                // auto-detect
session.transcription.forLanguage("en-US", handler)              // single language
session.transcription.forLanguage(["en-US", "es-ES"], handler)   // multi-language
session.transcription.configure({languageHints, vocabulary, diarization})
session.transcription.stop()                                     // tear down all
```

Source: [mobile/modules/miniapp/src/modules/transcription.ts](../../mobile/modules/miniapp/src/modules/transcription.ts)

---

## Quick start

```ts
import {MiniappSession, createTransport} from "@mentra/miniapp"

const session = new MiniappSession({transport: createTransport()})
await session.connect()

session.transcription.configure({
  languageHints: ["en", "ja"],
  vocabulary: ["MentraOS", "HIPAA"],
  diarization: true,
})

// Auto-detect language — detected tag is in `data.language`.
const unsubAuto = session.transcription.on((data) => {
  console.log(`[${data.language ?? "??"}] ${data.text} (final=${data.isFinal})`)
})

// Or pin to specific languages.
const unsubEn = session.transcription.forLanguage("en-US", (data) => {
  if (data.isFinal) console.log("English final:", data.text)
})

// later
session.transcription.stop()  // detaches every sub this module owns
```

---

## Manifest

Transcription requires `MICROPHONE` in the miniapp manifest. The phone
runtime rejects subscriptions with `PERMISSION_NOT_DECLARED` when it's
missing.

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
if (!session.transcription.hasPermission) {
  // transcription subs will be rejected — prompt the user to update the manifest
}
```

---

### `on(handler)` — `UnsubscribeFn`

Subscribe to all transcription events (auto-detect language). The detected
language tag is in `data.language`.

Wire-level: subscribes to `transcription:auto`. Handlers on
`transcription:auto` receive any `transcription:<lang>` event via the
EventManager's wildcard fan-out.

**Handler signature:** `(data: TranscriptionData) => void`

```ts
interface TranscriptionData {
  text: string
  isFinal: boolean
  language?: string
}
```

**Returns:** `UnsubscribeFn` — call to detach. Subscription is also tracked
by the module so `stop()` will clean it up.

---

### `forLanguage(language, handler)` — `UnsubscribeFn`

Subscribe to transcription for one or more specific languages. Each call
is independent; multiple can be active simultaneously.

**Parameters:**
- `language: string | string[]` — BCP-47 tag(s), e.g. `"en-US"` or
  `["en-US", "es-ES"]`. An empty array returns a no-op unsubscribe.
- `handler: (data: TranscriptionData) => void` — called for every event in
  any of the listed languages.

Internally fans the call out to one wire subscription per tag
(`transcription:<lang>`) and returns a combined `UnsubscribeFn` that
detaches all of them at once.

**Returns:** `UnsubscribeFn`.

---

### `configure(config)` — `void`

Apply transcription configuration (language hints, custom vocabulary,
diarisation toggle). Sent to the cloud immediately as a one-shot. Cached
locally so future reconnect logic can re-send.

**Parameters:** `TranscriptionConfig`

```ts
interface TranscriptionConfig {
  /** ISO 639-1 language hints to improve detection accuracy (e.g. ["en", "ja"]). */
  languageHints?: string[]
  /** Custom vocabulary / boosted terms (e.g. ["MentraOS", "HIPAA"]). */
  vocabulary?: string[]
  /** Enable speaker diarisation. Defaults vary by provider. */
  diarization?: boolean
}
```

Fire-and-forget; no ack. The phone forwards to the cloud STT layer.

---

### `stop()` — `void`

Tear down every transcription subscription this module owns (both `on()`
and `forLanguage()` registrations made through this module). Does not
affect raw `session.mic` audio subscriptions.

---

### `_getConfig()` — `TranscriptionConfig | null`

**@internal.** Returns a fresh shallow copy of the most recent config
passed to `configure()`, or `null` if `configure()` has never been called.
Read by tests / future reconnect logic.

---

## Errors

| Code | Where | Meaning |
| --- | --- | --- |
| `PERMISSION_NOT_DECLARED` | Phone runtime, surfaced via `session.on("error", ...)` / `session.permissions.onPermissionError(...)` | The miniapp subscribed to `transcription:*` without declaring `MICROPHONE` in its manifest. |

Transcription subs do not throw synchronously — the rejection is async,
delivered as a session-level error event. Use
`session.permissions.onPermissionError(...)` for a typed handler.

---

## Wire-level reference

For host implementors — request/response message types this module emits:

| Method | Request type | Response |
| --- | --- | --- |
| `configure` | `TRANSCRIPTION_CONFIG` (`{config: TranscriptionConfig}`, one-shot) | — |

Streams:

| Subscribe | Stream type | Payload |
| --- | --- | --- |
| `on` | `TRANSCRIPTION` with `:auto` suffix (`transcription:auto`) | `TranscriptionData` |
| `forLanguage` | `TRANSCRIPTION` with `:<lang>` suffix (e.g. `transcription:en-US`) | `TranscriptionData` |

The `transcription:auto` channel receives wildcard fan-out from every
`transcription:<lang>` event, so a single auto-detect subscriber sees all
languages.

---

## Tests

_No integration tests yet._
