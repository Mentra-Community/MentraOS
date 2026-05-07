#include "mos_display_caption_default_scrolling.h"

#include <zephyr/logging/log.h>
#include <lvgl.h>

LOG_MODULE_REGISTER(default_scrolling, LOG_LEVEL_DBG);

lv_obj_t *mos_ui_default_scrolling_create(lv_obj_t *container, const mos_ui_default_scrolling_cfg_t *cfg)
{
    if (!container || !cfg)
    {
        LOG_ERR("default_scrolling: invalid args");
        return NULL;
    }

    lv_obj_t *label = lv_label_create(container);
    lv_obj_set_width(label, cfg->width);
    lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_LEFT, 0);
    lv_obj_set_style_text_color(label, cfg->text_color, 0);
    lv_obj_set_style_text_line_space(label, cfg->line_spacing, 0);
    lv_obj_align(label, LV_ALIGN_TOP_LEFT, 0, cfg->label_y_offset);

    if (cfg->font)
    {
        lv_obj_set_style_text_font(label, cfg->font, 0);
    }

    LOG_DBG("default_scrolling created @%p", (void *)label);
    return label;
}

void mos_ui_default_scrolling_update_text(lv_obj_t *default_scrolling, const lv_font_t *font, const char *text)
{
    if (!default_scrolling || !text)
    {
        return;
    }

    if (font)
    {
        lv_obj_set_style_text_font(default_scrolling, font, 0);
    }

    lv_label_set_text(default_scrolling, text);
}
