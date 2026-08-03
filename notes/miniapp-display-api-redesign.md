# Miniapp SDK Display API Redesign — Design Doc

**Status:** Draft — analysis complete, decisions made, not yet implemented
**Scope:** `@mentra/miniapp` SDK display surface, host pipeline (island module), native SGC layer
**Out of scope:** Nex firmware (developed separately — we assume text/bitmap verbs in its SGC), cloud SDK (`@mentra/sdk`) display path

---

## 1. Problem

The miniapp SDK display API got mangled as G2 support was bolted on. Developers face **three overlapping APIs** that all funnel into a pipeline whose intermediate representation is *"one layout at a time"* — while modern hardware (G2, NIMO, Nex) renders *"a scene of positioned elements."* Every G2 hack in the codebase is a workaround for that mismatch.

We need **one API** that works as similarly as possible across glasses. G1/Z100 are legacy hardware being phased out; the design optimizes for **G2, NIMO, and Mentra Display (Nex)** with a degradation path for the old devices.

### 1.1 What developers see today

| Surface | Model | Wire type | Status |
|---|---|---|---|
| `session.display` (`mobile/modules/miniapp/src/modules/display.ts`) | Legacy cloud-SDK layouts (`text_wall`, `double_text_wall`, `reference_card`, `dashboard_card`, `bitmap_view`) **plus** G2 bolt-ons (`positioned_text` via `showTextAt`, `x/y/w/h` on bitmaps) | `miniapp_display` | What everyone actually uses |
| `session.canvas` (`modules/canvas.ts`) | Op-based (`show_text`/`show_bitmap`/`show_page`/`clear`) with `page_id` + `Box` | `miniapp_canvas` | Used by one miniapp (`everything`); `show_page` dead-ends host-side (`LocalMiniappRuntime.ts:1663` — acks, renders nothing) |
| `session.dashboard` (`modules/dashboard.ts`) | `setContent(mode, content)` | `miniapp_dashboard_content_update` | Documented noop |

`canvas` is a fiction: host-side `handleCanvas` (`LocalMiniappRuntime.ts:1631`) translates its ops back into the same layout union (`show_text → positioned_text`, `show_bitmap → bitmap_view`, `clear → clear_view`) and funnels through the same `LocalDisplayManager.request()`. Two vocabularies, one pipeline.

### 1.2 Mangle inventory

- **G2 leaked into the "generic" API.** `showTextAt` is documented "G2 only" (`display.ts:186-193`); `BitmapView` docs carry the magic rule *"On G2, width>200 (or height>100) renders in quad mode"* (`display.ts:68`); `borderWidth`/`borderRadius` are G2 container properties; the 576×288 canvas is hard-baked into JSDoc.
- **`positioned_text` needs a native bypass hack** — `DeviceManager.swift:1099-1112` routes it *around* the single `viewState` slot straight to the SGC, because the constantly-refreshing `text_wall` would clobber it every frame. The single-slot IR fighting multi-element reality.
- **Miniapps carry G2 firmware workarounds in app code.** The navigation miniapp hardcodes G2 rects (`{x: 576-100, y: 0, w: 100, h: 100}`), blanks tiles with white bitmaps because G2 reuses same-rect containers, and sequences `clear`-then-redraw with `setTimeout`s for container teardown (`miniapps/navigation/src/background/managers/DisplayManager.ts:12-16, 79-101, 187-205`).
- **Docs are stale**: `sdk/docs/display.md` and README document a nonexistent `clearView` (real method is `clear`, `display.ts:203`), and omit `showTextAt`, `breakMode`, and bitmap positioning.
- **`GlassesCapabilities` is untyped** (`session.ts:55-57` — `[key: string]: unknown`); every miniapp re-rolls its own `hasDisplay`/model-name shape-guessing (teleprompter `DisplayProfiles.ts:37-51`, merge `index.ts:691-704`, mentra-ai `GlassesController.ts:88`). No way to ask "can I position things?"
- **Data inconsistencies**: capability profile says G2 = 640×200 / 5 lines (`even-realities-g2.ts`), display-utils profile says 8 lines (`display-utils/src/profiles/g2.ts`), the native default container is 576×288, and RE demos place containers at y=230 — the firmware canvas is bigger than any declared number.
- **`breakMode`** silently applies to only 3 of 7 layout types (`display.ts:208-210`); canvas has no equivalent.

### 1.3 What works and must be preserved

The host **text adaptation layer**: `DisplayProcessor` + `display-utils` (shared with cloud) do pixel-accurate per-device text measurement, wrapping, kinsoku, and column composition against per-device font metrics. The event-driven native queue (post-PR #3207) handles pacing per device. The altitude is right: **the phone owns layout and wrapping; glasses render.**

The current pipeline, for reference:

```
miniapp SDK (display.*/canvas.*)
  → envelope → LocalMiniappRuntime.handleDisplay/handleCanvas
  → LocalDisplayManager.request   (boot queue + core/bg arbitration + duration/expiry)
  → DisplayProcessor.processDisplayEvent   (device-profile text wrap, double→single composition, placeholders)
  → BluetoothSdk.displayEvent
  → native DeviceManager.displayEvent → viewState dedup → sendCurrentState layout switch
  → per-device SGC (G1 binary / G2 EvenHub protobuf containers / Nex protobuf / Mach1),
    sendPositionedText defaulting to no-op on non-G2
```

---

## 2. Hardware matrix

| | **G1** | **Z100/Mach1** | **G2** | **NIMO (dynamic UI)** | **Nex / Mentra Display** |
|---|---|---|---|---|---|
| Model | one text wall (top-left) + fullscreen 1-bit BMP | text only, **no bitmap** | **retained containers**: page → create/rebuild → update-in-place → shutdown | **immediate-mode draw list**: full frame of positioned objects, `is_clear_all_obj` | our firmware (external team); today: protobuf `DisplayText` + BMP |
| Canvas | 576×135 usable | 390px wrap, 7 lines | 576×288+ (declared 640×200 — wrong) | 540×280 panel, **500×220 drawable** | 640×480 panel; public exposure TBD (less, for pupil/waveguide margin) |
| Positioned text | ✗ | ✗ | ✓ text box w/ border, radius, padding; **no font size**; max 6 | ✓ text box w/ 4 font sizes (charset caveats per size), alpha 0–255 | ✓ (OEM spec: x/y + font_code + size + align) |
| Shapes | ✗ | ✗ | ✗ (container borders only — border+radius box ≈ rect) | ✓ line, rect (radius, fill), circle, per-object alpha | ✓ (OEM spec: line/rect/circle, intensity 0–15) |
| Images | fullscreen 1-bit — path exists both platforms but **broken in practice** (format must be byte-perfect; see §3.4.8) | ✗ declared — but Ultralite SDK `canvas.drawBackground` is plumbed in `Mach1.swift`/`.kt`, never wired | ✓ positioned, max 4, 4-bit gray, 4096B fragments + ACK | ✓ positioned, 2bpp + zlib | ✓ (OEM spec: positioned, raw/RLE, chunked + ACK, cached by id) |
| Partial update | ✗ | ✗ | ✓ update text/image in place | ✗ (full frame resend) | ✓ (OEM spec: retained ids + `update` + atomic `commit`) |
| Unused headroom | — | — | firmware **ListContainer** (scrollable selectable menus + selection events) — unexposed | — | we control the spec |

Sources: G2 = `mobile/modules/bluetooth-sdk/ios/Source/sgcs/G2.swift` + `local/g2_re/ae_g2_rev/proto/.../EvenHub.proto`; NIMO = `local/NIMO/Mentra接入Nimo智能眼镜-动态创建UI布局接入指导.pdf` (dynamic-UI protocol, app id 253) + `local/NIMO/current_nimo_sdk/docs/protocol/`; Nex target = `mintlify-docs/glasses-oems/firmware-spec.mdx`.

### 2.1 NIMO dynamic-UI protocol (the new PDF, summarized)

Immediate-mode frame protocol on app id 253 (`UI_SCREEN_ID_DYNAMIC`):

- Flow: open app (`0x07/0x01`) → glasses report enter → app sends UI updates (`0x07/0x04`) → glasses ack per frame → input events up (`0x06/0x01`: head up/down, L/R click, L/R long-press) → exit (`0x07/0x03`).
- Frame = `total_obj_num` + `is_clear_all_obj` + object array. Object types: line (0), rect (1, border width + corner radius + fill), circle (2), text label (3, x/y/w/h box + `language_type` + `font_size` enum + text), bitmap (4, x/y/w/h + chunking fields reserved).
- Per-object `intensity` 0–255 (alpha).
- Font sizes quantized: 0=16px (full charset), 1=20px (ASCII only), 2=24px (ASCII + a few CJK units), 3=32px (ASCII + °).
- Full-screen refresh; no retained elements or partial update — every change resends the frame's object list.
- Images: 2bpp (4 gray levels) + zlib, per `IMAGE_PROTOCOL.en.md`.

NIMO also has a legacy fixed-widget model (dashboard/nav/translate/teleprompter apps with resId slots) in `current_nimo_sdk` — **not** a build target for this API; the dynamic-UI protocol is.

### 2.2 The convergence

G2 (retained containers), NIMO (immediate draw list), and our own OEM Display Protocol spec (`mintlify-docs/glasses-oems/firmware-spec.mdx` — immediate draws + optional retained ids + atomic commit) all describe the same thing: **a monochrome frame of positioned text boxes and images, plus simple shapes on 2 of 3.** G2 is the only one missing shapes, and its bordered containers cover rects. NIMO's protocol is nearly a strict subset of the OEM spec.

Differences to bridge:

1. **Retained vs immediate** — G2 wants diffs; NIMO wants full frames. A *declarative* API absorbs both: the dev describes the frame; the host diffs per device. `G2.swift` already works this way internally (reconcile loop; display ops are pure state mutations, `G2.swift:1578-1603, 2160-2230`) — the pattern just isn't surfaced.
2. **Fonts** — G2: one fixed size; NIMO: 4 quantized sizes with charset limits; Nex: whatever ships. Resolution: v1 ships **no font-size knob at all** (decision 5); if/when one is added it must be a *hint* the host quantizes per device against capability-reported sizes.
3. **Coordinates** — different canvas geometries (§4, decision 1).

---

## 3. Design

### 3.1 Developer-facing API: one declarative `render(scene)`

Immediate-mode mental model, last-wins per app, no lifecycle to manage:

```ts
const result = await session.display.render([
  {type: "text",  id: "title", box: {x: 0, y: 0, w: 500, h: 40},  text: "Turn left"},
  {type: "text",  id: "stats", box: {x: 0, y: 180, w: 500, h: 40}, text: "2.1 km · 14 min", style: {border: 1, radius: 4, overflow: "ellipsis"}},
  {type: "image", id: "map",   box: {x: 400, y: 0, w: 100, h: 100}, data: pngBase64},  // base64 PNG (§3.4.3)
  {type: "rect",  box: {x: 0, y: 176, w: 500, h: 44}, style: {radius: 4, fill: false}},
], {view: "main", durationMs?})
// result: {status: "displayed" | "queued" | "blocked", degraded?: boolean, dropped?: string[], reason?}
// "displayed" = accepted & sent to the device, NOT a render confirmation (only NIMO acks frames; don't promise what G1/G2 can't report)
// awaiting is OPT-IN; plain fire-and-forget call works
```

- **`render` replaces the frame.** Matches NIMO natively and matches how miniapps already think (captions/teleprompter re-send full text each tick). `render([])` ≡ `clear()`; `clear()` stays as sugar.
- **Optional `id`s enable diffing** per the normative contract in §3.4: same id ⇒ update content in place (G2 `updateTextData`, no page rebuild, no flicker); changed structure ⇒ G2 `rebuildPage`, NIMO full-frame resend. The host does what navigation's app-level hacks do today — correctly, once, for everyone.
- **Text is a box + wrap policy, never dev-pre-wrapped.** `DisplayProcessor`/`display-utils` keep doing measurement per device font metrics. `breakMode` becomes a per-element style, applied uniformly. Overflow policy is explicit (§3.4.2).
- **No `align`, no font `size` in v1.** G2 `TextContainerProperty` has neither field; NIMO labels have no alignment and only 4 quantized sizes with per-size charset caveats. Shipping style knobs that render approximately-wrong (space-padded "centering" with a proportional font) or inconsistently on the two primary targets loses developer trust. Devs position/center the *box* instead. Both can be added later as additive style fields once backends support them; capabilities will advertise them when they exist.
- **Awaitable result (opt-in).** Today's #1 "why isn't my display showing" is the arbitration layer silently eating frames (boot queue, background lock, other app owns display). The envelope protocol already supports `requestId` + `REQUEST_RESULT`, so `render()` returns a promise resolving `{status, reason?}`; not awaiting keeps fire-and-forget behavior.
- **Element union is v1-minimal but extensible**: `text | image | rect` now; `line | circle | list` reserved (see decisions 2–3).
- **Legacy sugar survives**: `showTextWall` / `showReferenceCard` compile onto `render` (one text element filling the default region); `showDoubleTextWall` compiles to two side-by-side boxed text elements (real containers on G2/NIMO, column-composed on G1/Z100 — §3.4.8). Zero migration for the 90% case; captions/teleprompter/kawaii don't change.
- **`await display.measure(text, style, widthPx)` helper** exposes the host's per-device text measurement (line count, fit) so devs never hand-tune against one device — the navigation-miniapp failure mode. **Async by necessity**: font metrics live host-side; this is an RPC, never a sync call.

### 3.2 Host-side IR: the OEM Display Protocol DrawOp list

Make the internal contract literally the `DrawOp` frame from `mintlify-docs/glasses-oems/firmware-spec.mdx:290-308` (draw ops + optional retained ids + atomic commit). One IR, N backends:

```
SDK scene ──compile──▶ DrawOp frame ──┬─▶ Nex / future OEMs: passthrough (draw_* + commit; retained ids + update)
                                      ├─▶ G2 adapter: DrawOps → EvenHub container reconcile
                                      │     text → TextContainer, image → ImageContainer,
                                      │     rect → bordered empty container
                                      ├─▶ NIMO adapter: DrawOps → dynamic-UI frame (appid 253, is_clear_all_obj=1)
                                      └─▶ G1/Z100 degrade: text elements in reading order (ColumnComposer for rows)
                                            → join → wrap → text wall; images/rects dropped + reported (§3.4.8)
```

New OEM = new adapter — or no adapter, if they implement the spec. The `positioned_text` viewState bypass, the quad-mode magic, and the single-slot model all dissolve because the IR *is* a scene.

### 3.3 Typed display capabilities

Miniapps must be able to query this (plumb through `session.capabilities`; populate on `"ready"` — capabilities are null in `start()`):

```ts
display: {
  width: number, height: number,        // real public drawable canvas (fix the 640×200-vs-576×288 lie)
  canPosition: boolean,                 // false → only sugar methods render
  maxTextElements: number,              // G2: 6 — rects share this pool on G2 (§3.4.6)
  maxImageElements: number,             // G2: 4
  shapes: ("rect" | "line" | "circle")[],  // G2: ["rect"]; NIMO/Nex: all three eventually
  // fontSizes intentionally absent in v1 — no size knob exists (§3.4.5); added with the knob
  intensityLevels: number,              // NIMO 256, OEM spec 16, G1 2
  partialUpdate: boolean,
} | null                                // Mentra Live
```

### 3.4 Contract details (normative)

#### 3.4.1 Diff contract

The API shape doesn't change for this — ids stay optional — but adapters MUST match elements between consecutive scenes by these rules, in order:

1. same `id` + same `type` ⇒ same element: update content in place (box may move if the backend supports it, else rebuild path)
2. no `id`: match by `(type, box)` — what the G2 SGC effectively keys on today — else by index within type
3. anything unmatched ⇒ structural change ⇒ rebuild path

**Hard rule: content-only changes must never rebuild.** Captions at 3 Hz with a stable id must compile to G2 `updateTextData` every time. This matters beyond flicker: G2 page teardown/rebuild is coupled to mic state and firmware recovery storms (see the mic-session incident work) — a miniapp reordering its array must not be able to trigger that.

#### 3.4.2 Text wrap & overflow

- **Wrapping always happens on the phone** (display-utils metrics are the single source of truth). The box then either passes through as a container (G2) or decomposes into per-line positioned ops (Nex per OEM spec — `DrawText` is single-line by design; NIMO too if its firmware in-box wrap proves untrustworthy — the PDF doesn't specify wrap-vs-clip, test it).
- `overflow: "clip" | "ellipsis"`, default `"clip"`. Pagination/scroll stays app-level (display-utils ScrollView helpers).
- `await display.measure(text, style, widthPx)` gives devs the host's exact per-device measurement (async — metrics live host-side).

#### 3.4.3 Images

- **Input format contract: PNG (base64).** In practice adapters decode anything the platform image decoder reads (PNG/JPEG/BMP — `CGImage`/`BitmapFactory` handle all three), but PNG is what we document so nobody believes input byte layout matters. Images render monochrome/grayscale per device `intensityLevels`; color is quantized.
- **Hard invariant: adapters always decode → re-encode to the device-perfect wire format. Dev bytes NEVER pass through.** Dev input is *pixels*, never *wire format*. Each device's perfection requirement (G2 4-bit BMP, NIMO 2bpp+zlib, G1 inverted/padded 1-bit BMP, Nex packed intensity rows) lives in its adapter exactly once. This is the lesson of G1's bitmap rot: "must be formatted PERFECTLY" knowledge previously lived in app code / cloud v1 magic bytes and evaporated. (mentra-ai hand-rolling a 4-bit BMP encoder in miniapp code today is the same anti-pattern, one device newer.) No SDK-side PNG→BMP converter needed — adapters want decodable pixels, not BMPs.
- `data` (base64) inline every frame is fine at real refresh rates (≤~3 Hz in practice; the JS bridge cost is noise). **Asset registration is deferred** — the expensive hop is BLE, and that's an adapter rule, not an API: *image element with unchanged content ⇒ no re-upload* (G2 adapter compares content per container id and skips the fragment session; NIMO has no cache, nothing lost). `assetId` is purely additive later if a high-frequency image case appears (maps to OEM spec `preload_image`/`display_cached_image`).
- Bitmap dims must match `box` dims in v1; host rejects otherwise. Any scaling is phone-side, never glasses-side.

#### 3.4.4 Rect ≈ bordered container on G2

`text.style.border/radius` is the fast path (one G2 container). A standalone `rect` compiles to an empty bordered container on G2, a native rect on NIMO/Nex. Rect-behind-text at the same box = two G2 containers — legal, not free; document it.

#### 3.4.5 v1 style surface

`text.style`: `border?`, `radius?`, `overflow?`, `breakMode?`. **No `align`, no `size`** (see §3.1 rationale; additive later). Capabilities omit `fontSizes` until a size knob exists.

#### 3.4.6 Bounds & budgets

- **Out-of-bounds boxes are clamped, never rejected.** The host intersects every box with the device's drawable canvas and re-wraps text to the clamped width; raw boxes never reach firmware (G2 returns a hard `OVERSIZE_RESPONSE_CONTAINER` error for oversized containers). Clamping is reported via `degraded: true`. This is what makes "designed on G2's 576×288, running on NIMO's 500×220" safe, and vice versa.
- **Element-budget overflow: render in array order until the device budget is exhausted, drop the rest**, report `degraded: true, dropped: [...]`. Never error — consistent with §3.4.8.
- **G2 accounting trap: rects share the text-container pool** (a rect compiles to an empty bordered text container, §3.4.4). A scene with 6 texts + 1 rect exceeds G2's budget of 6. `maxTextElements` documents this shared pool.

#### 3.4.7 Scene persistence & replay

The host retains each app's **last scene per (app, view)** and adapters **replay it on device recovery** — glasses reconnect, G2 firmware recovery (`systemExit` → rebuild), display power-cycle. Apps never re-send on reconnect; the current scene is always reconstructible host-side. This is the declarative model's core payoff (recovery = replay, no app cooperation needed — `G2.swift` already does this internally today) and it is normative: the arbitration layer must NOT be stateless.

#### 3.4.8 G1/Z100 degrade rules

Context: few users, dwindling over time — don't over-optimize, but nothing may straight-up break. Guiding rule: **content-preserving, never-erroring, honestly-reported.**

- **Text → collapse to a text wall.** Sort text elements in reading order (y, then x), join with blank lines, run through the existing `DisplayProcessor` wrap (G1: 576px/5 lines, Z100: 390px/7 lines), clip overflow. **Row exception**: two text elements with overlapping y-ranges and disjoint x-ranges are column-composed via `ColumnComposer` (pixel-measured space padding — the shipped `double_text_wall` mechanism) with column widths taken from the boxes. Scope guard: rows = 2 columns with clean separation only; anything fancier falls back to reading-order stacking. This is NOT a general ASCII-art layout engine.
- **Zero-regression guarantee via sugar**: `showTextWall` compiles to one text element → collapses to exactly today's text wall through today's wrap path. `showDoubleTextWall(top, bottom)` compiles to two side-by-side boxed text elements → real containers on G2/NIMO (better than today), column-composed on G1/Z100 (byte-identical to today). Captions/teleprompter/kawaii/merge — the entire real G1/Z100 workload — behave identically.
- **Rects → drop silently.** Decoration; never an error.
- **Images → drop and tell the truth twice.** v1 does NOT attempt the G1 BMP path (broken in practice; failure mode is ugly — 194-byte chunks with 10×1s retries wedging a fragile BLE link). (1) Capabilities stop lying: G1 flips to `canDisplayBitmap: false` / `maxImageElements: 0`; Z100 stays false. (2) The awaitable result reports it: `{status: "displayed", degraded: true, dropped: ["map"]}` — an all-image scene renders nothing but the app can detect it and fall back (e.g. merge-style `speaker.speak`).
- **Everything else is device-agnostic**: arbitration/durationMs/boot queue unchanged; `render([])` → G1's existing space-textwall clear; the §3.4.1 diff contract is vacuous here (no retained elements — every frame is a full text-wall rewrite; the native throttle paces it); `measure()` works (display-utils has G1/Z100 profiles).
- **Optional future (not v1, only if a flagship app needs it)**: scene that is a *single* image → fullscreen BMP (fullscreen-only was the only shape G1 ever rendered). The known-good G1 byte layout survives in-repo: `createTestBMPHex()` in `G1.swift` (header labeled "from our working data") + cloud v1's converter `cloud/packages/sdk/src/utils/bitmap-utils.ts`; fixing = byte-diff `convertToG1Bmp` output against those. Z100 is cheaper still: `Mach1.swift`/`Mach1.kt` already call the Vuzix Ultralite SDK's `canvas.drawBackground` + `commit` — plumbed, just never wired to capability.

### 3.5 Deprecations

- `session.canvas` — fold into `display`; `page_id`/`show_page` never worked.
- `showTextAt` / public `positioned_text` — subsumed by `render`.
- `session.dashboard` noop module.
- Quad-mode magic threshold — replaced by explicit multi-element scenes.
- Fix docs: `clearView` → `clear`; document actual surface.

**Dashboard disposition**: the whole dashboard surface (`session.dashboard`, `view: "dashboard"`, `showDashboardCard`) is busted/no-op today and nothing uses it. Leave it no-op — do not build dashboard rendering into this redesign. The `view` option stays in the API signature for forward compat, but dashboard semantics are explicitly out of scope.

---

## 4. Decisions (made)

1. **Coordinate space: raw device X/Y, keep v1 simple.** Devs specify raw pixel coordinates; capabilities expose the real drawable canvas per device. No virtual canvas / scaling in v1 — G2 (576×288), NIMO (500×220), and Nex (public exposure TBD, less than 640×480 for pupil-position/waveguide-coupling margin) are close enough in resolution. **Short term: we design all first-party miniapps against NIMO-class resolution (~500×220).** Long term: a proper scaling system (future work, out of scope).
2. **Shapes: rects only in v1.** Rect maps to G2 bordered container, NIMO rect object, OEM-spec `draw_rect`. Line/circle stay behind the capability flag for later.
3. **Lists: deferred, but the element union must accommodate a future `list` element** — even if implemented as SGC-level emulation on devices without native lists (G2 has firmware ListContainer with selection events; NIMO/Nex would emulate off scroll/tap input).
4. **Nex firmware is out of scope** — developed by a separate team. We build the miniapp-SDK-through-SGC layers; Nex's SGC will have text/bitmap verbs, which is all the degrade/passthrough path needs initially. The DrawOp IR remains the target contract for when its firmware converges on the OEM spec.
5. **Cut `align` and font `size` from v1 styles.** No current OEM supports either (G2: neither field exists; NIMO: no alignment, only quantized sizes with charset caveats). Additive later.
6. **No asset registration in v1.** Displays refresh at ≤~3 Hz in practice — inline `data` over the JS bridge is noise. BLE re-upload is prevented by the adapter dedupe rule (§3.4.3), not by API.
7. **Awaitable `render()` result, opt-in** — `{status: "displayed" | "queued" | "blocked", reason?}` via existing `requestId`/`REQUEST_RESULT` plumbing. Fire-and-forget stays the default.
8. **Wrap always on the phone; the box is the SDK abstraction.** G2 gets containers; Nex gets per-line `DrawText` ops (per OEM spec); NIMO in-box wrap is untrusted until tested — fall back to per-line labels if flaky.
9. **Image input = PNG (documented); adapters always decode → re-encode** — dev bytes never reach the wire verbatim (§3.4.3). No SDK-side format converter.
10. **G1/Z100: content-preserving degrade, no bitmap attempt in v1** (§3.4.8) — text collapses to a wall (ColumnComposer for side-by-side rows), rects dropped, images dropped + reported via the awaitable result; G1's `canDisplayBitmap` capability flips to `false` to match reality.
11. **Out-of-bounds boxes clamped, budget overflow drops tail + reports** (§3.4.6) — never reject a frame, never let raw geometry reach firmware.
12. **Scene persistence & replay is normative** (§3.4.7) — host retains last scene per (app, view); adapters replay on device recovery; apps never re-send on reconnect.
13. **Dashboard stays no-op** — the surface is busted today and unused; `view` stays in the signature, dashboard semantics out of scope (§3.5).

---

## 5. Phasing

1. **Contract first** — scene/element types + typed display capabilities in the SDK; `render()` compiles to today's layout union under the hood (no host changes yet). **Fidelity caveat, stated up front**: today's pipeline is single-slot, so a multi-element scene can only ride it as *sequential* `positioned_text`/`bitmap_view` events — best-effort, non-atomic, no diff guarantees (exactly how navigation hacks it today). Phase 1's real deliverables are the API contract, the typed capabilities, and prepping the **navigation miniapp** migration — the acid test, since it holds all the G2 hacks. Do not expect phase-1 scenes to render atomically; phase 2 fixes that.
2. **Host IR swap** — DrawOp-list IR through `LocalDisplayManager`/`DisplayProcessor`; real G2 adapter with container diffing (kills the `DeviceManager.swift` viewState bypass); scene persistence/replay (§3.4.7); G1/Z100 degrade path.
3. **NIMO adapter** — dynamic-UI protocol (appid 253) SGC backend.
4. **Migrate all first-party miniapps** onto `render()`/sugar — Mentra AI, Merge, Captions, Translation, Navigation/Maps, Teleprompter, Recorder, Kawaii, Everything, example-miniapp + template. After this, nothing first-party calls the legacy surface.
5. **Remove the legacy display API** — delete the canvas module, `showTextAt`/`positioned_text` public surface, legacy layout-union paths that no longer have consumers; fix docs (`clearView` → `clear`, document the real surface).

---

## Appendix A: G2 EvenHub display model (reference)

- Transport: EvenHub BLE chars (write `…2760…5401`, notify `…5402`), `0xAA`-framed, 236B max payload, CRC16 on final packet.
- Commands: `createStartupPage` (0), `updateImageRawData` (3), `updateTextData` (5), `rebuildPage` (7), `shutdownPage` (9), heartbeat (12).
- Containers: `TextContainerProperty {x, y, w, h, borderWidth, borderColor, borderRadius, padding, containerId, name, isEventCapture, content}` — **no font size, no alignment**. `ImageContainerProperty {x, y, w, h, containerId, name}`. Firmware also has `ListContainerProperty` (selectable items + `ListEvent` — unused by us).
- Limits: 6 text containers (ids 1–6), 4 image containers (ids 10–13, LRU), container 0 is event-capture.
- Images: 4-bit grayscale BMP, 4096B fragments, per-fragment ACK, retry whole image w/ fresh session up to 3 attempts.
- `clearDisplay` deliberately avoids `shutdownPage` (kills mic + triggers systemExit→recovery rebuild storm); blanks text to `" "` and overwrites images with black instead (`G2.swift:2212-2230`).
- Update-in-place (`updateTextData`) avoids rebuilds — the property the G2 adapter's diffing must exploit.

## Appendix B: Key file index

| Concern | Files |
|---|---|
| SDK display surface | `mobile/modules/miniapp/src/modules/display.ts`, `canvas.ts`, `dashboard.ts`, `protocol.ts` |
| Host runtime + arbitration | `mobile/modules/engine/src/services/LocalMiniappRuntime.ts`, `LocalDisplayManager.ts` |
| Text adaptation | `mobile/modules/engine/src/services/DisplayProcessor.ts`, `mobile/modules/engine/src/utils/display/` (mirrors `cloud/packages/display-utils/`) |
| Native dispatch | `mobile/modules/bluetooth-sdk/ios/Source/DeviceManager.swift`, `.../android/.../DeviceManager.kt` |
| SGC verb protocol | `mobile/modules/bluetooth-sdk/ios/Source/sgcs/SGCManager.swift` (+ `.kt`) |
| Per-device drivers | `sgcs/G1.swift`, `G2.swift`, `MentraNex.swift`, `Nimo.swift`, `Mach1.swift`, `MentraLive.swift` (+ Android `.kt` mirrors) |
| Capabilities | `cloud/packages/types/src/hardware.ts`, `cloud/packages/types/src/capabilities/*.ts` (duplicated in `cloud/packages/cloud/src/config/capabilities/`) |
| OEM display spec (IR source) | `mintlify-docs/glasses-oems/firmware-spec.mdx` |
| NIMO dynamic-UI protocol | `local/NIMO/Mentra接入Nimo智能眼镜-动态创建UI布局接入指导.pdf`, `local/NIMO/current_nimo_sdk/docs/protocol/` |
| G2 firmware ground truth | `local/g2_re/ae_g2_rev/proto/proto_out_v2.1.0_beta_v3/protos/g2/EvenHub.proto`, `local/g2_re/ae_g2_rev/aegray/demos/` |
| G2-hack case study | `miniapps/navigation/src/background/managers/DisplayManager.ts` |
