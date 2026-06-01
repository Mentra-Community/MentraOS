# `session.led`

Control for the glasses RGB LED. Colors are named strings (the phone maps
them to per-device LED indices) and actions are "on" / "off". The API
mirrors the cloud SDK's LED module.

Source: [mobile/modules/miniapp/src/modules/led.ts](../../mobile/modules/miniapp/src/modules/led.ts)

---

## Quick start

```ts
import {MiniappSession, createTransport} from "@mentra/miniapp"

const session = new MiniappSession({transport: createTransport()})
await session.connect()

// Blink red 3 times: 200ms on, 200ms off.
await session.led.blink("red", 200, 200, 3)

// Solid green for 2 seconds.
await session.led.solid("green", 2000)

// All off.
await session.led.turnOff()
```

---

## API

### `turnOn(options?)` — `Promise<void>`

Turn an LED on with the given pattern. All parameters have defaults so
calling with no arguments is valid (red, 1000ms on, 0ms off, 1 cycle).

**Parameters:** `LedControlOptions`

```ts
interface LedControlOptions {
  color?: LedColor
  /** LED on duration in ms. */
  ontime?: number
  /** LED off duration in ms. */
  offtime?: number
  /** Number of on/off cycles. */
  count?: number
}

type LedColor = "red" | "green" | "blue" | "orange" | "white"
```

**Defaults:**

| Field | Default |
| --- | --- |
| `color` | `"red"` |
| `ontime` | `1000` |
| `offtime` | `0` |
| `count` | `1` |

**Returns:** `Promise<void>` — resolves after the request has been sent
(fire-and-forget; no ack).

> ⚠️ The promise resolves once the request has been dispatched, not when
> the LED has finished its pattern. There is no completion event.

---

### `turnOff()` — `Promise<void>`

Turn all LEDs off. Fire-and-forget — no ack.

**Returns:** `Promise<void>`.

---

### `blink(color, ontime, offtime, count)` — `Promise<void>`

Blink pattern — repeats `count` times alternating `ontime` ms on and
`offtime` ms off. Sugar over `turnOn({color, ontime, offtime, count})`.

**Parameters:**

| Name | Type |
| --- | --- |
| `color` | `LedColor` |
| `ontime` | `number` (ms) |
| `offtime` | `number` (ms) |
| `count` | `number` |

**Returns:** `Promise<void>`.

---

### `solid(color, duration)` — `Promise<void>`

Solid LED for a fixed duration. Sugar over
`turnOn({color, ontime: duration, offtime: 0, count: 1})`.

**Parameters:**

| Name | Type |
| --- | --- |
| `color` | `LedColor` |
| `duration` | `number` (ms) |

**Returns:** `Promise<void>`.

---

## Errors

All LED methods dispatch as one-shot requests with no response. There are
no synchronous throws and no per-request error events on this module.

| Code | Where | Meaning |
| --- | --- | --- |
| — | — | None. |

---

## Wire-level reference

For host implementors — request types this module emits:

| Method | Request type | Payload | Response |
| --- | --- | --- | --- |
| `turnOn` | `RGB_LED` | `{action: "on", color, ontime, offtime, count}` | — (one-shot) |
| `turnOff` | `RGB_LED` | `{action: "off"}` | — (one-shot) |
| `blink` | `RGB_LED` | `{action: "on", color, ontime, offtime, count}` | — (one-shot) |
| `solid` | `RGB_LED` | `{action: "on", color, ontime: duration, offtime: 0, count: 1}` | — (one-shot) |

This module subscribes to no streams.

---

## Tests

_no integration tests yet_
