#include "display_test_view.h"

#include <errno.h>
#include <string.h>

#include <zephyr/logging/log.h>

#include "display_config.h"

#include "mos_font_storage.h"

LOG_MODULE_REGISTER(display_test_view, LOG_LEVEL_INF);

typedef struct
{
    display_pattern_id_t current_pattern;
    lv_obj_t *gbk_test_label;
} display_test_view_state_t;

static display_test_view_state_t s_test_state_legacy = {
    .current_pattern = DISPLAY_PATTERN_DEFAULT,
    .gbk_test_label = NULL,
};
static display_test_view_state_t *s_test_state = &s_test_state_legacy;

#define s_current_pattern (s_test_state->current_pattern)
#define s_gbk_test_label (s_test_state->gbk_test_label)

size_t display_test_view_state_size(void)
{
    return sizeof(display_test_view_state_t);
}

int display_test_view_state_init(void *state, void *context)
{
    ARG_UNUSED(context);
    if (state == NULL)
    {
        return -EINVAL;
    }
    memset(state, 0, sizeof(display_test_view_state_t));
    ((display_test_view_state_t *)state)->current_pattern = DISPLAY_PATTERN_DEFAULT;
    s_test_state = (display_test_view_state_t *)state;
    return 0;
}

int display_test_view_state_deinit(void *state, void *context)
{
    ARG_UNUSED(context);
    if (state == NULL)
    {
        return -EINVAL;
    }
    memset(state, 0, sizeof(display_test_view_state_t));
    if (s_test_state == (display_test_view_state_t *)state)
    {
        s_test_state = &s_test_state_legacy;
        s_test_state->current_pattern = DISPLAY_PATTERN_DEFAULT;
        s_test_state->gbk_test_label = NULL;
    }
    return 0;
}

static void anim_set_x_cb(void *obj, int32_t v)
{
    lv_obj_set_x((lv_obj_t *)obj, v);
}

static void create_chess_pattern(lv_obj_t *screen)
{
    const display_config_t *config = display_get_config();
    const int chess_size = config->patterns.chess_square_size;
    const int chess_cols = config->width / chess_size;
    const int chess_rows = config->height / chess_size;

    for (int row = 0; row < chess_rows; row++)
    {
        for (int col = 0; col < chess_cols; col++)
        {
            bool is_white = ((row + col) % 2) == 0;
            lv_obj_t *square = lv_obj_create(screen);
            lv_obj_set_size(square, chess_size, chess_size);
            lv_obj_set_pos(square, col * chess_size, row * chess_size);
            lv_color_t color =
                is_white ? display_get_adjusted_color(lv_color_white()) : display_get_adjusted_color(lv_color_black());
            lv_obj_set_style_bg_color(square, color, 0);
            lv_obj_set_style_bg_opa(square, LV_OPA_COVER, 0);
            lv_obj_set_style_border_width(square, 0, 0);
            lv_obj_set_style_pad_all(square, 0, 0);
        }
    }
}

static void create_horizontal_zebra_pattern(lv_obj_t *screen)
{
    const display_config_t *config = display_get_config();
    const int stripe_height = config->patterns.bar_thickness;
    const int num_stripes = config->height / stripe_height;

    for (int i = 0; i < num_stripes; i++)
    {
        bool is_white = (i % 2) == 0;
        lv_obj_t *stripe = lv_obj_create(screen);
        lv_obj_set_size(stripe, config->width, stripe_height);
        lv_obj_set_pos(stripe, 0, i * stripe_height);
        lv_color_t color =
            is_white ? display_get_adjusted_color(lv_color_white()) : display_get_adjusted_color(lv_color_black());
        lv_obj_set_style_bg_color(stripe, color, 0);
        lv_obj_set_style_bg_opa(stripe, LV_OPA_COVER, 0);
        lv_obj_set_style_border_width(stripe, 0, 0);
        lv_obj_set_style_pad_all(stripe, 0, 0);
    }
}

static void create_vertical_zebra_pattern(lv_obj_t *screen)
{
    const display_config_t *config = display_get_config();
    const int stripe_width = config->patterns.bar_thickness;
    const int num_stripes = config->width / stripe_width;

    for (int i = 0; i < num_stripes; i++)
    {
        bool is_white = (i % 2) == 0;
        lv_obj_t *stripe = lv_obj_create(screen);
        lv_obj_set_size(stripe, stripe_width, config->height);
        lv_obj_set_pos(stripe, i * stripe_width, 0);
        lv_color_t color =
            is_white ? display_get_adjusted_color(lv_color_white()) : display_get_adjusted_color(lv_color_black());
        lv_obj_set_style_bg_color(stripe, color, 0);
        lv_obj_set_style_bg_opa(stripe, LV_OPA_COVER, 0);
        lv_obj_set_style_border_width(stripe, 0, 0);
        lv_obj_set_style_pad_all(stripe, 0, 0);
    }
}

static void create_center_rectangle_pattern_ssd1306(lv_obj_t *screen)
{
    const char *text = "Welcome to MentraOS NExFirmware!";
    const lv_font_t *font = mos_font_storage_get_lvgl_font();
    const uint32_t ms_per_px = 25;
    const lv_coord_t sw = lv_obj_get_width(screen);
    const lv_coord_t sh = lv_obj_get_height(screen);

    lv_obj_set_style_bg_color(screen, lv_color_white(), 0);
    lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, 0);

    lv_obj_t *label = lv_label_create(screen);
    lv_obj_set_style_text_color(label, lv_color_black(), 0);
    lv_obj_set_style_text_font(label, font, 0);
    lv_label_set_text(label, text);
    lv_label_set_long_mode(label, LV_LABEL_LONG_CLIP);

    lv_obj_update_layout(label);
    lv_coord_t label_w = lv_obj_get_width(label);
    lv_coord_t label_h = lv_obj_get_height(label);
    lv_obj_set_y(label, (sh - label_h) / 2);

    const lv_coord_t x_start = sw;
    const lv_coord_t x_end = -label_w;
    uint32_t total_px = (uint32_t)(x_start - x_end);
    uint32_t anim_time_ms = total_px * ms_per_px;

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

void display_test_view_reset_state(void)
{
    s_current_pattern = DISPLAY_PATTERN_DEFAULT;
    s_gbk_test_label = NULL;
}

void display_test_view_detach(void)
{
    s_gbk_test_label = NULL;
}

display_pattern_id_t display_test_view_get_current_pattern(void)
{
    return s_current_pattern;
}

int display_test_view_get_pattern_count(void)
{
    return DISPLAY_PATTERN_COUNT;
}

void display_test_view_set_current_pattern(display_pattern_id_t pattern_id)
{
    if (!display_pattern_id_is_valid((int)pattern_id))
    {
        return;
    }

    s_current_pattern = pattern_id;
}

void display_test_view_show_pattern(lv_obj_t *screen, display_pattern_id_t pattern_id)
{
    if (screen == NULL)
    {
        return;
    }

    switch (pattern_id)
    {
        case DISPLAY_PATTERN_CHESS:
            create_chess_pattern(screen);
            break;
        case DISPLAY_PATTERN_HORIZONTAL_ZEBRA:
            create_horizontal_zebra_pattern(screen);
            break;
        case DISPLAY_PATTERN_VERTICAL_ZEBRA:
            create_vertical_zebra_pattern(screen);
            break;
        case DISPLAY_PATTERN_SCROLLING_WELCOME:
            create_center_rectangle_pattern_ssd1306(screen);
            break;
        default:
            return;
    }

    s_current_pattern = pattern_id;
}

void display_test_view_show_gbk_chars(void)
{
    static const char *k_gbk_chars[] = {
        "\xE4\xBD\xA0", "\xE5\xA5\xBD", "!", "\xE6\xAC\xA2", "\xE8\xBF\x8E", "\xE8\xBF\x9B",
        "\xE5\x85\xA5", "\xE5\xBC\x80", "\xE5\x8F\x91", "\xE8\x80\x85", "\xE6\xA8\xA1", "\xE5\xBC\x8F",
    };
    static const uint32_t k_gbk_codepoints[] = {0x4F60, 0x597D, 0x0021, 0x6B22, 0x8FCE, 0x8FDB,
                                                0x5165, 0x5F00, 0x53D1, 0x8005, 0x6A21, 0x5F0F};
    static lv_obj_t *gbk_chars_screen = NULL;
    static lv_obj_t *gbk_char_labels[ARRAY_SIZE(k_gbk_chars)] = {0};

    if (!gbk_chars_screen)
    {
        gbk_chars_screen = lv_obj_create(NULL);
        if (!gbk_chars_screen)
        {
            return;
        }
        lv_obj_set_style_bg_color(gbk_chars_screen, display_get_background_color(), 0);
        lv_obj_set_style_bg_opa(gbk_chars_screen, LV_OPA_COVER, 0);

        for (size_t i = 0; i < ARRAY_SIZE(k_gbk_chars); i++)
        {
            gbk_char_labels[i] = lv_label_create(gbk_chars_screen);
            if (!gbk_char_labels[i])
            {
                return;
            }
            lv_obj_set_style_text_color(gbk_char_labels[i], display_get_text_color(), 0);
        }
    }

    lv_screen_load(gbk_chars_screen);

    const lv_font_t *font = display_get_font("gbk");
    if (!font)
    {
        font = display_get_font("primary");
    }
    if (!font)
    {
        return;
    }

    lv_display_t *disp = lv_display_get_default();
    lv_coord_t disp_w = disp ? lv_display_get_horizontal_resolution(disp) : 640;
    lv_coord_t disp_h = disp ? lv_display_get_vertical_resolution(disp) : 480;

    lv_coord_t total_w = 0;
    for (size_t i = 0; i < ARRAY_SIZE(k_gbk_chars); i++)
    {
        lv_font_glyph_dsc_t dsc;
        lv_coord_t adv = (font && lv_font_get_glyph_dsc(font, &dsc, k_gbk_codepoints[i], 0))
                             ? (lv_coord_t)((dsc.adv_w + 15) / 16)
                             : 24;
        total_w += adv + 4;
    }
    if (total_w > 0)
    {
        total_w -= 4;
    }

    lv_coord_t start_x = (disp_w > total_w) ? (disp_w - total_w) / 2 : 0;
    lv_coord_t y = (disp_h > font->line_height) ? (disp_h - font->line_height) / 2 : 0;

    lv_coord_t x = start_x;
    for (size_t i = 0; i < ARRAY_SIZE(k_gbk_chars); i++)
    {
        if (gbk_char_labels[i])
        {
            lv_obj_set_style_text_font(gbk_char_labels[i], font, 0);
            lv_label_set_text_static(gbk_char_labels[i], k_gbk_chars[i]);

            lv_font_glyph_dsc_t dsc;
            lv_coord_t adv = (font && lv_font_get_glyph_dsc(font, &dsc, k_gbk_codepoints[i], 0))
                                 ? (lv_coord_t)((dsc.adv_w + 15) / 16)
                                 : 24;
            lv_obj_set_pos(gbk_char_labels[i], x, y);
            x += adv + 4;
        }
    }
}

void display_test_view_show_gbk_text(void)
{
    static const char *k_gbk_text =
        "\xE4\xB8\xAD\xE5\x8D\x8E\xE4\xBA\xBA\xE5\x90\x8D\xE5\x85\xB1\xE5\x92\x8C\xE5\x9B\xBD!!!";
    static lv_obj_t *gbk_screen = NULL;

    if (!gbk_screen)
    {
        gbk_screen = lv_obj_create(NULL);
        if (!gbk_screen)
        {
            return;
        }
        lv_obj_set_style_bg_color(gbk_screen, display_get_background_color(), 0);
        lv_obj_set_style_bg_opa(gbk_screen, LV_OPA_COVER, 0);
    }

    if (!s_gbk_test_label)
    {
        s_gbk_test_label = lv_label_create(gbk_screen);
        if (!s_gbk_test_label)
        {
            return;
        }
        lv_obj_set_style_text_color(s_gbk_test_label, display_get_text_color(), 0);

        const lv_font_t *font = display_get_font("gbk");
        if (!font)
        {
            font = display_get_font("primary");
        }
        if (!font)
        {
            return;
        }
        lv_obj_set_style_text_font(s_gbk_test_label, font, 0);
        lv_label_set_long_mode(s_gbk_test_label, LV_LABEL_LONG_WRAP);
        lv_obj_set_width(s_gbk_test_label, 600);
        lv_obj_align(s_gbk_test_label, LV_ALIGN_CENTER, 0, 0);
    }

    lv_screen_load(gbk_screen);
    lv_label_set_text_static(s_gbk_test_label, k_gbk_text);
    lv_obj_move_foreground(s_gbk_test_label);
    lv_obj_invalidate(s_gbk_test_label);
}
