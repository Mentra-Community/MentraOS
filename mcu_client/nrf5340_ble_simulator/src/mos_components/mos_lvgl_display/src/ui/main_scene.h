#ifndef MAIN_SCENE_H_
#define MAIN_SCENE_H_

#include <stdbool.h>
#include <stdint.h>
#include <lvgl.h>

#include "welcome/welcome_view.h"
#include "caption/caption_view.h"
#include "display_config.h"
#include "mos_lvgl_display.h"  /* for display_biz_lang_t */

/* Active sub-view of the main scene. NONE means the scene hasn't been created (or has been
 * destroyed). The mode is mutated by the activate_* helpers and the positioned-text path,
 * read from any thread (BLE/protobuf), and is the single source of truth for the
 * "what is main_scene currently showing" question that other modules used to mirror. */
typedef enum
{
    MOS_UI_MAIN_SCENE_MODE_NONE = 0,
    MOS_UI_MAIN_SCENE_MODE_WELCOME,
    MOS_UI_MAIN_SCENE_MODE_CAPTION,
    MOS_UI_MAIN_SCENE_MODE_POSITIONED,
} mos_ui_main_scene_mode_t;

typedef struct
{
    mos_ui_welcome_view_t welcome;
    mos_ui_caption_view_t caption;
} mos_ui_main_scene_t;

typedef struct
{
    int x;
    int y;
    int width;
    int height;
    int padding;
    lv_color_t bg_color;
    lv_color_t text_color;
    const lv_font_t *font;
    int line_spacing;
    int label_y_offset;
    const lv_font_t *dfu_font;
    lv_color_t dfu_bar_bg_color;
    lv_color_t dfu_bar_fill_color;
} mos_ui_main_scene_cfg_t;

/* ------------------------------------------------------------------------- *
 * Lifecycle
 * ------------------------------------------------------------------------- */
mos_ui_main_scene_t mos_ui_main_scene_create(lv_obj_t *parent, const mos_ui_main_scene_cfg_t *cfg);
void mos_ui_main_scene_destroy(mos_ui_main_scene_t *scene);

/* ------------------------------------------------------------------------- *
 * Mode / view activation
 * ------------------------------------------------------------------------- */
void mos_ui_main_scene_show_welcome(mos_ui_main_scene_t *scene);
void mos_ui_main_scene_show_positioned(mos_ui_main_scene_t *scene);

/* ------------------------------------------------------------------------- *
 * Readiness queries (used by control-plane to gate operations after teardown).
 * ------------------------------------------------------------------------- */
bool mos_ui_main_scene_caption_is_ready(const mos_ui_main_scene_t *scene);
bool mos_ui_main_scene_welcome_is_ready(const mos_ui_main_scene_t *scene);
bool mos_ui_main_scene_welcome_is_visible(const mos_ui_main_scene_t *scene);

/* Mode queries — thread-safe; the answer is mirrored to a mutex-protected slot inside
 * main_scene so non-LVGL threads (BLE/protobuf) can route on it. */
mos_ui_main_scene_mode_t mos_ui_main_scene_get_mode(void);
bool mos_ui_main_scene_is_welcome_mode(void);
bool mos_ui_main_scene_can_render_caption(void);

/* ------------------------------------------------------------------------- *
 * Layout / invalidation
 * ------------------------------------------------------------------------- */
void mos_ui_main_scene_relayout_welcome(mos_ui_main_scene_t *scene);
void mos_ui_main_scene_relayout_caption(mos_ui_main_scene_t *scene);
void mos_ui_main_scene_invalidate_welcome(mos_ui_main_scene_t *scene);
void mos_ui_main_scene_invalidate_caption(mos_ui_main_scene_t *scene);

/* Apply a height/margin config snapshot to all scene containers. */
void mos_ui_main_scene_apply_height_config(mos_ui_main_scene_t *scene,
                                            lv_obj_t *screen,
                                            const display_config_t *cfg);

/* ------------------------------------------------------------------------- *
 * Welcome view
 * ------------------------------------------------------------------------- */
void mos_ui_main_scene_clear_welcome(mos_ui_main_scene_t *scene);
/* Wipe the content of whichever view (welcome or caption) is the active mode. */
void mos_ui_main_scene_clear_active(mos_ui_main_scene_t *scene);
void mos_ui_main_scene_refresh_welcome_text(mos_ui_main_scene_t *scene, const lv_font_t *font);

/* Re-render the welcome label with the supplied font (e.g. after a battery tick). No-op
 * unless the scene is in welcome mode and the welcome view is ready. Also clears any
 * stale positioned overlay so the welcome content owns the screen. */
void mos_ui_main_scene_refresh_welcome_active(mos_ui_main_scene_t *scene, const lv_font_t *font);
void mos_ui_main_scene_update_dfu_progress(mos_ui_main_scene_t *scene, bool show, uint8_t percent);
void mos_ui_main_scene_update_dfu_status(mos_ui_main_scene_t *scene, const char *text);

/* ------------------------------------------------------------------------- *
 * Caption view
 * ------------------------------------------------------------------------- */
void mos_ui_main_scene_clear_caption(mos_ui_main_scene_t *scene);
void mos_ui_main_scene_clear_positioned(mos_ui_main_scene_t *scene);
void mos_ui_main_scene_scroll_caption_to_bottom(mos_ui_main_scene_t *scene);
void mos_ui_main_scene_set_caption_scroll_enabled(mos_ui_main_scene_t *scene, bool enabled);
void mos_ui_main_scene_render_positioned_text(mos_ui_main_scene_t *scene,
                                                uint16_t x, uint16_t y,
                                                const char *text, uint32_t raw_color);

/* ------------------------------------------------------------------------- *
 * Caption text rendering — wraps the internal renderer (font selection, CJK probing).
 * Throttling/dedup/last-rendered are owned by caption_throttler, not the scene.
 * ------------------------------------------------------------------------- */
void mos_ui_main_scene_render_caption_text(mos_ui_main_scene_t *scene,
                                            const char *text, uint32_t committed_seq);

/* Lower-level activation hooks the caption renderer dispatches into after picking the
 * appropriate font. Not for direct use from the control plane — call _render_caption_text
 * to go through the throttler/renderer pipeline. */
void mos_ui_main_scene_show_caption_default(mos_ui_main_scene_t *scene,
                                             const lv_font_t *font, const char *text);
void mos_ui_main_scene_show_caption_custom(mos_ui_main_scene_t *scene, const char *text,
                                            const lv_font_t *font_primary,
                                            const lv_font_t *font_fallback,
                                            lv_color_t text_color);

int  mos_ui_main_scene_set_translation_pair(display_biz_lang_t src, display_biz_lang_t dst);
void mos_ui_main_scene_get_translation_pair(display_biz_lang_t *src, display_biz_lang_t *dst);

/* ------------------------------------------------------------------------- *
 * Dynamic font integration
 * ------------------------------------------------------------------------- */
/* Apply a font swap to all scene-owned dynamic-font labels. While welcome is the active
 * mode, welcome_text is left for the caller to refresh separately (battery-aware text). */
void mos_ui_main_scene_apply_dynamic_font(mos_ui_main_scene_t *scene, const lv_font_t *new_font);

/* React to a system-wide font change: re-apply the font to every tracked label, refresh
 * the active view's content (welcome rebuilds with battery; caption re-renders cached text),
 * relayout containers, and invalidate so the next frame paints with the new glyph metrics.
 * Caller just signals "the font changed"; the scene owns all post-swap UI work. */
void mos_ui_main_scene_handle_font_changed(mos_ui_main_scene_t *scene, const lv_font_t *new_font);

#endif /* MAIN_SCENE_H_ */
