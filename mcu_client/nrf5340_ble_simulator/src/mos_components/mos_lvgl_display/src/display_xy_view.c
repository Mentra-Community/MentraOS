#include "display_xy_view.h"

#include <errno.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "display_config.h"

LOG_MODULE_REGISTER(display_xy_view, LOG_LEVEL_INF);

#if defined(CONFIG_LV_FONT_SIMSUN_16_CJK)
LV_FONT_DECLARE(lv_font_simsun_16_cjk);
#endif

typedef struct
{
    lv_obj_t *xy_text_container;
    lv_obj_t *current_xy_text_label;
} display_xy_view_state_t;

static display_xy_view_state_t s_xy_state_legacy = {0};
static display_xy_view_state_t *s_xy_state = &s_xy_state_legacy;

#define s_xy_text_container (s_xy_state->xy_text_container)
#define s_current_xy_text_label (s_xy_state->current_xy_text_label)

size_t display_xy_view_state_size(void)
{
    return sizeof(display_xy_view_state_t);
}

int display_xy_view_state_init(void *state, void *context)
{
    ARG_UNUSED(context);
    if (state == NULL)
    {
        return -EINVAL;
    }
    memset(state, 0, sizeof(display_xy_view_state_t));
    s_xy_state = (display_xy_view_state_t *)state;
    return 0;
}

int display_xy_view_state_deinit(void *state, void *context)
{
    ARG_UNUSED(context);
    if (state == NULL)
    {
        return -EINVAL;
    }
    memset(state, 0, sizeof(display_xy_view_state_t));
    if (s_xy_state == (display_xy_view_state_t *)state)
    {
        s_xy_state = &s_xy_state_legacy;
        memset(s_xy_state, 0, sizeof(display_xy_view_state_t));
    }
    return 0;
}

static lv_color_t color_from_rgb565(uint32_t color)
{
    uint16_t c = (uint16_t)color;
    uint8_t r = (c >> 11) & 0x1F;
    uint8_t g = (c >> 5) & 0x3F;
    uint8_t b = c & 0x1F;
    return lv_color_make((uint8_t)((r * 255U) / 31U), (uint8_t)((g * 255U) / 63U), (uint8_t)((b * 255U) / 31U));
}

static bool utf8_contains_cjk(const char *text)
{
    if (!text)
    {
        return false;
    }

    const uint8_t *p = (const uint8_t *)text;
    while (*p != '\0')
    {
        uint32_t code = 0;
        uint8_t len = 1;

        if ((*p & 0x80u) == 0)
        {
            code = *p;
            len = 1;
        }
        else if ((*p & 0xE0u) == 0xC0u)
        {
            if ((p[1] & 0xC0u) != 0x80u)
            {
                break;
            }
            code = ((uint32_t)(p[0] & 0x1Fu) << 6) | (uint32_t)(p[1] & 0x3Fu);
            len = 2;
        }
        else if ((*p & 0xF0u) == 0xE0u)
        {
            if ((p[1] & 0xC0u) != 0x80u || (p[2] & 0xC0u) != 0x80u)
            {
                break;
            }
            code = ((uint32_t)(p[0] & 0x0Fu) << 12) | ((uint32_t)(p[1] & 0x3Fu) << 6) | (uint32_t)(p[2] & 0x3Fu);
            len = 3;
        }
        else if ((*p & 0xF8u) == 0xF0u)
        {
            if ((p[1] & 0xC0u) != 0x80u || (p[2] & 0xC0u) != 0x80u || (p[3] & 0xC0u) != 0x80u)
            {
                break;
            }
            code = ((uint32_t)(p[0] & 0x07u) << 18) | ((uint32_t)(p[1] & 0x3Fu) << 12)
                   | ((uint32_t)(p[2] & 0x3Fu) << 6) | (uint32_t)(p[3] & 0x3Fu);
            len = 4;
        }

        if ((code >= 0x3400u && code <= 0x9FFFu) || (code >= 0xF900u && code <= 0xFAFFu)
            || (code >= 0x20000u && code <= 0x2EBEFu) || (code >= 0x3000u && code <= 0x303Fu)
            || (code >= 0xFF00u && code <= 0xFFEFu) || (code >= 0x1100u && code <= 0x11FFu)
            || (code >= 0x3130u && code <= 0x318Fu) || (code >= 0xAC00u && code <= 0xD7AFu))
        {
            return true;
        }

        p += len;
    }

    return false;
}

static bool is_cjk_codepoint(uint32_t code)
{
    return ((code >= 0x3400u && code <= 0x9FFFu) || (code >= 0xF900u && code <= 0xFAFFu)
            || (code >= 0x20000u && code <= 0x2EBEFu) || (code >= 0x3000u && code <= 0x303Fu)
            || (code >= 0xFF00u && code <= 0xFFEFu) || (code >= 0x1100u && code <= 0x11FFu)
            || (code >= 0x3130u && code <= 0x318Fu) || (code >= 0xAC00u && code <= 0xD7AFu));
}

static void render_gbk_per_char(lv_obj_t *target_container, lv_coord_t x, lv_coord_t y, lv_coord_t max_width,
                                const char *render_text, const lv_font_t *gbk_font, lv_color_t text_color)
{
    const uint8_t *p = (const uint8_t *)render_text;
    lv_coord_t cur_x = x;
    lv_coord_t cur_y = y;
    lv_coord_t line_h = (gbk_font ? gbk_font->line_height : 16);

    while (*p != '\0')
    {
        uint32_t code = 0;
        uint8_t len = 1;

        if ((*p & 0x80u) == 0)
        {
            code = *p;
            len = 1;
        }
        else if ((*p & 0xE0u) == 0xC0u)
        {
            if ((p[1] & 0xC0u) != 0x80u)
            {
                break;
            }
            code = ((uint32_t)(p[0] & 0x1Fu) << 6) | (uint32_t)(p[1] & 0x3Fu);
            len = 2;
        }
        else if ((*p & 0xF0u) == 0xE0u)
        {
            if ((p[1] & 0xC0u) != 0x80u || (p[2] & 0xC0u) != 0x80u)
            {
                break;
            }
            code = ((uint32_t)(p[0] & 0x0Fu) << 12) | ((uint32_t)(p[1] & 0x3Fu) << 6) | (uint32_t)(p[2] & 0x3Fu);
            len = 3;
        }
        else if ((*p & 0xF8u) == 0xF0u)
        {
            if ((p[1] & 0xC0u) != 0x80u || (p[2] & 0xC0u) != 0x80u || (p[3] & 0xC0u) != 0x80u)
            {
                break;
            }
            code = ((uint32_t)(p[0] & 0x07u) << 18) | ((uint32_t)(p[1] & 0x3Fu) << 12)
                   | ((uint32_t)(p[2] & 0x3Fu) << 6) | (uint32_t)(p[3] & 0x3Fu);
            len = 4;
        }

        if (code == '\n' || code == '\r')
        {
            cur_x = x;
            cur_y += line_h;
            p += len;
            continue;
        }

        char buf[5] = {0};
        if (code <= 0x7Fu)
        {
            buf[0] = (char)code;
            buf[1] = '\0';
        }
        else if (len > 0 && len <= 4)
        {
            memcpy(buf, p, len);
            buf[len] = '\0';
        }

        lv_font_glyph_dsc_t dsc;
        bool has_glyph = false;
        const lv_font_t *active_font = gbk_font;
#if defined(CONFIG_LV_FONT_SIMSUN_16_CJK)
        const lv_font_t *font_cjk_fallback = &lv_font_simsun_16_cjk;
#else
        const lv_font_t *font_cjk_fallback = NULL;
#endif

        if (gbk_font && lv_font_get_glyph_dsc(gbk_font, &dsc, code, 0))
        {
            has_glyph = true;
        }
        else if (is_cjk_codepoint(code) && font_cjk_fallback
                 && lv_font_get_glyph_dsc(font_cjk_fallback, &dsc, code, 0))
        {
            has_glyph = true;
            active_font = font_cjk_fallback;
        }
        else
        {
            active_font = (gbk_font != NULL) ? gbk_font : font_cjk_fallback;
            buf[0] = '?';
            buf[1] = '\0';
            if (active_font && lv_font_get_glyph_dsc(active_font, &dsc, (uint32_t)0x3F, 0))
            {
                has_glyph = true;
            }
        }

        if (!has_glyph)
        {
            cur_x += (code < 0x80u) ? (line_h / 2) : line_h;
            p += len;
            continue;
        }

        lv_coord_t glyph_w = dsc.box_w;
        if (glyph_w == 0)
        {
            glyph_w = (lv_coord_t)((dsc.adv_w + 15) / 16);
        }

        lv_coord_t adv = (lv_coord_t)((dsc.adv_w + 15) / 16);
        if (code >= 0x80u && glyph_w > 0 && glyph_w < adv)
        {
            bool is_fullwidth_punct = (code >= 0x3000u && code <= 0x303Fu) || (code >= 0xFF00u && code <= 0xFFEFu);
            adv = is_fullwidth_punct ? (glyph_w + adv) / 2 : glyph_w + 2;
        }

        if (max_width > 0 && (cur_x + adv) > max_width)
        {
            cur_x = x;
            cur_y += line_h;
        }

        lv_obj_t *lbl = lv_label_create(target_container);
        lv_label_set_text(lbl, buf);
        if (active_font != NULL)
        {
            lv_obj_set_style_text_font(lbl, active_font, 0);
        }
        lv_obj_set_style_text_color(lbl, text_color, 0);
        lv_obj_set_pos(lbl, cur_x, cur_y);

        cur_x += adv;
        p += len;
    }
}

void display_xy_view_reset_state(void)
{
    s_xy_text_container = NULL;
    s_current_xy_text_label = NULL;
}

void display_xy_view_detach(void)
{
    s_xy_text_container = NULL;
    s_current_xy_text_label = NULL;
}

void display_xy_view_ensure(lv_obj_t *screen)
{
    const display_config_t *config;
    lv_obj_t *container;

    if (s_xy_text_container != NULL || screen == NULL)
    {
        return;
    }

    config = display_get_config();
    container = lv_obj_create(screen);

    lv_obj_set_size(container, config->layout.usable_width, config->layout.usable_height);
    lv_obj_set_pos(container, config->layout.margin_left, config->layout.margin_top);
    lv_obj_set_scroll_dir(container, LV_DIR_NONE);
    lv_obj_set_scrollbar_mode(container, LV_SCROLLBAR_MODE_OFF);
    lv_obj_set_style_bg_color(container, lv_color_white(), 0);
    lv_obj_set_style_bg_opa(container, LV_OPA_COVER, 0);
    lv_obj_set_style_border_color(container, lv_color_black(), 0);
    lv_obj_set_style_border_opa(container, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(container, 2, 0);

    s_xy_text_container = container;
}

void display_xy_view_clear(void)
{
    if (s_xy_text_container != NULL && lv_obj_get_child_cnt(s_xy_text_container) > 0)
    {
        lv_obj_clean(s_xy_text_container);
        lv_obj_invalidate(s_xy_text_container);
    }
    s_current_xy_text_label = NULL;
}

void display_xy_view_apply_config(lv_obj_t *screen, const display_config_t *config)
{
    if (s_xy_text_container == NULL || screen == NULL || config == NULL)
    {
        return;
    }

    (void)display_apply_container_config(s_xy_text_container, screen, config);
    lv_obj_update_layout(s_xy_text_container);
}

void display_xy_view_invalidate_visible(void)
{
    if (s_xy_text_container != NULL)
    {
        lv_obj_invalidate(s_xy_text_container);
    }
}

lv_obj_t *display_xy_view_get_container(void)
{
    return s_xy_text_container;
}

void display_xy_view_update_text(uint16_t x, uint16_t y, const char *text_content, uint16_t font_size, uint32_t color,
                                 lv_obj_t *overlay_container, lv_obj_t *translation_container, bool *used_overlay)
{
    lv_obj_t *target_container = NULL;
    const char *render_text = text_content;
    const lv_font_t *font;
    lv_color_t text_color;
    bool force_cjk = false;
    bool use_gbk = true;
    bool use_gbk_chars = true;

    ARG_UNUSED(font_size);
    ARG_UNUSED(translation_container);

    if (used_overlay != NULL)
    {
        *used_overlay = false;
    }

    if (text_content == NULL)
    {
        LOG_ERR("Invalid XY text content pointer");
        return;
    }

    if (s_xy_text_container != NULL)
    {
        target_container = s_xy_text_container;
    }
    else if (overlay_container != NULL)
    {
        target_container = overlay_container;
        if (used_overlay != NULL)
        {
            *used_overlay = true;
        }
    }
    else
    {
        target_container = lv_screen_active();
    }

    lv_obj_set_style_bg_color(target_container, display_get_background_color(), 0);
    lv_obj_set_style_bg_opa(target_container, LV_OPA_COVER, 0);

    if (lv_obj_get_child_cnt(target_container) > 0)
    {
        lv_obj_clean(target_container);
        s_current_xy_text_label = NULL;
        if (target_container == overlay_container)
        {
            lv_obj_clear_flag(overlay_container, LV_OBJ_FLAG_HIDDEN);
        }
    }
    else if (target_container == overlay_container)
    {
        lv_obj_clear_flag(overlay_container, LV_OBJ_FLAG_HIDDEN);
    }

    const uint16_t max_x = 580;
    const uint16_t max_y = 420;
    if (x >= max_x || y >= max_y)
    {
        x = (x >= max_x) ? (max_x - 50) : x;
        y = (y >= max_y) ? (max_y - 30) : y;
    }

    if (strncmp(text_content, "[cjkchars]", 10) == 0)
    {
        force_cjk = true;
        render_text = text_content + 10;
        while (*render_text == ' ')
        {
            render_text++;
        }
    }
    else if (strncmp(text_content, "[cjk]", 5) == 0)
    {
        force_cjk = true;
        render_text = text_content + 5;
        while (*render_text == ' ')
        {
            render_text++;
        }
    }

    if (!force_cjk && !utf8_contains_cjk(render_text))
    {
        use_gbk = false;
        use_gbk_chars = false;
    }

    font = use_gbk ? display_get_font("gbk") : display_get_font("secondary");
    if (!font)
    {
        font = display_get_font("primary");
    }

    text_color = color_from_rgb565(color);
    if (color == 0xFFFFu)
    {
        lv_color_t bg = display_get_background_color();
        uint16_t avg = (uint16_t)bg.red + (uint16_t)bg.green + (uint16_t)bg.blue;
        text_color = (avg > (3u * 128u)) ? lv_color_black() : lv_color_white();
    }

    if (use_gbk_chars && font)
    {
        render_gbk_per_char(target_container, x, y, 0, render_text, font, text_color);
        lv_obj_invalidate(target_container);
    }
    else
    {
        s_current_xy_text_label = lv_label_create(target_container);
        lv_label_set_text(s_current_xy_text_label, render_text);
        lv_obj_set_style_text_font(s_current_xy_text_label, font, 0);
        lv_obj_set_style_text_color(s_current_xy_text_label, text_color, 0);
        lv_obj_set_style_bg_opa(s_current_xy_text_label, LV_OPA_TRANSP, 0);
        lv_label_set_long_mode(s_current_xy_text_label, LV_LABEL_LONG_WRAP);
        lv_obj_set_width(s_current_xy_text_label, max_x - x);
        lv_obj_set_pos(s_current_xy_text_label, x, y);
        lv_obj_invalidate(s_current_xy_text_label);
    }
}
