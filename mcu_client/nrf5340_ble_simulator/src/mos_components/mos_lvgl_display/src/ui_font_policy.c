#include "ui_font_policy.h"

#include "ui_framework.h"

#include <zephyr/logging/log.h>

#include "mos_binfont_lvgl.h"
#include "mos_font_storage.h"

LOG_MODULE_REGISTER(ui_font_policy, LOG_LEVEL_INF);

static mos_font_language_t mos_lang_from_ui_lang(ui_lang_t lang)
{
    switch (lang)
    { 
        case UI_LANG_ZH:
            return MOS_FONT_LANG_ZH_CN;
        case UI_LANG_KO:
        case UI_LANG_JA:
        case UI_LANG_EN:
        default:
            return MOS_FONT_LANG_EN_US;
    }
}
void ui_font_policy_apply_runtime_language(void)
{
    ui_lang_t ui_lang = ui_framework_get_language();
    mos_font_language_t target_lang = mos_lang_from_ui_lang(ui_lang);

    if (target_lang == mos_binfont_get_current_language())
    {
        return;
    }

    mos_font_size_t target_size = mos_font_get_current_size();
    if (target_size == 0U)
    {
        target_size = MOS_FONT_SIZE_18;
    }

    if (mos_font_switch_language(target_lang, target_size) != 0)
    {
        LOG_WRN("Failed to switch runtime language to %u", (unsigned int)target_lang);
    }
}

void ui_font_policy_apply_content_language(display_biz_lang_t src_lang, display_biz_lang_t dst_lang, bool has_cjk)
{
    (void)src_lang;
    (void)dst_lang;

    mos_font_language_t target_lang = has_cjk ? MOS_FONT_LANG_ZH_CN : MOS_FONT_LANG_EN_US;

    if (target_lang == mos_binfont_get_current_language())
    {
        return;
    }

    mos_font_size_t target_size = mos_font_get_current_size();
    if (target_size == 0U || target_lang == MOS_FONT_LANG_ZH_CN)
    {
        target_size = MOS_FONT_SIZE_18;
    }

    if (mos_font_switch_language(target_lang, target_size) != 0)
    {
        LOG_WRN("Failed to switch content language to %u", (unsigned int)target_lang);
    }
}

bool ui_font_policy_use_chinese_copy(void)
{
    return ui_framework_get_language() == UI_LANG_ZH;
}
