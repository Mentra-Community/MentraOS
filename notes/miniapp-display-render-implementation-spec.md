# Miniapp Display `render()` — Implementation Spec & Plan

**Status:** Spec v3 — supersedes the phasing in `miniapp-display-api-redesign.md` §5 for execution; that doc's API contract (§3–4) remains normative (one flagged refinement, §4 here) and is referenced as **[DESIGN]**.
**Base:** new branch off `ya/mentra-display-add-canvas` (Yash's Mentra Display canvas work — the firmware protocol, SGC verbs, and nav HUD from that branch are foundations here, not throwaways).
**Firmware reference (READ-ONLY):** `~/Programming/OSSG/Mentra-Zephyr-Glasses-Client`, branch `ya/add-bitmap-rendering-support` (Yash's latest; the canvas system exists ONLY there, not on fw main/dev). **The firmware repo is 100% Yash's domain — we never modify it.** Facts cited as **[FW]** were read from that source. The loaner Mentra Display runs a canvas-branch build (confirmed by Alex).
**Ownership:** us = SDK surface, host pipeline, G2 (iOS + Android), G1/Z100 degrade. Yash = Mentra Display SGC (+ its firmware), NIMO SGC. This spec defines the contract he slots into.
**Delivery:** one effort, one PR (§11). The [DESIGN] §5 phase split is dropped — the bridge unit changes to a scene from day one.

---

## 1. Architecture rule

**Device-specific code lives only in SGCs.** The host is device-aware exclusively through declarative data — the display capabilities block ([DESIGN] §3.3) and the display profiles (`display-utils`) — consumed by generic algorithms. No `if (isG2)` above the SGC layer.

| Concern | Lives | Device-specific how |
|---|---|---|
| Scene diff (match + classify elements) | Host | Not at all — pure set arithmetic |
| Bounds clamp, element budgets, image-size limits | Host | Data only: `width/height`, `maxTextElements`, `maxImageElements`, `maxImagePx` |
| Text wrap | Host | Data only: profile font metrics (existing tables; line height derived `height / maxLines` unless a profile overrides) |
| Degrade for non-positioning devices | Host | Data only: gated on `canPosition: false`, parameterized by profile |
| Scene retention + replay | Host | Not at all |
| Verb translation (update vs rebuild vs blank vs delete), frame-application ordering | SGC | Fully — this is the SGC's job |
| Wire image encoding (4-bit BMP / 1-bit+dither / …) | SGC | Fully |
| Firmware id/session/ack bookkeeping; firmware-internal recovery; ack-driven self-heal | SGC | Fully (device-session state is the SGC's, by definition) |

Keep the capability surface minimal — the [DESIGN] §3.3 block plus `maxImagePx` (forced by firmware reality, §7), nothing speculative. When a behavior can't be expressed as generic data acted on generically, it belongs in the SGC, not as a new host flag.

## 2. Pipeline

```
miniapp SDK: display.render(scene) / sugar compiles to render()
  → ONE envelope message per scene
  → LocalDisplayManager (arbitration/boot queue/duration — unchanged semantics)
  → host scene pipeline (island, TS, generic): validate, then BRANCH —
      canPosition == false:
        degrade: compile scene → legacy text_wall/double_text_wall
        → EXISTING legacy path (DisplayProcessor wraps there, exactly as today;
          the scene pipeline must NOT wrap first — wrapping twice breaks the goldens)
      canPosition == true:
        clamp to canvas → enforce budgets + image limits → wrap text (profile metrics)
        → diff vs last-SENT (post-processed) frame for (app, view, device) → annotate
        → SceneFrame (full scene + annotations) → ONE bridge event
  → native DeviceManager: scene slot per view (enters the existing event-driven
    display queue as a single item; last-wins per view preserved) → SGC
  → SGC: default base walks annotations → per-element verbs (G2, Mentra Display)
         or override takes the whole frame (NIMO-style full-frame, future)
```

The old per-layout path stays intact for legacy cloud-app layouts and as the degrade target. It is not extended.

**Scene ↔ legacy transitions (same view):** arbitration can hand the display from a scene app to a legacy-layout app (cloud app) and back. DeviceManager owns the handoff: legacy event arriving over a scene slot ⇒ SGC clears its scene elements first, then renders the layout; scene event arriving over a legacy slot ⇒ treated as `replay` (all-created).

## 3. SDK surface

Per [DESIGN] §3.1. Shipping in this effort:

- `display.render(elements, {view?, durationMs?})` — replace-the-frame, last-wins per app. `render([])` ≡ `clear()`.
- Elements: `text | image | rect` with optional `id`, `box`, v1 style surface per [DESIGN] §3.4.5 (`border`, `radius`, `overflow: "clip" | "ellipsis"`, `breakMode`; no `align`, no `size`).
- **Awaitable, opt-in.** The promise resolves when arbitration resolves the request: `{status: "displayed" | "blocked", degraded?, dropped?, reason?}`. A boot-queued request resolves on its eventual outcome — `"queued"` is not a terminal status. `degraded`/`dropped` are host-known (clamp/budget/degrade), so this needs no device ack; `"displayed"` = sent, not render-confirmed.
- Sugar (`showTextWall`/`showDoubleTextWall`/`showReferenceCard`) becomes a **deprecated compat layer, not a kept surface**: each compiles in the SDK to a `render()` scene (one full-canvas text element / two side-by-side boxes), keeps working so existing apps don't break on merge day, but is marked `@deprecated` in code (IDE strikethrough + lint) and removed from the docs — new docs teach `render()` only, with the canonical full-canvas-text snippet (`box` from `capabilities.display`) shown once as the migration pattern. End state of this effort: **no first-party miniapp calls sugar** (§11); deletion of the shims happens in a later SDK major, not here.
- Typed display capabilities ([DESIGN] §3.3 + `maxImagePx`), populated on `"ready"` (capabilities are null in `start()`). Plumbed through both capability dirs (`types/src/capabilities/` + cloud config mirror) and the local host delivery; Mentra Live reports `display: null`.
- `display.measure(text, style, widthPx)` — async host RPC over profile metrics. Fast-follow if it slips; the contract ships with it reserved.

**Deleted** (pre-release, no shims): `drawLayout`, `removeElement`, `LayoutSpec`, `RemoveOp`, `remove_element` layout type, `showTextAt`, public `positioned_text`, the `canvas` module. Docs fixed (`clearView` → `clear`).

**First-party sweep:** sugar keeps every existing app working through the transition *by construction*, but the end state is a full fleet migration to raw `render()` — captions, translation, teleprompter, merge, kawaii, mentra-ai, recorder, `everything` (the lone `session.canvas` consumer), plus **example-miniapp and the template** (what new devs copy — these matter most). Nav is refit early as the acid test (§9); the rest migrate late (§11), after `render()` is hardware-proven, since sugar-compiled and hand-written scenes take the identical path — the migration is mechanical, not risky.

## 4. SceneFrame IR (host → native contract)

One message per `render()`:

```ts
{
  appId, view, sceneEpoch,              // epoch bumps on replay/app-switch/reconnect
  replay?: boolean,                     // full rebuild expected; annotations all "created"
  elements: [{
    id,                                 // app-supplied or host-synthesized ((type, index) — stable across identical scenes)
    type, box, style?, text?, imageData?,    // post-clamp, post-wrap (text arrives pre-wrapped with newlines)
    change: "created" | "updated" | "moved" | "unchanged",
    contentHash,                        // images: lets SGCs skip BLE re-upload without retaining pixels
  }],
  removed: [ids],                       // computed by the host differ — apps never send removes
}
```

Rules:
- Annotations are computed against the last **post-processed frame the host sent** for this (app, view, device) — an element dropped by budget last frame and fitting now is correctly `created`. Diff matching per [DESIGN] §3.4.1: same id ⇒ update in place; no id ⇒ (type, box), else index-within-type; unmatched ⇒ structural.
- **Content-only changes must never trigger a rebuild path** ([DESIGN] §3.4.1 hard rule — on G2 this is correctness, not perf: rebuilds couple to mic state).
- Device switch, reconnect, or app-switch resets the baseline: next frame is `replay: true` / epoch bump, all `created`. Epoch bump also bypasses native dedup. **Replay is always create-based, never update-based** — updates to dead firmware ids are dropped silently on the wire (**[FW]**: `update_text/update_image for unknown id` → local `LOG_WRN`, no ack; the phone can't observe the failure).
- **Image validation (flagged refinement of [DESIGN] §3.4.3):** an image whose bitmap dims ≠ box dims, whose box clamps smaller, or which exceeds the device `maxImagePx` is **dropped per-element + reported** in `dropped[]` — consistent with §3.4.6/§3.4.8's never-error rule, refining [DESIGN]'s "host rejects" to per-element drop. Frames are never rejected; silent drops are never allowed. Scaling stays app-side/phone-side, never on glasses.
- `rect` compiles to an **empty bordered text box on BOTH primary targets** — G2 bordered container and Mentra Display bordered TEXTBOX (**[FW]**: `CanvasComponentType` = BITMAP | TEXTBOX | SCROLL_TEXTBOX; no shape primitive). Rects share the 6-text pool on both; `maxTextElements` documents the shared pool.
- The full scene is always present, so an SGC never needs to retain a previous scene — and can **self-heal locally** (repaint from the frame in hand) without a host round-trip.

This is morally the [DESIGN] §3.2 DrawOp IR; aligning field names with `mintlify-docs/glasses-oems/firmware-spec.mdx` is cosmetic and can happen when the OEM side needs it.

## 5. Host pipeline (island, all generic TS, Jest-tested)

- **SceneStore** — last sent frame per (app, view). Session-lifetime; cleared on app stop and `clear()`. Feeds the differ and replay.
- **Differ** — the §3.4.1 matching rules. Pure function: `(prevSentFrame, nextScene) → annotated frame`.
- **Clamp & budget** — intersect boxes with the capability canvas, re-wrap text to the clamped width; render in array order to the element budget, drop the tail; image limits per §4; all reported via `degraded`/`dropped` ([DESIGN] §3.4.6). Raw geometry never reaches firmware.
- **Wrap** — always on the phone ([DESIGN] decision 8), positioned branch only (the degrade branch wraps on the legacy path as today — §2). Uses the **existing** profile font metrics (per Alex: no new measurement program); line count bound = box height ÷ line height, derived `height / maxLines` unless the profile overrides; overflow clipped or ellipsized per style. Boxes carry pre-wrapped text; firmware in-box wrap (G2 containers, Mentra Display LVGL `LONG_WRAP` — **[FW]**) is the belt-and-braces fallback, so a metrics miss degrades to a firmware re-wrap, not breakage. Tune opportunistically during tier-1 hardware time.
- **Degrade (`canPosition: false`)** — generic collapse per [DESIGN] §3.4.8: text elements in reading order (y, then x) joined with blank lines; the 2-column row exception via ColumnComposer; rects dropped silently; images dropped + reported. Output rides the existing legacy layout path unwrapped (that path wraps). Sugar therefore stays byte-identical on G1/Z100 (golden-tested — §9).
- **Replay** ([DESIGN] §3.4.7) — on reconnect/device-ready (existing native connection events), the host re-emits the arbitration winner's current scene with `replay: true`, all-created (§4). **durationMs (pinned):** wall-clock deadline from the original render; an expired scene is not replayed — arbitration falls through to the next owner; unexpired scenes replay with remaining time. Firmware-*internal* recovery (G2 systemExit rebuild storms) stays in the SGC, from its own device-session records.
- **App switch** — arbitration change emits the new owner's scene (epoch bump, all `created`); the SGC repaints per §6 (no blanking clear). Apps never re-send on switch-back. Duration expiry is just an app switch to the fallback owner.

## 6. Bridge & DeviceManager

- New `scene` event alongside legacy layout events. Per view, the native slot holds **the whole current scene** — `sendCurrentState` re-dispatches a coherent frame (dashboard exit, native re-push); dedup is a scene-hash compare (content only; `durationMs` stays out of the hash; epoch bump bypasses dedup). This retires: the per-element `elementId`/`layoutId` ViewState plumbing from Yash's branch, the `remove_element` wire type, the `statesEqual` blind spots, the iOS `positioned_text` viewState bypass, and per-element interleaving.
- **Frame application order is paint-then-sweep** (the answer to atomicity without a firmware commit verb): creates/updates/moves first — new content lands over or alongside old — then `removed` last, so stale content disappears only after its replacement is visible. **Epoch change does NOT mean a blanking clear**: on Mentra Display, create-on-existing-id = replace (**[FW]**), so the new scene repaints over vacated firmware ids and leftovers are deleted individually at the end; `CanvasClear` is reserved for true teardown (`clear()`, app stop, display off) because it also exits the canvas *view* (**[FW]**: first create activates the view, clear tears it down — bouncing it flashes). On G2 the same policy reads: blank leftovers last, `rebuildPage` only when the SGC judges N structural changes cheaper as one rebuild. LVGL repaints on its own ~16 ms tick, so ops landing within a tick appear together; residual cross-tick tearing is content-forward (new appears, then old vanishes) and acceptable for v1. A firmware batch/commit verb (OEM-spec-aligned) remains the right long-term ask **on Yash's roadmap, his call** — our IR is already frame-shaped, so adopting it later changes only the SGC translation, nothing above.
- SGC base class ships a **generic** default frame handler implementing the above: walk elements by annotation → `drawLayoutText` / `drawLayoutBitmap` (skip `unchanged`; skip image re-upload on matching `contentHash`), then `removed` → `removeLayoutElement(id)`. Yash's verb signatures survive as-is — that's the slot-in contract. An SGC either implements the verbs (G2, Mentra Display) or overrides the whole-frame handler (NIMO, future).
- Scene↔legacy transitions handled per §2. Legacy layout events otherwise keep their existing path untouched (cloud apps, degrade output).

## 7. Per-device work

### G2 — iOS + Android (our main deliverable)
Both drivers already contain the container machinery (pools 1–6/10–13, `updateTextData`, `rebuildPage`, blank-not-shutdown; G2.kt is a full ~4.5k-line port). Work is surfacing it through the verb contract:
- Element-id-aware container mapping (today rect-keyed).
- `updated` → `updateTextData` in place. `created` → add container. `moved` → recreate at the same container id. `removed` → **blank in place** (text `" "`, image black; never `shutdownPage` — mic/recovery coupling). Rebuild-vs-per-container is the SGC's stateless local judgment over the annotated frame.
- Image `contentHash` unchanged → skip the fragment session.
- Budgets host-enforced from capabilities; the SGC trusts the frame. `maxImagePx` for G2 left unset until verified against the quad-mode constraints.
- Delete the `DeviceManager.swift:1099` positioned_text bypass (dies with the scene slot).

### Mentra Display (Yash's; we keep it working and validate against it)
Firmware facts (**[FW]**, all read from `ya/add-bitmap-rendering-support`; repo is read-only to us):
- **Geometry: 500×220 usable region, centered in the 640×480 A6N panel** (`mos_display_config.c`, margins 70/130). Canvas coordinates are virtual-screen-relative. Yash's Kotlin constants were right; his `nex.ts` profile change (576×288/8 lines) is **wrong → fix to 500×220**, keeping the profile's existing font metrics and maxLines (the firmware itself carries a stale "576x288" comment at `mos_display.c:489` — mention to Yash). 500×220 = NIMO's drawable = the [DESIGN] decision-1 target: **the fleet-wide design resolution.**
- **Bitmap components cap at 200×200 px** (`CANVAS_IMAGE_MAX_I1_BYTES` = 5,000 B, plus per-dimension OVERSIZE checks). Full-canvas imagery is impossible (500×220 needs ≥6 tiles; the pool holds 4). Surfaced as capability `maxImagePx: {width: 200, height: 200}`; host drops + reports larger images (§4). Nav's assets fit (minimap 150×150, arrow 38×38).
- **Updates to nonexistent ids drop silently on the wire** (local `LOG_WRN` only, no ack) → replay/recovery is create-based, period (§4/§5).
- **Create-on-existing-id = replace** — enables no-flash repaint (§6) and `moved` without delete-then-create.
- **`CanvasResult` acks** (OK/INVALID/OVERSIZE/OOM, create+clear only) are currently ignored by the phone SGC. v1: consume + log, and treat create-INVALID/OOM as a **self-heal trigger** — the SGC repaints from the full frame it already holds (no host round-trip; the payoff of full-scene IR).
- **TEXTBOX wraps via LVGL `LONG_WRAP`** — the §5 fallback-wrap assumption holds.
- **Headroom, don't build:** `SCROLL_TEXTBOX` + phone-driven `scroll_offset` (future `list`/scroll element backend, mirroring G2's unused ListContainer); 2bpp-grayscale POC (future `intensityLevels`).
- SGC changes on our branch are mechanical: default frame handler drives the existing verbs; registry cleared on disconnect; the false "oldest-out eviction" comment goes (host budgets prevent scene overflow; the rect-keyed *legacy-path* leak still needs its fix); geometry constants aligned to 500×220; `CanvasResult` consumption.

### iOS protobuf regen for Mentra Display (we can try this on the loaner)
- Source of truth: `~/Programming/OSSG/Mentra-Zephyr-Glasses-Client`, branch **`ya/add-bitmap-rendering-support`**, `proto/mentraos_ble.proto` — same proto Yash's Android `MentraosBle.java` regen came from (protoc 4.29.6). Read-only: we copy the proto out to regenerate; we never push to that repo.
- Regenerate `mobile/modules/bluetooth-sdk/ios/Source/sgcs/mentraos_ble.pb.swift` with `protoc` + `protoc-gen-swift` matched to the SwiftProtobuf runtime the `MentraBluetoothSDK` pod resolves (current gencode is APIVersion_2 — verify the pinned runtime first).
- Record the firmware commit hash in the regenerated file headers on both platforms. The canvas messages are not on firmware main/dev, so field numbers (62–66, result 31) could renumber before Yash merges — **flag the risk to him Monday; merge timing is his call**; if his branch changes, we re-regen.
- After regen: thin Swift verb translation in `MentraNex.swift` (small, because diffing is host-side) → tier-2 validation on the loaner, and a working iOS reference for Yash.

### Z100 / Mach1 and G1
**Zero SGC changes.** Everything is host-side degrade onto the legacy path they already speak. One capability fix: G1 `canDisplayBitmap` → `false` ([DESIGN] §3.4.8; known-good byte layouts stay archived in-repo). Fullscreen single-image degrade: out of scope.

### NIMO (Yash's, future — contract completeness only)
Override the whole-frame handler; ignore annotations; serialize `elements` to a dynamic-UI frame (`is_clear_all_obj=1`); skip identical frames by scene hash. No retained state. Nothing here blocks or presupposes it.

## 8. Yash's branch: keep / delete / fix

| | Items |
|---|---|
| **Keep** | Canvas protobuf verbs + `MentraosBle.java` regen; `NexProtobufUtils`; `MentraNex.kt` (as verb translation); SGCManager verb signatures (the slot-in contract); dither/invert; `ArrowRenderer`; nav HUD design, rects, and copy changes |
| **Delete** | SDK `drawLayout`/`removeElement`/`LayoutSpec`/`RemoveOp` + exports; `remove_element` wire type; per-element `elementId`/`layoutId` ViewState plumbing; nav's remove-lists and `navHudShown`/`lastArrowKey` bookkeeping |
| **Fix** | `nex.ts` profile → **500×220** (definitive; keep existing font metrics/maxLines); registry cleared on disconnect; eviction comment/code mismatch + rect-keyed legacy-path leak; consume `CanvasResult` (log + self-heal); nav bundle **version bump** (never re-ship changed bytes as 1.1.7); G2 remove support both platforms (the un-regression) |

## 9. Validation

- **Jest (pure functions):** differ (all §3.4.1 match paths, content-vs-structural, budget-drop re-entry), clamp/budget/image-limit (`degraded`/`dropped`), degrade collapse + ColumnComposer rows (verifying degrade output is unwrapped — the legacy path wraps), replay/duration expiry, scene↔legacy transition dispatch, paint-then-sweep ordering in the base handler.
- **Golden regression:** sugar output on G1/Z100 profiles byte-identical to today's `text_wall`/`double_text_wall`.
- **G2 hardware:** captions ~3 Hz with a stable id → `updateTextData` every frame, no flicker, no page rebuilds (watch mic state); nav HUD↔message transitions leave nothing stale and never blank-flash; scene→cloud-app handoff leaves nothing stale; reconnect → replay; dashboard in/out → scene re-push.
- **Mentra Display (loaner, canvas-branch firmware confirmed):** tier 1 — host pipeline against Yash's *unchanged* Android SGC (full e2e, zero new native code, real delete verb; watch `CanvasResult` codes; confirm no-flash repaint on app switch; opportunistically check wrap accuracy against the existing metrics). Tier 2 — iOS pb regen + thin Swift translation (§7).
- **Nav refit** is the acid test ([DESIGN] §5): one `buildScene()` composing memoized arrow + cached minimap + stats + maneuver *or* message; keep the 3s re-push crutch until replay is proven on hardware, then delete it.

## 10. Resolved decisions & remaining opens

Resolved by firmware source or Alex (previously open):
1. Update-to-nonexistent-id = **silent on the wire** → replay is create-based (§4/§5).
2. Atomicity without commit = **paint-then-sweep + create-as-replace repaint; no blanking clears mid-session** (§6). Commit verb stays a Yash-roadmap nice-to-have, not a v1 dependency.
3. Firmware repo = **Yash's domain, read-only to us**; our side pins regen provenance and flags the field-renumber risk to him.
4. Image cap = **200×200 per bitmap component**; no full-canvas imagery; `maxImagePx` capability (§7).
5. Font metrics = **use the existing profile tables**; fix geometry to 500×220; derive line height; tune opportunistically on hardware.
6. Loaner firmware = **canvas branch** (confirmed).

Still open (none block starting): Yash's firmware-proto merge timing (his call — until merged, our gencodes pin a branch commit); G2 `maxImagePx` verification against quad-mode constraints.

## 11. Order of work — one PR

Per Alex: **one big PR to dev** (structured commits inside for reviewability — proto regen and the bundled zip isolated at minimum). Merge gate: G2 remove support working, nav bundle version-bumped, G1/Z100 goldens passing.

1. Branch off `ya/mentra-display-add-canvas`.
2. Host pipeline: SceneStore + differ + clamp/budget/image-limits + degrade + replay, with the Jest suite. (Yash-independent.)
3. SceneFrame bridge event + DeviceManager scene slot + scene↔legacy transitions + SGC base frame handler (paint-then-sweep).
4. SDK surface swap: `render()` + typed capabilities (incl. `maxImagePx`); sugar reduced to `@deprecated` compat wrappers over `render()`; delete retained API.
5. G2 verb support, both platforms.
6. Nav refit + rebuilt, version-bumped bundle (the acid test).
7. Mentra Display: mechanical refit of `MentraNex.kt` onto the frame handler + lifecycle fixes + `CanvasResult` consume/self-heal + 500×220 profile fix; tier-1 validation on the loaner.
8. iOS Mentra Display pb regen (proto copied read-only from the firmware repo, §7) + thin Swift translation; tier-2 validation on the loaner.
9. **Fleet migration off sugar** (after hardware validation, low risk — same path): captions, translation, teleprompter, merge, kawaii, mentra-ai, recorder, `everything`, example-miniapp + template. Goldens re-run against the migrated apps' raw `render()` calls (same invariant: G1/Z100 output byte-identical to today).
10. **Docs**: mintlify miniapp display pages + `sdk/docs/display.md` + module README rewritten around `render()`/`measure()`/capabilities; sugar absent from the docs (deprecation note only); the `clearView` lie fixed.
11. Monday, Yash: walkthrough; flag the stale fw geometry comment, the proto-merge/renumber risk, and the commit-verb suggestion — all his domain, zero dependencies from us.

---

## 12. As-built addendum (2026-07-03, post hardware validation)

Everything in §1–§11 shipped on `aisraelov/display-render-v1` and was
hardware-validated on **G2 iOS** (captions, nav HUD, tiled minimap, reconnect,
kill/teardown) and **Mentra Display iOS** (captions + maps, tier-2 incl. the
pb.swift regen and a rewritten 1-bit BMP encoder — the old iOS conversion
emitted raw RGBA, never a BMP). Deltas and discoveries vs the spec as written:

- **Sugar converts to scenes HOST-side** (LocalDisplayManager.sendNow), not
  SDK-side — old zips and cloud-shaped layouts ride the scene path for free;
  the G1/Z100 legacy path is literally unchanged code.
- **G2 firmware image envelope**: transfers into containers beyond ~200×100 are
  refused (IMAGE_RAW_DATA_FAILED). Instead of a host `maxImagePx` cap, the G2
  SGC **tiles** larger images (ceil(w/200)×ceil(h/100) grid from one grayscale
  render, one container per tile, 4-container pool bound).
- **Page-lifecycle rules learned on hardware**: one coalesced rebuild per
  frame (per-create rebuilds = firmware storm = BLE drop); never send
  SHUTDOWN_PAGE while the page is down (recovery loop starves the page
  forever); removed elements must leave the page **structurally** (a blanked
  husk still renders — see next point).
- **The firmware overflow tick**: a text container shorter than its content
  makes the firmware draw a cursor-like indicator. One firmware line needs
  **≥40px** of container height (28px ticks; hardware-bisected). Fixes: SGC
  min-height guard (≥40px, content-independent), G2 profile
  `lineHeightPx: 40` (host height-clipping active), clearDisplay purges
  positioned scene husks with one coalesced rebuild.
- **isEventCapture** is required for touch (removing it kills the touchbar)
  and is NOT the tick source. A dedicated 1×1 container id 0 carries it.
- **G2 notification channel decoded** (service 4, NotificationDataPackage):
  iOS notifications reach the G2 via ANCS; the glasses report the source app.
  Piped up as `phone_notification` (empty title/content) into the same path
  Android's NotificationListenerService feeds — the iOS half of the
  notification story.
- **Zombie-frame gate**: display/render/canvas traffic drops for unmounted
  apps (a dying app's in-flight frame repainted after teardown).
- **First-party migration (in-branch)**: captions 1.0.8, translation 1.0.9,
  teleprompter 1.0.1, recorder 1.0.3, merge 0.1.26, navigation 1.1.14 now call
  raw `display.render()` (full-canvas text element with a stable id;
  `render([])` clears; merge keeps `durationMs` + `breakMode: "word"` via
  RenderOptions/style). example-miniapp's GlassesController + DisplayPage
  tester and the create-mentra-miniapp template lead with `render()`.
  kawaii and mentra-ai deliberately untouched (they call `showTextWall`,
  which stays).
- **Unused sugar REMOVED from the SDK (in-branch)**: usage audit across all
  monorepo miniapps + the external `Mentra-Community/Mentra-AI-Miniapp` (the
  real Mentra AI; the monorepo copy is defunct) found zero callers of
  `showDoubleTextWall`, `showReferenceCard`, `showDashboardCard` (tester demo
  buttons only) and `showTextAt` (nav only — its 4 sites migrated to a shared
  full-canvas render element in 1.1.14). All four methods + their SDK types
  deleted. KEPT: `showTextWall`, `showBitmapView`, `clear` — the external
  Mentra AI uses all three. Hosts still accept the historical layout types
  (`double_text_wall`, `reference_card`, `dashboard_card`, `positioned_text`)
  on the wire — bundles packed with older SDKs send them.

## 13. Remaining work (TODO)

Pre-PR (this branch):
- [x] Maneuver-box two-line fix verification on glasses (nav 1.1.13) —
      confirmed on hardware ("turn right onto Gough Street", two lines)
- [x] First-party miniapp migration to raw render() (see §12 last bullet)
- [x] Docs rewrite: mintlify display pages, sdk/docs/display.md, fix the
      `clearView` lie
- [ ] **Android hardware pass** — all validation so far was iOS; G2 Android +
      Mentra Display Android (tier-1) are compile-verified only (PR caveat)
- [ ] Final sweep: prettier, full jest, gradle, iOS build; push + PR to dev

Also done in-branch (2026-07-03 round 2):
- [x] kawaii 0.1.9 + codex-kawaii-e2e 0.1.2 migrated to render()
- [x] `everything` miniapp DELETED (was unbundled, unreferenced, sole canvas
      consumer) and `miniapps/mentra-ai` DELETED (abandoned example-scaffold;
      the real Mentra AI lives in Mentra-Community/Mentra-AI-Miniapp)
- [x] render() migration PR opened on Mentra-Community/Mentra-AI-Miniapp —
      NOT merged; gated on host render() rollout (MentraOS PR #3341)
- [x] Canvas module DELETED end to end: session.canvas + CanvasManager +
      CanvasOperation + CANVAS wire type + host handleCanvas + tester
      CanvasPage + docs page (redirected to display/layouts). Zero consumers
      existed once `everything` was gone; no shipped bundle ever sent
      miniapp_canvas.

- [x] SUGAR FULLY DELETED from the SDK (2026-07-03 round 3, Alex's call):
      nav 1.1.15 migrated its secondary paths (large map, test box, dev-panel
      text tests, clear → render); then `showTextWall`, `showBitmapView`,
      `clear`, `send()`, and the legacy layout types were removed from
      display.ts. `session.display` is render()-only. The external
      Mentra-AI-Miniapp dev branch typechecks again once PR #6 merges (Aryan,
      Monday 2026-07-06). Hardware note: nav's swipe-up large-map + loading
      message paths (1.1.14/1.1.15 changes) have not had a device pass.

Post-merge (gated on Alex):
- [ ] Host WIRE support for legacy DISPLAY layouts must OUTLIVE the SDK —
      registry bundles packed with older SDKs and cloud-SDK apps still send
      them, and the G1/Z100 degrade path emits them internally. Keep
      `MiniappRequestType.DISPLAY` + handleDisplay + the sugar→scene converter.
- [ ] `display.measure()` helper (reserved in the contract, unimplemented)

Follow-ups:
- [ ] Remove nav's 3s re-push crutch once host replay is explicitly verified
      (`LOCAL_DISPLAY: replayCurrent` observed on a reconnect)
- [ ] Confirm the 40px G2 line constant with Even; ask about the overflow
      indicator and a per-container delete verb
- [ ] Pairing screens call BluetoothSdk.forget() on ENTRY — wipes the default
      wearable if the user backs out; move forget to new-device commit
      (separate small PR)
- [ ] Yash handoff: firmware proto merge timing (field-renumber risk while
      canvas lives on his branch), stale 576×288 comment in mos_display.c,
      batch/commit verb suggestion, CanvasResult self-heal deepening
- [ ] Notification relay build-out: G2-only today; other iOS glasses need
      their own ANCS-report path; Android relay = none needed
      (NotificationListenerService)
- [ ] NIMO adapter (Yash — whole-frame handler contract ready); future `list`
      element on G2 ListContainer / Mentra Display SCROLL_TEXTBOX
