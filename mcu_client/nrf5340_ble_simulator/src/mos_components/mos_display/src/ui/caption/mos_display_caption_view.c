#include "mos_display_caption_view.h"

#include <string.h>
#include <zephyr/logging/log.h>
#include <lvgl.h>

#include "mos_display_config.h"
#include "utils/mos_display_utf8.h"
#include "utils/mos_display_custom_rendering.h"
#include "utils/mos_display_color_utils.h"

LOG_MODULE_REGISTER(caption_view, LOG_LEVEL_DBG);

/* Caption overlay usable area is 580x420 (600x440 outer minus 10px padding each side). */
#define CAPTION_POSITIONED_MAX_X 580U
#define CAPTION_POSITIONED_MAX_Y 420U

mos_ui_caption_view_t mos_ui_caption_view_create(lv_obj_t *parent, const mos_ui_caption_view_cfg_t *cfg)
{
    mos_ui_caption_view_t view = {0};

    if (!parent || !cfg)
    {
        LOG_ERR("caption_view: invalid args");
        return view;
    }

    lv_obj_t *container = lv_obj_create(parent);
    lv_obj_set_size(container, cfg->width, cfg->height);
    lv_obj_set_pos(container, cfg->x, cfg->y);
    lv_obj_set_scroll_dir(container, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(container, LV_SCROLLBAR_MODE_OFF);
    lv_obj_set_style_bg_color(container, cfg->bg_color, 0);
    lv_obj_set_style_bg_opa(container, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(container, 0, 0);
    lv_obj_set_style_border_opa(container, LV_OPA_TRANSP, 0);
    lv_obj_set_style_pad_all(container, cfg->padding, 0);
    view.container = container;

    view.default_scrolling = mos_ui_default_scrolling_create(container, &cfg->default_scrolling);
    view.custom_scrolling   = mos_ui_custom_scrolling_create(container, &cfg->custom_scrolling);
    view.positioned         = mos_ui_positioned_create(container, &cfg->positioned);

    LOG_DBG("caption_view created @%p", (void *)container);
    return view;
}

void mos_ui_caption_view_set_mode(mos_ui_caption_view_t *view, mos_ui_caption_mode_t mode)
{
    if (!view)
    {
        return;
    }

    bool show_default    = (mode == MOS_UI_CAPTION_MODE_DEFAULT);
    bool show_custom     = (mode == MOS_UI_CAPTION_MODE_CUSTOM);
    bool show_positioned = (mode == MOS_UI_CAPTION_MODE_POSITIONED);

    if (view->default_scrolling)
    {
        if (show_default) lv_obj_clear_flag(view->default_scrolling, LV_OBJ_FLAG_HIDDEN);
        else              lv_obj_add_flag(view->default_scrolling, LV_OBJ_FLAG_HIDDEN);
    }

    if (view->custom_scrolling.container)
    {
        if (show_custom) lv_obj_clear_flag(view->custom_scrolling.container, LV_OBJ_FLAG_HIDDEN);
        else             lv_obj_add_flag(view->custom_scrolling.container, LV_OBJ_FLAG_HIDDEN);
    }

    if (view->positioned)
    {
        if (show_positioned) lv_obj_clear_flag(view->positioned, LV_OBJ_FLAG_HIDDEN);
        else                 lv_obj_add_flag(view->positioned, LV_OBJ_FLAG_HIDDEN);
    }
}

void mos_ui_caption_view_update_default_text(mos_ui_caption_view_t *view, const lv_font_t *font, const char *text)
{
    if (!view || !text)
    {
        return;
    }

    mos_ui_caption_view_set_mode(view, MOS_UI_CAPTION_MODE_DEFAULT);
    mos_ui_default_scrolling_update_text(view->default_scrolling, font, text);
}

void mos_ui_caption_view_update_custom_text(mos_ui_caption_view_t *view, const char *text,
                                             const lv_font_t *font_primary, const lv_font_t *font_fallback,
                                             lv_color_t text_color)
{
    if (!view || !text)
    {
        return;
    }

    mos_ui_caption_view_set_mode(view, MOS_UI_CAPTION_MODE_CUSTOM);
    mos_ui_custom_scrolling_update_text(&view->custom_scrolling, text, font_primary, font_fallback, text_color);
}

void mos_ui_caption_view_render_positioned_text(mos_ui_caption_view_t *view,
                                                 uint16_t x, uint16_t y,
                                                 const char *text,
                                                 uint32_t raw_color)
{
    if (!view || !view->positioned || !text)
    {
        return;
    }

    mos_ui_caption_view_set_mode(view, MOS_UI_CAPTION_MODE_POSITIONED);

    /* Reset the overlay to a known state. */
    lv_obj_set_style_bg_color(view->positioned, display_get_background_color(), 0);
    lv_obj_set_style_bg_opa(view->positioned, LV_OPA_COVER, 0);
    if (lv_obj_get_child_cnt(view->positioned) > 0)
    {
        lv_obj_clean(view->positioned);
    }
    lv_obj_clear_flag(view->positioned, LV_OBJ_FLAG_HIDDEN);

    /* Phone-side protocol: [cjk] / [cjkchars] prefixes route to GBK font. */
    bool force_cjk = false;
    bool use_per_char = true;
    const char *render_text = text;

    if (strncmp(text, "[cjkchars]", 10) == 0)
    {
        force_cjk = true;
        render_text = text + 10;
        while (*render_text == ' ') render_text++;
    }
    else if (strncmp(text, "[cjk]", 5) == 0)
    {
        force_cjk = true;
        render_text = text + 5;
        while (*render_text == ' ') render_text++;
    }

    bool needs_cjk = force_cjk || utf8_contains_cjk(render_text);
    if (!needs_cjk)
    {
        use_per_char = false;
    }

    const lv_font_t *font = needs_cjk ? display_get_font("gbk") : display_get_font("secondary");
    if (font == NULL)
    {
        font = display_get_font("primary");
    }

    /* Color: 0xFFFF is the wire sentinel for "auto pick contrast against background". */
    lv_color_t text_color = mos_color_from_rgb565(raw_color);
    if (raw_color == 0xFFFFu)
    {
        lv_color_t bg = display_get_background_color();
        uint16_t avg = (uint16_t)bg.red + (uint16_t)bg.green + (uint16_t)bg.blue;
        text_color = (avg > (3u * 128u)) ? lv_color_black() : lv_color_white();
    }

    /* Clamp coordinates to the overlay's usable area. */
    if (x >= CAPTION_POSITIONED_MAX_X)
    {
        x = CAPTION_POSITIONED_MAX_X - 50U;
    }
    if (y >= CAPTION_POSITIONED_MAX_Y)
    {
        y = CAPTION_POSITIONED_MAX_Y - 30U;
    }

    if (use_per_char && font != NULL)
    {
        /* No auto-wrap: max_width=0; only \n / \r break lines, matching the phone app. */
        mos_ui_custom_render(view->positioned, x, y, 0, render_text, font, NULL, text_color,
                             NULL, 0, NULL, NULL, NULL, NULL);
        lv_obj_invalidate(view->positioned);
    }
    else
    {
        lv_obj_t *label = lv_label_create(view->positioned);
        lv_label_set_text(label, render_text);
        lv_obj_set_style_text_font(label, font, 0);
        lv_obj_set_style_text_color(label, text_color, 0);
        lv_obj_set_style_bg_opa(label, LV_OPA_TRANSP, 0);
        lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);
        lv_obj_set_width(label, CAPTION_POSITIONED_MAX_X - x);
        lv_obj_set_pos(label, x, y);
        lv_obj_invalidate(label);
    }

    LOG_INF("Positioned render at (%u,%u) font=%s color=0x%06X: %.30s%s",
            x, y, needs_cjk ? "gbk" : "secondary", (unsigned int)raw_color,
            render_text, strlen(render_text) > 30 ? "..." : "");
}

void mos_ui_caption_view_clear(mos_ui_caption_view_t *view)
{
    if (!view)
    {
        return;
    }

    if (view->default_scrolling)
    {
        lv_label_set_text(view->default_scrolling, "");
        lv_obj_clear_flag(view->default_scrolling, LV_OBJ_FLAG_HIDDEN);
    }
    if (view->custom_scrolling.container)
    {
        lv_obj_add_flag(view->custom_scrolling.container, LV_OBJ_FLAG_HIDDEN);
        lv_obj_clean(view->custom_scrolling.container);
        /* lv_obj_clean freed every child; the pool's cached pointers now dangle.
         * Zero them so acquire_label re-creates labels instead of reusing freed memory. */
        memset(view->custom_scrolling.pool, 0, sizeof(view->custom_scrolling.pool));
        view->custom_scrolling.pool_used = 0;
    }
    mos_ui_caption_view_clear_positioned(view);
    if (view->container)
    {
        lv_obj_scroll_to_y(view->container, 0, LV_ANIM_OFF);
        lv_obj_invalidate(view->container);
    }
}

void mos_ui_caption_view_clear_positioned(mos_ui_caption_view_t *view)
{
    if (!view || !view->positioned)
    {
        return;
    }

    if (lv_obj_get_child_cnt(view->positioned) > 0)
    {
        lv_obj_clean(view->positioned);
    }
    lv_obj_add_flag(view->positioned, LV_OBJ_FLAG_HIDDEN);
}

void mos_ui_caption_view_scroll_to_bottom(mos_ui_caption_view_t *view)
{
    if (!view || !view->container || !view->default_scrolling)
    {
        return;
    }
    if (lv_obj_has_flag(view->default_scrolling, LV_OBJ_FLAG_HIDDEN))
    {
        return;
    }

    lv_obj_update_layout(view->default_scrolling);
    lv_obj_update_layout(view->container);

    const lv_coord_t view_h = lv_obj_get_content_height(view->container);
    const lv_coord_t ly = lv_obj_get_y(view->default_scrolling);
    const lv_coord_t lh = lv_obj_get_height(view->default_scrolling);
    lv_coord_t target = ly + lh - view_h;
    if (target < 0)
    {
        target = 0;
    }
    lv_obj_scroll_to_y(view->container, target, LV_ANIM_OFF);
}

void mos_ui_caption_view_set_scroll_enabled(mos_ui_caption_view_t *view, bool enabled)
{
    if (!view || !view->container)
    {
        return;
    }

    if (enabled)
    {
        lv_obj_set_scroll_dir(view->container, LV_DIR_VER);
    }
    else
    {
        lv_obj_set_scroll_dir(view->container, LV_DIR_NONE);
        lv_obj_scroll_to_y(view->container, 0, LV_ANIM_OFF);
    }
}

void mos_ui_caption_view_destroy(mos_ui_caption_view_t *view)
{
    if (!view)
    {
        return;
    }

    if (view->container)
    {
        lv_obj_del(view->container);
    }

    view->container = NULL;
    view->default_scrolling = NULL;
    view->custom_scrolling.container = NULL;
    memset(view->custom_scrolling.pool, 0, sizeof(view->custom_scrolling.pool));
    view->custom_scrolling.pool_used = 0;
    view->positioned = NULL;
}
