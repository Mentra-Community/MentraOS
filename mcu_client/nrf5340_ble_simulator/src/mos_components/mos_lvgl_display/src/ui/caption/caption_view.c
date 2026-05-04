#include "caption_view.h"

#include <zephyr/logging/log.h>
#include <lvgl.h>

LOG_MODULE_REGISTER(caption_view, LOG_LEVEL_DBG);

mos_ui_caption_view_t mos_ui_caption_view_create(lv_obj_t *parent, const mos_ui_caption_view_cfg_t *cfg)
{
    mos_ui_caption_view_t view = {0};

    if (!parent || !cfg)
    {
        LOG_ERR("caption_view: invalid args");
        return view;
    }

    lv_obj_t *container = lv_obj_create(parent);
    lv_obj_set_size(container, cfg->width, cfg->height);
    lv_obj_set_pos(container, cfg->x, cfg->y);
    lv_obj_set_scroll_dir(container, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(container, LV_SCROLLBAR_MODE_OFF);
    lv_obj_set_style_bg_color(container, cfg->bg_color, 0);
    lv_obj_set_style_bg_opa(container, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(container, 0, 0);
    lv_obj_set_style_border_opa(container, LV_OPA_TRANSP, 0);
    lv_obj_set_style_pad_all(container, cfg->padding, 0);
    view.container = container;

    view.default_scrolling = mos_ui_default_scrolling_create(container, &cfg->default_scrolling);
    view.custom_scrolling   = mos_ui_custom_scrolling_create(container, &cfg->custom_scrolling);
    view.positioned         = mos_ui_positioned_create(container, &cfg->positioned);

    LOG_DBG("caption_view created @%p", (void *)container);
    return view;
}

void mos_ui_caption_view_set_mode(mos_ui_caption_view_t *view, mos_ui_caption_mode_t mode)
{
    if (!view)
    {
        return;
    }

    bool show_default    = (mode == MOS_UI_CAPTION_MODE_DEFAULT);
    bool show_custom     = (mode == MOS_UI_CAPTION_MODE_CUSTOM);
    bool show_positioned = (mode == MOS_UI_CAPTION_MODE_POSITIONED);

    if (view->default_scrolling)
    {
        if (show_default) lv_obj_clear_flag(view->default_scrolling, LV_OBJ_FLAG_HIDDEN);
        else              lv_obj_add_flag(view->default_scrolling, LV_OBJ_FLAG_HIDDEN);
    }

    if (view->custom_scrolling.container)
    {
        if (show_custom) lv_obj_clear_flag(view->custom_scrolling.container, LV_OBJ_FLAG_HIDDEN);
        else             lv_obj_add_flag(view->custom_scrolling.container, LV_OBJ_FLAG_HIDDEN);
    }

    if (view->positioned)
    {
        if (show_positioned) lv_obj_clear_flag(view->positioned, LV_OBJ_FLAG_HIDDEN);
        else                 lv_obj_add_flag(view->positioned, LV_OBJ_FLAG_HIDDEN);
    }
}

void mos_ui_caption_view_update_default_text(mos_ui_caption_view_t *view, const lv_font_t *font, const char *text)
{
    if (!view || !text)
    {
        return;
    }

    mos_ui_caption_view_set_mode(view, MOS_UI_CAPTION_MODE_DEFAULT);
    mos_ui_default_scrolling_update_text(view->default_scrolling, font, text);
}

void mos_ui_caption_view_update_custom_text(mos_ui_caption_view_t *view, const char *text,
                                             const lv_font_t *font_primary, const lv_font_t *font_fallback,
                                             lv_color_t text_color)
{
    if (!view || !text)
    {
        return;
    }

    mos_ui_caption_view_set_mode(view, MOS_UI_CAPTION_MODE_CUSTOM);
    mos_ui_custom_scrolling_update_text(&view->custom_scrolling, text, font_primary, font_fallback, text_color);
}

void mos_ui_caption_view_update_positioned_text(mos_ui_caption_view_t *view, const char *text,
                                                 const lv_font_t *font, lv_color_t text_color,
                                                 lv_coord_t x, lv_coord_t y)
{
    if (!view || !view->positioned || !text)
    {
        return;
    }

    // TODO: Add implementation later.
    mos_ui_caption_view_set_mode(view, MOS_UI_CAPTION_MODE_POSITIONED);
}

void mos_ui_caption_view_destroy(mos_ui_caption_view_t *view)
{
    if (!view)
    {
        return;
    }

    if (view->container)
    {
        lv_obj_del(view->container);
    }

    view->container = NULL;
    view->default_scrolling = NULL;
    view->custom_scrolling.container = NULL;
    view->custom_scrolling.pool_used = 0;
    view->positioned = NULL;
}
