# `session.glasses`

Device-state events for the glasses hardware itself. Reports battery level +
charging state and connection status (connected/disconnected, model name).

The phone has its own battery and connection telemetry on `session.phone` —
use this module specifically for what's happening on the glasses.

Source: [mobile/modules/miniapp/src/modules/glasses.ts](../../mobile/modules/miniapp/src/modules/glasses.ts)

---

## Quick start

```ts
import {MiniappSession, createTransport} from "@mentra/miniapp"

const session = new MiniappSession({transport: createTransport()})
await session.connect()

const unsubBattery = session.glasses.onBattery((data) => {
  console.log(`Glasses battery: ${data.level}% (charging=${data.charging})`)
})

const unsubConnection = session.glasses.onConnection((data) => {
  if (data.connected) {
    console.log(`Connected to ${data.modelName ?? "glasses"}`)
  } else {
    console.log("Glasses disconnected")
  }
})

// later
unsubBattery()
unsubConnection()
```

---

## API

### `onBattery(handler)` — `UnsubscribeFn`

Subscribes to the glasses battery stream. Fires whenever the glasses report
a battery-level or charging-state change.

**Handler signature:** `(data: BatteryData) => void`

```ts
interface BatteryData {
  level: number
  charging: boolean
}
```

**Returns:** `UnsubscribeFn` — call to detach.

---

### `onConnection(handler)` — `UnsubscribeFn`

Subscribes to the glasses connection stream. Fires whenever the connected
state flips, and on initial bind once the phone knows.

**Handler signature:** `(data: ConnectionData) => void`

```ts
interface ConnectionData {
  connected: boolean
  modelName?: string
}
```

**Returns:** `UnsubscribeFn` — call to detach.

---

## Errors

This module has no synchronous throws. Subscriptions return an
`UnsubscribeFn` directly; no permission gate applies.

| Code | Where | Meaning |
| --- | --- | --- |
| — | — | None. |

---

## Wire-level reference

For host implementors — streams this module subscribes to:

| Subscribe | Stream type | Payload |
| --- | --- | --- |
| `onBattery` | `GLASSES_BATTERY` | `BatteryData` |
| `onConnection` | `GLASSES_CONNECTION` | `ConnectionData` |

This module does not emit any request types — it is purely subscription-based.

---

## Tests

_no integration tests yet_
