#ifndef MOS_DISPLAY_CAPTION_CUSTOM_SCROLLING_H_
#define MOS_DISPLAY_CAPTION_CUSTOM_SCROLLING_H_

#include <lvgl.h>

#define MOS_UI_CUSTOM_SCROLLING_POOL_SIZE 256

typedef struct
{
    int width;
    int height;
    int label_y_offset;
} mos_ui_custom_scrolling_cfg_t;

typedef struct
{
    lv_obj_t *container;
    lv_obj_t *pool[MOS_UI_CUSTOM_SCROLLING_POOL_SIZE];
    size_t pool_used;
} mos_ui_custom_scrolling_t;

mos_ui_custom_scrolling_t mos_ui_custom_scrolling_create(lv_obj_t *container, const mos_ui_custom_scrolling_cfg_t *cfg);

void mos_ui_custom_scrolling_update_text(mos_ui_custom_scrolling_t *cs,
                                          const char *text,
                                          const lv_font_t *font_primary, const lv_font_t *font_fallback,
                                          lv_color_t text_color);

#endif /* MOS_DISPLAY_CAPTION_CUSTOM_SCROLLING_H_ */
