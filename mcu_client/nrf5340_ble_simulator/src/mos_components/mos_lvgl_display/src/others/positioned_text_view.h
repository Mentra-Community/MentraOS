#ifndef POSITIONED_TEXT_VIEW_H_
#define POSITIONED_TEXT_VIEW_H_

#include <lvgl.h>

typedef struct
{
    lv_obj_t *container;
} mos_ui_positioned_text_view_t;

typedef struct
{
    int x;
    int y;
    int width;
    int height;
} mos_ui_positioned_text_view_cfg_t;

mos_ui_positioned_text_view_t mos_ui_positioned_text_view_create(lv_obj_t *parent,
                                                                  const mos_ui_positioned_text_view_cfg_t *cfg);
void mos_ui_positioned_text_view_place(lv_obj_t *container, int x, int y, const char *text, const lv_font_t *font,
                                       lv_color_t color);
void mos_ui_positioned_text_view_clear(lv_obj_t *container);
void mos_ui_positioned_text_view_destroy(mos_ui_positioned_text_view_t *view);

#endif /* POSITIONED_TEXT_VIEW_H_ */
