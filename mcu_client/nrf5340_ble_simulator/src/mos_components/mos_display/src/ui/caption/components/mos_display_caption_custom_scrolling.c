#include "mos_display_caption_custom_scrolling.h"
#include "utils/mos_display_custom_rendering.h"

#include <zephyr/logging/log.h>
#include <lvgl.h>

LOG_MODULE_REGISTER(custom_scrolling, LOG_LEVEL_DBG);

mos_ui_custom_scrolling_t mos_ui_custom_scrolling_create(lv_obj_t *container, const mos_ui_custom_scrolling_cfg_t *cfg)
{
    mos_ui_custom_scrolling_t cs = {0};

    if (!container || !cfg)
    {
        LOG_ERR("custom_scrolling: invalid args");
        return cs;
    }

    lv_obj_t *obj = lv_obj_create(container);
    lv_obj_set_size(obj, cfg->width, cfg->height);
    lv_obj_set_style_bg_opa(obj, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(obj, 0, 0);
    lv_obj_set_style_border_opa(obj, LV_OPA_TRANSP, 0);
    lv_obj_set_scroll_dir(obj, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(obj, LV_SCROLLBAR_MODE_AUTO);
    lv_obj_align(obj, LV_ALIGN_TOP_LEFT, 0, cfg->label_y_offset);
    lv_obj_add_flag(obj, LV_OBJ_FLAG_HIDDEN);

    cs.container = obj;

    LOG_DBG("custom_scrolling created @%p", (void *)obj);
    return cs;
}

void mos_ui_custom_scrolling_update_text(mos_ui_custom_scrolling_t *cs,
                                          const char *text,
                                          const lv_font_t *font_primary, const lv_font_t *font_fallback,
                                          lv_color_t text_color)
{
    if (!cs || !cs->container || !text)
    {
        return;
    }

    lv_coord_t content_width = lv_obj_get_content_width(cs->container);

    mos_ui_custom_render(cs->container,
                          0, 0, content_width,
                          text,
                          font_primary, font_fallback,
                          text_color,
                          cs->pool, MOS_UI_CUSTOM_SCROLLING_POOL_SIZE, &cs->pool_used,
                          NULL, NULL, NULL);
}
