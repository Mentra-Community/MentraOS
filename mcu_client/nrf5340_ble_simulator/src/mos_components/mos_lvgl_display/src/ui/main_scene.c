#include "main_scene.h"

#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(main_scene, LOG_LEVEL_DBG);

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

    lv_obj_update_layout(parent);

    LOG_DBG("main_scene created");
    return scene;
}


static void activate_caption(mos_ui_main_scene_t *scene)
{
    if (scene->welcome.container)
        lv_obj_add_flag(scene->welcome.container, LV_OBJ_FLAG_HIDDEN);
    if (scene->caption.container)
        lv_obj_clear_flag(scene->caption.container, LV_OBJ_FLAG_HIDDEN);
}

static void activate_welcome(mos_ui_main_scene_t *scene)
{
    if (scene->caption.container)
        lv_obj_add_flag(scene->caption.container, LV_OBJ_FLAG_HIDDEN);
    if (scene->welcome.container)
        lv_obj_clear_flag(scene->welcome.container, LV_OBJ_FLAG_HIDDEN);
}

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

void mos_ui_main_scene_show_positioned(mos_ui_main_scene_t *scene)
{
    if (!scene) return;
    activate_caption(scene);
    mos_ui_caption_view_set_mode(&scene->caption, MOS_UI_CAPTION_MODE_POSITIONED);
}

void mos_ui_main_scene_show_welcome(mos_ui_main_scene_t *scene)
{
    if (!scene) return;
    activate_welcome(scene);
}

void mos_ui_main_scene_clear_welcome(mos_ui_main_scene_t *scene)
{
    if (!scene) return;
    mos_ui_welcome_view_clear(&scene->welcome);
}

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

void mos_ui_main_scene_destroy(mos_ui_main_scene_t *scene)
{
    if (!scene)
    {
        return;
    }

    mos_ui_welcome_view_destroy(&scene->welcome);
    mos_ui_caption_view_destroy(&scene->caption);
}
