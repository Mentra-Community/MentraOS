#ifndef CAPTION_VIEW_H_
#define CAPTION_VIEW_H_

#include <lvgl.h>
#include "components/default_scrolling.h"
#include "components/custom_scrolling.h"
#include "components/positioned.h"

typedef enum
{
    MOS_UI_CAPTION_MODE_DEFAULT,
    MOS_UI_CAPTION_MODE_CUSTOM,
    MOS_UI_CAPTION_MODE_POSITIONED,
} mos_ui_caption_mode_t;

typedef struct
{
    lv_obj_t *container;
    lv_obj_t *default_scrolling;
    mos_ui_custom_scrolling_t custom_scrolling;
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
void mos_ui_caption_view_set_mode(mos_ui_caption_view_t *view, mos_ui_caption_mode_t mode);
void mos_ui_caption_view_update_default_text(mos_ui_caption_view_t *view, const lv_font_t *font, const char *text);
void mos_ui_caption_view_update_custom_text(mos_ui_caption_view_t *view, const char *text,
                                             const lv_font_t *font_primary, const lv_font_t *font_fallback,
                                             lv_color_t text_color);
void mos_ui_caption_view_update_positioned_text(mos_ui_caption_view_t *view, const char *text,
                                                 const lv_font_t *font, lv_color_t text_color,
                                                 lv_coord_t x, lv_coord_t y);
void mos_ui_caption_view_destroy(mos_ui_caption_view_t *view);

#endif /* CAPTION_VIEW_H_ */
