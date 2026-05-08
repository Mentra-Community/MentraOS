#ifndef MOS_DISPLAY_WELCOME_VIEW_H_
#define MOS_DISPLAY_WELCOME_VIEW_H_

#include <stdbool.h>
#include <stdint.h>
#include <lvgl.h>
#include "components/mos_display_welcome_text.h"
#include "components/mos_display_dfu_status.h"
#include "components/mos_display_dfu_progress_bar.h"

typedef struct
{
    lv_obj_t *container;
    lv_obj_t *welcome_text;
    lv_obj_t *dfu_status;
    mos_ui_dfu_progress_t dfu_progress;
} mos_ui_welcome_view_t;

typedef struct
{
    int x;
    int y;
    int width;
    int height;
    int padding;
    lv_color_t bg_color;
    mos_ui_welcome_text_cfg_t text;
    lv_color_t dfu_text_color;
    const lv_font_t *dfu_font;
    lv_color_t dfu_bar_bg_color;
    lv_color_t dfu_bar_fill_color;
} mos_ui_welcome_view_cfg_t;

mos_ui_welcome_view_t mos_ui_welcome_view_create(lv_obj_t *parent, const mos_ui_welcome_view_cfg_t *cfg);
void mos_ui_welcome_view_clear(mos_ui_welcome_view_t *view);
void mos_ui_welcome_view_refresh_text(mos_ui_welcome_view_t *view, const lv_font_t *font);
void mos_ui_welcome_view_update_dfu_progress(mos_ui_welcome_view_t *view, bool show, uint8_t percent);
void mos_ui_welcome_view_update_dfu_status(mos_ui_welcome_view_t *view, const char *text);
void mos_ui_welcome_view_destroy(mos_ui_welcome_view_t *view);

#endif /* MOS_DISPLAY_WELCOME_VIEW_H_ */
