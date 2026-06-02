# `session.display`

Glasses display layouts for miniapps. The miniapp calls
`session.display.showTextWall(...)` (or one of the other `show*` methods)
to push a layout to the glasses; `clearView(...)` removes it.

Mirrors cloud SDK v3's `DisplayManager` naming. Was called `LayoutManager` /
`session.layouts` before the v3-alignment round.

The phone-side `LocalMiniappRuntime` forwards each call to
`CoreModule.displayEvent`, which reads `event.view` and
`event.layout.layoutType`.

Source: [mobile/modules/miniapp/src/modules/display.ts](../../mobile/modules/miniapp/src/modules/display.ts)

---

## Quick start

```ts
import {MiniappSession, createTransport} from "@mentra/miniapp"

const session = new MiniappSession({transport: createTransport()})
await session.connect()

session.display.showTextWall("Hello, world")

// Two-row layout for 5s.
session.display.showDoubleTextWall("Top row", "Bottom row", {durationMs: 5000})

// Reference card with title and body.
session.display.showReferenceCard("Weather", "72°F, sunny")

// Dashboard card — auto-targets the dashboard view.
session.display.showDashboardCard("Steps", "8,142")

// Show a bitmap (base64 PNG/JPEG).
session.display.showBitmapView(pngBase64)

// Clear.
session.display.clearView()
```

---

## API

### `showTextWall(text, options?)` — `void`

Shows a single block of text filling the glasses display.

**Parameters:**
- `text: string`
- `options?: DisplayOptions`

Fire-and-forget; no ack.

---

### `showDoubleTextWall(topText, bottomText, options?)` — `void`

Two stacked text rows — top and bottom.

**Parameters:**
- `topText: string`
- `bottomText: string`
- `options?: DisplayOptions`

Fire-and-forget; no ack.

---

### `showReferenceCard(title, text, options?)` — `void`

Reference card — title plus body text.

**Parameters:**
- `title: string`
- `text: string`
- `options?: DisplayOptions`

Fire-and-forget; no ack.

---

### `showDashboardCard(leftText, rightText)` — `void`

Dashboard card — two-column layout for sections that appear in the OS
dashboard. Always targets `view: "dashboard"`; the `view` option on
`DisplayOptions` is ignored here.

**Parameters:**
- `leftText: string`
- `rightText: string`

Fire-and-forget; no ack.

---

### `showBitmapView(data, options?)` — `void`

Shows a bitmap. Phone SGC handles conversion to glasses-native format.

**Parameters:**
- `data: string` — base64-encoded PNG/JPEG.
- `options?: DisplayOptions`

Fire-and-forget; no ack.

---

### `clearView(view?)` — `void`

Clears the specified view.

**Parameters:**
- `view?: ViewType` — defaults to `"main"`.

Fire-and-forget; no ack.

---

## Types

```ts
type ViewType = "main" | "dashboard"

type LayoutType =
  | "text_wall"
  | "double_text_wall"
  | "reference_card"
  | "dashboard_card"
  | "bitmap_view"
  | "clear_view"

interface TextWall {
  layoutType: "text_wall"
  text: string
}

interface DoubleTextWall {
  layoutType: "double_text_wall"
  topText: string
  bottomText: string
}

interface ReferenceCard {
  layoutType: "reference_card"
  title: string
  text: string
}

interface DashboardCard {
  layoutType: "dashboard_card"
  leftText: string
  rightText: string
}

interface BitmapView {
  layoutType: "bitmap_view"
  /** Base64-encoded PNG/JPEG. Phone SGC converts to glasses-native format. */
  data: string
}

interface ClearView {
  layoutType: "clear_view"
}

type Layout =
  | TextWall
  | DoubleTextWall
  | ReferenceCard
  | DashboardCard
  | BitmapView
  | ClearView

interface DisplayOptions {
  view?: ViewType
  durationMs?: number
}
```

---

## Errors

This module has no synchronous throws. All methods are fire-and-forget over
the one-shot envelope path; the phone runtime swallows malformed layouts
silently rather than rejecting back to the miniapp.

---

## Wire-level reference

For host implementors — every method on this module emits the same
`DISPLAY` request envelope, with the discriminating `layoutType` inside
`layout`:

```jsonc
{
  "type": "miniapp_display",
  "view": "main",          // or "dashboard"
  "layout": { "layoutType": "text_wall", "text": "..." },
  "durationMs": 5000       // optional
}
```

| Method | Request type | `view` | `layout.layoutType` |
| --- | --- | --- | --- |
| `showTextWall` | `DISPLAY` | `options.view ?? "main"` | `text_wall` |
| `showDoubleTextWall` | `DISPLAY` | `options.view ?? "main"` | `double_text_wall` |
| `showReferenceCard` | `DISPLAY` | `options.view ?? "main"` | `reference_card` |
| `showDashboardCard` | `DISPLAY` | `"dashboard"` (forced) | `dashboard_card` |
| `showBitmapView` | `DISPLAY` | `options.view ?? "main"` | `bitmap_view` |
| `clearView` | `DISPLAY` | `view ?? "main"` | `clear_view` |

All calls go through `session.sendOneShot(...)` — there is no
`REQUEST_RESULT` reply.

---

## Tests

_no integration tests yet_
