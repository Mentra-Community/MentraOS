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
    view.custom_scrolling = mos_ui_custom_scrolling_create(container, &cfg->custom_scrolling);
    view.positioned = mos_ui_positioned_create(container, &cfg->positioned);

    LOG_DBG("caption_view created @%p", (void *)container);
    return view;
}

void mos_ui_caption_view_update(lv_obj_t *label, const lv_font_t *font, const char *text)
{
    if (!label || !text)
    {
        return;
    }

    if (font)
    {
        lv_obj_set_style_text_font(label, font, 0);
    }

    lv_label_set_text(label, text);
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
    view->custom_scrolling = NULL;
    view->positioned = NULL;
}
