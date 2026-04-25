#include "display_caption_view.h"

#include <errno.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "caption_state.h"
#include "display_config.h"
#include "display_view_support.h"
#include "ui_font_policy.h"
#include "ui_framework.h"
#include "ui_pages.h"

#include "mos_binfont_lvgl.h"
#include "mos_font_storage.h"
#if defined(CONFIG_LV_FONT_SIMSUN_16_CJK)
LV_FONT_DECLARE(lv_font_simsun_16_cjk);
#endif

LOG_MODULE_REGISTER(display_caption_view, LOG_LEVEL_INF);

#define PROTOBUF_GBK_LABEL_POOL_SIZE 256
#define CJK_PROBE_RELOAD_COOLDOWN_MS 5000U

/*
 * display_caption_view is the current shared text view implementation.
 *
 * `UI_PAGE_CAPTION` and `UI_PAGE_TRANSLATION` currently reuse the same LVGL
 * object graph and text rendering path. The page identity still matters for
 * business meaning, logging, and future layout divergence.
 * display_caption_view 是当前共用的底层文本视图实现。
 * `UI_PAGE_CAPTION` 和 `UI_PAGE_TRANSLATION` 目前复用同一套 LVGL 对象树和文本渲染路径，
 * 但页面身份仍然决定业务语义、日志含义，以及未来是否拆分成不同布局。
 */
typedef struct
{
    lv_obj_t *protobuf_container;
    lv_obj_t *protobuf_label;
    lv_obj_t *protobuf_gbk_container;
    lv_obj_t *protobuf_xy_overlay_container;
    size_t protobuf_gbk_label_pool_used;
    char last_protobuf_text[CAPTION_TEXT_MAX_CHARS];
    bool last_protobuf_text_valid;
    uint32_t last_cjk_probe_reload_ms;
} display_caption_view_state_t;

static display_pattern_id_t display_caption_view_active_pattern(void)
{
    return ui_pages_default_pattern_for_page(ui_framework_get_active_page());
}

static const char *display_caption_view_target_label(void)
{
    switch (ui_framework_get_active_page())
    {
        case UI_PAGE_CAPTION:
            return "CAPTION";
        case UI_PAGE_TRANSLATION:
            return "TRANSLATION";
        default:
            return "TEXT";
    }
}

static display_caption_view_state_t s_caption_state_legacy = {0};
static display_caption_view_state_t *s_caption_state = &s_caption_state_legacy;

#define s_protobuf_container            (s_caption_state->protobuf_container)
#define s_protobuf_label                (s_caption_state->protobuf_label)
#define s_protobuf_gbk_container        (s_caption_state->protobuf_gbk_container)
#define s_protobuf_xy_overlay_container (s_caption_state->protobuf_xy_overlay_container)
#define s_protobuf_gbk_label_pool_used  (s_caption_state->protobuf_gbk_label_pool_used)
#define s_last_protobuf_text            (s_caption_state->last_protobuf_text)
#define s_last_protobuf_text_valid      (s_caption_state->last_protobuf_text_valid)
#define s_last_cjk_probe_reload_ms      (s_caption_state->last_cjk_probe_reload_ms)

static lv_obj_t *s_protobuf_gbk_label_pool[PROTOBUF_GBK_LABEL_POOL_SIZE];

size_t display_caption_view_state_size(void)
{
    return sizeof(display_caption_view_state_t);
}

int display_caption_view_state_init(void *state, void *context)
{
    ARG_UNUSED(context);
    if (state == NULL)
    {
        return -EINVAL;
    }
    memset(state, 0, sizeof(display_caption_view_state_t));
    s_caption_state = (display_caption_view_state_t *)state;
    return 0;
}

int display_caption_view_state_deinit(void *state, void *context)
{
    ARG_UNUSED(context);
    if (state == NULL)
    {
        return -EINVAL;
    }
    memset(state, 0, sizeof(display_caption_view_state_t));
    if (s_caption_state == (display_caption_view_state_t *)state)
    {
        s_caption_state = &s_caption_state_legacy;
        memset(s_caption_state, 0, sizeof(display_caption_view_state_t));
    }
    return 0;
}

static bool utf8_is_ascii_only(const char *text)
{
    if (!text)
    {
        return true;
    }
    for (const uint8_t *p = (const uint8_t *)text; *p != '\0'; ++p)
    {
        if (*p >= 0x80u)
        {
            return false;
        }
    }
    return true;
}

static bool utf8_first_non_ascii_codepoint(const char *text, uint32_t *out_codepoint)
{
    if (!text || !out_codepoint)
    {
        return false;
    }

    const uint8_t *p = (const uint8_t *)text;
    while (*p != '\0')
    {
        uint32_t code = 0;

        if ((*p & 0x80u) == 0)
        {
            p += 1;
            continue;
        }
        if ((*p & 0xE0u) == 0xC0u)
        {
            if ((p[1] & 0xC0u) != 0x80u)
            {
                return false;
            }
            code = ((uint32_t)(p[0] & 0x1Fu) << 6) | (uint32_t)(p[1] & 0x3Fu);
            *out_codepoint = code;
            return true;
        }
        if ((*p & 0xF0u) == 0xE0u)
        {
            if ((p[1] & 0xC0u) != 0x80u || (p[2] & 0xC0u) != 0x80u)
            {
                return false;
            }
            code = ((uint32_t)(p[0] & 0x0Fu) << 12) | ((uint32_t)(p[1] & 0x3Fu) << 6) | (uint32_t)(p[2] & 0x3Fu);
            *out_codepoint = code;
            return true;
        }
        if ((*p & 0xF8u) == 0xF0u)
        {
            if ((p[1] & 0xC0u) != 0x80u || (p[2] & 0xC0u) != 0x80u || (p[3] & 0xC0u) != 0x80u)
            {
                return false;
            }
            code = ((uint32_t)(p[0] & 0x07u) << 18) | ((uint32_t)(p[1] & 0x3Fu) << 12) |
                   ((uint32_t)(p[2] & 0x3Fu) << 6) | (uint32_t)(p[3] & 0x3Fu);
            *out_codepoint = code;
            return true;
        }
        return false;
    }

    return false;
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
            code = ((uint32_t)(p[0] & 0x07u) << 18) | ((uint32_t)(p[1] & 0x3Fu) << 12) |
                   ((uint32_t)(p[2] & 0x3Fu) << 6) | (uint32_t)(p[3] & 0x3Fu);
            len = 4;
        }

        if ((code >= 0x3400u && code <= 0x9FFFu) || (code >= 0xF900u && code <= 0xFAFFu) ||
            (code >= 0x20000u && code <= 0x2EBEFu) || (code >= 0x3000u && code <= 0x303Fu) ||
            (code >= 0xFF00u && code <= 0xFFEFu) || (code >= 0x1100u && code <= 0x11FFu) ||
            (code >= 0x3130u && code <= 0x318Fu) || (code >= 0xAC00u && code <= 0xD7AFu))
        {
            return true;
        }

        p += len;
    }

    return false;
}

static bool is_cjk_codepoint(uint32_t code)
{
    return ((code >= 0x3400u && code <= 0x9FFFu) || (code >= 0xF900u && code <= 0xFAFFu) ||
            (code >= 0x20000u && code <= 0x2EBEFu) || (code >= 0x3000u && code <= 0x303Fu) ||
            (code >= 0xFF00u && code <= 0xFFEFu) || (code >= 0x1100u && code <= 0x11FFu) ||
            (code >= 0x3130u && code <= 0x318Fu) || (code >= 0xAC00u && code <= 0xD7AFu));
}

static lv_obj_t *protobuf_gbk_acquire_label(lv_obj_t *parent, size_t index)
{
    if (index >= PROTOBUF_GBK_LABEL_POOL_SIZE)
    {
        return NULL;
    }

    if (s_protobuf_gbk_label_pool[index] == NULL)
    {
        s_protobuf_gbk_label_pool[index] = lv_label_create(parent);
        lv_obj_set_style_bg_opa(s_protobuf_gbk_label_pool[index], LV_OPA_TRANSP, 0);
        lv_obj_set_style_pad_all(s_protobuf_gbk_label_pool[index], 0, 0);
    }

    return s_protobuf_gbk_label_pool[index];
}

static void render_gbk_per_char(lv_obj_t *target_container, lv_coord_t x, lv_coord_t y, lv_coord_t max_width,
                                const char *render_text, const lv_font_t *gbk_font, const lv_font_t *font_primary,
                                lv_color_t text_color)
{
    const uint8_t *p = (const uint8_t *)render_text;
    lv_coord_t cur_x = x;
    lv_coord_t cur_y = y;
    lv_coord_t line_h = (gbk_font ? gbk_font->line_height : 16);
    bool use_pool = (target_container == s_protobuf_gbk_container);
    size_t label_index = 0;

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
        const bool cjk_char = is_cjk_codepoint(code);
#if defined(CONFIG_LV_FONT_SIMSUN_16_CJK)
        const lv_font_t *font_cjk_fallback = &lv_font_simsun_16_cjk;
#else
        const lv_font_t *font_cjk_fallback = NULL;
#endif

        if (gbk_font && lv_font_get_glyph_dsc(gbk_font, &dsc, code, 0))
        {
            has_glyph = true;
        }
        else if (font_primary && lv_font_get_glyph_dsc(font_primary, &dsc, code, 0))
        {
            has_glyph = true;
            active_font = font_primary;
        }
        else if (cjk_char && font_cjk_fallback && lv_font_get_glyph_dsc(font_cjk_fallback, &dsc, code, 0))
        {
            has_glyph = true;
            active_font = font_cjk_fallback;
        }
        else
        {
            active_font = (gbk_font != NULL) ? gbk_font : font_primary;
            buf[0] = '?';
            buf[1] = '\0';
            if (active_font && lv_font_get_glyph_dsc(active_font, &dsc, (uint32_t)0x3F, 0))
            {
                has_glyph = true;
            }
            else if (font_primary && lv_font_get_glyph_dsc(font_primary, &dsc, (uint32_t)0x3F, 0))
            {
                has_glyph = true;
                active_font = font_primary;
            }
            else if (font_cjk_fallback && lv_font_get_glyph_dsc(font_cjk_fallback, &dsc, (uint32_t)0x3F, 0))
            {
                has_glyph = true;
                active_font = font_cjk_fallback;
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

        lv_obj_t *lbl = NULL;
        if (use_pool)
        {
            lbl = protobuf_gbk_acquire_label(target_container, label_index);
            if (lbl == NULL)
            {
                break;
            }
            lv_obj_clear_flag(lbl, LV_OBJ_FLAG_HIDDEN);
            label_index++;
        }
        else
        {
            lbl = lv_label_create(target_container);
        }

        lv_label_set_text(lbl, buf);
        if (lv_obj_get_style_text_font(lbl, 0) != active_font)
        {
            lv_obj_set_style_text_font(lbl, active_font, 0);
        }
        lv_obj_set_style_text_color(lbl, text_color, 0);
        lv_obj_set_pos(lbl, cur_x, cur_y);

        cur_x += adv;
        p += len;
    }

    if (use_pool)
    {
        for (size_t index = label_index; index < s_protobuf_gbk_label_pool_used; ++index)
        {
            if (s_protobuf_gbk_label_pool[index] != NULL)
            {
                lv_obj_add_flag(s_protobuf_gbk_label_pool[index], LV_OBJ_FLAG_HIDDEN);
            }
        }
        s_protobuf_gbk_label_pool_used = label_index;
    }
}

static void protobuf_scroll_ascii_label_bottom_visible(void)
{
    if (s_protobuf_container == NULL || s_protobuf_label == NULL)
    {
        return;
    }
    if (lv_obj_has_flag(s_protobuf_label, LV_OBJ_FLAG_HIDDEN))
    {
        return;
    }

    lv_obj_update_layout(s_protobuf_label);
    lv_obj_update_layout(s_protobuf_container);

    const lv_coord_t view_h = lv_obj_get_content_height(s_protobuf_container);
    const lv_coord_t ly = lv_obj_get_y(s_protobuf_label);
    const lv_coord_t lh = lv_obj_get_height(s_protobuf_label);
    lv_coord_t target = ly + lh - view_h;

    if (target < 0)
    {
        target = 0;
    }
    lv_obj_scroll_to_y(s_protobuf_container, target, LV_ANIM_OFF);
}

void display_caption_view_reset_state(void)
{
    s_protobuf_container = NULL;
    s_protobuf_label = NULL;
    s_protobuf_gbk_container = NULL;
    s_protobuf_xy_overlay_container = NULL;
    memset(s_protobuf_gbk_label_pool, 0, sizeof(s_protobuf_gbk_label_pool));
    s_protobuf_gbk_label_pool_used = 0U;
    s_last_protobuf_text_valid = false;
    s_last_protobuf_text[0] = '\0';
    s_last_cjk_probe_reload_ms = 0U;
}

void display_caption_view_reset_text_cache(void)
{
    s_last_protobuf_text_valid = false;
    s_last_protobuf_text[0] = '\0';
}

void display_caption_view_detach(void)
{
    s_protobuf_container = NULL;
    s_protobuf_label = NULL;
    s_protobuf_gbk_container = NULL;
    s_protobuf_xy_overlay_container = NULL;
    memset(s_protobuf_gbk_label_pool, 0, sizeof(s_protobuf_gbk_label_pool));
    s_protobuf_gbk_label_pool_used = 0U;
}

void display_caption_view_ensure(lv_obj_t *screen, lv_obj_t *welcome_container)
{
    const display_config_t *config;

    if (s_protobuf_container != NULL && s_protobuf_label != NULL)
    {
        return;
    }
    if (screen == NULL)
    {
        return;
    }

    config = display_get_config();

    s_protobuf_container = lv_obj_create(screen);
    display_apply_container_config(s_protobuf_container, screen, config);
    lv_obj_set_scroll_dir(s_protobuf_container, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(s_protobuf_container, LV_SCROLLBAR_MODE_OFF);
    lv_obj_set_style_bg_color(s_protobuf_container, display_get_background_color(), 0);
    lv_obj_set_style_bg_opa(s_protobuf_container, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(s_protobuf_container, 0, 0);
    lv_obj_set_style_border_opa(s_protobuf_container, LV_OPA_TRANSP, 0);

    s_protobuf_label = lv_label_create(s_protobuf_container);
    lv_obj_set_width(s_protobuf_label, config->layout.usable_width - (config->layout.padding * 2));
    lv_label_set_long_mode(s_protobuf_label, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_align(s_protobuf_label, LV_TEXT_ALIGN_LEFT, 0);
    lv_obj_set_style_text_color(s_protobuf_label, display_get_text_color(), 0);
    lv_obj_set_style_text_line_space(s_protobuf_label, config->fonts.line_spacing, 0);
    lv_obj_set_style_text_font(s_protobuf_label, display_get_font("secondary"), 0);
    lv_obj_align(s_protobuf_label, LV_ALIGN_TOP_LEFT, 0, DISPLAY_VIEW_CONTENT_YOFF);
    display_ui_register_dynamic_label(s_protobuf_label);

    s_protobuf_gbk_container = lv_obj_create(s_protobuf_container);
    lv_obj_set_size(s_protobuf_gbk_container, config->layout.usable_width - (config->layout.padding * 2),
                    config->layout.usable_height - (config->layout.padding * 2));
    lv_obj_set_style_bg_opa(s_protobuf_gbk_container, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(s_protobuf_gbk_container, 0, 0);
    lv_obj_set_style_border_opa(s_protobuf_gbk_container, LV_OPA_TRANSP, 0);
    lv_obj_set_scroll_dir(s_protobuf_gbk_container, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(s_protobuf_gbk_container, LV_SCROLLBAR_MODE_AUTO);
    lv_obj_align(s_protobuf_gbk_container, LV_ALIGN_TOP_LEFT, 0, DISPLAY_VIEW_CONTENT_YOFF);
    lv_obj_add_flag(s_protobuf_gbk_container, LV_OBJ_FLAG_HIDDEN);

    s_protobuf_xy_overlay_container = lv_obj_create(s_protobuf_container);
    lv_obj_set_size(s_protobuf_xy_overlay_container, config->layout.usable_width - (config->layout.padding * 2),
                    config->layout.usable_height - (config->layout.padding * 2));
    lv_obj_set_style_bg_opa(s_protobuf_xy_overlay_container, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(s_protobuf_xy_overlay_container, 0, 0);
    lv_obj_set_style_border_opa(s_protobuf_xy_overlay_container, LV_OPA_TRANSP, 0);
    lv_obj_set_style_pad_all(s_protobuf_xy_overlay_container, 0, 0);
    lv_obj_set_scroll_dir(s_protobuf_xy_overlay_container, LV_DIR_NONE);
    lv_obj_set_scrollbar_mode(s_protobuf_xy_overlay_container, LV_SCROLLBAR_MODE_OFF);
    lv_obj_align(s_protobuf_xy_overlay_container, LV_ALIGN_TOP_LEFT, 0, 0);
    lv_obj_add_flag(s_protobuf_xy_overlay_container, LV_OBJ_FLAG_HIDDEN);

    if (welcome_container != NULL)
    {
        lv_obj_add_flag(welcome_container, LV_OBJ_FLAG_HIDDEN);
    }

    memset(s_protobuf_gbk_label_pool, 0, sizeof(s_protobuf_gbk_label_pool));
    s_protobuf_gbk_label_pool_used = 0U;
    lv_obj_update_layout(s_protobuf_container);
}

void display_caption_view_destroy(void)
{
    if (s_protobuf_label != NULL)
    {
        display_ui_unregister_dynamic_label(s_protobuf_label);
    }
    if (s_protobuf_container != NULL)
    {
        lv_obj_del(s_protobuf_container);
    }

    display_caption_view_detach();
}

void display_caption_view_clear(void)
{
    if (s_protobuf_label != NULL)
    {
        lv_label_set_text(s_protobuf_label, "");
        lv_obj_clear_flag(s_protobuf_label, LV_OBJ_FLAG_HIDDEN);
    }

    if (s_protobuf_gbk_container != NULL)
    {
        lv_obj_add_flag(s_protobuf_gbk_container, LV_OBJ_FLAG_HIDDEN);
        for (size_t index = 0; index < s_protobuf_gbk_label_pool_used; ++index)
        {
            if (s_protobuf_gbk_label_pool[index] != NULL)
            {
                lv_obj_add_flag(s_protobuf_gbk_label_pool[index], LV_OBJ_FLAG_HIDDEN);
            }
        }
        s_protobuf_gbk_label_pool_used = 0U;
    }

    display_caption_view_hide_xy_overlay();

    if (s_protobuf_container != NULL)
    {
        lv_obj_scroll_to_y(s_protobuf_container, 0, LV_ANIM_OFF);
        lv_obj_invalidate(s_protobuf_container);
    }

    display_ui_request_refresh();
}

void display_caption_view_hide_xy_overlay(void)
{
    if (s_protobuf_xy_overlay_container == NULL)
    {
        return;
    }

    if (lv_obj_get_child_cnt(s_protobuf_xy_overlay_container) > 0)
    {
        lv_obj_clean(s_protobuf_xy_overlay_container);
    }

    lv_obj_add_flag(s_protobuf_xy_overlay_container, LV_OBJ_FLAG_HIDDEN);
}

void display_caption_view_set_welcome_scroll(bool welcome_active)
{
    if (s_protobuf_container == NULL)
    {
        return;
    }

    if (welcome_active)
    {
        lv_obj_set_scroll_dir(s_protobuf_container, LV_DIR_NONE);
        lv_obj_scroll_to_y(s_protobuf_container, 0, LV_ANIM_OFF);
    }
    else
    {
        lv_obj_set_scroll_dir(s_protobuf_container, LV_DIR_VER);
    }
}

void display_caption_view_apply_config(lv_obj_t *screen, const display_config_t *config)
{
    if (s_protobuf_container == NULL || screen == NULL || config == NULL)
    {
        return;
    }

    (void)display_apply_container_config(s_protobuf_container, screen, config);
    lv_obj_update_layout(s_protobuf_container);
}

void display_caption_view_invalidate_visible(void)
{
    if (s_protobuf_container != NULL)
    {
        lv_obj_invalidate(s_protobuf_container);
    }
    if (s_protobuf_gbk_container != NULL && !lv_obj_has_flag(s_protobuf_gbk_container, LV_OBJ_FLAG_HIDDEN))
    {
        lv_obj_invalidate(s_protobuf_gbk_container);
    }
}

void display_caption_view_scroll_bottom_visible(void)
{
    protobuf_scroll_ascii_label_bottom_visible();
}

bool display_caption_view_has_last_text(void)
{
    return s_last_protobuf_text_valid;
}

const char *display_caption_view_get_last_text(void)
{
    return s_last_protobuf_text;
}

void display_caption_view_invalidate_last_text(void)
{
    s_last_protobuf_text_valid = false;
}

bool display_caption_view_text_equals_last(const char *text)
{
    return (text != NULL) && s_last_protobuf_text_valid && strcmp(text, s_last_protobuf_text) == 0;
}

void display_caption_view_render_text(const char *text_content, uint32_t committed_seq, display_biz_lang_t src_lang,
                                      display_biz_lang_t dst_lang, lv_obj_t *welcome_container)
{
    char render_text[CAPTION_TEXT_MAX_CHARS] = {0};

    if (text_content == NULL)
    {
        LOG_ERR("Invalid text content pointer");
        return;
    }

    strncpy(render_text, text_content, sizeof(render_text) - 1U);
    render_text[sizeof(render_text) - 1U] = '\0';

    if (display_caption_view_text_equals_last(render_text))
    {
        return;
    }

    display_caption_view_ensure(lv_screen_active(), welcome_container);

    if (s_protobuf_container == NULL || s_protobuf_label == NULL)
    {
        LOG_ERR("Protobuf container not initialized");
        return;
    }

    if (welcome_container != NULL)
    {
        lv_obj_add_flag(welcome_container, LV_OBJ_FLAG_HIDDEN);
    }
    display_caption_view_set_welcome_scroll(false);
    display_caption_view_hide_xy_overlay();

    bool ascii_only = utf8_is_ascii_only(render_text);
    bool has_cjk = utf8_contains_cjk(render_text);

    ui_font_policy_apply_content_language(src_lang, dst_lang, has_cjk);

    if (0 && has_cjk)
    {
        mos_font_language_t preferred_lang = MOS_FONT_LANG_EN_US;
        const lv_font_t *gbk_font = display_get_font("gbk");
        const display_config_t *display_cfg = display_get_config();
        const lv_font_t *font_primary = (display_cfg != NULL) ? display_cfg->fonts.secondary : NULL;

        if (src_lang == DISPLAY_BIZ_LANG_ZH || dst_lang == DISPLAY_BIZ_LANG_ZH || has_cjk)
        {
            preferred_lang = MOS_FONT_LANG_ZH_CN;
        }
        if (mos_binfont_get_current_language() != preferred_lang)
        {
            mos_font_size_t target_size =
                (preferred_lang == MOS_FONT_LANG_ZH_CN) ? MOS_FONT_SIZE_18 : mos_font_get_current_size();
            (void)mos_font_switch_language(preferred_lang, target_size);
            gbk_font = display_get_font("gbk");
        }

        if (gbk_font != NULL)
        {
            uint32_t probe_code = 0;
            lv_font_glyph_dsc_t probe_dsc;
            if (utf8_first_non_ascii_codepoint(render_text, &probe_code) &&
                !lv_font_get_glyph_dsc(gbk_font, &probe_dsc, probe_code, 0))
            {
#if !defined(CONFIG_LV_FONT_SIMSUN_16_CJK)
                uint32_t now_ms = k_uptime_get_32();
                if ((now_ms - s_last_cjk_probe_reload_ms) >= CJK_PROBE_RELOAD_COOLDOWN_MS)
                {
                    s_last_cjk_probe_reload_ms = now_ms;
                    mos_binfont_lvgl_deinit();
                    gbk_font = mos_binfont_get_lvgl_font();
                }
#endif
            }
        }

        if (s_protobuf_gbk_container != NULL && gbk_font != NULL)
        {
            lv_obj_align(s_protobuf_gbk_container, LV_ALIGN_TOP_LEFT, 0, DISPLAY_VIEW_CONTENT_YOFF);
            render_gbk_per_char(s_protobuf_gbk_container, 0, 0, lv_obj_get_content_width(s_protobuf_gbk_container),
                                render_text, gbk_font, font_primary, display_get_text_color());
            lv_obj_clear_flag(s_protobuf_gbk_container, LV_OBJ_FLAG_HIDDEN);
            lv_obj_add_flag(s_protobuf_label, LV_OBJ_FLAG_HIDDEN);
            lv_obj_update_layout(s_protobuf_gbk_container);
            lv_obj_scroll_to_y(s_protobuf_gbk_container, lv_obj_get_scroll_bottom(s_protobuf_gbk_container),
                               LV_ANIM_OFF);

            strncpy(s_last_protobuf_text, render_text, sizeof(s_last_protobuf_text) - 1U);
            s_last_protobuf_text[sizeof(s_last_protobuf_text) - 1U] = '\0';
            s_last_protobuf_text_valid = true;
            display_ui_request_refresh();
            LOG_INF("[RENDER][%s] commit seq=%u raw_len=%u render_len=%u page=%d pattern=%d hidden=%d",
                    display_caption_view_target_label(), committed_seq, (unsigned int)strlen(text_content),
                    (unsigned int)strlen(render_text), (int)ui_framework_get_active_page(),
                    display_caption_view_active_pattern(), (int)lv_obj_has_flag(s_protobuf_gbk_container, LV_OBJ_FLAG_HIDDEN));
            return;
        }
    }

    if (s_protobuf_gbk_container != NULL)
    {
        lv_obj_add_flag(s_protobuf_gbk_container, LV_OBJ_FLAG_HIDDEN);
    }
    lv_obj_clear_flag(s_protobuf_label, LV_OBJ_FLAG_HIDDEN);

    if (ascii_only)
    {
        bool need_builtin_fallback = true;
        const lv_font_t *active_binfont = mos_binfont_get_lvgl_font();
        if (active_binfont != NULL && mos_binfont_is_initialized())
        {
            lv_font_glyph_dsc_t probe_dsc;
            if (lv_font_get_glyph_dsc(active_binfont, &probe_dsc, (uint32_t)'?', 0) ||
                lv_font_get_glyph_dsc(active_binfont, &probe_dsc, (uint32_t)'A', 0))
            {
                need_builtin_fallback = false;
            }
        }

        if (need_builtin_fallback)
        {
            const display_config_t *display_cfg = display_get_config();
            if (display_cfg != NULL && display_cfg->fonts.secondary != NULL)
            {
                lv_obj_set_style_text_font(s_protobuf_label, display_cfg->fonts.secondary, 0);
            }
        }
    }
#if defined(CONFIG_LV_FONT_SIMSUN_16_CJK)
    if (has_cjk)
    {
        lv_obj_set_style_text_font(s_protobuf_label, &lv_font_simsun_16_cjk, 0);
    }
#endif

    lv_label_set_text(s_protobuf_label, render_text);
    lv_obj_align(s_protobuf_label, LV_ALIGN_TOP_LEFT, 0, DISPLAY_VIEW_CONTENT_YOFF);
    protobuf_scroll_ascii_label_bottom_visible();
    lv_obj_invalidate(s_protobuf_label);
    lv_obj_invalidate(s_protobuf_container);

    strncpy(s_last_protobuf_text, render_text, sizeof(s_last_protobuf_text) - 1U);
    s_last_protobuf_text[sizeof(s_last_protobuf_text) - 1U] = '\0';
    s_last_protobuf_text_valid = true;
    display_ui_request_refresh();
    LOG_INF("[RENDER][%s] commit seq=%u raw_len=%u render_len=%u page=%d pattern=%d hidden=%d",
            display_caption_view_target_label(), committed_seq, (unsigned int)strlen(text_content),
            (unsigned int)strlen(render_text), (int)ui_framework_get_active_page(),
            display_caption_view_active_pattern(), (int)lv_obj_has_flag(s_protobuf_label, LV_OBJ_FLAG_HIDDEN));
}

lv_obj_t *display_caption_view_get_container(void)
{
    return s_protobuf_container;
}

lv_obj_t *display_caption_view_get_label(void)
{
    return s_protobuf_label;
}

lv_obj_t *display_caption_view_get_gbk_container(void)
{
    return s_protobuf_gbk_container;
}

lv_obj_t *display_caption_view_get_xy_overlay_container(void)
{
    return s_protobuf_xy_overlay_container;
}
