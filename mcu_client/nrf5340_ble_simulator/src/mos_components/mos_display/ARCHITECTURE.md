# `mos_display` Architecture

The display module is organized as four layers, each with a narrow responsibility. Higher layers compose lower layers — never the reverse.

```
mos_display.c (orchestrator)
        │
        ▼
   main_scene  ────────────── test_scenes
        │                          (side-loaded UI for hardware tests)
   ┌────┴────┐
   ▼         ▼
welcome    caption          ◄── views
   │         │
 [components]               ◄── components
```

## Design intent

The display module owns everything pixel-related: panel bring-up, scene management, text throttling, font lifecycle. The point of the architecture below is to keep that responsibility _internally_ simple — so adding a new event, a new view, or a new component does not require holding the entire module in your head at once.

Three goals drive the layering:

- **Clear abstractions with clear boundaries.** Each layer does exactly one job, and the API between layers is narrow. A reader should be able to understand any single file without needing to read its peers.
- **Boundaries don't get crossed.** A component never reaches up to its scene; a view never reaches sideways to another view; the orchestrator is the only place where threads, hardware, and external state meet UI. When a "convenient shortcut" across a boundary feels tempting, that's the signal the abstractions are wrong — not that the rule is.
- **Separation of concerns over convenience.** A new caption-rendering policy belongs in the caption view; a new external event belongs as an `LCD_CMD_*` in the orchestrator. Where code lives is dictated by _what kind of thing changed_, not by what's quickest to wire up.

The payoff is debuggability: when something breaks, the bug lives in one layer, gets fixed in one layer, and doesn't ripple. The cost is a little more upfront discipline. The cost is much smaller than the cost of spaghetti once the module has more than a few dozen files.

## Layers

### Component (`ui/<view>/components/`)

Owns a single piece of UI — a label, a progress bar, a positioned overlay. Knows how to create itself, set its own text/styles, hide and show. Does **not** know who owns it, when it should be visible, or what other components exist.

Examples: `welcome_text`, `dfu_status`, `dfu_progress_bar`, `default_scrolling`, `custom_scrolling`, `positioned`.

### View (`ui/<view>/`)

Composes components into a coherent screen region (welcome, caption). Owns the lifecycle of its children, decides which component is visible at any moment based on a mode (e.g. `MOS_UI_CAPTION_MODE_DEFAULT` vs `_CUSTOM` vs `_POSITIONED`), and exposes a small API surface to its scene (`update_text`, `clear`, `set_mode`).

Views never reach across to each other. The caption view doesn't know the welcome view exists.

### Scene (`ui/`)

The control plane for views. `main_scene` owns both `welcome_view` and `caption_view`, decides which one is on screen at any time, and serializes mode transitions (`activate_welcome`, `activate_caption`, `show_positioned`). It also holds the cross-thread mode mirror that BLE/protobuf threads read to decide whether a render is allowed at all.

A scene knows the views it contains. It does not know about the orchestrator, the BLE stack, DFU state, or panel hardware.

### Orchestrator (`mos_display.c`)

The single entry point that drives the whole module. Responsibilities:

- **Lifecycle**: bring up the panel (`display_open_panel`), tear it down, swap to a test scene and back.
- **Event ingest**: a single LVGL thread services a message queue and handles every command the rest of the firmware can send: `LCD_CMD_OPEN`, `LCD_CMD_UPDATE_HEIGHT`, `LCD_CMD_BT_DISCONNECTED`, `LCD_CMD_UPDATE_DFU_PROGRESS`, `LCD_CMD_UPDATE_DFU_STATUS_TEXT`, `LCD_CMD_CLEAR_DISPLAY`, `LCD_CMD_SHOW_PATTERN`, `LCD_CMD_UPDATE_DYNAMIC_FONT`, etc.
- **Cross-cutting concerns**: caption throttling (decoupling BLE ingest rate from render rate), refresh budgeting (`lvgl_min_refresh_ms`, `lvgl_force_one_refresh`), dynamic font swaps, periodic battery refresh.
- **Routing**: translates external events into scene-level calls. BT disconnects → scene shows welcome. DFU progress arrives → scene forwards to welcome view. Caption text arrives → throttler buffers, then commits to the scene when allowed.

The orchestrator is the _only_ file that knows about the panel driver, the message queue, the LVGL thread, and BLE/protobuf state simultaneously. Everything below it deals strictly with UI.

## Test scenes (`test_ui/`)

Hardware self-test patterns (chess, zebra, center rectangle) live in `test_ui/`, not in `ui/`. They're scenes — selectable via `LCD_CMD_SHOW_PATTERN` exactly like the main scene — but they exist for panel bring-up and visual diagnostics, not for the user-facing product.

Keeping them in their own directory means:

- **Production UI logic stays focused.** Reading `ui/` is reading the real app; nothing in there is a debug aid.
- **Test scenes can take shortcuts.** Diagnostic patterns paint full-screen LVGL primitives directly without going through view/component decomposition. That's appropriate for a test harness and inappropriate for the product, so the looser rules don't bleed into `ui/`.
- **Stripping test scenes from a release build is a one-folder change.** Drop `test_ui/` from the CMake source list and `LCD_CMD_SHOW_PATTERN` becomes a no-op; nothing in `ui/` notices.

## UI library boundary

**Rule**: only code under `ui/` and `test_ui/` may include `<lvgl.h>` or use `lv_*` types. Everything else — the orchestrator, the throttler, config, and `utils/` — should be LVGL-agnostic.

The point is portability. If we ever swap LVGL for another rendering library, the only directories that should need to change are `ui/` and `test_ui/`. The orchestrator's event handling, the throttler's render cadence, the config's layout math, and most utilities have no business knowing what library paints pixels.

### Current state

The rule is the target, not the present. Files outside `ui/`/`test_ui/` that still touch LVGL today and need to be cleaned up:

- `mos_display.c` — uses `lv_screen_active()` and `lv_color_t` directly. Should call into the scene through library-agnostic types.
- `include/mos_display.h`, `include/mos_display_config.h` — leak `lv_color_t` and `lv_font_t` through the public API. Callers across the firmware end up needing `<lvgl.h>` transitively.
- `mos_display_config.c` — same.
- `utils/mos_display_screen_utils.{c,h}` — this one is a thin wrapper _over_ LVGL by design; it's the natural seam to push LVGL behind. Either it gets renamed/repurposed as the abstraction layer, or its callers move into `ui/`.
- `utils/mos_display_color_utils.{c,h}`, `utils/mos_display_custom_rendering.{c,h}`, `utils/mos_display_dynamic_font_labels.{c,h}` — all use LVGL types in their APIs.

Files already LVGL-clean: `mos_display_caption_throttler.{c,h}`, `utils/mos_display_text_diag.{c,h}`, `utils/mos_display_utf8.{c,h}`.

The migration path is roughly: introduce module-local types (`mos_color_t`, `mos_font_t`, an opaque view handle) in the public API, convert at the `ui/` boundary, then strip LVGL includes from non-UI files one by one.

## Directory map

```
mos_display/
├── include/                     ← public API (consumed outside the module)
│   ├── mos_display.h
│   └── mos_display_config.h
└── src/
    ├── mos_display.c            ← orchestrator
    ├── mos_display_config.c     ← layout/colors/font config
    ├── mos_display_caption_throttler.{c,h}  ← caption-specific throttler
    ├── ui/                      ← production UI tree
    │   ├── mos_display_main_scene.{c,h}
    │   ├── caption/
    │   │   ├── mos_display_caption_view.{c,h}
    │   │   ├── mos_display_caption_renderer.{c,h}
    │   │   └── components/
    │   └── welcome/
    │       ├── mos_display_welcome_view.{c,h}
    │       └── components/
    ├── test_ui/                 ← alternate scenes for hardware self-test
    │   └── mos_display_test_scenes.{c,h}
    └── utils/                   ← cross-cutting helpers (no UI policy)
        ├── mos_display_screen_utils.{c,h}
        ├── mos_display_color_utils.{c,h}
        ├── mos_display_custom_rendering.{c,h}
        ├── mos_display_dynamic_font_labels.{c,h}
        ├── mos_display_text_diag.{c,h}
        └── mos_display_utf8.{c,h}
```

## Rules of thumb

- **A component never imports another component.** If two components need to coordinate, that's the view's job.
- **A view never imports another view.** If two views need to coordinate, that's the scene's job.
- **A scene never imports the orchestrator, the BLE stack, or the panel driver.** Scenes operate on `lv_obj_t*` and config structs only.
- **The orchestrator is the only place where threads, message queues, and external state meet UI calls.** New external events get a new `LCD_CMD_*` and a handler in the orchestrator's switch — they do not get plumbed into views directly.
- **`utils/` holds helpers that are policy-free.** Anything caption-specific or welcome-specific belongs in its view's directory, not here.
- **Only `ui/` and `test_ui/` import `<lvgl.h>`.** New code outside those folders must not introduce `lv_*` types. See "UI library boundary" above for the migration target and the current cleanup list.
