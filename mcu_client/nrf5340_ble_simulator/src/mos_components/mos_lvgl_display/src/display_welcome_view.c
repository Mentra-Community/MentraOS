#include "display_welcome_view.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>

#include <zephyr/logging/log.h>

#include "display_config.h"
#include "display_view_support.h"
#include "ui_font_policy.h"
#include "ui_runtime.h"
#include "main.h"
#include "protobuf_handler.h"

#include "mos_binfont_lvgl.h"
#include "mos_font_storage.h"

LOG_MODULE_REGISTER(display_welcome_view, LOG_LEVEL_INF);

typedef struct
{
    lv_obj_t *welcome_container;
    lv_obj_t *welcome_label;
    lv_obj_t *dfu_status_label;
    lv_obj_t *dfu_progress_bar;
    lv_obj_t *dfu_progress_fill;
    lv_coord_t dfu_progress_bar_w;
    bool welcome_active;
    bool welcome_initializing;
    char last_welcome_text[160];
    bool last_welcome_text_valid;
} display_welcome_view_state_t;

static display_welcome_view_state_t s_welcome_state_legacy = {0};
static display_welcome_view_state_t *s_welcome_state = &s_welcome_state_legacy;

#define s_welcome_container     (s_welcome_state->welcome_container)
#define s_welcome_label         (s_welcome_state->welcome_label)
#define s_dfu_status_label      (s_welcome_state->dfu_status_label)
#define s_dfu_progress_bar      (s_welcome_state->dfu_progress_bar)
#define s_dfu_progress_fill     (s_welcome_state->dfu_progress_fill)
#define s_dfu_progress_bar_w    (s_welcome_state->dfu_progress_bar_w)
#define s_welcome_active        (s_welcome_state->welcome_active)
#define s_welcome_initializing  (s_welcome_state->welcome_initializing)
#define s_last_welcome_text     (s_welcome_state->last_welcome_text)
#define s_last_welcome_text_valid (s_welcome_state->last_welcome_text_valid)

size_t display_welcome_view_state_size(void)
{
    return sizeof(display_welcome_view_state_t);
}

int display_welcome_view_state_init(void *state, void *context)
{
    ARG_UNUSED(context);
    if (state == NULL)
    {
        return -EINVAL;
    }
    memset(state, 0, sizeof(display_welcome_view_state_t));
    s_welcome_state = (display_welcome_view_state_t *)state;
    return 0;
}

int display_welcome_view_state_deinit(void *state, void *context)
{
    ARG_UNUSED(context);
    if (state == NULL)
    {
        return -EINVAL;
    }
    memset(state, 0, sizeof(display_welcome_view_state_t));
    if (s_welcome_state == (display_welcome_view_state_t *)state)
    {
        s_welcome_state = &s_welcome_state_legacy;
        memset(s_welcome_state, 0, sizeof(display_welcome_view_state_t));
    }
    return 0;
}

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

static void build_welcome_screen_text(char *buf, size_t buflen, const display_config_t *config)
{
    const char *device_name = get_ble_device_name();
    uint32_t battery_pct = protobuf_get_battery_level();
    bool charging = protobuf_get_charging_state();

    const char *ble_icon = get_ble_icon();
    const char *battery_icon = get_battery_icon(battery_pct, charging);

    if (config->width >= 500)
    {
        snprintf(buf, buflen,
                 "Welcome to MentraOS\n"
                 "Build V1.2.3 %s %s\n"
                 "Waiting for connection\n"
                 "Device Name: %s %s\n"
                 "Battery: %s %u%%",
                 __DATE__, __TIME__, ble_icon, device_name, battery_icon, (unsigned int)battery_pct);
    }
    else
    {
        snprintf(buf, buflen,
                 "Welcome to MentraOS\n"
                 "Build V1.2.3 %s %s\n"
                 "Waiting for connection\n"
                 "Device: %s %s\n"
                 "Battery: %s %u%%",
                 __DATE__, __TIME__, ble_icon, device_name, battery_icon, (unsigned int)battery_pct);
    }
}
static void welcome_apply_preferred_font(lv_obj_t *label)
{
    if (label == NULL)
    {
        return;
    }

    /* Keep welcome font in sync with runtime UI language before selecting active binfont. */
    ui_font_policy_apply_runtime_language();

    const lv_font_t *use = mos_binfont_get_lvgl_font();
    const uint8_t cur_lang = mos_binfont_get_current_language();
    const uint8_t cur_pt = mos_binfont_get_current_size();

    if (use == NULL || !mos_binfont_is_initialized())
    {
        use = display_get_font("secondary");
        LOG_WRN("Welcome: binfont lang=%u pt=%u not ready, using built-in secondary @%p",
                cur_lang, cur_pt, (void *)use);
    }

    if (use != NULL)
    {
        lv_obj_set_style_text_font(label, use, 0);
    }
}

void display_welcome_view_reset_state(void)
{
    s_welcome_container = NULL;
    s_welcome_label = NULL;
    s_dfu_status_label = NULL;
    s_dfu_progress_bar = NULL;
    s_dfu_progress_fill = NULL;
    s_dfu_progress_bar_w = 0;
    s_welcome_active = false;
    s_welcome_initializing = false;
    s_last_welcome_text_valid = false;
    s_last_welcome_text[0] = '\0';
}

void display_welcome_view_reset_text_cache(void)
{
    s_last_welcome_text_valid = false;
    s_last_welcome_text[0] = '\0';
}

void display_welcome_view_detach(void)
{
    s_welcome_container = NULL;
    s_welcome_label = NULL;
    s_dfu_status_label = NULL;
    s_dfu_progress_bar = NULL;
    s_dfu_progress_fill = NULL;
    s_dfu_progress_bar_w = 0;
    s_welcome_active = false;
    s_welcome_initializing = false;
}

void display_welcome_view_ensure(lv_obj_t *screen)
{
    const display_config_t *config;
    char display_text[160] = {0};
    const char *initial_text;

    if (s_welcome_container != NULL && s_welcome_label != NULL)
    {
        return;
    }

    if (screen == NULL)
    {
        return;
    }

    config = display_get_config();
    if (config == NULL)
    {
        LOG_ERR("Failed to get display config");
        return;
    }

    s_welcome_container = lv_obj_create(screen);
    display_apply_container_config(s_welcome_container, screen, config);
    lv_obj_set_scroll_dir(s_welcome_container, LV_DIR_NONE);
    lv_obj_set_scrollbar_mode(s_welcome_container, LV_SCROLLBAR_MODE_OFF);
    lv_obj_set_style_bg_color(s_welcome_container, display_get_background_color(), 0);
    lv_obj_set_style_bg_opa(s_welcome_container, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(s_welcome_container, 0, 0);
    lv_obj_set_style_border_opa(s_welcome_container, LV_OPA_TRANSP, 0);

    s_welcome_label = lv_label_create(s_welcome_container);
    lv_obj_set_width(s_welcome_label, config->layout.usable_width - (config->layout.padding * 2));
    lv_label_set_long_mode(s_welcome_label, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_align(s_welcome_label, LV_TEXT_ALIGN_LEFT, 0);

    s_welcome_initializing = true;

    welcome_apply_preferred_font(s_welcome_label);

    build_welcome_screen_text(display_text, sizeof(display_text), config);
    initial_text = display_text;

    lv_obj_set_style_text_color(s_welcome_label, display_get_text_color(), 0);
    lv_obj_set_style_text_line_space(s_welcome_label, config->fonts.line_spacing, 0);
    lv_label_set_text(s_welcome_label, initial_text);
    lv_obj_update_layout(s_welcome_label);
    lv_obj_align(s_welcome_label, LV_ALIGN_TOP_LEFT, 0, DISPLAY_VIEW_CONTENT_YOFF);
    lv_obj_clear_flag(s_welcome_label, LV_OBJ_FLAG_HIDDEN);
    display_ui_register_dynamic_label(s_welcome_label);

    s_dfu_status_label = lv_label_create(s_welcome_container);
    lv_label_set_text(s_dfu_status_label, "");
    lv_obj_set_width(s_dfu_status_label, config->layout.usable_width - (config->layout.padding * 2));
    lv_obj_set_style_text_font(s_dfu_status_label, display_get_font("secondary"), 0);
    lv_obj_set_style_text_color(s_dfu_status_label, display_get_text_color(), 0);
    lv_obj_set_style_text_align(s_dfu_status_label, LV_TEXT_ALIGN_LEFT, 0);
    lv_obj_align_to(s_dfu_status_label, s_welcome_label, LV_ALIGN_OUT_BOTTOM_LEFT, 0, 4);
    lv_obj_add_flag(s_dfu_status_label, LV_OBJ_FLAG_HIDDEN);
    display_ui_register_dynamic_label(s_dfu_status_label);

    s_dfu_progress_bar_w = (lv_coord_t)(config->layout.usable_width / 2);
    s_dfu_progress_bar = lv_obj_create(s_welcome_container);
    lv_obj_set_size(s_dfu_progress_bar, s_dfu_progress_bar_w, 12);
    lv_obj_align_to(s_dfu_progress_bar, s_dfu_status_label, LV_ALIGN_OUT_BOTTOM_MID, 0, 4);
    lv_obj_set_style_bg_color(s_dfu_progress_bar, display_get_background_color(), 0);
    lv_obj_set_style_bg_opa(s_dfu_progress_bar, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(s_dfu_progress_bar, 0, 0);
    lv_obj_set_style_radius(s_dfu_progress_bar, 4, 0);
    lv_obj_set_style_pad_all(s_dfu_progress_bar, 0, 0);

    s_dfu_progress_fill = lv_obj_create(s_dfu_progress_bar);
    lv_obj_set_size(s_dfu_progress_fill, 0, 12);
    lv_obj_align(s_dfu_progress_fill, LV_ALIGN_LEFT_MID, 0, 0);
    lv_obj_set_style_bg_color(s_dfu_progress_fill, display_get_text_color(), 0);
    lv_obj_set_style_bg_opa(s_dfu_progress_fill, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(s_dfu_progress_fill, 0, 0);
    lv_obj_set_style_radius(s_dfu_progress_fill, 4, 0);
    lv_obj_set_style_pad_all(s_dfu_progress_fill, 0, 0);
    lv_obj_add_flag(s_dfu_progress_bar, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(s_dfu_progress_fill, LV_OBJ_FLAG_HIDDEN);

    lv_obj_update_layout(s_welcome_container);
    s_welcome_active = true;
    s_welcome_initializing = false;
}

void display_welcome_view_restore(lv_obj_t *screen)
{
    display_welcome_view_ensure(screen);

    if (s_welcome_container != NULL)
    {
        lv_obj_clear_flag(s_welcome_container, LV_OBJ_FLAG_HIDDEN);
        lv_obj_invalidate(s_welcome_container);
    }

    if (s_welcome_label != NULL)
    {
        lv_obj_clear_flag(s_welcome_label, LV_OBJ_FLAG_HIDDEN);
        lv_obj_align(s_welcome_label, LV_ALIGN_TOP_LEFT, 0, DISPLAY_VIEW_CONTENT_YOFF);
    }

    s_welcome_active = true;
}

void display_welcome_view_update_battery(void)
{
    const display_config_t *config;
    static char welcome_buf[160];

    if (!s_welcome_active || !ui_runtime_page_is_active(UI_PAGE_WELCOME) || s_welcome_initializing)
    {
        return;
    }

    display_welcome_view_ensure(lv_screen_active());

    if (s_welcome_label == NULL)
    {
        return;
    }

    config = display_get_config();

    welcome_apply_preferred_font(s_welcome_label);
    build_welcome_screen_text(welcome_buf, sizeof(welcome_buf), config);

    if (s_last_welcome_text_valid && strncmp(s_last_welcome_text, welcome_buf, sizeof(s_last_welcome_text)) == 0)
    {
        return;
    }

    lv_label_set_text(s_welcome_label, welcome_buf);
    lv_obj_clear_flag(s_welcome_label, LV_OBJ_FLAG_HIDDEN);
    lv_obj_invalidate(s_welcome_label);

    strncpy(s_last_welcome_text, welcome_buf, sizeof(s_last_welcome_text) - 1U);
    s_last_welcome_text[sizeof(s_last_welcome_text) - 1U] = '\0';
    s_last_welcome_text_valid = true;
    display_ui_request_refresh();
}

void display_welcome_view_clear(void)
{
    if (s_welcome_label != NULL)
    {
        lv_label_set_text(s_welcome_label, "");
        lv_obj_clear_flag(s_welcome_label, LV_OBJ_FLAG_HIDDEN);
    }
    if (s_dfu_status_label != NULL)
    {
        lv_label_set_text(s_dfu_status_label, "");
        lv_obj_add_flag(s_dfu_status_label, LV_OBJ_FLAG_HIDDEN);
    }
    if (s_dfu_progress_fill != NULL)
    {
        lv_obj_set_width(s_dfu_progress_fill, 0);
    }
    if (s_dfu_progress_bar != NULL)
    {
        lv_obj_add_flag(s_dfu_progress_bar, LV_OBJ_FLAG_HIDDEN);
    }
    if (s_welcome_container != NULL)
    {
        lv_obj_invalidate(s_welcome_container);
    }
    display_ui_request_refresh();
}

void display_welcome_view_apply_config(lv_obj_t *screen, const display_config_t *config)
{
    if (s_welcome_container == NULL || screen == NULL || config == NULL)
    {
        return;
    }

    (void)display_apply_container_config(s_welcome_container, screen, config);
    lv_obj_update_layout(s_welcome_container);
}

void display_welcome_view_invalidate_visible(void)
{
    if (s_welcome_container != NULL && !lv_obj_has_flag(s_welcome_container, LV_OBJ_FLAG_HIDDEN))
    {
        lv_obj_invalidate(s_welcome_container);
    }
}

bool display_welcome_view_is_active(void)
{
    return s_welcome_active;
}

void display_welcome_view_set_active(bool active)
{
    s_welcome_active = active;
}

bool display_welcome_view_is_initializing(void)
{
    return s_welcome_initializing;
}

lv_obj_t *display_welcome_view_get_container(void)
{
    return s_welcome_container;
}

lv_obj_t *display_welcome_view_get_label(void)
{
    return s_welcome_label;
}

lv_obj_t *display_welcome_view_get_dfu_status_label(void)
{
    return s_dfu_status_label;
}

lv_obj_t *display_welcome_view_get_dfu_progress_bar(void)
{
    return s_dfu_progress_bar;
}

lv_obj_t *display_welcome_view_get_dfu_progress_fill(void)
{
    return s_dfu_progress_fill;
}

lv_coord_t display_welcome_view_get_dfu_progress_bar_width(void)
{
    return s_dfu_progress_bar_w;
}
