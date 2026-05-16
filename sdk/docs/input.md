# `session.input`

Physical control events on the glasses — buttons and touch surfaces.
Future input modes (gesture, voice command, eye tracking) will extend this
module rather than spawning new top-level modules.

Touch overloads mirror cloud SDK v3's `device.onTouchEvent`. Per-gesture
filtering rides on `touch_event:<gesture>` stream variants the phone
runtime fans out alongside the bare `touch_event` stream.

Source: [mobile/modules/miniapp/src/modules/input.ts](../../mobile/modules/miniapp/src/modules/input.ts)

---

## Quick start

```ts
import {MiniappSession, createTransport} from "@mentra/miniapp"

const session = new MiniappSession({transport: createTransport()})
await session.connect()

const unsubButton = session.input.onButtonPress((data) => {
  console.log(`button ${data.buttonId} ${data.pressType}`)
})

// All touches.
const unsubTouch = session.input.onTouch((data) => {
  console.log(`touch ${data.kind}`)
})

// Filter by gesture.
const unsubClick = session.input.onTouch("click", (data) => {
  console.log("clicked")
})

// Multiple gestures, single subscription.
const unsubScroll = session.input.onTouch(["scroll_top", "scroll_bottom"], (data) => {
  console.log(`scrolled ${data.kind}`)
})

// later
unsubButton()
unsubTouch()
unsubClick()
unsubScroll()
```

---

## API

### `onButtonPress(handler)` — `UnsubscribeFn`

Subscribes to physical button press events.

**Handler signature:** `(data: ButtonPressData) => void`

```ts
interface ButtonPressData {
  buttonId: string
  pressType: "short" | "long"
}
```

**Returns:** `UnsubscribeFn` — call to detach.

---

### `onTouch(handler)` / `onTouch(gesture, handler)` / `onTouch(gestures, handler)` — `UnsubscribeFn`

Subscribes to touch events. Three overloads:

- `onTouch(handler)` — all touch events on the bare `touch_event` stream.
- `onTouch(gesture, handler)` — only events matching `gesture` (e.g.
  `"click"`), via the `touch_event:<gesture>` stream variant.
- `onTouch(gestures, handler)` — multiple gestures via a single
  subscription. Internally opens one stream variant per gesture and returns
  an unsubscribe that tears all of them down. Passing an empty array
  returns a no-op unsubscribe; the handler is never called.

**Handler signature:** `(data: TouchData) => void`

```ts
interface TouchData {
  kind: "click" | "double_click" | "scroll_top" | "scroll_bottom" | string
}
```

**Returns:** `UnsubscribeFn` — call to detach. For the array overload, all
underlying subscriptions are torn down; individual unsubscribe errors are
swallowed.

---

## Errors

This module has no synchronous throws. Subscriptions go through the
session's generic `_subscribe` path; any phone-side permission failure
surfaces as an async `ERROR` envelope rather than a throw at the call
site.

---

## Wire-level reference

For host implementors — stream types this module subscribes to:

| Subscribe | Stream type | Payload |
| --- | --- | --- |
| `onButtonPress` | `BUTTON_PRESS` (`"button_press"`) | `ButtonPressData` |
| `onTouch(handler)` | `TOUCH_EVENT` (`"touch_event"`) | `TouchData` |
| `onTouch(gesture, handler)` | `"touch_event:<gesture>"` (variant of `TOUCH_EVENT`) | `TouchData` |
| `onTouch(gestures, handler)` | one `"touch_event:<gesture>"` per entry | `TouchData` |

There are no request-side messages — this module is subscription-only.

---

## Tests

_no integration tests yet_
