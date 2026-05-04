#include "welcome_text.h"

#include <zephyr/logging/log.h>
#include <lvgl.h>

LOG_MODULE_REGISTER(welcome_text, LOG_LEVEL_DBG);

lv_obj_t *mos_ui_welcome_text_create(lv_obj_t *container, const mos_ui_welcome_text_cfg_t *cfg)
{
    if (!container || !cfg)
    {
        LOG_ERR("welcome_text: invalid args");
        return NULL;
    }

    lv_obj_t *label = lv_label_create(container);
    lv_obj_set_width(label, cfg->width - cfg->padding * 2);
    lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_LEFT, 0);
    lv_obj_set_style_text_color(label, cfg->text_color, 0);
    lv_obj_set_style_text_line_space(label, cfg->line_spacing, 0);

    if (cfg->font)
    {
        lv_obj_set_style_text_font(label, cfg->font, 0);
    }

    if (cfg->initial_text)
    {
        lv_label_set_text(label, cfg->initial_text);
        lv_obj_update_layout(label);
    }

    LOG_DBG("welcome_text created @%p", (void *)label);
    return label;
}

void mos_ui_welcome_text_update(lv_obj_t *label, const lv_font_t *font, const char *text)
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
