# `session.heading`

Phone compass heading events for miniapps. The miniapp subscribes via
`session.heading.onUpdate(...)` and receives a stream of compass bearings in
degrees (0 = north, 90 = east).

The phone-side runtime owns the magnetometer / sensor fusion; the SDK module
is a thin pass-through over the bridge.

> **Platform:** The `HEADING_UPDATE` stream is Android-only in the wire
> protocol. Subscribing on iOS succeeds but no events fire.

Source: [mobile/modules/miniapp/src/modules/heading.ts](../../mobile/modules/miniapp/src/modules/heading.ts)

---

## Quick start

```ts
import {MiniappSession, createTransport} from "@mentra/miniapp"

const session = new MiniappSession({transport: createTransport()})
await session.connect()

const unsub = session.heading.onUpdate((data) => {
  console.log(`heading: ${data.degrees}°`)
})

// later
unsub()
```

---

## Manifest

Heading requires `LOCATION` in the miniapp manifest. Without it, the phone
runtime rejects the underlying subscribe with `PERMISSION_NOT_DECLARED`.

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
if (!session.heading.hasPermission) {
  // heading subscriptions will be rejected by the phone runtime
}
```

---

### `onUpdate(handler)` — `UnsubscribeFn`

Subscribes to continuous compass heading updates.

**Handler signature:** `(data: HeadingData) => void`

```ts
interface HeadingData {
  /** Compass heading in degrees, 0 = north, 90 = east. */
  degrees: number
}
```

**Returns:** `UnsubscribeFn` — call to detach.

---

## Errors

| Code | Where | Meaning |
| --- | --- | --- |
| `PERMISSION_NOT_DECLARED` | Phone-side rejection of the underlying `SUBSCRIBE` | `LOCATION` missing from miniapp manifest. |

This module has no synchronous throws on its own methods — permission gating
happens at the phone runtime when the `SUBSCRIBE` is processed.

---

## Platform notes

- **Android:** Full support — events stream continuously from the
  magnetometer / sensor fusion stack.
- **iOS:** `HEADING_UPDATE` is not emitted by the phone runtime. Subscribing
  is a no-op.

---

## Wire-level reference

For host implementors — this module is stream-only.

| Subscribe | Stream type | Payload |
| --- | --- | --- |
| `onUpdate` | `HEADING_UPDATE` | `HeadingData` |

---

## Tests

_no integration tests yet_
