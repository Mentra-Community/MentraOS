#include "mos_display_main_scene.h"

#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <lvgl.h>

#include "caption/mos_display_caption_renderer.h"
#include "mos_display_caption_throttler.h"
#include "mos_display_config.h"
#include "utils/mos_display_dynamic_font_labels.h"

LOG_MODULE_REGISTER(main_scene, LOG_LEVEL_DBG);

/* Cross-thread-readable mode mirror. The LVGL thread is the only writer (always via the
 * activate_* / set_mode helpers below); BLE/protobuf threads read this to decide whether
 * to enqueue caption text or route to the positioned overlay. */
static K_MUTEX_DEFINE(s_mode_lock);
static mos_ui_main_scene_mode_t s_mode = MOS_UI_MAIN_SCENE_MODE_NONE;

/* Debug-border flag. Read from any thread; writes are guarded so the shell thread can flip
 * it independently of the LVGL thread that performs the apply. */
static K_MUTEX_DEFINE(s_debug_lock);
static bool s_debug_borders = false;

static void set_mode(mos_ui_main_scene_mode_t mode)
{
    k_mutex_lock(&s_mode_lock, K_FOREVER);
    s_mode = mode;
    k_mutex_unlock(&s_mode_lock);
}

mos_ui_main_scene_mode_t mos_ui_main_scene_get_mode(void)
{
    mos_ui_main_scene_mode_t mode;
    k_mutex_lock(&s_mode_lock, K_FOREVER);
    mode = s_mode;
    k_mutex_unlock(&s_mode_lock);
    return mode;
}

bool mos_ui_main_scene_is_welcome_mode(void)
{
    return mos_ui_main_scene_get_mode() == MOS_UI_MAIN_SCENE_MODE_WELCOME;
}

bool mos_ui_main_scene_can_render_caption(void)
{
    mos_ui_main_scene_mode_t mode = mos_ui_main_scene_get_mode();
    return mode == MOS_UI_MAIN_SCENE_MODE_WELCOME || mode == MOS_UI_MAIN_SCENE_MODE_CAPTION;
}

/* ------------------------------------------------------------------------- *
 * Debug borders
 * ------------------------------------------------------------------------- */

void mos_ui_main_scene_set_debug_borders(bool on)
{
    k_mutex_lock(&s_debug_lock, K_FOREVER);
    s_debug_borders = on;
    k_mutex_unlock(&s_debug_lock);
}

bool mos_ui_main_scene_debug_borders_enabled(void)
{
    bool on;
    k_mutex_lock(&s_debug_lock, K_FOREVER);
    on = s_debug_borders;
    k_mutex_unlock(&s_debug_lock);
    return on;
}

static void apply_border_to(lv_obj_t *obj, bool on, lv_color_t color)
{
    if (!obj) return;
    if (on)
    {
        lv_obj_set_style_border_width(obj, 1, 0);
        lv_obj_set_style_border_color(obj, color, 0);
        lv_obj_set_style_border_opa(obj, LV_OPA_COVER, 0);
    }
    else
    {
        lv_obj_set_style_border_width(obj, 0, 0);
        lv_obj_set_style_border_opa(obj, LV_OPA_TRANSP, 0);
    }
    lv_obj_invalidate(obj);
}

void mos_ui_main_scene_apply_debug_borders(mos_ui_main_scene_t *scene, lv_obj_t *screen)
{
    bool on = mos_ui_main_scene_debug_borders_enabled();
    lv_color_t color = display_get_text_color();

    apply_border_to(screen, on, color);
    if (scene)
    {
        apply_border_to(scene->welcome.container, on, color);
        apply_border_to(scene->caption.container, on, color);
    }
}

/* ------------------------------------------------------------------------- *
 * Lifecycle
 * ------------------------------------------------------------------------- */

mos_ui_main_scene_t mos_ui_main_scene_create(lv_obj_t *parent, const mos_ui_main_scene_cfg_t *cfg)
{
    mos_ui_main_scene_t scene = {0};

    if (!parent || !cfg)
    {
        LOG_ERR("main_scene: invalid args");
        return scene;
    }

    int inner_width = cfg->width - (cfg->padding * 2);
    int inner_height = cfg->height - (cfg->padding * 2);

    mos_ui_welcome_view_cfg_t welcome_cfg = {
        .x = cfg->x,
        .y = cfg->y,
        .width = cfg->width,
        .height = cfg->height,
        .padding = cfg->padding,
        .bg_color = cfg->bg_color,
        .text = {
            .width = cfg->width,
            .padding = cfg->padding,
            .text_color = cfg->text_color,
            .font = cfg->font,
            .line_spacing = cfg->line_spacing,
        },
        .dfu_text_color = cfg->text_color,
        .dfu_font = cfg->dfu_font,
        .dfu_bar_bg_color = cfg->dfu_bar_bg_color,
        .dfu_bar_fill_color = cfg->dfu_bar_fill_color,
    };

    mos_ui_caption_view_cfg_t caption_cfg = {
        .x = cfg->x,
        .y = cfg->y,
        .width = cfg->width,
        .height = cfg->height,
        .padding = cfg->padding,
        .bg_color = cfg->bg_color,
        .default_scrolling = {
            .width = inner_width,
            .label_y_offset = cfg->label_y_offset,
            .text_color = cfg->text_color,
            .font = cfg->font,
            .line_spacing = cfg->line_spacing,
        },
        .custom_scrolling = {
            .width = inner_width,
            .height = inner_height,
            .label_y_offset = cfg->label_y_offset,
        },
        .positioned = {
            .width = inner_width,
            .height = inner_height,
        },
    };

    scene.welcome = mos_ui_welcome_view_create(parent, &welcome_cfg);
    scene.caption = mos_ui_caption_view_create(parent, &caption_cfg);

    if (scene.caption.container)
    {
        lv_obj_add_flag(scene.caption.container, LV_OBJ_FLAG_HIDDEN);
    }

    /* Register the labels that need hot-swapping on QSPI font change. */
    mos_dynamic_font_labels_add(scene.welcome.welcome_text);
    mos_dynamic_font_labels_add(scene.caption.default_scrolling);

    lv_obj_update_layout(parent);

    set_mode(MOS_UI_MAIN_SCENE_MODE_WELCOME);

    /* parent is the active screen (passed in from create_scrolling_text_container). Re-apply
     * the current debug-border flag so re-created containers don't lose the border across a
     * pattern rebuild. */
    mos_ui_main_scene_apply_debug_borders(&scene, parent);

    LOG_DBG("main_scene created");
    return scene;
}

void mos_ui_main_scene_destroy(mos_ui_main_scene_t *scene)
{
    if (!scene)
    {
        return;
    }

    /* Labels live inside the views; clear the registry before tearing the views down. */
    mos_dynamic_font_labels_clear();

    mos_ui_welcome_view_destroy(&scene->welcome);
    mos_ui_caption_view_destroy(&scene->caption);
    set_mode(MOS_UI_MAIN_SCENE_MODE_NONE);
}

/* ------------------------------------------------------------------------- *
 * Mode / view activation
 * ------------------------------------------------------------------------- */

static void activate_caption(mos_ui_main_scene_t *scene)
{
    set_mode(MOS_UI_MAIN_SCENE_MODE_CAPTION);
    if (scene->welcome.container)
        lv_obj_add_flag(scene->welcome.container, LV_OBJ_FLAG_HIDDEN);
    if (scene->caption.container)
        lv_obj_clear_flag(scene->caption.container, LV_OBJ_FLAG_HIDDEN);
}

static void activate_welcome(mos_ui_main_scene_t *scene)
{
    set_mode(MOS_UI_MAIN_SCENE_MODE_WELCOME);
    if (scene->caption.container)
        lv_obj_add_flag(scene->caption.container, LV_OBJ_FLAG_HIDDEN);
    if (scene->welcome.container)
        lv_obj_clear_flag(scene->welcome.container, LV_OBJ_FLAG_HIDDEN);
}

void mos_ui_main_scene_show_welcome(mos_ui_main_scene_t *scene)
{
    if (!scene) return;
    activate_welcome(scene);
}

void mos_ui_main_scene_show_positioned(mos_ui_main_scene_t *scene)
{
    if (!scene) return;
    activate_caption(scene);
    set_mode(MOS_UI_MAIN_SCENE_MODE_POSITIONED);
    mos_ui_caption_view_set_mode(&scene->caption, MOS_UI_CAPTION_MODE_POSITIONED);
}

/* ------------------------------------------------------------------------- *
 * Readiness / visibility
 * ------------------------------------------------------------------------- */

bool mos_ui_main_scene_caption_is_ready(const mos_ui_main_scene_t *scene)
{
    return scene && scene->caption.container != NULL;
}

bool mos_ui_main_scene_welcome_is_ready(const mos_ui_main_scene_t *scene)
{
    return scene && scene->welcome.container != NULL;
}

bool mos_ui_main_scene_welcome_is_visible(const mos_ui_main_scene_t *scene)
{
    if (!mos_ui_main_scene_welcome_is_ready(scene))
    {
        return false;
    }
    return !lv_obj_has_flag(scene->welcome.container, LV_OBJ_FLAG_HIDDEN);
}

/* ------------------------------------------------------------------------- *
 * Layout / invalidation
 * ------------------------------------------------------------------------- */

void mos_ui_main_scene_relayout_welcome(mos_ui_main_scene_t *scene)
{
    if (mos_ui_main_scene_welcome_is_ready(scene))
    {
        lv_obj_update_layout(scene->welcome.container);
    }
}

void mos_ui_main_scene_relayout_caption(mos_ui_main_scene_t *scene)
{
    if (mos_ui_main_scene_caption_is_ready(scene))
    {
        lv_obj_update_layout(scene->caption.container);
    }
}

void mos_ui_main_scene_invalidate_welcome(mos_ui_main_scene_t *scene)
{
    if (mos_ui_main_scene_welcome_is_ready(scene))
    {
        lv_obj_invalidate(scene->welcome.container);
    }
}

void mos_ui_main_scene_invalidate_caption(mos_ui_main_scene_t *scene)
{
    if (mos_ui_main_scene_caption_is_ready(scene))
    {
        lv_obj_invalidate(scene->caption.container);
    }
}

void mos_ui_main_scene_apply_height_config(mos_ui_main_scene_t *scene,
                                            lv_obj_t *screen,
                                            const display_config_t *cfg)
{
    if (!scene || !screen || !cfg) return;

    if (mos_ui_main_scene_welcome_is_ready(scene))
    {
        (void)display_apply_container_config(scene->welcome.container, screen, cfg);
        lv_obj_update_layout(scene->welcome.container);
    }
    if (mos_ui_main_scene_caption_is_ready(scene))
    {
        (void)display_apply_container_config(scene->caption.container, screen, cfg);
        lv_obj_update_layout(scene->caption.container);
    }
}

/* ------------------------------------------------------------------------- *
 * Welcome view
 * ------------------------------------------------------------------------- */

void mos_ui_main_scene_clear_welcome(mos_ui_main_scene_t *scene)
{
    if (!scene) return;
    mos_ui_welcome_view_clear(&scene->welcome);
}

void mos_ui_main_scene_clear_active(mos_ui_main_scene_t *scene)
{
    if (!scene) return;
    if (mos_ui_main_scene_is_welcome_mode())
    {
        mos_ui_welcome_view_clear(&scene->welcome);
    }
    else
    {
        mos_ui_caption_view_clear(&scene->caption);
    }
}

void mos_ui_main_scene_refresh_welcome_text(mos_ui_main_scene_t *scene, const lv_font_t *font)
{
    if (!scene) return;
    mos_ui_welcome_view_refresh_text(&scene->welcome, font);
}

void mos_ui_main_scene_refresh_welcome_active(mos_ui_main_scene_t *scene, const lv_font_t *font)
{
    if (!scene) return;
    if (!mos_ui_main_scene_is_welcome_mode()) return;
    if (!mos_ui_main_scene_welcome_is_ready(scene)) return;

    mos_ui_caption_view_clear_positioned(&scene->caption);
    mos_ui_welcome_view_refresh_text(&scene->welcome, font);
}

void mos_ui_main_scene_update_dfu_progress(mos_ui_main_scene_t *scene, bool show, uint8_t percent)
{
    if (!scene) return;
    mos_ui_welcome_view_update_dfu_progress(&scene->welcome, show, percent);
}

void mos_ui_main_scene_update_dfu_status(mos_ui_main_scene_t *scene, const char *text)
{
    if (!scene) return;
    mos_ui_welcome_view_update_dfu_status(&scene->welcome, text);
}

/* ------------------------------------------------------------------------- *
 * Caption view
 * ------------------------------------------------------------------------- */

void mos_ui_main_scene_clear_caption(mos_ui_main_scene_t *scene)
{
    if (!scene) return;
    mos_ui_caption_view_clear(&scene->caption);
}

void mos_ui_main_scene_clear_positioned(mos_ui_main_scene_t *scene)
{
    if (!scene) return;
    mos_ui_caption_view_clear_positioned(&scene->caption);
}

void mos_ui_main_scene_scroll_caption_to_bottom(mos_ui_main_scene_t *scene)
{
    if (!scene) return;
    mos_ui_caption_view_scroll_to_bottom(&scene->caption);
}

void mos_ui_main_scene_set_caption_scroll_enabled(mos_ui_main_scene_t *scene, bool enabled)
{
    if (!scene) return;
    mos_ui_caption_view_set_scroll_enabled(&scene->caption, enabled);
}

void mos_ui_main_scene_render_positioned_text(mos_ui_main_scene_t *scene,
                                                uint16_t x, uint16_t y,
                                                const char *text, uint32_t raw_color)
{
    if (!scene) return;
    activate_caption(scene);
    set_mode(MOS_UI_MAIN_SCENE_MODE_POSITIONED);
    mos_ui_caption_view_set_scroll_enabled(&scene->caption, true);
    mos_ui_caption_view_render_positioned_text(&scene->caption, x, y, text, raw_color);
}

/* ------------------------------------------------------------------------- *
 * Caption text rendering — wraps caption_renderer
 * ------------------------------------------------------------------------- */

void mos_ui_main_scene_render_caption_text(mos_ui_main_scene_t *scene,
                                            const char *text, uint32_t committed_seq)
{
    if (!scene) return;
    activate_caption(scene);
    mos_ui_caption_renderer_render(scene, text, committed_seq);
}

int mos_ui_main_scene_set_translation_pair(display_biz_lang_t src, display_biz_lang_t dst)
{
    return mos_ui_caption_renderer_set_translation_pair(src, dst);
}

void mos_ui_main_scene_get_translation_pair(display_biz_lang_t *src, display_biz_lang_t *dst)
{
    mos_ui_caption_renderer_get_translation_pair(src, dst);
}

/* These are used by the renderer internally; kept as public shims for now since the renderer
 * lives in a sibling file. They funnel through the same activate_caption path so the caption
 * view is visible before its content updates. */
void mos_ui_main_scene_show_caption_default(mos_ui_main_scene_t *scene, const lv_font_t *font, const char *text)
{
    if (!scene) return;
    activate_caption(scene);
    mos_ui_caption_view_update_default_text(&scene->caption, font, text);
}

void mos_ui_main_scene_show_caption_custom(mos_ui_main_scene_t *scene, const char *text,
                                            const lv_font_t *font_primary, const lv_font_t *font_fallback,
                                            lv_color_t text_color)
{
    if (!scene) return;
    activate_caption(scene);
    mos_ui_caption_view_update_custom_text(&scene->caption, text, font_primary, font_fallback, text_color);
}

/* ------------------------------------------------------------------------- *
 * Dynamic font integration
 * ------------------------------------------------------------------------- */

static bool font_skip_predicate(lv_obj_t *label, void *user_data)
{
    const mos_ui_main_scene_t *scene = (const mos_ui_main_scene_t *)user_data;
    if (!scene) return false;
    /* welcome_text on welcome screen is refreshed later via the battery refresh path. */
    return mos_ui_main_scene_is_welcome_mode() && label == scene->welcome.welcome_text;
}

void mos_ui_main_scene_apply_dynamic_font(mos_ui_main_scene_t *scene, const lv_font_t *new_font)
{
    if (!scene || !new_font) return;
    mos_dynamic_font_labels_apply(new_font, font_skip_predicate, scene);
}

/* Render-callback used by the throttler when re-running the last caption text. */
static void font_change_caption_rerender(const char *text, uint32_t seq, void *user_data)
{
    mos_ui_main_scene_t *scene = (mos_ui_main_scene_t *)user_data;
    activate_caption(scene);
    mos_ui_caption_renderer_render(scene, text, seq);
}

void mos_ui_main_scene_handle_font_changed(mos_ui_main_scene_t *scene, const lv_font_t *new_font)
{
    if (!scene || !new_font) return;

    /* 1. Push the font onto every dynamic-font label (skips welcome_text in welcome mode;
     *    that label gets a content rebuild below). */
    mos_ui_main_scene_apply_dynamic_font(scene, new_font);

    bool welcome_mode = mos_ui_main_scene_is_welcome_mode();

    /* 2. Refresh the active view's content with the new font. */
    if (welcome_mode)
    {
        mos_ui_welcome_view_refresh_text(&scene->welcome, new_font);
        activate_welcome(scene);
        if (scene->welcome.container)
        {
            lv_obj_update_layout(scene->welcome.container);
            lv_obj_invalidate(scene->welcome.container);
        }
    }
    else if (scene->caption.container)
    {
        /* Re-render whatever caption was last committed; the throttler holds the text and
         * bypasses dedup so the new glyph metrics are picked up. */
        mos_caption_throttler_force_rerender(font_change_caption_rerender, scene);
    }

    /* 3. Caption container always needs a relayout pass after a font swap (its scrollable
     *    inner-content metrics depend on glyph height even when caption is hidden). */
    if (scene->caption.container)
    {
        lv_obj_update_layout(scene->caption.container);
        mos_ui_caption_view_set_scroll_enabled(&scene->caption, !welcome_mode);
        if (!welcome_mode)
        {
            mos_ui_caption_view_scroll_to_bottom(&scene->caption);
        }
        lv_obj_invalidate(scene->caption.container);
    }
}
