# `session.location`

Phone location events for miniapps. Exposes both a continuous `onUpdate`
subscription and a one-shot `getOnce()` poll over
`MiniappRequestType.LOCATION_POLL`.

The SDK module is a thin pass-through over the bridge — the phone runtime
owns the GPS subscription and fans fixes out to the miniapp's stream.

Source: [mobile/modules/miniapp/src/modules/location.ts](../../mobile/modules/miniapp/src/modules/location.ts)

---

## Quick start

```ts
import {MiniappSession, createTransport} from "@mentra/miniapp"

const session = new MiniappSession({transport: createTransport()})
await session.connect()

// Seed the UI with an immediate fix.
const fix = await session.location.getOnce()
console.log(`at ${fix.lat}, ${fix.lng}`)

// Then stream updates.
const unsub = session.location.onUpdate((data) => {
  console.log(`tick ${data.lat}, ${data.lng}`)
})

// later
unsub()
```

---

## Manifest

Location requires `LOCATION` in the miniapp manifest. Both `onUpdate` and
`getOnce()` go through the phone runtime, which rejects with
`PERMISSION_NOT_DECLARED` when the manifest is missing it.

```json
{
  "permissions": ["LOCATION"]
}
```

---

## API

### `hasPermission` — `boolean`

True iff `LOCATION` is declared in the miniapp's manifest. Synchronous;
reads the cached manifest record populated at `CONNECT_ACK`.

```ts
if (!session.location.hasPermission) {
  // location features won't work — prompt the user to update the manifest
}
```

---

### `onUpdate(handler)` — `UnsubscribeFn`

Subscribes to continuous location updates. Fires once per phone-side fix.

**Handler signature:** `(data: LocationData) => void`

```ts
interface LocationData {
  lat: number
  lng: number
  /** Accuracy in meters, if the platform reported it. */
  accuracy?: number
  /** Unix ms timestamp of the fix. */
  timestamp?: number
  /** Set when this event is a response to a single-location request. */
  correlationId?: string
}
```

**Returns:** `UnsubscribeFn` — call to detach.

---

### `getOnce()` — `Promise<LocationData>`

Requests a single location fix. Resolves with the next available reading
from the phone. Useful at app load to seed UI before a continuous stream of
updates begins.

**Returns:** `LocationData` (shape above).

---

## Errors

| Code | Where | Meaning |
| --- | --- | --- |
| `PERMISSION_NOT_DECLARED` | `getOnce` (rejected Promise), `onUpdate` (phone-side `ERROR` push) | `LOCATION` missing from miniapp manifest. |

Unlike navigation, this module does not throw `PERMISSION_NOT_DECLARED`
synchronously — the phone runtime is the gate. Failed requests surface as
rejected Promises from `getOnce()` or as an async `ERROR` envelope when
subscribing without permission.

---

## Wire-level reference

For host implementors — request/response message types this module emits:

| Method | Request type | Response |
| --- | --- | --- |
| `getOnce` | `LOCATION_POLL` | `REQUEST_RESULT` with `data: LocationData` |

Streams:

| Subscribe | Stream type | Payload |
| --- | --- | --- |
| `onUpdate` | `LOCATION_UPDATE` | `LocationData` |

> Note: the phone-side subscription envelope rewrites `LOCATION_UPDATE` to
> `{stream: "location_stream", rate: "realtime"}` on the way out. Miniapp
> authors never see this; the wire-level stream name on inbound events is
> still `location_update`.

---

## Tests

_no integration tests yet_
