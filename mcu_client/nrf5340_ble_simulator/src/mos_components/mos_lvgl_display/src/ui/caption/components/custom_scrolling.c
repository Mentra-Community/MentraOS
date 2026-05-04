#include "custom_scrolling.h"

#include <zephyr/logging/log.h>
#include <lvgl.h>

LOG_MODULE_REGISTER(custom_scrolling, LOG_LEVEL_DBG);

lv_obj_t *mos_ui_custom_scrolling_create(lv_obj_t *container, const mos_ui_custom_scrolling_cfg_t *cfg)
{
    if (!container || !cfg)
    {
        LOG_ERR("custom_scrolling: invalid args");
        return NULL;
    }

    lv_obj_t *cs = lv_obj_create(container);
    lv_obj_set_size(cs, cfg->width, cfg->height);
    lv_obj_set_style_bg_opa(cs, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(cs, 0, 0);
    lv_obj_set_style_border_opa(cs, LV_OPA_TRANSP, 0);
    lv_obj_set_scroll_dir(cs, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(cs, LV_SCROLLBAR_MODE_AUTO);
    lv_obj_align(cs, LV_ALIGN_TOP_LEFT, 0, cfg->label_y_offset);
    lv_obj_add_flag(cs, LV_OBJ_FLAG_HIDDEN);

    LOG_DBG("custom_scrolling created @%p", (void *)cs);
    return cs;
}
