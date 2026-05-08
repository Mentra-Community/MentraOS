#include "mos_display_custom_rendering.h"

#include <string.h>
#include <zephyr/logging/log.h>
#include <lvgl.h>

LOG_MODULE_REGISTER(custom_rendering, LOG_LEVEL_DBG);

#if defined(CONFIG_LV_FONT_SIMSUN_16_CJK)
LV_FONT_DECLARE(lv_font_simsun_16_cjk);
#endif

static bool is_cjk(uint32_t code)
{
    return (code >= 0x4E00u && code <= 0x9FFFu) ||
           (code >= 0x3400u && code <= 0x4DBFu) ||
           (code >= 0xF900u && code <= 0xFAFFu) ||
           (code >= 0x3000u && code <= 0x303Fu) ||
           (code >= 0xFF00u && code <= 0xFFEFu);
}

static lv_obj_t *acquire_label(lv_obj_t *container, lv_obj_t **pool, size_t pool_size,
                                size_t *pool_used, size_t index)
{
    if (pool == NULL)
    {
        lv_obj_t *lbl = lv_label_create(container);
        lv_obj_set_style_bg_opa(lbl, LV_OPA_TRANSP, 0);
        lv_obj_set_style_pad_all(lbl, 0, 0);
        return lbl;
    }

    if (index >= pool_size)
    {
        return NULL;
    }

    if (pool[index] == NULL)
    {
        pool[index] = lv_label_create(container);
        lv_obj_set_style_bg_opa(pool[index], LV_OPA_TRANSP, 0);
        lv_obj_set_style_pad_all(pool[index], 0, 0);
        if (pool_used && index >= *pool_used)
        {
            *pool_used = index + 1;
        }
    }

    return pool[index];
}

void mos_ui_custom_render(lv_obj_t *container,
                             lv_coord_t x, lv_coord_t y, lv_coord_t max_width,
                             const char *text,
                             const lv_font_t *font_primary,
                             const lv_font_t *font_fallback,
                             lv_color_t text_color,
                             lv_obj_t **pool, size_t pool_size, size_t *pool_used,
                             lv_coord_t *out_end_x, lv_coord_t *out_end_y,
                             size_t *out_byte_len)
{
    if (!container || !text)
    {
        return;
    }

    const uint8_t *p = (const uint8_t *)text;
    const uint8_t *p_start = p;
    lv_coord_t cur_x = x;
    lv_coord_t cur_y = y;
    lv_coord_t line_h = font_primary ? font_primary->line_height : 16;
    size_t label_index = 0;

#if defined(CONFIG_LV_FONT_SIMSUN_16_CJK)
    const lv_font_t *font_cjk_fallback = &lv_font_simsun_16_cjk;
#else
    const lv_font_t *font_cjk_fallback = NULL;
#endif

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
                break;
            code = ((uint32_t)(p[0] & 0x1Fu) << 6) | (uint32_t)(p[1] & 0x3Fu);
            len = 2;
        }
        else if ((*p & 0xF0u) == 0xE0u)
        {
            if ((p[1] & 0xC0u) != 0x80u || (p[2] & 0xC0u) != 0x80u)
                break;
            code = ((uint32_t)(p[0] & 0x0Fu) << 12) | ((uint32_t)(p[1] & 0x3Fu) << 6) |
                   (uint32_t)(p[2] & 0x3Fu);
            len = 3;
        }
        else if ((*p & 0xF8u) == 0xF0u)
        {
            if ((p[1] & 0xC0u) != 0x80u || (p[2] & 0xC0u) != 0x80u || (p[3] & 0xC0u) != 0x80u)
                break;
            code = ((uint32_t)(p[0] & 0x07u) << 18) | ((uint32_t)(p[1] & 0x3Fu) << 12) |
                   ((uint32_t)(p[2] & 0x3Fu) << 6) | (uint32_t)(p[3] & 0x3Fu);
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
        }
        else if (len > 0 && len <= 4)
        {
            memcpy(buf, p, len);
        }

        lv_font_glyph_dsc_t dsc;
        bool has_glyph = false;
        const lv_font_t *active_font = font_primary;

        if (font_primary && lv_font_get_glyph_dsc(font_primary, &dsc, code, 0))
        {
            has_glyph = true;
        }
        else if (font_fallback && lv_font_get_glyph_dsc(font_fallback, &dsc, code, 0))
        {
            has_glyph = true;
            active_font = font_fallback;
        }
        else if (is_cjk(code) && font_cjk_fallback &&
                 lv_font_get_glyph_dsc(font_cjk_fallback, &dsc, code, 0))
        {
            has_glyph = true;
            active_font = font_cjk_fallback;
        }
        else
        {
            buf[0] = '?';
            buf[1] = '\0';
            const lv_font_t *candidates[] = {font_primary, font_fallback, font_cjk_fallback};
            for (int i = 0; i < 3; i++)
            {
                if (candidates[i] && lv_font_get_glyph_dsc(candidates[i], &dsc, (uint32_t)'?', 0))
                {
                    has_glyph = true;
                    active_font = candidates[i];
                    break;
                }
            }
            LOG_WRN("custom_render: no glyph for U+%04X, using placeholder", (unsigned int)code);
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
        if (code >= 0x80u && glyph_w > 0 && (lv_coord_t)glyph_w < adv)
        {
            bool is_fullwidth_punct = (code >= 0x3000u && code <= 0x303Fu) ||
                                      (code >= 0xFF00u && code <= 0xFFEFu);
            adv = is_fullwidth_punct ? (glyph_w + adv) / 2 : glyph_w + 2;
        }

        if (max_width > 0 && (cur_x + adv) > max_width)
        {
            cur_x = x;
            cur_y += line_h;
        }

        lv_obj_t *lbl = acquire_label(container, pool, pool_size, pool_used, label_index);
        if (lbl == NULL)
        {
            LOG_WRN("custom_render: label pool exhausted at %u", (unsigned int)label_index);
            break;
        }

        lv_obj_clear_flag(lbl, LV_OBJ_FLAG_HIDDEN);
        lv_label_set_text(lbl, buf);
        if (lv_obj_get_style_text_font(lbl, 0) != active_font)
        {
            lv_obj_set_style_text_font(lbl, active_font, 0);
        }
        lv_obj_set_style_text_color(lbl, text_color, 0);
        lv_obj_set_pos(lbl, cur_x, cur_y);

        cur_x += adv;
        label_index++;
        p += len;
    }

    if (pool != NULL && pool_used != NULL)
    {
        for (size_t i = label_index; i < *pool_used; i++)
        {
            if (pool[i] != NULL)
            {
                lv_obj_add_flag(pool[i], LV_OBJ_FLAG_HIDDEN);
            }
        }
        *pool_used = label_index;
    }

    if (out_end_x)   *out_end_x = cur_x;
    if (out_end_y)   *out_end_y = cur_y;
    if (out_byte_len) *out_byte_len = (size_t)(p - p_start);
}
