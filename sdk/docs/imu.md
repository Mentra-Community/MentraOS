# `session.imu`

Inertial-measurement-unit events from the glasses. V1 exposes head-up /
head-down position only; acceleration and orientation events are
wire-protocol future work.

The phone-side runtime forwards IMU samples from the glasses; the SDK module
is a thin pass-through over the bridge.

Source: [mobile/modules/miniapp/src/modules/imu.ts](../../mobile/modules/miniapp/src/modules/imu.ts)

---

## Quick start

```ts
import {MiniappSession, createTransport} from "@mentra/miniapp"

const session = new MiniappSession({transport: createTransport()})
await session.connect()

const unsub = session.imu.onHeadPosition((data) => {
  if (data.position === "up") {
    console.log("user looked up")
  } else {
    console.log("user looked down")
  }
})

// later
unsub()
```

---

## API

### `onHeadPosition(handler)` — `UnsubscribeFn`

Subscribes to head-position events from the glasses' IMU.

**Handler signature:** `(data: HeadPositionData) => void`

```ts
interface HeadPositionData {
  position: "up" | "down"
}
```

**Returns:** `UnsubscribeFn` — call to detach.

---

## Errors

This module declares no synchronous throws and no stream-side error events.
Subscription rejection (if any) surfaces through the generic session error
channel.

---

## Wire-level reference

For host implementors — this module is stream-only.

| Subscribe | Stream type | Payload |
| --- | --- | --- |
| `onHeadPosition` | `HEAD_POSITION` | `HeadPositionData` |

Acceleration and orientation events are not yet defined in the wire
protocol.

---

## Tests

_no integration tests yet_
