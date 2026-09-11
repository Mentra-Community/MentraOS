# `session.translation`

Top-level translation API. Mirrors cloud SDK v3's `TranslationManager`:
subscribe to a `fromLang → toLang` stream and receive `TranslationData`
events as the cloud STT layer delivers them.

Hoisted to top-level (vs. nested under `session.mic`) for the same reason
as transcription: translation is a domain in its own right, not a
microphone-input event.

Source: [mobile/modules/miniapp/src/modules/translation.ts](../../mobile/modules/miniapp/src/modules/translation.ts)

---

## Quick start

```ts
import {MiniappSession, createTransport} from "@mentra/miniapp"

const session = new MiniappSession({transport: createTransport()})
await session.connect()

const unsub = session.translation.forLanguagePair("en-US", "es-ES", (data) => {
  console.log(`[${data.sourceLanguage} → ${data.targetLanguage}]`, data.text)
  if (data.isFinal) console.log("(final)")
})

// later — unsubscribe one pair…
unsub()

// …or tear down everything this module owns.
session.translation.stop()
```

---

## Manifest

Translation requires `MICROPHONE` in the miniapp manifest. `hasPermission`
reflects this; the phone runtime rejects subscriptions with
`PERMISSION_NOT_DECLARED` otherwise.

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
if (!session.translation.hasPermission) {
  // translation won't work — update the manifest
}
```

---

### `forLanguagePair(fromLang, toLang, handler)` — `UnsubscribeFn`

Subscribes to a `fromLang → toLang` translation stream. Each call is
independent; multiple language pairs can run simultaneously.

**Parameters:**
- `fromLang: string` — BCP-47 source tag (e.g. `"en-US"`).
- `toLang: string` — BCP-47 target tag (e.g. `"es-ES"`).
- `handler: (data: TranslationData) => void`

```ts
interface TranslationData {
  text: string
  isFinal: boolean
  sourceLanguage: string
  targetLanguage: string
}
```

**Returns:** `UnsubscribeFn` — call to detach. The module also tracks
every active unsubscribe so `stop()` can tear them all down at once.

```ts
type UnsubscribeFn = () => void
```

**Side effects:**
- Wire-level subscribes to `translation:<fromLang>:<toLang>` on the first
  handler attached to that stream (ref-counted in `EventManager`).

---

### `stop()` — `void`

Tears down every translation subscription this module owns. Individual
unsub functions returned by `forLanguagePair` still work — `stop()` is the
bulk equivalent.

---

## Errors

| Code | Where | Meaning |
| --- | --- | --- |
| `PERMISSION_NOT_DECLARED` | runtime-side rejection of the underlying `SUBSCRIBE` | `MICROPHONE` missing from miniapp manifest. Surfaces as an async error event, not a sync throw — the module itself does not gate. |

No methods on this module throw synchronously.

---

## Wire-level reference

For host implementors — this module emits no direct requests; it only
manages subscriptions through `MiniappSession._subscribe`.

Streams:

| Subscribe | Stream type | Payload |
| --- | --- | --- |
| `forLanguagePair(from, to, …)` | `TRANSLATION` (variant `translation:<from>:<to>`) | `TranslationData` |

---

## Tests

_no integration tests yet_
