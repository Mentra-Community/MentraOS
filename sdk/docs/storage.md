# `session.storage`

Phone-local simple key/value storage, scoped to `(userId, packageName)`.
All operations round-trip to LocalMiniappRuntime, which reads/writes the
phone's AsyncStorage with a namespaced key format:

```
mentraos_localstorage_{userId}_{packageName}_{key}
```

Values are plain strings. Callers serialize structured data with
`JSON.stringify` themselves — this matches the cloud SDK's `SimpleStorage`
shape so the same caller code works in both environments.

Source: [mobile/modules/miniapp/src/modules/storage.ts](../../mobile/modules/miniapp/src/modules/storage.ts)

---

## Quick start

```ts
import {MiniappSession, createTransport} from "@mentra/miniapp"

const session = new MiniappSession({transport: createTransport()})
await session.connect()

// Persist a value.
await session.storage.set("last_route", JSON.stringify({lat: 37.77, lng: -122.4}))

// Read it back (on next launch, after reconnect, etc.).
const raw = await session.storage.get("last_route")
const route = raw ? JSON.parse(raw) : null

// List every key this miniapp has stored.
const keys = await session.storage.list()

// Delete one.
await session.storage.delete("last_route")
```

---

## API

### `get(key)` — `Promise<string | null>`

Read the string value stored at `key`. Resolves to `null` if no value is
set for that key.

**Parameters:**

| Name | Type |
| --- | --- |
| `key` | `string` |

**Returns:** `Promise<string | null>`.

---

### `set(key, value)` — `Promise<void>`

Write `value` (a string) under `key`. Overwrites any prior value. Callers
that need to store objects should `JSON.stringify` first.

**Parameters:**

| Name | Type |
| --- | --- |
| `key` | `string` |
| `value` | `string` |

**Returns:** `Promise<void>` — resolves once the phone confirms the write.

---

### `delete(key)` — `Promise<void>`

Remove the value at `key`. No-op if the key was not set.

**Parameters:**

| Name | Type |
| --- | --- |
| `key` | `string` |

**Returns:** `Promise<void>`.

---

### `list()` — `Promise<string[]>`

Return every key this miniapp has stored. Keys are returned as the
caller-supplied portion only — the
`mentraos_localstorage_{userId}_{packageName}_` namespace prefix is
stripped before the keys reach the SDK. Resolves to `[]` when no keys are
set.

**Returns:** `Promise<string[]>`.

---

## Errors

This module has no synchronous throws. Each method awaits a
`REQUEST_RESULT` round-trip — host-side failures (transport torn down,
internal phone-side error) surface as a rejected promise via the standard
miniapp error envelope.

| Code | Where | Meaning |
| --- | --- | --- |
| `REQUEST_ABORTED` | any method (rejected promise) | Session torn down or the request timed out before the phone replied. |
| `INTERNAL` | any method (rejected promise) | Phone-side code path threw while servicing the storage operation. |
| `NOT_CONNECTED` | any method (rejected promise) | Transport closed before the request was sent. |

---

## Wire-level reference

For host implementors — request/response message types this module emits:

| Method | Request type | Payload | Response |
| --- | --- | --- | --- |
| `get` | `STORAGE_GET` | `{key}` | `REQUEST_RESULT` with `data: {value: string \| null}` |
| `set` | `STORAGE_SET` | `{key, value}` | `REQUEST_RESULT` (no data) |
| `delete` | `STORAGE_DELETE` | `{key}` | `REQUEST_RESULT` (no data) |
| `list` | `STORAGE_LIST` | `{}` | `REQUEST_RESULT` with `data: {keys: string[]}` |

This module subscribes to no streams.

---

## Tests

_no integration tests yet_
