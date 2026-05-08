#include "mos_display_screen_utils.h"

#include <zephyr/kernel.h>
#include <lvgl.h>

lv_obj_t *mos_screen_get_root(void)
{
    return lv_screen_active();
}

void mos_screen_clear_children(void)
{
    lv_obj_t *screen = lv_screen_active();
    lv_obj_t *child;
    while ((child = lv_obj_get_child(screen, 0)) != NULL)
    {
        lv_obj_del(child);
        /* Yield periodically so a deep tree doesn't starve the rest of the system. */
        k_yield();
    }
}

void mos_screen_invalidate_children(void)
{
    lv_obj_t *screen = lv_screen_active();
    uint32_t n = lv_obj_get_child_cnt(screen);
    for (uint32_t i = 0; i < n; i++)
    {
        lv_obj_t *child = lv_obj_get_child(screen, i);
        if (child != NULL)
        {
            lv_obj_invalidate(child);
        }
    }
}

void mos_screen_set_background(lv_color_t color)
{
    lv_obj_t *screen = lv_screen_active();
    lv_obj_set_style_bg_color(screen, color, 0);
    lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, 0);
}

void mos_screen_invalidate_full(void)
{
    lv_obj_invalidate(lv_screen_active());
}
