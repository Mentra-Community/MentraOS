#include "xy_text_view.h"

#include <string.h>
#include <zephyr/logging/log.h>
#include <lvgl.h>

#include "display_config.h"
#include "display_scene.h"
#include "utils/utf8.h"
#include "utils/custom_rendering.h"
#include "utils/color_utils.h"

LOG_MODULE_REGISTER(xy_text_view, LOG_LEVEL_DBG);

static lv_obj_t *s_container = NULL;

void mos_ui_xy_text_view_create(lv_obj_t *parent)
{
    if (parent == NULL)
    {
        LOG_ERR("xy_text_view: parent is NULL");
        return;
    }

    const display_config_t *config = display_get_config();

    lv_obj_t *container = lv_obj_create(parent);
    lv_obj_set_size(container, config->layout.usable_width, config->layout.usable_height);
    lv_obj_set_pos(container, config->layout.margin_left, config->layout.margin_top);

    lv_obj_set_scroll_dir(container, LV_DIR_NONE);
    lv_obj_set_scrollbar_mode(container, LV_SCROLLBAR_MODE_OFF);

    lv_obj_set_style_bg_color(container, lv_color_white(), 0);
    lv_obj_set_style_bg_opa(container, LV_OPA_COVER, 0);
    lv_obj_set_style_border_color(container, lv_color_black(), 0);
    lv_obj_set_style_border_opa(container, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(container, 2, 0);

    s_container = container;
    LOG_INF("Pattern 5 XY container created (%dx%d)", config->layout.usable_width, config->layout.usable_height);
}

void mos_ui_xy_text_view_destroy(void)
{
    s_container = NULL;
}

bool mos_ui_xy_text_view_exists(void)
{
    return s_container != NULL;
}

void mos_ui_xy_text_view_invalidate(void)
{
    if (s_container != NULL)
    {
        lv_obj_invalidate(s_container);
    }
}

void mos_ui_xy_text_view_clear(void)
{
    if (s_container == NULL)
    {
        return;
    }
    if (lv_obj_get_child_cnt(s_container) > 0)
    {
        lv_obj_clean(s_container);
    }
    lv_obj_invalidate(s_container);
}

void mos_ui_xy_text_view_render(mos_ui_main_scene_t *scene,
                                 uint16_t x, uint16_t y,
                                 const char *text,
                                 uint16_t font_size, uint32_t color)
{
    if (text == NULL)
    {
        LOG_ERR("Invalid XY text content pointer");
        return;
    }

    display_scene_set_mode(DISPLAY_SCENE_MODE_XY);

    lv_obj_t *target_container = NULL;
    bool using_caption_overlay = false;

    if (s_container != NULL)
    {
        target_container = s_container;
        LOG_INF("Using Pattern 5 XY text container");
    }
    else if (scene != NULL && scene->caption.positioned != NULL)
    {
        target_container = scene->caption.positioned;
        using_caption_overlay = true;
        LOG_INF("Using Pattern 4 XY overlay container");
    }
    else
    {
        LOG_WRN("No container available, rendering directly to screen");
        target_container = lv_screen_active();
    }

#if defined(CONFIG_LVGL)
    if (using_caption_overlay && scene != NULL)
    {
        mos_ui_main_scene_set_caption_scroll_enabled(scene, true);
    }
#endif

    lv_obj_set_style_bg_color(target_container, display_get_background_color(), 0);
    lv_obj_set_style_bg_opa(target_container, LV_OPA_COVER, 0);
    if (lv_obj_get_child_cnt(target_container) > 0)
    {
        lv_obj_clean(target_container);
        if (using_caption_overlay)
        {
            lv_obj_clear_flag(scene->caption.positioned, LV_OBJ_FLAG_HIDDEN);
        }
    }
    else if (using_caption_overlay)
    {
        lv_obj_clear_flag(scene->caption.positioned, LV_OBJ_FLAG_HIDDEN);
    }

    /* 580x420 usable area, 10px padding (600x440 outer). */
    const uint16_t max_x = 580;
    const uint16_t max_y = 420;

    LOG_INF("Original XY: (%u,%u), max bounds: (%u,%u)", x, y, max_x, max_y);
    if (x >= max_x || y >= max_y)
    {
        LOG_WRN("XY coordinates out of bounds: (%u,%u) - max is (%u,%u)", x, y, max_x, max_y);
        x = (x >= max_x) ? max_x - 50 : x;
        y = (y >= max_y) ? max_y - 30 : y;
        LOG_WRN("Clamped to: (%u,%u)", x, y);
    }

    bool use_gbk = true;
    bool use_gbk_chars = true;
    bool force_cjk = false;
    const char *render_text = text;

    /* Phone-side protocol prefixes [cjk]/[cjkchars] route to GBK font here. */
    if (strncmp(text, "[cjkchars]", 10) == 0)
    {
        force_cjk = true;
        render_text = text + 10;
        while (*render_text == ' ') render_text++;
        LOG_INF("GBK per-char mode detected, text='%.30s'", render_text);
    }
    else if (strncmp(text, "[cjk]", 5) == 0)
    {
        force_cjk = true;
        render_text = text + 5;
        while (*render_text == ' ') render_text++;
        LOG_INF("GBK mode detected, text='%.30s'", render_text);
    }

    if (!force_cjk && !utf8_contains_cjk(render_text))
    {
        use_gbk = false;
        use_gbk_chars = false;
    }

    const lv_font_t *font = use_gbk ? display_get_font("gbk") : display_get_font("secondary");
    if (font == NULL)
    {
        LOG_WRN("%s font not available, falling back to primary font", use_gbk ? "gbk" : "secondary");
        font = display_get_font("primary");
    }
    if (use_gbk && font != NULL)
    {
        LOG_INF("Using GBK font @%p for rendering: '%.20s'", font, render_text);
    }

    lv_color_t text_color = mos_color_from_rgb565(color);
    if (color == 0xFFFFu)
    {
        lv_color_t bg = display_get_background_color();
        uint16_t avg = (uint16_t)bg.red + (uint16_t)bg.green + (uint16_t)bg.blue;
        text_color = (avg > (3u * 128u)) ? lv_color_black() : lv_color_white();
        LOG_INF("Auto text color: bg=(%u,%u,%u) -> %s", bg.red, bg.green, bg.blue,
                (avg > (3u * 128u)) ? "black" : "white");
    }

    lv_obj_t *xy_text_label = NULL;

    if (use_gbk_chars && font != NULL)
    {
        /* No auto-wrap by width: max_width=0; only \n/\r break lines, matching the phone app. */
        mos_ui_custom_render(target_container, x, y, 0, render_text, font, NULL, text_color,
                             NULL, 0, NULL, NULL, NULL, NULL);
        lv_obj_invalidate(target_container);
    }
    else
    {
        xy_text_label = lv_label_create(target_container);
        lv_label_set_text(xy_text_label, render_text);
        lv_obj_set_style_text_font(xy_text_label, font, 0);
        lv_obj_set_style_text_color(xy_text_label, text_color, 0);
        lv_obj_set_style_bg_opa(xy_text_label, LV_OPA_TRANSP, 0);
        lv_label_set_long_mode(xy_text_label, LV_LABEL_LONG_WRAP);
        lv_obj_set_width(xy_text_label, max_x - x);
        lv_obj_set_pos(xy_text_label, x, y);
    }

    const char *pattern_name = (target_container == s_container) ? "Pattern 5" : "Pattern 4";
    const char *font_name = use_gbk ? "gbk" : "secondary";
    LOG_INF("[%s] Cleared all text, positioned new at (%u,%u), %s_font, color:0x%06X: %.30s%s",
            pattern_name, x, y, font_name, (unsigned int)color, render_text,
            strlen(render_text) > 30 ? "..." : "");

    if (xy_text_label != NULL)
    {
        lv_obj_invalidate(xy_text_label);
    }

    (void)font_size;
}
