#ifndef CAPTION_VIEW_H_
#define CAPTION_VIEW_H_

#include <lvgl.h>
#include "components/default_scrolling.h"
#include "components/custom_scrolling.h"
#include "components/positioned.h"

typedef struct
{
    lv_obj_t *container;
    lv_obj_t *default_scrolling;
    lv_obj_t *custom_scrolling;
    lv_obj_t *positioned;
} mos_ui_caption_view_t;

typedef struct
{
    int x;
    int y;
    int width;
    int height;
    int padding;
    lv_color_t bg_color;
    mos_ui_default_scrolling_cfg_t default_scrolling;
    mos_ui_custom_scrolling_cfg_t custom_scrolling;
    mos_ui_positioned_cfg_t positioned;
} mos_ui_caption_view_cfg_t;

mos_ui_caption_view_t mos_ui_caption_view_create(lv_obj_t *parent, const mos_ui_caption_view_cfg_t *cfg);
void mos_ui_caption_view_update(lv_obj_t *label, const lv_font_t *font, const char *text);
void mos_ui_caption_view_destroy(mos_ui_caption_view_t *view);

#endif /* CAPTION_VIEW_H_ */
