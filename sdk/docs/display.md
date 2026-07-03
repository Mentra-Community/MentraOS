# `session.display`

Glasses display for miniapps. The primary API is `render(elements, options?)`
— replace-the-frame scene rendering with host-side diffing. A small set of
legacy one-shot layouts (`showTextWall`, `showBitmapView`, `clear`) remains
and is converted to single-element scenes by the phone.

Mirrors cloud SDK v3's `DisplayManager` naming. Was called `LayoutManager` /
`session.layouts` before the v3-alignment round.

Source: [mobile/modules/miniapp/src/modules/display.ts](../../mobile/modules/miniapp/src/modules/display.ts)

---

## Quick start

```ts
import {MiniappSession, createTransport} from "@mentra/miniapp"

const session = new MiniappSession({transport: createTransport()})
await session.connect()

// The scene API: describe the whole frame; the host diffs it against the
// previous one. Stable ids update in place; render([]) clears.
const d = session.capabilities?.display
session.display.render([
  {type: "text",  id: "stats", box: {x: 12, y: 9, w: 200, h: 40}, text: "863 m · 11 min"},
  {type: "image", id: "map",   box: {x: 335, y: 14, w: 150, h: 150}, data: mapPng},
  {type: "rect",  id: "frame", box: {x: 4, y: 4, w: 560, h: 280}, style: {border: 2, radius: 6}},
])

// Clear.
session.display.render([])

// Legacy one-shot layouts (host-converted to scenes).
session.display.showTextWall("Hello, world")
session.display.showBitmapView(pngBase64, {x: 476, y: 188, width: 100, height: 100})
session.display.clear()
```

---

## API

### `render(elements, options?)` — `Promise<RenderResult>`

Render a whole scene of positioned elements — replace-the-frame.

Each call describes everything that should be on screen; the host diffs it
against the previous frame per device (elements with a stable `id` update in
place; elements you stop sending are removed). There is no lifecycle to manage
and no remove calls — `render([])` clears.

Coordinates are raw pixels on the device's drawable canvas — read
`session.capabilities.display` (populated on the `"ready"` event) for the real
width/height and element budgets. Out-of-bounds boxes are clamped and
over-budget elements are dropped tail-first; both are reported via the result,
never silently. On devices that can't position content
(`capabilities.display.canPosition === false`), the host degrades the scene to
a full-view text layout.

Awaiting is OPT-IN — a plain fire-and-forget call is fine. The returned
promise **never rejects**; failures resolve as `{status: "blocked", reason}`.

**Parameters:**
- `elements: RenderElement[]`
- `options?: RenderOptions` — `{view?, durationMs?}`

---

### `showTextWall(text, options?)` — `void`

Shows a single block of text filling the glasses display.

**Parameters:**
- `text: string`
- `options?: DisplayOptions`

Fire-and-forget; no ack.

---

### `showBitmapView(data, options?)` — `void`

Shows a bitmap. Phone SGC handles conversion to glasses-native format.
Optional `x`/`y`/`width`/`height` position and size the bitmap's container;
omit them for default placement.

**Parameters:**
- `data: string` — base64-encoded PNG/JPEG.
- `options?: BitmapOptions` — `DisplayOptions` plus `x`, `y`, `width`, `height`.

Fire-and-forget; no ack.

---

### `clear(view?)` — `void`

Clears the specified view.

**Parameters:**
- `view?: ViewType` — defaults to `"main"`.

Fire-and-forget; no ack.

---

## Types

```ts
type ViewType = "main" | "dashboard"

type DisplayBreakMode = "character" | "character-no-hyphen" | "word" | "strict-word"

// ── render() ──────────────────────────────────────────────────────────────

/** Pixel-space bounding box on the device's drawable canvas. */
interface RenderBox {
  x: number
  y: number
  w: number
  h: number
}

interface RenderTextStyle {
  border?: number        // border width in px (0/absent = none)
  radius?: number        // border corner radius in px
  overflow?: "clip" | "ellipsis"  // default "clip"
  breakMode?: DisplayBreakMode    // line-break policy for host-side wrapping
}

interface RenderRectStyle {
  border?: number
  radius?: number
}

type RenderElement =
  | {type: "text"; id?: string; box: RenderBox; text: string; style?: RenderTextStyle}
  | {type: "image"; id?: string; box: RenderBox; data: string}  // data: base64 PNG/JPEG
  | {type: "rect"; id?: string; box: RenderBox; style?: RenderRectStyle}

interface RenderOptions {
  view?: ViewType
  durationMs?: number    // auto-clear after this many ms
}

interface RenderResult {
  status: "displayed" | "blocked"  // "displayed" = accepted and sent to the
                                   // device — NOT a render confirmation
  degraded?: boolean               // host adjusted the scene (clamp/drop/degrade)
  dropped?: string[]               // ids of dropped elements — never silent
  reason?: string                  // why blocked
}

// ── legacy one-shot layouts ───────────────────────────────────────────────

// Layout types this SDK still emits. Hosts accept a wider historical set
// (double_text_wall, reference_card, dashboard_card, positioned_text) from
// older bundles.
type LayoutType = "text_wall" | "bitmap_view" | "clear_view"

interface DisplayOptions {
  view?: ViewType
  durationMs?: number
  breakMode?: DisplayBreakMode  // text_wall only
}

interface BitmapOptions extends DisplayOptions {
  x?: number
  y?: number
  width?: number
  height?: number
}
```

---

## Errors

`render()` never rejects — every failure (arbitration loss, timeout,
disconnect) resolves as `{status: "blocked", reason}`.

The legacy `show*` methods have no synchronous throws. They are
fire-and-forget over the one-shot envelope path; the phone runtime swallows
malformed layouts silently rather than rejecting back to the miniapp.

---

## Wire-level reference

For host implementors — two request shapes:

**`render()`** emits a `RENDER` request envelope with a `requestId`; the host
replies with `REQUEST_RESULT` carrying the `RenderResult` once display
arbitration settles it:

```jsonc
{
  "payload": {
    "type": "miniapp_render",
    "view": "main",            // or "dashboard"
    "elements": [ { "type": "text", "id": "stats", "box": {"x": 12, "y": 9, "w": 200, "h": 40}, "text": "..." } ],
    "durationMs": 5000         // optional
  },
  "requestId": "…"
}
```

**Legacy layouts** emit the same `DISPLAY` one-shot envelope as before, with
the discriminating `layoutType` inside `layout` (no `REQUEST_RESULT`):

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
| `render` | `RENDER` | `options.view ?? "main"` | — (elements array) |
| `showTextWall` | `DISPLAY` | `options.view ?? "main"` | `text_wall` |
| `showBitmapView` | `DISPLAY` | `options.view ?? "main"` | `bitmap_view` |
| `clear` | `DISPLAY` | `view ?? "main"` | `clear_view` |

The host converts every `DISPLAY` layout into a scene internally, so both
shapes flow through the same per-device scene pipeline. Hosts must also keep
accepting the historical layout types (`double_text_wall`, `reference_card`,
`dashboard_card`, `positioned_text`) — bundles packed with older SDKs still
send them; only the SDK methods were removed.

---

## Tests

Host-side scene pipeline: `mobile/src/__tests__/displayScene.test.ts` (diff /
clamp / budget / degrade / sugar-equivalence goldens) and
`mobile/src/__tests__/displaySceneWiring.test.ts` (runtime → bridge wiring).
