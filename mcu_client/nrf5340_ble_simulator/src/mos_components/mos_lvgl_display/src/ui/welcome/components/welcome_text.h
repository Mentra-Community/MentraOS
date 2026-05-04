#ifndef WELCOME_TEXT_H_
#define WELCOME_TEXT_H_

#include <lvgl.h>

typedef struct
{
    int width;
    int padding;
    lv_color_t text_color;
    const lv_font_t *font;
    int line_spacing;
    const char *initial_text;
} mos_ui_welcome_text_cfg_t;

lv_obj_t *mos_ui_welcome_text_create(lv_obj_t *container, const mos_ui_welcome_text_cfg_t *cfg);
void mos_ui_welcome_text_update(lv_obj_t *label, const lv_font_t *font, const char *text);

#endif /* WELCOME_TEXT_H_ */
