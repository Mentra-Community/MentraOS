#include "positioned_text_view.h"

#include <zephyr/logging/log.h>
#include <lvgl.h>

LOG_MODULE_REGISTER(positioned_text_view, LOG_LEVEL_DBG);

mos_ui_positioned_text_view_t mos_ui_positioned_text_view_create(lv_obj_t *parent,
                                                                  const mos_ui_positioned_text_view_cfg_t *cfg)
{
    mos_ui_positioned_text_view_t view = {.container = NULL};

    if (!parent || !cfg)
    {
        LOG_ERR("positioned_text_view: invalid args");
        return view;
    }

    lv_obj_t *container = lv_obj_create(parent);
    lv_obj_set_size(container, cfg->width, cfg->height);
    lv_obj_set_pos(container, cfg->x, cfg->y);
    lv_obj_set_scroll_dir(container, LV_DIR_NONE);
    lv_obj_set_scrollbar_mode(container, LV_SCROLLBAR_MODE_OFF);
    lv_obj_set_style_bg_opa(container, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(container, 0, 0);
    lv_obj_set_style_border_opa(container, LV_OPA_TRANSP, 0);
    lv_obj_set_style_pad_all(container, 0, 0);

    LOG_DBG("positioned_text_view created: container @%p", (void *)container);

    view.container = container;
    return view;
}

void mos_ui_positioned_text_view_place(lv_obj_t *container, int x, int y, const char *text, const lv_font_t *font,
                                       lv_color_t color)
{
    if (!container || !text)
    {
        return;
    }

    mos_ui_positioned_text_view_clear(container);

    lv_obj_t *label = lv_label_create(container);
    lv_label_set_text(label, text);
    lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(label, lv_obj_get_width(container) - x);
    lv_obj_set_pos(label, x, y);
    lv_obj_set_style_bg_opa(label, LV_OPA_TRANSP, 0);
    lv_obj_set_style_text_color(label, color, 0);

    if (font)
    {
        lv_obj_set_style_text_font(label, font, 0);
    }

    lv_obj_invalidate(label);

    LOG_DBG("placed text at (%d,%d): '%.30s'", x, y, text);
}

void mos_ui_positioned_text_view_clear(lv_obj_t *container)
{
    if (!container)
    {
        return;
    }

    if (lv_obj_get_child_cnt(container) > 0)
    {
        lv_obj_clean(container);
    }
}

void mos_ui_positioned_text_view_destroy(mos_ui_positioned_text_view_t *view)
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
}
