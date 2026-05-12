#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/display.h>
#include <zephyr/kernel.h>

#include "lvgl_display.h"
// #include <lvgl.h>
#include <display/lcd/a6n.h>
#include <zephyr/logging/log.h>

#include "bal_os.h"
#include "mos_display_caption_throttler.h"
#include "mos_display_config.h"
#include "main.h"
#include "mos_brightness.h"
#include "mos_display.h"
#include "protobuf_handler.h"
#include "utils/mos_display_screen_utils.h"
#include "ui/mos_display_main_scene.h"
#include "test_ui/mos_display_test_scenes.h"
#include "utils/mos_display_text_diag.h"
#if defined(CONFIG_LVGL)
#include "mos_binfont_lvgl.h"
#endif

LOG_MODULE_REGISTER(mos_display, LOG_LEVEL_DBG);

#define TASK_LVGL_NAME "MOS_LVGL"

#define LVGL_THREAD_STACK_SIZE (4096 * 4)
#define LVGL_THREAD_PRIORITY 6
K_THREAD_STACK_DEFINE(lvgl_stack_area, LVGL_THREAD_STACK_SIZE);
static struct k_thread lvgl_thread_data;
k_tid_t lvgl_thread_handle;

#define DISPLAY_CMD_QSZ 16
K_MSGQ_DEFINE(lvgl_display_msgq, sizeof(display_cmd_t), DISPLAY_CMD_QSZ, 4);

#define LVGL_TICK_MS 5

static volatile bool display_onoff = false;

static mos_ui_main_scene_t g_main_scene;

#if defined(CONFIG_LVGL)
static void update_welcome_label_with_battery(void);
static void reset_display_text_caches(void);
static void clear_current_display_text(void);

/* Welcome/BLE text share the same top margin within Pattern 4. */
#define PROTOBUF_BLE_LABEL_YOFF 0

/* Font-switch callback.
 * Note: may run in shell thread; LVGL API must run on the LVGL thread, so post a command. */
static void on_font_changed(const lv_font_t *new_font)
{
    LOG_INF("Font changed callback called, sending update to LVGL thread");
    display_cmd_t cmd = {.type = LCD_CMD_UPDATE_DYNAMIC_FONT, .p.font_update = {.font_ptr = new_font}};
    mos_msgq_send(&lvgl_display_msgq, &cmd, MOS_OS_WAIT_FOREVER);
}
#endif

static volatile bool lvgl_force_one_refresh = false;
static uint32_t lvgl_min_refresh_ms = 10;
static volatile bool lvgl_freeze_refresh = false;

/* Suppress repeated "blocked" logs when the scene is gating caption render. */
static uint32_t s_caption_blocked_log_ms = 0U;

#define WELCOME_BATTERY_REFRESH_MS (60 * 1000)
static struct k_work_delayable welcome_battery_work;
static void welcome_battery_work_handler(struct k_work *work);

/* Display on/off state management. */
void set_display_onoff(bool state)
{
    display_onoff = state;
}
bool get_display_onoff(void)
{
    return display_onoff;
}

int display_set_translation_pair(display_biz_lang_t src_lang, display_biz_lang_t dst_lang)
{
    return mos_ui_main_scene_set_translation_pair(src_lang, dst_lang);
}

void display_get_translation_pair(display_biz_lang_t *src_lang, display_biz_lang_t *dst_lang)
{
    mos_ui_main_scene_get_translation_pair(src_lang, dst_lang);
}

void display_open(void)
{
    // display_cmd_t cmd = {.type = LCD_CMD_OPEN, .param = NULL};
    display_cmd_t cmd = {.type = LCD_CMD_OPEN, .p.open = {.brightness = 9, .mirror = 0x08}};
    mos_msgq_send(&lvgl_display_msgq, &cmd, MOS_OS_WAIT_FOREVER);
}

void display_close(void)
{
    // display_cmd_t cmd = {.type = LCD_CMD_CLOSE, .param = NULL};
    // mos_msgq_sendsplay_msgq, &cmd, MOS_OS_WAIT_FOREVER);
}

void display_request_welcome_battery_refresh(void)
{
    display_cmd_t cmd = {.type = LCD_CMD_UPDATE_WELCOME_BATTERY};
    (void)mos_msgq_send(&lvgl_display_msgq, &cmd, (int64_t)50); /* 50 ms non-blocking / 50 ms 非阻塞 */
}

/* On BT connect: clear any stale caption ingest/dedup state so the next phone-side update
 * paints unconditionally, even if it matches whatever was last shown before the previous
 * disconnect. Thread-safe; runs synchronously on the calling thread. */
void display_handle_bt_connected(void)
{
    mos_caption_throttler_reset();
    s_caption_blocked_log_ms = 0U;
    LOG_INF("BT connected — caption ingest state reset");
}

/* On BT disconnect: emit the event for the LVGL thread; the dispatch handler decides
 * what UI follows (currently: reset caption ingest, return to welcome, refresh battery). */
void display_handle_bt_disconnected(void)
{
    display_cmd_t cmd = {.type = LCD_CMD_BT_DISCONNECTED};
    int ret = mos_msgq_send(&lvgl_display_msgq, &cmd, 100);
    if (ret != 0)
    {
        LOG_WRN("Failed to enqueue BT_DISCONNECTED event (error: %d)", ret);
    }
}

/* Thread-safe: update DFU progress bar on welcome screen (below battery).
 * 线程安全：更新欢迎界面 DFU 进度条（电量下方）。 */
void display_update_dfu_progress(uint8_t show, uint8_t percent)
{
    display_cmd_t cmd = {.type = LCD_CMD_UPDATE_DFU_PROGRESS, .p.dfu_progress = {.show = show, .percent = percent}};
    (void)mos_msgq_send(&lvgl_display_msgq, &cmd, (int64_t)50);
}

/* Thread-safe: update DFU status line below battery (e.g. "DFU Updating... 45%"); empty/NULL hides it.
 * 线程安全：更新电量下方一行 DFU 状态文字；text 为空或 NULL 则隐藏。 */
void display_update_dfu_status_text(const char *text)
{
    display_cmd_t cmd = {.type = LCD_CMD_UPDATE_DFU_STATUS_TEXT};
    if (text != NULL)
    {
        strncpy(cmd.p.protobuf_text.text, text, MAX_TEXT_LEN);
        cmd.p.protobuf_text.text[MAX_TEXT_LEN] = '\0';
    }
    else
    {
        cmd.p.protobuf_text.text[0] = '\0';
    }
    (void)mos_msgq_send(&lvgl_display_msgq, &cmd, (int64_t)50);
}

void display_update_height(uint16_t height)
{
    display_cmd_t cmd = {.type = LCD_CMD_UPDATE_HEIGHT, .p.height = {.height = height}};
    mos_msgq_send(&lvgl_display_msgq, &cmd, MOS_OS_WAIT_FOREVER);
}


/* Thread-safe protobuf text update: state-only ingest, LVGL thread pulls later.
 * 线程安全 protobuf 文本更新：仅写入状态，由 LVGL 线程稍后主动拉取。 */
void display_update_protobuf_text(const char *text_content)
{
    if (!text_content)
    {
        LOG_ERR("Invalid text content pointer");
        return;
    }

    mos_text_diag_log_payload(text_content);
    mos_caption_throttler_ingest(text_content);
}

void display_submit_text_payload(uint16_t x, uint16_t y, const char *text_content, uint16_t font_size, uint32_t color)
{
    if (mos_ui_main_scene_get_mode() == MOS_UI_MAIN_SCENE_MODE_POSITIONED)
    {
        uint32_t y_offset = (uint32_t)y + 80U;
        uint16_t y_clamped = (y_offset > 65535U) ? 65535U : (uint16_t)y_offset;
        uint16_t effective_font_size = (font_size > 0U) ? font_size : 12U;

        display_update_positioned_text(x, y_clamped, text_content, effective_font_size, color);
        return;
    }

    display_update_protobuf_text(text_content);
}

void display_submit_scrolling_text_payload(const char *text_content)
{
    display_update_protobuf_text(text_content);
}

/* Thread-safe positioned text rendering: enqueue for the LVGL thread to draw on the caption overlay. */
void display_update_positioned_text(uint16_t x, uint16_t y, const char *text_content, uint16_t font_size, uint32_t color)
{
    if (!text_content)
    {
        LOG_ERR("Invalid text content pointer for positioned text");
        return;
    }

    LOG_INF("Enqueue positioned text pos=(%u,%u) size=%u: %s", x, y, font_size, text_content);

    display_cmd_t cmd = {.type = LCD_CMD_UPDATE_POSITIONED_TEXT,
                         .p.positioned_text = {
                             .x = x, .y = y, .font_size = font_size, .color = color, .text = {0}
                         }};

    size_t text_len = strlen(text_content);
    if (text_len > MAX_TEXT_LEN)
    {
        text_len = MAX_TEXT_LEN;
        LOG_WRN("Positioned text truncated to %d chars", MAX_TEXT_LEN);
    }

    strncpy(cmd.p.positioned_text.text, text_content, text_len);
    cmd.p.positioned_text.text[text_len] = '\0';

    /* 0 timeout — non-blocking, LVGL processes asynchronously. */
    int ret = mos_msgq_send(&lvgl_display_msgq, &cmd, 0);
    if (ret != 0)
    {
        LOG_WRN("Failed to send positioned text message to display queue (error: %d)", ret);
    }
}

void display_clear_screen(void)
{
    display_cmd_t cmd = {.type = LCD_CMD_CLEAR_DISPLAY};
    mos_msgq_send(&lvgl_display_msgq, &cmd, MOS_OS_WAIT_FOREVER);
}

void display_request_full_redraw(void)
{
    display_cmd_t cmd = {.type = LCD_CMD_INVALIDATE_FULL_SCREEN};
    (void)mos_msgq_send(&lvgl_display_msgq, &cmd, MOS_OS_WAIT_FOREVER);
}

void display_request_visible_redraw(void)
{
    display_cmd_t cmd = {.type = LCD_CMD_INVALIDATE_VISIBLE_UI};
    (void)mos_msgq_send(&lvgl_display_msgq, &cmd, MOS_OS_WAIT_FOREVER);
}

void display_set_debug_borders(bool enabled)
{
    display_cmd_t cmd = {
        .type = LCD_CMD_SET_DEBUG_BORDERS,
        .p.debug_borders = {.enabled = enabled},
    };
    (void)mos_msgq_send(&lvgl_display_msgq, &cmd, MOS_OS_WAIT_FOREVER);
}

bool display_get_debug_borders(void)
{
    return mos_ui_main_scene_debug_borders_enabled();
}

/****************************************************/
/* 前向声明 / Forward declarations */
static void show_test_pattern(int pattern_id);

static void show_default_ui(void)
{
    LOG_INF("🖼️ Starting with scrolling 'Welcome to MentraOS NExFirmware!' text...");
    LOG_INF("🖼️ show_default_ui() called, pattern will be set to 4");

    /* 从图案 3（滚动欢迎文案）开始，进阶文本动画 / Start with pattern 3 (scrolling welcome text) - advanced text
     * animation */
    show_test_pattern(4);

    LOG_INF("🖼️ Scrolling welcome message complete - should see animated text");
}

static const lv_font_t *font_to_be_used(void)
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

static void create_scrolling_text_container(lv_obj_t *screen)
{
    const display_config_t *config = display_get_config();

    mos_ui_main_scene_cfg_t cfg = {
        .x = config->layout.margin_left,
        .y = config->layout.margin_top,
        .width = config->layout.usable_width,
        .height = config->layout.usable_height,
        .padding = config->layout.padding,
        .bg_color = display_get_background_color(),
        .text_color = display_get_text_color(),
        .font = font_to_be_used(),
        .line_spacing = config->fonts.line_spacing,
        .label_y_offset = PROTOBUF_BLE_LABEL_YOFF,
        .dfu_font = display_get_font("secondary"),
        .dfu_bar_bg_color = display_get_background_color(),
        .dfu_bar_fill_color = display_get_text_color(),
    };

    g_main_scene = mos_ui_main_scene_create(screen, &cfg);

    k_work_init_delayable(&welcome_battery_work, welcome_battery_work_handler);
    k_work_schedule(&welcome_battery_work, K_MSEC(WELCOME_BATTERY_REFRESH_MS));

    LOG_INF("main_scene created: %dx%d", config->layout.usable_width, config->layout.usable_height);
}



bool display_is_welcome_screen_active(void)
{
    return mos_ui_main_scene_is_welcome_mode();
}

/* lv_obj_del-ing children dangles every cached lv_obj_t* in this file; main_scene_destroy
 * tears its views and clears the dynamic-font registry it owns. */
static void tear_down_screen_child_global_refs(void)
{
    k_work_cancel_delayable(&welcome_battery_work);
    mos_ui_main_scene_destroy(&g_main_scene);
    memset(&g_main_scene, 0, sizeof(g_main_scene));
}

static void reset_display_text_caches(void)
{
    mos_caption_throttler_reset();
    s_caption_blocked_log_ms = 0U;
}

static void clear_current_display_text(void)
{
    /* ClearDisplay only wipes content from the currently-active container;
     * the container itself is preserved. */
    reset_display_text_caches();
    mos_ui_main_scene_clear_active(&g_main_scene);
    mos_screen_invalidate_full();
    lvgl_force_one_refresh = true;
}

static void show_test_pattern(int pattern_id)
{
    /* LVGL-thread only — no locking needed. Tear down the main scene FIRST so its destructor
     * runs against live objects; only then clear any remaining screen children (e.g. leftover
     * test-pattern objects from a previous SHOW_PATTERN). The reverse order would have
     * mos_screen_clear_children() free welcome/caption containers, leaving g_main_scene
     * holding dangling pointers that the destroy path then lv_obj_del's again. */
    tear_down_screen_child_global_refs();
    mos_screen_clear_children();
    mos_screen_set_background(display_get_background_color());

    lv_obj_t *screen = mos_screen_get_root();
    switch (pattern_id)
    {
        case 0:
        {
            const display_config_t *config = display_get_config();
            mos_ui_test_pattern_create_chess(screen, config->patterns.chess_square_size, config->width, config->height);
            break;
        }
        case 1:
        {
            const display_config_t *config = display_get_config();
            mos_ui_test_pattern_create_horizontal_zebra(screen, config->patterns.bar_thickness, config->width);
            break;
        }
        case 2:
        {
            const display_config_t *config = display_get_config();
            mos_ui_test_pattern_create_vertical_zebra(screen, config->patterns.bar_thickness, config->height);
            break;
        }
        case 3:
            mos_ui_test_pattern_create_center_rectangle(screen, font_to_be_used());
            break;
        case 4:
            create_scrolling_text_container(screen);
            break;
        default:
            LOG_ERR("❌ Unknown pattern ID: %d", pattern_id);
            return;
    }
}

/** Mark only the active pattern's root container(s) dirty — used after driver-only param
 * changes (e.g. software depth) to refresh the current frame without a full screen flush. */
static void invalidate_current_visible_ui(void)
{
    if (mos_ui_main_scene_get_mode() != MOS_UI_MAIN_SCENE_MODE_NONE)
    {
        if (mos_ui_main_scene_welcome_is_visible(&g_main_scene))
        {
            mos_ui_main_scene_invalidate_welcome(&g_main_scene);
        }
        mos_ui_main_scene_invalidate_caption(&g_main_scene);
    }
    else
    {
        /* Test patterns 0–3: dynamic children sit directly on screen; mark each dirty. */
        mos_screen_invalidate_children();
    }
}

static void update_display_height(uint16_t height)
{
    if (height > 8)
        height = 8;

    LOG_INF("update_display_height - Thread-safe height update: %u", height);

    if (!mos_ui_main_scene_welcome_is_ready(&g_main_scene)
        && !mos_ui_main_scene_caption_is_ready(&g_main_scene))
    {
        LOG_WRN("Pattern 4 containers not initialized");
        return;
    }

    const display_config_t *config = display_get_config();
    display_config_t tmp = *config;

    uint32_t total_available_margin = config->height - config->layout.usable_height;

    /* height 8 = top (zero margin), height 1 = bottom (max margin) */
    float mt_f = (float)total_available_margin * ((float)(8 - height) / 7.0f);
    uint32_t mt = (uint32_t)(mt_f + 0.5f);

    if (mt > UINT16_MAX)
        mt = UINT16_MAX;
    tmp.layout.margin_top = (uint16_t)mt;

    /* Keep container fully visible: margin_top + usable_height <= screen height */
    if ((uint32_t)tmp.layout.margin_top + (uint32_t)tmp.layout.usable_height > (uint32_t)tmp.height)
    {
        tmp.layout.margin_top = (tmp.height > tmp.layout.usable_height) ? (tmp.height - tmp.layout.usable_height) : 0;
    }

    display_set_margin_top(tmp.layout.margin_top);
    mos_ui_main_scene_apply_height_config(&g_main_scene, mos_screen_get_root(), &tmp);

    /* lv_obj_set_pos invalidates the container's old/new bbox, but child labels can render
     * past that bbox (multi-line text, descenders), and on a partial-buffer mono panel any
     * overflow pixels at the old position stay in the controller's framebuffer. Force a
     * full screen redraw so the entire affected region is repainted. */
    mos_screen_invalidate_full();
    lvgl_force_one_refresh = true;

    LOG_INF("Applied margin_top=%u (height=%u)", tmp.layout.margin_top, height);
}


/* Throttler render hook: invoked once when a pending text passes the throttle/dedup gate. */
static void caption_render_callback(const char *text, uint32_t seq, void *user_data)
{
    mos_ui_main_scene_render_caption_text((mos_ui_main_scene_t *)user_data, text, seq);
}

/* LVGL-thread tick: respect the scene-level gate (test patterns, etc.), then ask the
 * throttler to commit any pending text. Returns true if a render actually happened. */
static bool protobuf_text_service_pending(void)
{
    if (!mos_ui_main_scene_can_render_caption())
    {
        uint32_t pending_seq = 0U;
        uint32_t now_ms = k_uptime_get_32();
        if (mos_caption_throttler_has_pending(NULL, 0, &pending_seq)
            && ((now_ms - s_caption_blocked_log_ms) >= 1000U))
        {
            s_caption_blocked_log_ms = now_ms;
            LOG_INF("[RENDER][CAPTION] blocked seq=%u mode=%d",
                    pending_seq, (int)mos_ui_main_scene_get_mode());
        }
        return false;
    }

    bool committed = mos_caption_throttler_service(caption_render_callback, &g_main_scene);
    mos_caption_throttler_log_stats_if_due();
    return committed;
}

/* Battery-tick refresh of the welcome label. LVGL thread only.
 * The scene method skips itself when not in welcome mode, so no overwrite of caption/BLE text. */
static void update_welcome_label_with_battery(void)
{
    mos_ui_main_scene_refresh_welcome_active(&g_main_scene, font_to_be_used());
}

static void welcome_battery_work_handler(struct k_work *work)
{
    display_cmd_t cmd = {.type = LCD_CMD_UPDATE_WELCOME_BATTERY};
    mos_msgq_send(&lvgl_display_msgq, &cmd,
                  (int64_t)100); /* 100 ms 超时；bal_os 使用 int64_t ms / 100 ms timeout; bal_os uses int64_t ms */
    k_work_schedule((struct k_work_delayable *)work, K_MSEC(3));
}

/* Power up the panel, run vendor bring-up, set initial brightness, clear stale framebuffer,
 * open the display, then load the default UI. Brightness is set before clear/open so the
 * first visible frame already has the user-facing level applied. */
static void display_open_panel(uint8_t brightness_pct)
{
    a6n_power_on();
    set_display_onoff(true);
    a6n_apply_vendor_init_sequence();
    mos_brightness_request_manual(brightness_pct);
    mos_delay_ms(2);
    a6n_clear_screen(false);
    mos_delay_ms(20);
    a6n_open_display();
    show_default_ui();
}

void lvgl_dispaly_init(void *p1, void *p2, void *p3)
{
    const struct device *display_dev;
    display_dev = DEVICE_DT_GET(DT_CHOSEN(zephyr_display));
    if (!device_is_ready(display_dev))
    {
        LOG_INF("display_dev Device not ready, aborting test");
        return;
    }

    /* 初始化模块化显示配置系统 / Initialize modular display configuration system */
    int config_result = display_config_init();
    if (config_result != 0)
    {
        LOG_ERR("Failed to initialize display configuration: %d", config_result);
        return;
    }

#if defined(CONFIG_LVGL)
    /* 注册字体切换回调 / Register font change callback */
    mos_font_register_change_callback(on_font_changed);
#endif
    mos_caption_throttler_reset();

    const display_config_t *config = display_get_config();
    LOG_INF("🖼️ Display configuration loaded: %s (%dx%d)", config->name, config->width, config->height);
    if (a6n_init_sem_take() != 0) /* 等待屏幕 SPI 初始化完成 / Wait for screen SPI init complete */
    {
        LOG_ERR("Failed to a6n_init_sem_take err");
        return;
    }
    static uint32_t last_refresh_ms;
    display_state_t state_type = LCD_STATE_INIT;
    display_cmd_t cmd;
    display_open();
    while (1)
    {
        bool need_refresh = false;
        /* 到预算了，允许本轮刷一次 / When budgeted, allow one refresh this round */
        if (state_type == LCD_STATE_ON && ((k_uptime_get_32() - last_refresh_ms) >= lvgl_min_refresh_ms))
        {
            need_refresh = true;
        }

        /* 处理消息（仍给其它任务时间）/ Handle message (still give other tasks time) */
        int err = mos_msgq_receive(&lvgl_display_msgq, &cmd, LVGL_TICK_MS);
        if (err == 0)
        {
            /* 连续多条 BLE 文案时只保留最后一条再重绘，避免 clean→画→clean→画 导致闪一下消失再出现 */
        reenter_switch:
            switch (cmd.type)
            {
                case LCD_CMD_OPEN:
                    display_open_panel(30);
                    state_type = LCD_STATE_ON;
                    break;
                case LCD_CMD_UPDATE_HEIGHT:
                    /* 在 LVGL 线程内安全处理高度更新 / Handle height updates safely in LVGL thread */
                    LOG_INF("LCD_CMD_UPDATE_HEIGHT - Thread-safe height update: %u", cmd.p.height.height);
                    update_display_height(cmd.p.height.height);
                    break;
                case LCD_CMD_UPDATE_POSITIONED_TEXT:
                    mos_ui_main_scene_render_positioned_text(&g_main_scene,
                                                              cmd.p.positioned_text.x,
                                                              cmd.p.positioned_text.y,
                                                              cmd.p.positioned_text.text,
                                                              cmd.p.positioned_text.color);
                    lvgl_freeze_refresh = false;
                    lvgl_force_one_refresh = true;
                    lvgl_min_refresh_ms = 100;
                    break;
                case LCD_CMD_UPDATE_WELCOME_BATTERY:
                    /* 用当前电量刷新欢迎标签（60s 周期）/ Refresh welcome label with current battery (60s period) */
                    update_welcome_label_with_battery();
                    break;
                case LCD_CMD_BT_DISCONNECTED:
                    /* Discard any pending caption ingest, swap back to the welcome scene, and
                     * refresh the battery line so the user sees current state on reconnect. */
                    reset_display_text_caches();
                    mos_ui_main_scene_show_welcome(&g_main_scene);
                    update_welcome_label_with_battery();
                    LOG_INF("BT disconnected → welcome scene restored");
                    break;
                case LCD_CMD_UPDATE_DFU_PROGRESS:
                    mos_ui_main_scene_update_dfu_progress(&g_main_scene,
                                                           cmd.p.dfu_progress.show,
                                                           cmd.p.dfu_progress.percent);
                    break;
                case LCD_CMD_UPDATE_DFU_STATUS_TEXT:
                    mos_ui_main_scene_update_dfu_status(&g_main_scene, cmd.p.protobuf_text.text);
                    break;
                case LCD_CMD_CLEAR_DISPLAY:
                    clear_current_display_text();
                    break;
                case LCD_CMD_CLOSE:
                    if (get_display_onoff())
                    {
                        /* a6n_clear_screen(false); / lv_timer_handler();
                         * scroll_text_stop(); set_display_onoff(false); a6n_power_off(); */
                    }
                    state_type = LCD_STATE_OFF;
                    break;
                case LCD_CMD_SHOW_PATTERN:
                    LOG_INF("LCD_CMD_SHOW_PATTERN - Showing pattern %d", cmd.p.pattern.pattern_id);
                    show_test_pattern(cmd.p.pattern.pattern_id);
                    break;
                case LCD_CMD_UPDATE_DYNAMIC_FONT:
                    mos_ui_main_scene_handle_font_changed(&g_main_scene, cmd.p.font_update.font_ptr);
                    break;
                case LCD_CMD_INVALIDATE_FULL_SCREEN:
                    lvgl_force_one_refresh = true;
                    mos_screen_invalidate_full();
                    break;
                case LCD_CMD_INVALIDATE_VISIBLE_UI:
                    lvgl_force_one_refresh = true;
                    invalidate_current_visible_ui();
                    break;
                case LCD_CMD_SET_DEBUG_BORDERS:
                    mos_ui_main_scene_set_debug_borders(cmd.p.debug_borders.enabled);
                    mos_ui_main_scene_apply_debug_borders(&g_main_scene, mos_screen_get_root());
                    lvgl_force_one_refresh = true;
                    break;
                default:
                    break;
            }
            if (state_type == LCD_STATE_ON)
                need_refresh = true;
        }
        if (state_type == LCD_STATE_ON)
        {
            if (protobuf_text_service_pending())
            {
                need_refresh = true;
            }
        }
        // 如果需要刷新，则调用 lv_timer_handler 刷新，判断条件为：屏幕开启且需要刷新，或者强制刷新
        // Refresh if needed: screen is on and either refresh is due or forced
        if (state_type == LCD_STATE_ON && (need_refresh || lvgl_force_one_refresh))
        {
            if (!lvgl_freeze_refresh || lvgl_force_one_refresh)
            {
                lv_timer_handler(); /* 每轮只刷一次 / Only refresh once per round */

                last_refresh_ms = k_uptime_get_32();
                lvgl_force_one_refresh = false;
            }
        }
    }
}

void lvgl_display_thread(void)
{
    /* 启动 LVGL 专用线程 / Start LVGL dedicated thread */
    lvgl_thread_handle = k_thread_create(&lvgl_thread_data, lvgl_stack_area, K_THREAD_STACK_SIZEOF(lvgl_stack_area),
                                         lvgl_dispaly_init, NULL, NULL, NULL, LVGL_THREAD_PRIORITY, 0, K_NO_WAIT);
    k_thread_name_set(lvgl_thread_handle, TASK_LVGL_NAME);
}
