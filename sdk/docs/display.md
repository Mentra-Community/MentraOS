# `session.display`

Glasses display for miniapps. One API: `render(elements, options?)` —
replace-the-frame scene rendering with host-side diffing.

The legacy one-shot `show*` layout methods (text walls, cards, positioned
bitmaps, `clear`) were removed from the SDK once nothing first-party or
known-external called them; hosts still accept the historical
`miniapp_display` wire shape from bundles packed with older SDKs (see
Wire-level reference).

Mirrors cloud SDK v3's `DisplayManager` naming. Was called `LayoutManager` /
`session.layouts` before the v3-alignment round.

Source: [mobile/modules/miniapp/src/modules/display.ts](../../mobile/modules/miniapp/src/modules/display.ts)

---

## Quick start

```ts
import {MiniappSession, createTransport} from "@mentra/miniapp"

const session = new MiniappSession({transport: createTransport()})
await session.connect()

// Describe the whole frame; the host diffs it against the previous one.
// Stable ids update in place; render([]) clears.
session.display.render([
  {type: "text",  id: "stats", box: {x: 12, y: 9, w: 200, h: 40}, text: "863 m · 11 min"},
  {type: "image", id: "map",   box: {x: 335, y: 14, w: 150, h: 150}, data: mapPng},
  {type: "rect",  id: "frame", box: {x: 4, y: 4, w: 560, h: 280}, style: {border: 2, radius: 6}},
])

// A "text wall": one full-canvas text element.
const d = session.capabilities?.display
session.display.render([
  {type: "text", id: "wall", box: {x: 0, y: 0, w: d?.width ?? 576, h: d?.height ?? 288}, text: "Hello, world"},
])

// Clear.
session.display.render([])
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

## Types

```ts
type ViewType = "main" | "dashboard"

type DisplayBreakMode = "character" | "character-no-hyphen" | "word" | "strict-word"

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
```

---

## Errors

`render()` never rejects — every failure (arbitration loss, timeout,
disconnect) resolves as `{status: "blocked", reason}`.

---

## Wire-level reference

For host implementors. `render()` emits a `RENDER` request envelope with a
`requestId`; the host replies with `REQUEST_RESULT` carrying the
`RenderResult` once display arbitration settles it:

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

**Legacy compat.** Hosts must ALSO keep accepting the historical `DISPLAY`
(`miniapp_display`) one-shot envelope — `{type, view, layout: {layoutType,
…}, durationMs?}` with layout types `text_wall`, `double_text_wall`,
`reference_card`, `dashboard_card`, `bitmap_view`, `positioned_text`,
`clear_view`. Bundles packed with older SDKs and cloud-shaped layouts still
send these; the host converts each into a scene internally, so both shapes
flow through the same per-device pipeline. Only the SDK methods were removed.

---

## Tests

Host-side scene pipeline: `mobile/src/__tests__/displayScene.test.ts` (diff /
clamp / budget / degrade / sugar-equivalence goldens) and
`mobile/src/__tests__/displaySceneWiring.test.ts` (runtime → bridge wiring).
