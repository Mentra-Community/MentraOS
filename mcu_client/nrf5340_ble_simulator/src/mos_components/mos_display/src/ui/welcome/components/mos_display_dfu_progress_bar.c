#include "mos_display_dfu_progress_bar.h"

#include <lvgl.h>

mos_ui_dfu_progress_t mos_ui_dfu_progress_bar_create(lv_obj_t *container, int width, lv_color_t bg_color,
                                                      lv_color_t fill_color, lv_obj_t *anchor)
{
    mos_ui_dfu_progress_t progress = {.bar = NULL, .fill = NULL, .bar_width = 0};

    lv_coord_t bar_width = (lv_coord_t)(width / 2);

    lv_obj_t *bar = lv_obj_create(container);
    lv_obj_set_size(bar, bar_width, 12);
    lv_obj_set_style_bg_color(bar, bg_color, 0);
    lv_obj_set_style_bg_opa(bar, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(bar, 0, 0);
    lv_obj_set_style_radius(bar, 4, 0);
    lv_obj_set_style_pad_all(bar, 0, 0);
    lv_obj_add_flag(bar, LV_OBJ_FLAG_HIDDEN);

    if (anchor)
    {
        lv_obj_align_to(bar, anchor, LV_ALIGN_OUT_BOTTOM_MID, 0, 4);
    }

    lv_obj_t *fill = lv_obj_create(bar);
    lv_obj_set_size(fill, 0, 12);
    lv_obj_align(fill, LV_ALIGN_LEFT_MID, 0, 0);
    lv_obj_set_style_bg_color(fill, fill_color, 0);
    lv_obj_set_style_bg_opa(fill, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(fill, 0, 0);
    lv_obj_set_style_radius(fill, 4, 0);
    lv_obj_set_style_pad_all(fill, 0, 0);

    progress.bar = bar;
    progress.fill = fill;
    progress.bar_width = bar_width;
    return progress;
}
