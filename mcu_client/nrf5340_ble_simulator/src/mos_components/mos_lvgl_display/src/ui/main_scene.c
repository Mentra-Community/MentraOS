#include "main_scene.h"

#include <string.h>
#include <zephyr/logging/log.h>
#include <lvgl.h>

#include "caption/caption_renderer.h"
#include "display_config.h"
#include "utils/dynamic_font_labels.h"

LOG_MODULE_REGISTER(main_scene, LOG_LEVEL_DBG);

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
    scene.welcome_mode = true;

    if (scene.caption.container)
    {
        lv_obj_add_flag(scene.caption.container, LV_OBJ_FLAG_HIDDEN);
    }

    /* Register the labels that need hot-swapping on QSPI font change. */
    mos_dynamic_font_labels_add(scene.welcome.welcome_text);
    mos_dynamic_font_labels_add(scene.caption.default_scrolling);

    lv_obj_update_layout(parent);

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
}

/* ------------------------------------------------------------------------- *
 * Mode / view activation
 * ------------------------------------------------------------------------- */

static void activate_caption(mos_ui_main_scene_t *scene)
{
    scene->welcome_mode = false;
    if (scene->welcome.container)
        lv_obj_add_flag(scene->welcome.container, LV_OBJ_FLAG_HIDDEN);
    if (scene->caption.container)
        lv_obj_clear_flag(scene->caption.container, LV_OBJ_FLAG_HIDDEN);
}

static void activate_welcome(mos_ui_main_scene_t *scene)
{
    scene->welcome_mode = true;
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

bool mos_ui_main_scene_is_welcome_mode(const mos_ui_main_scene_t *scene)
{
    return scene && scene->welcome_mode;
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
    if (scene->welcome_mode)
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
    /* The renderer dispatches into show_caption_default/custom which handles activation. */
    activate_caption(scene);
    mos_ui_caption_renderer_render(scene, text, committed_seq);
}

void mos_ui_main_scene_rerender_caption(mos_ui_main_scene_t *scene)
{
    if (!scene) return;
    mos_ui_caption_renderer_rerender(scene);
}

void mos_ui_main_scene_invalidate_caption_cache(void)
{
    mos_ui_caption_renderer_invalidate_cache();
}

void mos_ui_main_scene_reset_caption_cache(void)
{
    mos_ui_caption_renderer_reset_cache();
}

bool mos_ui_main_scene_caption_dedup_match(const char *text)
{
    if (!text || !mos_ui_caption_renderer_has_cache())
    {
        return false;
    }
    return strcmp(text, mos_ui_caption_renderer_get_cache()) == 0;
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
    return scene->welcome_mode && label == scene->welcome.welcome_text;
}

void mos_ui_main_scene_apply_dynamic_font(mos_ui_main_scene_t *scene, const lv_font_t *new_font)
{
    if (!scene || !new_font) return;
    mos_dynamic_font_labels_apply(new_font, font_skip_predicate, scene);
}

void mos_ui_main_scene_handle_font_changed(mos_ui_main_scene_t *scene, const lv_font_t *new_font)
{
    if (!scene || !new_font) return;

    /* 1. Push the font onto every dynamic-font label (skips welcome_text in welcome mode;
     *    that label gets a content rebuild below). */
    mos_ui_main_scene_apply_dynamic_font(scene, new_font);

    /* 2. CJK per-character pool uses old glyph height for coordinates;
     *    invalidate the cache so the next caption render re-runs layout. */
    mos_ui_caption_renderer_invalidate_cache();

    /* 3. Refresh the active view's content with the new font. */
    if (scene->welcome_mode)
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
        mos_ui_caption_renderer_rerender(scene);
    }

    /* 4. Caption container always needs a relayout pass after a font swap (its scrollable
     *    inner-content metrics depend on glyph height even when caption is hidden). */
    if (scene->caption.container)
    {
        lv_obj_update_layout(scene->caption.container);
        mos_ui_caption_view_set_scroll_enabled(&scene->caption, !scene->welcome_mode);
        if (!scene->welcome_mode)
        {
            mos_ui_caption_view_scroll_to_bottom(&scene->caption);
        }
        lv_obj_invalidate(scene->caption.container);
    }
}
