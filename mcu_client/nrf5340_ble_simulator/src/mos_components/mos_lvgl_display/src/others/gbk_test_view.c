#include "gbk_test_view.h"

#include <zephyr/logging/log.h>
#include <zephyr/sys/printk.h>
#include <zephyr/sys/util.h>
#include <lvgl.h>

#include "display_config.h"

LOG_MODULE_REGISTER(gbk_test_view, LOG_LEVEL_DBG);

/* UTF-8 byte escapes avoid source-encoding ambiguity. */
static const char *k_gbk_chars[] = {
    "\xE4\xBD\xA0", /* 你 */
    "\xE5\xA5\xBD", /* 好 */
    "!",
    "\xE6\xAC\xA2", /* 欢 */
    "\xE8\xBF\x8E", /* 迎 */
    "\xE8\xBF\x9B", /* 进 */
    "\xE5\x85\xA5", /* 入 */
    "\xE5\xBC\x80", /* 开 */
    "\xE5\x8F\x91", /* 发 */
    "\xE8\x80\x85", /* 者 */
    "\xE6\xA8\xA1", /* 模 */
    "\xE5\xBC\x8F", /* 式 */
};
static const uint32_t k_gbk_codepoints[] = {
    0x4F60, 0x597D, 0x0021, 0x6B22, 0x8FCE, 0x8FDB, 0x5165, 0x5F00, 0x53D1, 0x8005, 0x6A21, 0x5F0F,
};

static const char *k_gbk_text =
    "\xE4\xB8\xAD\xE5\x8D\x8E\xE4\xBA\xBA\xE5\x90\x8D\xE5\x85\xB1\xE5\x92\x8C\xE5\x9B\xBD!!!";

static lv_obj_t *s_gbk_chars_screen = NULL;
static lv_obj_t *s_gbk_char_labels[ARRAY_SIZE(k_gbk_chars)] = {0};

static lv_obj_t *s_gbk_text_screen = NULL;
static lv_obj_t *s_gbk_text_label = NULL;

void mos_ui_gbk_test_destroy(void)
{
    s_gbk_chars_screen = NULL;
    for (size_t i = 0; i < ARRAY_SIZE(s_gbk_char_labels); i++)
    {
        s_gbk_char_labels[i] = NULL;
    }
    s_gbk_text_screen = NULL;
    s_gbk_text_label = NULL;
}

void mos_ui_gbk_test_clear(void)
{
    if (s_gbk_text_label != NULL)
    {
        lv_label_set_text(s_gbk_text_label, "");
        lv_obj_invalidate(s_gbk_text_label);
    }
}

void mos_ui_gbk_test_show_chars(void)
{
    printk("GBK_TEST: start\r\n");
    LOG_INF("GBK_TEST: start");

    if (s_gbk_chars_screen == NULL)
    {
        s_gbk_chars_screen = lv_obj_create(NULL);
        if (s_gbk_chars_screen == NULL)
        {
            LOG_ERR("GBK_TEST: lv_obj_create(screen) failed");
            return;
        }
        lv_obj_set_style_bg_color(s_gbk_chars_screen, display_get_background_color(), 0);
        lv_obj_set_style_bg_opa(s_gbk_chars_screen, LV_OPA_COVER, 0);

        for (size_t i = 0; i < ARRAY_SIZE(k_gbk_chars); i++)
        {
            s_gbk_char_labels[i] = lv_label_create(s_gbk_chars_screen);
            if (s_gbk_char_labels[i] == NULL)
            {
                LOG_ERR("GBK_TEST: lv_label_create failed at %u", (unsigned int)i);
                return;
            }
            lv_obj_set_style_text_color(s_gbk_char_labels[i], display_get_text_color(), 0);
        }
    }

    lv_screen_load(s_gbk_chars_screen);

    const lv_font_t *font = display_get_font("gbk");
    if (font == NULL)
    {
        font = display_get_font("primary");
    }
    if (font == NULL)
    {
        LOG_ERR("GBK_TEST: no font available");
        return;
    }

    lv_display_t *disp = lv_display_get_default();
    lv_coord_t disp_w = disp ? lv_display_get_horizontal_resolution(disp) : 640;
    lv_coord_t disp_h = disp ? lv_display_get_vertical_resolution(disp) : 480;

    lv_coord_t total_w = 0;
    for (size_t i = 0; i < ARRAY_SIZE(k_gbk_chars); i++)
    {
        lv_font_glyph_dsc_t dsc;
        lv_coord_t adv = lv_font_get_glyph_dsc(font, &dsc, k_gbk_codepoints[i], 0)
                             ? (lv_coord_t)((dsc.adv_w + 15) / 16)
                             : 24;
        total_w += adv + 4;
    }
    if (total_w > 0) total_w -= 4;

    lv_coord_t start_x = (disp_w > total_w) ? (disp_w - total_w) / 2 : 0;
    lv_coord_t y = (disp_h > font->line_height) ? (disp_h - font->line_height) / 2 : 0;

    lv_coord_t x = start_x;
    for (size_t i = 0; i < ARRAY_SIZE(k_gbk_chars); i++)
    {
        if (s_gbk_char_labels[i] != NULL)
        {
            lv_obj_set_style_text_font(s_gbk_char_labels[i], font, 0);
            lv_label_set_text_static(s_gbk_char_labels[i], k_gbk_chars[i]);

            lv_font_glyph_dsc_t dsc;
            lv_coord_t adv = lv_font_get_glyph_dsc(font, &dsc, k_gbk_codepoints[i], 0)
                                 ? (lv_coord_t)((dsc.adv_w + 15) / 16)
                                 : 24;
            lv_obj_set_pos(s_gbk_char_labels[i], x, y);
            x += adv + 4;
        }
    }

    LOG_INF("GBK_TEST: end");
}

void mos_ui_gbk_test_show_text(void)
{
    printk("GBK_TEST: start\r\n");
    LOG_INF("GBK_TEST: start");

    if (s_gbk_text_screen == NULL)
    {
        s_gbk_text_screen = lv_obj_create(NULL);
        if (s_gbk_text_screen == NULL)
        {
            LOG_ERR("GBK_TEST: lv_obj_create(screen) failed");
            return;
        }
        lv_obj_set_style_bg_color(s_gbk_text_screen, display_get_background_color(), 0);
        lv_obj_set_style_bg_opa(s_gbk_text_screen, LV_OPA_COVER, 0);
    }

    if (s_gbk_text_label == NULL)
    {
        s_gbk_text_label = lv_label_create(s_gbk_text_screen);
        if (s_gbk_text_label == NULL)
        {
            LOG_ERR("GBK_TEST: lv_label_create failed");
            return;
        }
        lv_obj_set_style_text_color(s_gbk_text_label, display_get_text_color(), 0);

        const lv_font_t *font = display_get_font("gbk");
        if (font == NULL)
        {
            font = display_get_font("primary");
        }
        if (font == NULL)
        {
            LOG_ERR("GBK_TEST: no font available");
            return;
        }
        lv_obj_set_style_text_font(s_gbk_text_label, font, 0);
        lv_label_set_long_mode(s_gbk_text_label, LV_LABEL_LONG_WRAP);
        lv_obj_set_width(s_gbk_text_label, 600);
        lv_obj_align(s_gbk_text_label, LV_ALIGN_CENTER, 0, 0);
    }

    lv_screen_load(s_gbk_text_screen);
    lv_label_set_text_static(s_gbk_text_label, k_gbk_text);
    lv_obj_move_foreground(s_gbk_text_label);
    lv_obj_invalidate(s_gbk_text_label);

    LOG_INF("GBK_TEST: end");
}
