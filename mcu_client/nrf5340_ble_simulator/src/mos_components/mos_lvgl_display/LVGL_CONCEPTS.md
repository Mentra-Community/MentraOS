# LVGL Concepts

## Objects, Labels, and Containers

Everything in LVGL is an `lv_obj_t`. There is no separate type for containers or labels — the distinction is conceptual.

**Object** (`lv_obj_create`)
The base type. A plain styled rectangle with position, size, and style. Used as a grouping container for other objects.

**Label** (`lv_label_create`)
An object with text rendering bolted on. Knows how to draw strings, look up font glyphs, word wrap, and scroll text. Still an `lv_obj_t` under the hood.

**Container**
Just a naming convention for a plain `lv_obj_t` used as a parent to group children. No special type or API.

Because everything is `lv_obj_t`, calling `lv_obj_del(container)` deletes all children inside it automatically — LVGL walks the tree and cleans up.

## Layouts

A layout is an automatic positioning system for children inside a container. Instead of manually calling `lv_obj_set_pos(child, x, y)` for each child, you declare how children should be arranged and LVGL does the math.

**Flex** — row or column arrangement, similar to CSS flexbox:

```c
lv_obj_set_layout(container, LV_LAYOUT_FLEX);
lv_obj_set_flex_flow(container, LV_FLEX_FLOW_COLUMN);
```

**Grid** — row and column arrangement, similar to CSS grid.

## What We Use

This codebase does not use LVGL layouts. All positioning is manual via `lv_obj_set_pos()` and `lv_obj_set_size()`. This is why the positioned text view has to track x/y coordinates and handle line wrapping itself.

`lv_obj_update_layout()` is not enabling a layout — it tells LVGL to recalculate sizes and positions immediately rather than waiting for the next render cycle. Call it after making structural changes to the widget tree if you need the new dimensions right away.

## Component Conventions in This Codebase

Each UI component in this folder follows a consistent interface:

- `mos_ui_<component>_create(parent, cfg)` — creates LVGL objects, returns handles
- `mos_ui_<component>_update(...)` — updates content (text, font, etc.)
- `mos_ui_<component>_destroy(view)` — deletes objects and nulls handles

Components are dumb — they only create and style LVGL objects. They do not read display config, query BLE state, access battery level, or know anything about the protobuf transport. All data is passed in by the caller.
