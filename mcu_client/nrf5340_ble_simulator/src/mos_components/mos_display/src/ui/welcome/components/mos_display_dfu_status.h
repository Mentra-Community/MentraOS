#ifndef MOS_DISPLAY_DFU_STATUS_H_
#define MOS_DISPLAY_DFU_STATUS_H_

#include <lvgl.h>

lv_obj_t *mos_ui_dfu_status_create(lv_obj_t *container, int width, lv_color_t text_color,
                                    const lv_font_t *font, lv_obj_t *anchor);

#endif /* MOS_DISPLAY_DFU_STATUS_H_ */
