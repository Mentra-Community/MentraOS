#ifndef DFU_PROGRESS_BAR_H_
#define DFU_PROGRESS_BAR_H_

#include <lvgl.h>

typedef struct
{
    lv_obj_t *bar;
    lv_obj_t *fill;
    lv_coord_t bar_width;
} mos_ui_dfu_progress_t;

mos_ui_dfu_progress_t mos_ui_dfu_progress_bar_create(lv_obj_t *container, int width, lv_color_t bg_color,
                                                      lv_color_t fill_color, lv_obj_t *anchor);

#endif /* DFU_PROGRESS_BAR_H_ */
