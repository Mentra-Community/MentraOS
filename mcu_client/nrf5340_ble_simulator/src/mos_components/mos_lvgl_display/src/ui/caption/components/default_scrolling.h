#ifndef DEFAULT_SCROLLING_H_
#define DEFAULT_SCROLLING_H_

#include <lvgl.h>

typedef struct
{
    int width;
    int label_y_offset;
    lv_color_t text_color;
    const lv_font_t *font;
    int line_spacing;
} mos_ui_default_scrolling_cfg_t;

lv_obj_t *mos_ui_default_scrolling_create(lv_obj_t *container, const mos_ui_default_scrolling_cfg_t *cfg);

#endif /* DEFAULT_SCROLLING_H_ */
