#ifndef MOS_DISPLAY_CAPTION_POSITIONED_H_
#define MOS_DISPLAY_CAPTION_POSITIONED_H_

#include <lvgl.h>

typedef struct
{
    int width;
    int height;
} mos_ui_positioned_cfg_t;

lv_obj_t *mos_ui_positioned_create(lv_obj_t *container, const mos_ui_positioned_cfg_t *cfg);

#endif /* MOS_DISPLAY_CAPTION_POSITIONED_H_ */
