#include "caption_renderer.h"

#include <errno.h>
#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <lvgl.h>

#include "caption_throttler.h"
#include "display_config.h"
#include "utils/utf8.h"

#if defined(CONFIG_LVGL)
#include "mos_binfont_lvgl.h"
#endif
#if defined(CONFIG_LV_FONT_SIMSUN_16_CJK)
LV_FONT_DECLARE(lv_font_simsun_16_cjk);
#endif

LOG_MODULE_REGISTER(caption_renderer, LOG_LEVEL_DBG);

#define CAPTION_RENDER_MAX_CHARS CAPTION_TEXT_MAX_CHARS

/* Prevent frequent deinit/reload caused by missing-glyph probes (reduces sporadic stutter). */
#define CJK_PROBE_RELOAD_COOLDOWN_MS 5000U
static uint32_t s_last_cjk_probe_reload_ms = 0U;

static display_biz_lang_t s_biz_src_lang = DISPLAY_BIZ_LANG_ZH;
static display_biz_lang_t s_biz_dst_lang = DISPLAY_BIZ_LANG_EN;

int mos_ui_caption_renderer_set_translation_pair(display_biz_lang_t src, display_biz_lang_t dst)
{
    if (src == DISPLAY_BIZ_LANG_UNKNOWN || dst == DISPLAY_BIZ_LANG_UNKNOWN)
    {
        return -EINVAL;
    }
    s_biz_src_lang = src;
    s_biz_dst_lang = dst;
    LOG_INF("Business translation pair updated: src=%u dst=%u", (unsigned int)src, (unsigned int)dst);
    return 0;
}

void mos_ui_caption_renderer_get_translation_pair(display_biz_lang_t *src, display_biz_lang_t *dst)
{
    if (src != NULL) *src = s_biz_src_lang;
    if (dst != NULL) *dst = s_biz_dst_lang;
}

static void prepare_for_render(const char *text_content, char *out, size_t out_size)
{
    if (out == NULL || out_size == 0U) return;

    if (text_content == NULL)
    {
        out[0] = '\0';
        return;
    }

    /* Mirror the latest full text snapshot from the app as-is.
     * No line-tail or content-window trimming should happen here. */
    strncpy(out, text_content, out_size - 1U);
    out[out_size - 1U] = '\0';
}

static const lv_font_t *active_font(void)
{
#if defined(CONFIG_LVGL)
    const lv_font_t *font = mos_binfont_get_lvgl_font();
    if (font != NULL && mos_binfont_is_initialized())
    {
        return font;
    }
#endif
    return display_get_font("secondary");
}

#if defined(CONFIG_LVGL)
static void force_binfont_to_english(void)
{
    if (mos_binfont_get_current_language() == MOS_FONT_LANG_EN_US)
    {
        return;
    }

    mos_font_size_t target_size = mos_font_get_current_size();
    if (target_size == 0U)
    {
        target_size = MOS_FONT_SIZE_18;
    }
    int rc = mos_font_switch_language(MOS_FONT_LANG_EN_US, target_size);
    if (rc != 0)
    {
        LOG_WRN("Force binfont to EN failed (lang=%u size=%u): %d",
                (unsigned int)MOS_FONT_LANG_EN_US, (unsigned int)target_size, rc);
    }
}
#endif

static void render_cjk_path(mos_ui_main_scene_t *scene, const char *render_text, bool has_cjk)
{
    mos_font_language_t preferred_lang = MOS_FONT_LANG_EN_US;
    if (s_biz_src_lang == DISPLAY_BIZ_LANG_ZH || s_biz_dst_lang == DISPLAY_BIZ_LANG_ZH || has_cjk)
    {
        preferred_lang = MOS_FONT_LANG_ZH_CN;
    }
    if (mos_binfont_get_current_language() != preferred_lang)
    {
        mos_font_size_t target_size =
            (preferred_lang == MOS_FONT_LANG_ZH_CN) ? MOS_FONT_SIZE_18 : mos_font_get_current_size();
        int rc = mos_font_switch_language(preferred_lang, target_size);
        if (rc == 0)
        {
            LOG_INF("Auto-switch binfont to lang=%u size=%u for multilingual text",
                    (unsigned int)preferred_lang, (unsigned int)target_size);
        }
        else
        {
            LOG_WRN("Auto-switch binfont failed (lang=%u size=%u): %d",
                    (unsigned int)preferred_lang, (unsigned int)target_size, rc);
        }
    }

    const lv_font_t *font_cjk = display_get_font("gbk");
    const display_config_t *display_cfg = display_get_config();
    const lv_font_t *font_fallback = (display_cfg != NULL) ? display_cfg->fonts.secondary : NULL;

    if (font_cjk != NULL)
    {
        lv_font_glyph_dsc_t probe_dsc;
        bool has_ascii_A = lv_font_get_glyph_dsc(font_cjk, &probe_dsc, (uint32_t)'A', 0);
        bool has_ascii_q = lv_font_get_glyph_dsc(font_cjk, &probe_dsc, (uint32_t)'?', 0);
        LOG_DBG("CJK render: binfont lang=%u size=%u has_ascii_A=%d has_ascii_?=%d @%p",
                (unsigned int)mos_binfont_get_current_language(), (unsigned int)mos_binfont_get_current_size(),
                (int)has_ascii_A, (int)has_ascii_q, (void *)font_cjk);
    }

    if (font_cjk != NULL && has_cjk)
    {
        uint32_t probe_code = 0;
        lv_font_glyph_dsc_t probe_dsc;
        if (utf8_first_non_ascii_codepoint(render_text, &probe_code)
            && !lv_font_get_glyph_dsc(font_cjk, &probe_dsc, probe_code, 0))
        {
#if defined(CONFIG_LV_FONT_SIMSUN_16_CJK)
            LOG_WRN("CJK probe miss U+%04X on gbk font @%p, skip reload (simsun fallback enabled)",
                    (unsigned int)probe_code, (void *)font_cjk);
#else
            uint32_t now_ms = k_uptime_get_32();
            if ((now_ms - s_last_cjk_probe_reload_ms) >= CJK_PROBE_RELOAD_COOLDOWN_MS)
            {
                s_last_cjk_probe_reload_ms = now_ms;
                LOG_WRN("CJK probe miss U+%04X on current gbk font @%p, reloading binfont (cooldown %u ms)",
                        (unsigned int)probe_code, (void *)font_cjk, (unsigned int)CJK_PROBE_RELOAD_COOLDOWN_MS);
                mos_binfont_lvgl_deinit();
                font_cjk = mos_binfont_get_lvgl_font();
                if (font_cjk != NULL)
                {
                    if (lv_font_get_glyph_dsc(font_cjk, &probe_dsc, probe_code, 0))
                    {
                        LOG_INF("CJK probe recovered after binfont reload, U+%04X", (unsigned int)probe_code);
                    }
                    else
                    {
                        LOG_WRN("CJK probe still missing after reload, U+%04X", (unsigned int)probe_code);
                    }
                }
            }
            else
            {
                LOG_WRN("CJK probe miss U+%04X, skip reload due to cooldown", (unsigned int)probe_code);
            }
#endif
        }
    }

    mos_ui_main_scene_show_caption_custom(scene, render_text,
                                           font_cjk, font_fallback,
                                           display_get_text_color());
}

static void render_default_path(mos_ui_main_scene_t *scene, const char *render_text, bool has_cjk)
{
    const lv_font_t *font = active_font();

#if defined(CONFIG_LVGL)
    bool ascii_only = utf8_is_ascii_only(render_text);
    if (ascii_only)
    {
        bool need_builtin_fallback = true;
        const lv_font_t *active_binfont = mos_binfont_get_lvgl_font();
        if (active_binfont != NULL && mos_binfont_is_initialized())
        {
            lv_font_glyph_dsc_t probe_dsc;
            if (lv_font_get_glyph_dsc(active_binfont, &probe_dsc, (uint32_t)'?', 0)
                || lv_font_get_glyph_dsc(active_binfont, &probe_dsc, (uint32_t)'A', 0))
            {
                need_builtin_fallback = false;
            }
        }
        if (need_builtin_fallback)
        {
            const display_config_t *display_cfg = display_get_config();
            if (display_cfg != NULL && display_cfg->fonts.secondary != NULL)
            {
                font = display_cfg->fonts.secondary;
            }
        }
    }
#endif

#if defined(CONFIG_LV_FONT_SIMSUN_16_CJK)
    if (has_cjk)
    {
        font = &lv_font_simsun_16_cjk;
    }
#else
    (void)has_cjk;
#endif

    mos_ui_main_scene_show_caption_default(scene, font, render_text);
}

void mos_ui_caption_renderer_render(mos_ui_main_scene_t *scene,
                                     const char *text,
                                     uint32_t committed_seq)
{
    char render_text[CAPTION_RENDER_MAX_CHARS] = {0};

    if (scene == NULL || text == NULL)
    {
        LOG_ERR("Invalid args (scene=%p text=%p)", (void *)scene, (const void *)text);
        return;
    }

    prepare_for_render(text, render_text, sizeof(render_text));

#if defined(CONFIG_LVGL)
    force_binfont_to_english();
#endif

    bool has_cjk = utf8_contains_cjk(render_text);

    if (0 && has_cjk)
    {
        render_cjk_path(scene, render_text, has_cjk);
    }
    else
    {
        render_default_path(scene, render_text, has_cjk);
    }

    LOG_INF("[RENDER][CAPTION] commit seq=%u raw_len=%u render_len=%u mode=%d has_cjk=%d",
            committed_seq, (unsigned int)strlen(text), (unsigned int)strlen(render_text),
            (int)mos_ui_main_scene_get_mode(), (int)has_cjk);
}
