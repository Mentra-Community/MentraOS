#ifndef CUSTOM_SCROLLING_H_
#define CUSTOM_SCROLLING_H_

#include <lvgl.h>

typedef struct
{
    int width;
    int height;
    int label_y_offset;
} mos_ui_custom_scrolling_cfg_t;

lv_obj_t *mos_ui_custom_scrolling_create(lv_obj_t *container, const mos_ui_custom_scrolling_cfg_t *cfg);

#endif /* CUSTOM_SCROLLING_H_ */
