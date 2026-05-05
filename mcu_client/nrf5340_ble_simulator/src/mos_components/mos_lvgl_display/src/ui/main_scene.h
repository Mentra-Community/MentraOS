#ifndef MAIN_SCENE_H_
#define MAIN_SCENE_H_

#include <stdbool.h>
#include <stdint.h>
#include <lvgl.h>

#include "welcome/welcome_view.h"
#include "caption/caption_view.h"
#include "display_config.h"

typedef struct
{
    mos_ui_welcome_view_t welcome;
    mos_ui_caption_view_t caption;
    /* Which sub-view is currently the active mode of this scene.
     * True after create / show_welcome; flipped to false the moment caption-side rendering
     * (default scrolling, custom scrolling, or positioned text) takes over. */
    bool welcome_mode;
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
bool mos_ui_main_scene_is_welcome_mode(const mos_ui_main_scene_t *scene);

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
 * Caption text rendering — wraps the internal renderer (font selection, dedup,
 * CJK probing). Control plane never talks to the renderer directly.
 * ------------------------------------------------------------------------- */
void mos_ui_main_scene_render_caption_text(mos_ui_main_scene_t *scene,
                                            const char *text, uint32_t committed_seq);
void mos_ui_main_scene_rerender_caption(mos_ui_main_scene_t *scene);
void mos_ui_main_scene_invalidate_caption_cache(void);
void mos_ui_main_scene_reset_caption_cache(void);

/* True when the renderer's last-committed text exactly equals `text`.
 * Use this for upstream throttling/dedup decisions before calling _render_caption_text. */
bool mos_ui_main_scene_caption_dedup_match(const char *text);

int  mos_ui_main_scene_set_translation_pair(display_biz_lang_t src, display_biz_lang_t dst);
void mos_ui_main_scene_get_translation_pair(display_biz_lang_t *src, display_biz_lang_t *dst);

/* ------------------------------------------------------------------------- *
 * Dynamic font integration
 * ------------------------------------------------------------------------- */
/* Apply a font swap to all scene-owned dynamic-font labels. While welcome is the active
 * mode, welcome_text is left for the caller to refresh separately (battery-aware text). */
void mos_ui_main_scene_apply_dynamic_font(mos_ui_main_scene_t *scene, const lv_font_t *new_font);

#endif /* MAIN_SCENE_H_ */
