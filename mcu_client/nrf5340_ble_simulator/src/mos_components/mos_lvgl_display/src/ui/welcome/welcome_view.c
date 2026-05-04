#include "welcome_view.h"

#include <zephyr/logging/log.h>
#include <lvgl.h>

LOG_MODULE_REGISTER(welcome_view, LOG_LEVEL_DBG);

mos_ui_welcome_view_t mos_ui_welcome_view_create(lv_obj_t *parent, const mos_ui_welcome_view_cfg_t *cfg)
{
    mos_ui_welcome_view_t view = {0};

    if (!parent || !cfg)
    {
        LOG_ERR("welcome_view: invalid args");
        return view;
    }

    lv_obj_t *container = lv_obj_create(parent);
    lv_obj_set_size(container, cfg->width, cfg->height);
    lv_obj_set_pos(container, cfg->x, cfg->y);
    lv_obj_set_scroll_dir(container, LV_DIR_NONE);
    lv_obj_set_scrollbar_mode(container, LV_SCROLLBAR_MODE_OFF);
    lv_obj_set_style_bg_color(container, cfg->bg_color, 0);
    lv_obj_set_style_bg_opa(container, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(container, 0, 0);
    lv_obj_set_style_border_opa(container, LV_OPA_TRANSP, 0);
    lv_obj_set_style_pad_all(container, cfg->padding, 0);
    view.container = container;

    view.welcome_text = mos_ui_welcome_text_create(container, &cfg->text);

    int inner_width = cfg->width - cfg->padding * 2;
    view.dfu_status = mos_ui_dfu_status_create(container, inner_width,
                                                cfg->dfu_text_color, cfg->dfu_font,
                                                view.welcome_text);

    view.dfu_progress = mos_ui_dfu_progress_bar_create(container, inner_width,
                                                        cfg->dfu_bar_bg_color, cfg->dfu_bar_fill_color,
                                                        view.dfu_status);

    LOG_DBG("welcome_view created @%p", (void *)container);
    return view;
}

void mos_ui_welcome_view_destroy(mos_ui_welcome_view_t *view)
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
    view->welcome_text = NULL;
    view->dfu_status = NULL;
    view->dfu_progress.bar = NULL;
    view->dfu_progress.fill = NULL;
    view->dfu_progress.bar_width = 0;
}
