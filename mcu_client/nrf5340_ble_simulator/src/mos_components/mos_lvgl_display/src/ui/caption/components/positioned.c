#include "positioned.h"

#include <zephyr/logging/log.h>
#include <lvgl.h>

LOG_MODULE_REGISTER(positioned, LOG_LEVEL_DBG);

lv_obj_t *mos_ui_positioned_create(lv_obj_t *container, const mos_ui_positioned_cfg_t *cfg)
{
    if (!container || !cfg)
    {
        LOG_ERR("positioned: invalid args");
        return NULL;
    }

    lv_obj_t *overlay = lv_obj_create(container);
    lv_obj_set_size(overlay, cfg->width, cfg->height);
    lv_obj_set_style_bg_opa(overlay, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(overlay, 0, 0);
    lv_obj_set_style_border_opa(overlay, LV_OPA_TRANSP, 0);
    lv_obj_set_style_pad_all(overlay, 0, 0);
    lv_obj_set_scroll_dir(overlay, LV_DIR_NONE);
    lv_obj_set_scrollbar_mode(overlay, LV_SCROLLBAR_MODE_OFF);
    lv_obj_align(overlay, LV_ALIGN_TOP_LEFT, 0, 0);
    lv_obj_add_flag(overlay, LV_OBJ_FLAG_HIDDEN);

    LOG_DBG("positioned created @%p", (void *)overlay);
    return overlay;
}
