#include "mos_display_dfu_status.h"

#include <lvgl.h>

lv_obj_t *mos_ui_dfu_status_create(lv_obj_t *container, int width, lv_color_t text_color,
                                    const lv_font_t *font, lv_obj_t *anchor)
{
    lv_obj_t *label = lv_label_create(container);
    lv_label_set_text(label, "");
    lv_obj_set_width(label, width);
    lv_obj_set_style_text_color(label, text_color, 0);
    lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_LEFT, 0);
    lv_obj_add_flag(label, LV_OBJ_FLAG_HIDDEN);

    if (font)
    {
        lv_obj_set_style_text_font(label, font, 0);
    }

    if (anchor)
    {
        lv_obj_align_to(label, anchor, LV_ALIGN_OUT_BOTTOM_LEFT, 0, 4);
    }

    return label;
}
