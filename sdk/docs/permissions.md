# `session.permissions`

Manifest-declared permission introspection for miniapps. Lets a miniapp
check what its own `manifest.json` declared, observe changes to that
record, and listen for typed `PERMISSION_NOT_DECLARED` errors raised when
a subscription is rejected by the phone runtime.

Mirrors cloud SDK v3's `PermissionsManager` surface and semantics:

```
permissions.has(type)         — synchronous boolean
permissions.getAll()          — full PermissionRecord
permissions.onUpdate(handler) — fires on cache change
permissions.onPermissionError(handler) — typed handler for the existing
                                         PERMISSION_NOT_DECLARED error
```

> **What "permission" means here.** Same as v3: this module tracks
> **manifest-declared** permissions. `permissions.has("microphone") === true`
> means the miniapp's `manifest.json` declared `MICROPHONE` — it does NOT
> mean the user actually granted the OS permission. To detect OS-grant
> state, observe whether your subscriptions actually deliver events.
>
> OS-level grant state and `request(...)` are deferred to a future round.
> Their additions will land additively on this same module — `isGranted(...)`
> / `request(...)` alongside the existing `has(...)` / `getAll(...)` —
> without renaming today's surface.

Source: [mobile/modules/miniapp/src/modules/permissions.ts](../../mobile/modules/miniapp/src/modules/permissions.ts)

---

## Quick start

```ts
import {MiniappSession, createTransport} from "@mentra/miniapp"

const session = new MiniappSession({transport: createTransport()})
await session.connect()

if (!session.permissions.has("microphone")) {
  console.warn("MICROPHONE not declared — transcription will be rejected")
}

const unsubUpdate = session.permissions.onUpdate((perms) => {
  console.log("manifest perms changed", perms)
})

const unsubErr = session.permissions.onPermissionError((err) => {
  console.error(
    `[${err.code}] ${err.message} (perm=${err.permission}, op=${err.operation})`,
  )
})

// later
unsubUpdate()
unsubErr()
```

---

## API

### `has(type)` — `boolean`

True iff the named permission is declared in the miniapp's manifest.
Synchronous; reads the cached manifest record populated at `CONNECT_ACK`
and updated by any inbound `PERMISSIONS_UPDATE` push.

**Parameters:**
- `type: PermissionType` — one of the lowercase canonical keys.

```ts
type PermissionType = "location" | "microphone" | "camera" | "notifications" | "calendar"
type PermissionRecord = Record<PermissionType, boolean>
```

Manifest entries map onto these canonical keys as follows:

| Manifest key | Canonical |
| --- | --- |
| `MICROPHONE` | `microphone` |
| `CAMERA` | `camera` |
| `LOCATION`, `BACKGROUND_LOCATION` | `location` |
| `READ_NOTIFICATIONS`, `POST_NOTIFICATIONS` | `notifications` |
| `CALENDAR` | `calendar` |

`has()` is "do I have *any* form of this permission declared" — so
`BACKGROUND_LOCATION` alone is enough to make `has("location")` true.

---

### `getAll()` — `PermissionRecord`

Full record of declared permissions as a fresh shallow copy. Mutating the
returned object does not affect internal state.

```ts
const perms = session.permissions.getAll()
// → { location: false, microphone: true, camera: false, notifications: false, calendar: false }
```

---

### `onUpdate(handler)` — `UnsubscribeFn`

Subscribe to declared-permission updates. Fires when the cached record
changes — usually on `CONNECT_ACK`, or when the phone pushes a
`PERMISSIONS_UPDATE` (e.g. a dev miniapp re-scanned with an updated
manifest).

Does **not** fire immediately with the current value — call `getAll()`
separately if you want the seed.

**Handler signature:** `(perms: PermissionRecord) => void`

**Returns:** `UnsubscribeFn` — call to detach.

---

### `onPermissionError(handler)` — `UnsubscribeFn`

Subscribe to typed `PERMISSION_NOT_DECLARED` errors. Sugar over the
existing session `"error"` event, filtered to the permission-error code.

**Handler signature:** `(err: PermissionErrorEvent) => void`

```ts
interface PermissionErrorEvent {
  /** The error code. Always PERMISSION_NOT_DECLARED today; reserved for future codes. */
  code: string
  message: string
  /** The manifest permission name (UPPER_CASE) that was missing. */
  permission?: string
  /** The subscription / operation that triggered the rejection. */
  subscription?: string
  operation?: string
}
```

**Returns:** `UnsubscribeFn` — call to detach.

---

## Errors

| Code | Where | Meaning |
| --- | --- | --- |
| `PERMISSION_NOT_DECLARED` | Session `"error"` event, surfaced typed via `onPermissionError` | A subscription or operation required a manifest permission that the miniapp's `manifest.json` does not declare. |

This module does **not** throw synchronously; it's an observation /
filtering surface. Gated domain modules (e.g. `session.navigation`) are
where you'll see `PERMISSION_NOT_DECLARED` thrown sync.

---

## Wire-level reference

This module is read-only — it emits no requests. It observes:

| Push type | Effect |
| --- | --- |
| `CONNECT_ACK` | Seeds the cached `PermissionRecord` and fires `onUpdate` (when the record changed from defaults). |
| `PERMISSIONS_UPDATE` | Replaces the cached `PermissionRecord` and fires `onUpdate`. |
| `ERROR` with `code: "PERMISSION_NOT_DECLARED"` | Routed to `onPermissionError` handlers. |

---

## Tests

_No integration tests yet._
