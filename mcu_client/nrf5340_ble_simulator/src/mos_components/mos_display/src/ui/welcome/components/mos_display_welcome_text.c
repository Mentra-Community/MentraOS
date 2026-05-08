#include "mos_display_welcome_text.h"

#include <stdio.h>
#include <zephyr/logging/log.h>
#include <lvgl.h>

#include "main.h"
#include "protobuf_handler.h"
#if defined(CONFIG_LVGL)
#include "mos_binfont_lvgl.h"
#include "mos_font_storage.h"  /* MOS_FONT_LANG_ZH_CN */
#endif

LOG_MODULE_REGISTER(welcome_text, LOG_LEVEL_DBG);

#define WELCOME_TEXT_BUF_SIZE 160

static const char *get_ble_icon(void)
{
#ifdef LV_SYMBOL_BLUETOOTH
    if (!get_ble_connected_status())
    {
        return LV_SYMBOL_BLUETOOTH;
    }
#endif
    return "";
}

static const char *get_battery_icon(uint32_t pct, bool charging)
{
#ifdef LV_SYMBOL_CHARGE
    if (charging)
    {
        return LV_SYMBOL_CHARGE;
    }
#endif
#ifdef LV_SYMBOL_BATTERY_FULL
    if (pct >= 90)
    {
        return LV_SYMBOL_BATTERY_FULL;
    }
#endif
#ifdef LV_SYMBOL_BATTERY_2
    if (pct >= 50)
    {
        return LV_SYMBOL_BATTERY_2;
    }
#endif
#ifdef LV_SYMBOL_BATTERY_1
    if (pct >= 25)
    {
        return LV_SYMBOL_BATTERY_1;
    }
#endif
#ifdef LV_SYMBOL_BATTERY_EMPTY
    return LV_SYMBOL_BATTERY_EMPTY;
#endif
    return "";
}

static void build_welcome_text(char *buf, size_t buflen)
{
    const char *device_name = get_ble_device_name();
    uint32_t battery_pct = protobuf_get_battery_level();
    bool charging = protobuf_get_charging_state();
    const char *ble_icon = get_ble_icon();
    const char *battery_icon = get_battery_icon(battery_pct, charging);

#if defined(CONFIG_LVGL)
    if (mos_binfont_get_current_language() == MOS_FONT_LANG_ZH_CN)
    {
        snprintf(buf, buflen,
                 "\xe6\xac\xa2\xe8\xbf\x8e\xe4\xbd\xbf\xe7\x94\xa8 MentraOS\n"
                 "Build V1.2.3 %s %s\n"
                 "\xe7\xad\x89\xe5\xbe\x85\xe8\xbf\x9e\xe6\x8e\xa5\n"
                 "\xe8\xae\xbe\xe5\xa4\x87: %s %s\n"
                 "\xe7\x94\xb5\xe9\x87\x8f: %s %u%%",
                 __DATE__, __TIME__, ble_icon, device_name, battery_icon, (unsigned int)battery_pct);
        return;
    }
#endif

    snprintf(buf, buflen,
             "Welcome to MentraOS\n"
             "Build V1.2.3 %s %s\n"
             "Waiting for connection\n"
             "Device: %s %s\n"
             "Battery: %s %u%%",
             __DATE__, __TIME__, ble_icon, device_name, battery_icon, (unsigned int)battery_pct);
}

lv_obj_t *mos_ui_welcome_text_create(lv_obj_t *container, const mos_ui_welcome_text_cfg_t *cfg)
{
    if (!container || !cfg)
    {
        LOG_ERR("welcome_text: invalid args");
        return NULL;
    }

    lv_obj_t *label = lv_label_create(container);
    lv_obj_set_width(label, cfg->width - cfg->padding * 2);
    lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_LEFT, 0);
    lv_obj_set_style_text_color(label, cfg->text_color, 0);
    lv_obj_set_style_text_line_space(label, cfg->line_spacing, 0);

    if (cfg->font)
    {
        lv_obj_set_style_text_font(label, cfg->font, 0);
    }

    char text[WELCOME_TEXT_BUF_SIZE];
    build_welcome_text(text, sizeof(text));
    lv_label_set_text(label, text);

    lv_obj_align(label, LV_ALIGN_TOP_LEFT, 0, 0);
    lv_obj_update_layout(label);

    LOG_DBG("welcome_text created @%p", (void *)label);
    return label;
}

void mos_ui_welcome_text_update(lv_obj_t *label, const lv_font_t *font, const char *text)
{
    if (!label || !text)
    {
        return;
    }

    if (font)
    {
        lv_obj_set_style_text_font(label, font, 0);
    }

    lv_label_set_text(label, text);
}

void mos_ui_welcome_text_refresh(lv_obj_t *label, const lv_font_t *font)
{
    if (!label)
    {
        return;
    }
    if (font)
    {
        lv_obj_set_style_text_font(label, font, 0);
    }
    char text[WELCOME_TEXT_BUF_SIZE];
    build_welcome_text(text, sizeof(text));
    lv_label_set_text(label, text);
}
