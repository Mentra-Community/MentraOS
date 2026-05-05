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
#include "caption_state.h"
#include "display_config.h"
#include "display_scene.h"
#include "main.h"
#include "mos_brightness.h"
#include "mos_lvgl_display.h"
#include "protobuf_handler.h"
#include "screen.h"
#include "ui/main_scene.h"
#include "others/test_patterns.h"
#include "others/gbk_test_view.h"
#include "utils/text_diag.h"
#if defined(CONFIG_LVGL)
#include "mos_binfont_lvgl.h"
#endif

LOG_MODULE_REGISTER(mos_lvgl_display, LOG_LEVEL_DBG);

#define TASK_LVGL_NAME "MOS_LVGL"

#define LVGL_THREAD_STACK_SIZE (4096 * 4)
#define LVGL_THREAD_PRIORITY 6
K_THREAD_STACK_DEFINE(lvgl_stack_area, LVGL_THREAD_STACK_SIZE);
static struct k_thread lvgl_thread_data;
k_tid_t lvgl_thread_handle;

static K_SEM_DEFINE(lvgl_display_sem, 0, 1);

#define DISPLAY_CMD_QSZ 16
K_MSGQ_DEFINE(lvgl_display_msgq, sizeof(display_cmd_t), DISPLAY_CMD_QSZ, 4);

#define LVGL_TICK_MS 5

static volatile bool display_onoff = false;

static mos_ui_main_scene_t g_main_scene;

#if defined(CONFIG_LVGL)
static void restore_welcome_screen_state(void);
static void update_welcome_label_with_battery(void);
static void ensure_pattern4_scene_ready(void);
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

static void apply_font_update_in_lvgl_thread(const lv_font_t *new_font)
{
    if (new_font == NULL)
    {
        LOG_WRN("new_font is NULL, skipping font update");
        return;
    }

    mos_ui_main_scene_apply_dynamic_font(&g_main_scene, new_font);

    /* CJK per-character pool uses old glyph height for coordinates;
     * full-text relayout with the new font is required to avoid overlap artifacts. */
    mos_ui_main_scene_invalidate_caption_cache();

    bool welcome_mode = mos_ui_main_scene_is_welcome_mode(&g_main_scene);

    if (welcome_mode)
    {
        update_welcome_label_with_battery();
        mos_ui_main_scene_show_welcome(&g_main_scene);
    }
    else if (mos_ui_main_scene_caption_is_ready(&g_main_scene))
    {
        mos_ui_main_scene_rerender_caption(&g_main_scene);
    }

    if (welcome_mode)
    {
        mos_ui_main_scene_relayout_welcome(&g_main_scene);
    }

    if (mos_ui_main_scene_caption_is_ready(&g_main_scene))
    {
        mos_ui_main_scene_relayout_caption(&g_main_scene);
        mos_ui_main_scene_set_caption_scroll_enabled(&g_main_scene, !welcome_mode);
        if (!welcome_mode)
        {
            mos_ui_main_scene_scroll_caption_to_bottom(&g_main_scene);
        }
    }

    mos_screen_invalidate_full();
    LOG_INF("Font update complete");
}
#endif

static volatile bool lvgl_force_one_refresh = false;
static uint32_t lvgl_min_refresh_ms = 10;
static volatile bool lvgl_freeze_refresh = false;

#define PROTOBUF_TEXT_MAX_CHARS CAPTION_TEXT_MAX_CHARS
#define PROTOBUF_TEXT_THROTTLE_MS 250U

/* Throttle validation counters (printed once per second during traffic). */
static uint32_t s_pt_stats_window_start_ms = 0U;
static uint32_t s_pt_rx_count = 0U;
static uint32_t s_pt_commit_count = 0U;
static uint32_t s_pt_throttle_skip_count = 0U;
static uint32_t s_pt_dedup_skip_count = 0U;
static uint32_t s_caption_render_last_skip_log_ms = 0U;
static uint32_t s_caption_last_apply_ms = 0U;

#define WELCOME_BATTERY_REFRESH_MS (60 * 1000)
static struct k_work_delayable welcome_battery_work;
static void welcome_battery_work_handler(struct k_work *work);
static void protobuf_text_log_throttle_stats_if_due(void);

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
void lvgl_display_sem_give(void)
{
    mos_sem_give(&lvgl_display_sem);
}

int lvgl_display_sem_take(int64_t time)
{
    return mos_sem_take(&lvgl_display_sem, time);
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

/* Thread-safe: return to welcome screen (e.g. after BLE disconnect).
 * 线程安全：回到欢迎界面（如 BLE 断开后）。 */
void display_show_welcome_screen(void)
{
    display_cmd_t cmd = {.type = LCD_CMD_SHOW_WELCOME_SCREEN};
    int ret = mos_msgq_send(&lvgl_display_msgq, &cmd, 100);
    if (ret != 0)
    {
        LOG_WRN("Failed to enqueue welcome screen command (error: %d)", ret);
    }
}

void display_reset_protobuf_text_state(void)
{
    caption_state_reset();
    s_caption_last_apply_ms = 0U;
    mos_ui_main_scene_reset_caption_cache();
    LOG_INF("Reset protobuf text state (pending + de-dup cache cleared)");
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

/* Thread-safe pattern cycling: send message to LVGL thread.
 * 线程安全图案切换：发消息到 LVGL 线程。 */
void display_cycle_pattern(void)
{
    display_cmd_t cmd = {
        .type = LCD_CMD_CYCLE_PATTERN, .p.pattern = {.pattern_id = 0} /* Determined by LVGL thread / 由 LVGL 线程决定 */
    };
    mos_msgq_send(&lvgl_display_msgq, &cmd, MOS_OS_WAIT_FOREVER);
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

    s_pt_rx_count++;
    protobuf_text_log_throttle_stats_if_due();
    mos_text_diag_log_payload(text_content);

    caption_state_ingest(text_content);
}

void display_submit_text_payload(uint16_t x, uint16_t y, const char *text_content, uint16_t font_size, uint32_t color)
{
    if (display_scene_get_mode() == DISPLAY_SCENE_MODE_POSITIONED)
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

void display_show_gbk_test(void)
{
    display_cmd_t cmd = {.type = LCD_CMD_GBK_TEST};
    int ret = mos_msgq_send(&lvgl_display_msgq, &cmd, 0);
    if (ret != 0)
    {
        LOG_WRN("Failed to send GBK test message to display queue (error: %d)", ret);
    }
}

void display_show_gbk_chars_test(void)
{
    display_cmd_t cmd = {.type = LCD_CMD_GBK_CHARS_TEST};
    int ret = mos_msgq_send(&lvgl_display_msgq, &cmd, 0);
    if (ret != 0)
    {
        LOG_WRN("Failed to send GBK chars test message to display queue (error: %d)", ret);
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

void display_send_frame(void *data_ptr)
{
    // display_cmd_t cmd = {.type = LCD_CMD_DATA, .param = data_ptr};
    // mos_msgq_send(&lvgl_display_msgq, &cmd, MOS_OS_WAIT_FOREVER);
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

#if defined(CONFIG_LVGL)
/* Welcome-screen state reset: hide caption content, show the shared welcome container,
 * restore scene mode. Separate from text refresh on purpose. */
static void restore_welcome_screen_state(void)
{
    ensure_pattern4_scene_ready();
    mos_ui_main_scene_show_welcome(&g_main_scene);
    display_scene_set_mode(DISPLAY_SCENE_MODE_WELCOME);
}
#endif

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
    display_scene_set_mode(DISPLAY_SCENE_MODE_WELCOME);

    k_work_init_delayable(&welcome_battery_work, welcome_battery_work_handler);
    k_work_schedule(&welcome_battery_work, K_MSEC(WELCOME_BATTERY_REFRESH_MS));

    LOG_INF("main_scene created: %dx%d", config->layout.usable_width, config->layout.usable_height);
}



static int current_pattern = 4; /* Pattern 4 is the live welcome/caption scene. */
static const int num_patterns = 5;

/* 获取当前图案 ID 供条件逻辑使用 / Get current pattern ID for conditional logic */
int display_get_current_pattern(void)
{
    return display_scene_get_pattern();
}

bool display_is_welcome_screen_active(void)
{
    return display_scene_is_welcome_active();
}

/* lv_obj_del-ing children dangles every cached lv_obj_t* in this file; main_scene_destroy
 * tears its views and clears the dynamic-font registry it owns. */
static void tear_down_screen_child_global_refs(void)
{
    k_work_cancel_delayable(&welcome_battery_work);
    mos_ui_main_scene_destroy(&g_main_scene);
    memset(&g_main_scene, 0, sizeof(g_main_scene));
    mos_ui_gbk_test_destroy();
    display_scene_set_mode(DISPLAY_SCENE_MODE_TEST);
}

static void ensure_pattern4_scene_ready(void)
{
    if (mos_ui_main_scene_welcome_is_ready(&g_main_scene))
    {
        return;
    }

    LOG_INF("Recreating Pattern 4 scene after clear/reset");
    show_test_pattern(4);
}

static void reset_display_text_caches(void)
{
    caption_state_reset();
    s_caption_last_apply_ms = 0U;
    mos_ui_main_scene_reset_caption_cache();
}

static void clear_current_display_text(void)
{
    /* ClearDisplay only wipes content from the currently-active container;
     * the container itself is preserved. */
    reset_display_text_caches();
    mos_ui_main_scene_clear_active(&g_main_scene);
    mos_ui_gbk_test_clear();

    mos_screen_invalidate_full();
    lvgl_force_one_refresh = true;
}

static void show_test_pattern(int pattern_id)
{
    /* LVGL-thread only — no locking needed. */
    mos_screen_clear_children();
    tear_down_screen_child_global_refs();
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

    current_pattern = pattern_id;
    display_scene_set_pattern(pattern_id);
    switch (pattern_id)
    {
        case 4:
            display_scene_set_mode(DISPLAY_SCENE_MODE_WELCOME);
            break;
        default:
            display_scene_set_mode(DISPLAY_SCENE_MODE_TEST);
            break;
    }
}

/** Mark only the active pattern's root container(s) dirty — used after driver-only param
 * changes (e.g. software depth) to refresh the current frame without a full screen flush. */
static void invalidate_current_visible_ui(void)
{
    switch (current_pattern)
    {
        case 4:
            if (mos_ui_main_scene_welcome_is_visible(&g_main_scene))
            {
                mos_ui_main_scene_invalidate_welcome(&g_main_scene);
            }
            mos_ui_main_scene_invalidate_caption(&g_main_scene);
            break;
        default:
            /* Patterns 0–3: dynamic children sit directly on screen; mark each dirty. */
            mos_screen_invalidate_children();
            break;
    }
}

void cycle_test_pattern(void)
{
    /* 防抖：避免快速切换导致冲突 / SAFETY: Prevent rapid cycling that could cause conflicts */
    static int64_t last_cycle_time = 0;
    int64_t current_time = k_uptime_get();

    if (current_time - last_cycle_time < 1000)
    { /* 1 秒防抖 / 1 second debounce */
        return;
    }
    last_cycle_time = current_time;

    current_pattern = (current_pattern + 1) % num_patterns;
    LOG_INF("Pattern #%d", current_pattern); /* 简要日志 / Minimal log */
    show_test_pattern(current_pattern);
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

    /* height 1 = top (zero margin), height 8 = bottom (max margin) */
    float mt_f = (float)total_available_margin * ((float)(height - 1) / 7.0f);
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

    LOG_INF("Applied margin_top=%u (height=%u)", tmp.layout.margin_top, height);
}


/* Try to commit the latest pending protobuf text. Returns true if a commit was performed
 * (committed != necessarily rendered). When throttled, drops the commit; the caller will retry. */
static bool protobuf_text_try_commit_pending(char *latest_text, size_t latest_text_size,
                                             bool schedule_retry_if_throttled)
{
    uint32_t pending_arrival_ms = 0U;
    uint32_t pending_seq = 0U;
    bool has_pending = caption_state_peek_latest(latest_text, latest_text_size, &pending_arrival_ms, &pending_seq);
    if (!has_pending)
    {
        return false;
    }

    uint32_t now_ms = k_uptime_get_32();
    uint32_t elapsed_ms = now_ms - s_caption_last_apply_ms;
    uint32_t age_ms = now_ms - pending_arrival_ms;
    bool throttle_ready = !s_caption_last_apply_ms
                          || (elapsed_ms >= PROTOBUF_TEXT_THROTTLE_MS && age_ms >= PROTOBUF_TEXT_THROTTLE_MS);

    if (throttle_ready)
    {
        if (!caption_state_take_latest(latest_text, latest_text_size, &pending_seq))
        {
            return false;
        }

        if (mos_ui_main_scene_caption_dedup_match(latest_text))
        {
            s_pt_dedup_skip_count++;
            return false;
        }

        mos_ui_main_scene_render_caption_text(&g_main_scene, latest_text, pending_seq);
        s_pt_commit_count++;
        s_caption_last_apply_ms = k_uptime_get_32();
        return true;
    }

    s_pt_throttle_skip_count++;
    if ((now_ms - s_caption_render_last_skip_log_ms) >= 500U)
    {
        s_caption_render_last_skip_log_ms = now_ms;
        LOG_INF("[RENDER][CAPTION] throttle seq=%u elapsed=%u age=%u", pending_seq, elapsed_ms, age_ms);
    }
    ARG_UNUSED(schedule_retry_if_throttled);
    return false;
}

static void protobuf_text_log_throttle_stats_if_due(void)
{
    uint32_t now_ms = k_uptime_get_32();
    if (s_pt_stats_window_start_ms == 0U)
    {
        s_pt_stats_window_start_ms = now_ms;
        return;
    }

    uint32_t elapsed_ms = now_ms - s_pt_stats_window_start_ms;
    if (elapsed_ms < 1000U)
    {
        return;
    }

    // LOG_INF("[PT150] rx/s=%u commit/s=%u throttle_skip/s=%u dedup_skip/s=%u window=%ums", s_pt_rx_count,
    //         s_pt_commit_count, s_pt_throttle_skip_count, s_pt_dedup_skip_count, elapsed_ms);

    s_pt_stats_window_start_ms = now_ms;
    s_pt_rx_count = 0U;
    s_pt_commit_count = 0U;
    s_pt_throttle_skip_count = 0U;
    s_pt_dedup_skip_count = 0U;
}

static bool protobuf_text_service_pending(void)
{
    static char latest_text[PROTOBUF_TEXT_MAX_CHARS];
    bool committed;
    uint32_t now_ms = k_uptime_get_32();
    uint32_t pending_arrival_ms = 0U;
    uint32_t pending_seq = 0U;

    if (!display_scene_allows_caption_render())
    {
        if (caption_state_peek_latest(latest_text, sizeof(latest_text), &pending_arrival_ms, &pending_seq)
            && ((now_ms - s_caption_render_last_skip_log_ms) >= 1000U))
        {
            s_caption_render_last_skip_log_ms = now_ms;
            LOG_INF("[RENDER][CAPTION] blocked seq=%u scene=%d pattern=%d", pending_seq,
                    (int)display_scene_get_mode(), display_scene_get_pattern());
        }
        return false;
    }

    committed = protobuf_text_try_commit_pending(latest_text, sizeof(latest_text), false);
    protobuf_text_log_throttle_stats_if_due();
    return committed;
}

/* Refresh welcome label text with the current battery (60s cadence). LVGL thread only.
 * Skips when the scene isn't in welcome mode so we don't overwrite BLE/transcription content. */
static void update_welcome_label_with_battery(void)
{
    if (!mos_ui_main_scene_is_welcome_mode(&g_main_scene) || !display_scene_is_welcome_active())
    {
        return;
    }

    ensure_pattern4_scene_ready();

    if (!mos_ui_main_scene_welcome_is_ready(&g_main_scene))
    {
        return;
    }

    mos_ui_main_scene_clear_positioned(&g_main_scene);
    mos_ui_main_scene_refresh_welcome_text(&g_main_scene, font_to_be_used());
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

/* Test paths set heavier refresh + thread priority to keep the shell responsive while rendering. */
static void apply_gbk_test_loop_settings(void)
{
    display_scene_set_mode(DISPLAY_SCENE_MODE_TEST);
    k_work_cancel_delayable(&welcome_battery_work);

    lvgl_min_refresh_ms = 200;
    lvgl_force_one_refresh = true;
    lvgl_freeze_refresh = true;

    if (lvgl_thread_handle != NULL)
    {
        k_thread_priority_set(lvgl_thread_handle, LVGL_THREAD_PRIORITY + 4);
    }
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
    display_scene_reset();
    caption_state_reset();

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
                case LCD_CMD_INIT:
                    // state_type = LCD_STATE_OFF;
                    break;
                case LCD_CMD_OPEN:
                    display_open_panel(30);
                    state_type = LCD_STATE_ON;
                    break;
                case LCD_CMD_DATA:
                    break;
                case LCD_CMD_CYCLE_PATTERN:
                    /* 在 LVGL 线程内安全处理图案切换 / Handle pattern cycling safely in LVGL thread */
                    LOG_INF("LCD_CMD_CYCLE_PATTERN - Thread-safe pattern cycling");
                    cycle_test_pattern(); /* 现由 LVGL 线程上下文调用 / Now called from LVGL thread context */
                    break;
                case LCD_CMD_UPDATE_HEIGHT:
                    /* 在 LVGL 线程内安全处理高度更新 / Handle height updates safely in LVGL thread */
                    LOG_INF("LCD_CMD_UPDATE_HEIGHT - Thread-safe height update: %u", cmd.p.height.height);
                    update_display_height(cmd.p.height.height);
                    break;
                case LCD_CMD_UPDATE_PROTOBUF_TEXT:
                {
                    /* Compatibility wake-up: real caption servicing now happens in the main LVGL loop. */
                    protobuf_text_service_pending();
                    protobuf_text_log_throttle_stats_if_due();
                    break;
                }
                case LCD_CMD_UPDATE_POSITIONED_TEXT:
                    display_scene_set_mode(DISPLAY_SCENE_MODE_POSITIONED);
                    mos_ui_main_scene_render_positioned_text(&g_main_scene,
                                                              cmd.p.positioned_text.x,
                                                              cmd.p.positioned_text.y,
                                                              cmd.p.positioned_text.text,
                                                              cmd.p.positioned_text.color);
                    lvgl_freeze_refresh = false;
                    lvgl_force_one_refresh = true;
                    lvgl_min_refresh_ms = 100;
                    break;
                case LCD_CMD_GBK_TEST:
                    apply_gbk_test_loop_settings();
                    mos_ui_gbk_test_show_text();
                    break;
                case LCD_CMD_GBK_CHARS_TEST:
                    apply_gbk_test_loop_settings();
                    mos_ui_gbk_test_show_chars();
                    break;
                case LCD_CMD_UPDATE_WELCOME_BATTERY:
                    /* 用当前电量刷新欢迎标签（60s 周期）/ Refresh welcome label with current battery (60s period) */
                    update_welcome_label_with_battery();
                    break;
                case LCD_CMD_SHOW_WELCOME_SCREEN:
                    /* Re-enter the welcome view (e.g. after BLE disconnect). restore_welcome_screen_state
                     * calls show_welcome which flips the scene's welcome_mode flag, so the subsequent
                     * battery refresh will run. */
                    display_scene_set_mode(DISPLAY_SCENE_MODE_WELCOME);
                    reset_display_text_caches();
                    restore_welcome_screen_state();
                    update_welcome_label_with_battery();
                    LOG_INF("📱 Welcome screen shown (BLE disconnected)");
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
                    LOG_INF("LCD_CMD_UPDATE_DYNAMIC_FONT - Applying font update in LVGL thread");
                    apply_font_update_in_lvgl_thread(cmd.p.font_update.font_ptr);
                    break;
                case LCD_CMD_INVALIDATE_FULL_SCREEN:
                    lvgl_force_one_refresh = true;
                    mos_screen_invalidate_full();
                    break;
                case LCD_CMD_INVALIDATE_VISIBLE_UI:
                    lvgl_force_one_refresh = true;
                    invalidate_current_visible_ui();
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
