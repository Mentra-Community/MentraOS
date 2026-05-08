#include "mos_display_test_scenes.h"

#include <zephyr/logging/log.h>
#include <lvgl.h>

LOG_MODULE_REGISTER(test_scenes, LOG_LEVEL_DBG);

#define PATTERN_COLOR_A lv_color_white()
#define PATTERN_COLOR_B lv_color_black()

void mos_ui_test_pattern_create_chess(lv_obj_t *screen, int square_size, int width, int height)
{
    const int cols = width / square_size;
    const int rows = height / square_size;

    LOG_DBG("Creating chess pattern: %dx%d squares (%d cols x %d rows)", square_size, square_size, cols, rows);

    for (int row = 0; row < rows; row++)
    {
        for (int col = 0; col < cols; col++)
        {
            lv_obj_t *square = lv_obj_create(screen);
            lv_obj_set_size(square, square_size, square_size);
            lv_obj_set_pos(square, col * square_size, row * square_size);
            lv_color_t color = (row + col) % 2 == 0 ? PATTERN_COLOR_A : PATTERN_COLOR_B;
            lv_obj_set_style_bg_color(square, color, 0);
            lv_obj_set_style_bg_opa(square, LV_OPA_COVER, 0);
            lv_obj_set_style_border_width(square, 0, 0);
            lv_obj_set_style_pad_all(square, 0, 0);
        }
    }
}

void mos_ui_test_pattern_create_horizontal_zebra(lv_obj_t *screen, int stripe_height, int width)
{
    const int num_stripes = lv_obj_get_height(screen) / stripe_height;

    LOG_DBG("Creating horizontal zebra: %d stripes (%dpx)", num_stripes, stripe_height);

    for (int i = 0; i < num_stripes; i++)
    {
        lv_obj_t *stripe = lv_obj_create(screen);
        lv_obj_set_size(stripe, width, stripe_height);
        lv_obj_set_pos(stripe, 0, i * stripe_height);
        lv_color_t color = i % 2 == 0 ? PATTERN_COLOR_A : PATTERN_COLOR_B;
        lv_obj_set_style_bg_color(stripe, color, 0);
        lv_obj_set_style_bg_opa(stripe, LV_OPA_COVER, 0);
        lv_obj_set_style_border_width(stripe, 0, 0);
        lv_obj_set_style_pad_all(stripe, 0, 0);
    }
}

void mos_ui_test_pattern_create_vertical_zebra(lv_obj_t *screen, int stripe_width, int height)
{
    const int num_stripes = lv_obj_get_width(screen) / stripe_width;

    LOG_DBG("Creating vertical zebra: %d stripes (%dpx)", num_stripes, stripe_width);

    for (int i = 0; i < num_stripes; i++)
    {
        lv_obj_t *stripe = lv_obj_create(screen);
        lv_obj_set_size(stripe, stripe_width, height);
        lv_obj_set_pos(stripe, i * stripe_width, 0);
        lv_color_t color = i % 2 == 0 ? PATTERN_COLOR_A : PATTERN_COLOR_B;
        lv_obj_set_style_bg_color(stripe, color, 0);
        lv_obj_set_style_bg_opa(stripe, LV_OPA_COVER, 0);
        lv_obj_set_style_border_width(stripe, 0, 0);
        lv_obj_set_style_pad_all(stripe, 0, 0);
    }
}

static void anim_set_x_cb(void *obj, int32_t v)
{
    lv_obj_set_x((lv_obj_t *)obj, v);
}

void mos_ui_test_pattern_create_center_rectangle(lv_obj_t *screen, const lv_font_t *font)
{
    const char *text = "Welcome to MentraOS NExFirmware!";
    const uint32_t ms_per_px = 25;
    const lv_coord_t sw = lv_obj_get_width(screen);
    const lv_coord_t sh = lv_obj_get_height(screen);

    lv_obj_set_style_bg_color(screen, PATTERN_COLOR_A, 0);
    lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, 0);

    lv_obj_t *label = lv_label_create(screen);
    lv_obj_set_style_text_color(label, PATTERN_COLOR_B, 0);
    lv_obj_set_style_text_font(label, font, 0);
    lv_label_set_text(label, text);
    lv_label_set_long_mode(label, LV_LABEL_LONG_CLIP);

    lv_obj_update_layout(label);
    lv_coord_t label_w = lv_obj_get_width(label);
    lv_coord_t label_h = lv_obj_get_height(label);

    lv_obj_set_y(label, (sh - label_h) / 2);

    const lv_coord_t x_start = sw;
    const lv_coord_t x_end = -label_w;
    uint32_t anim_time_ms = (uint32_t)(x_start - x_end) * ms_per_px;

    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, label);
    lv_anim_set_exec_cb(&a, anim_set_x_cb);
    lv_anim_set_values(&a, x_start, x_end);
    lv_anim_set_time(&a, anim_time_ms);
    lv_anim_set_path_cb(&a, lv_anim_path_linear);
    lv_anim_set_repeat_delay(&a, 250);
    lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
    lv_anim_start(&a);
}
