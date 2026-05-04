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
#if defined(CONFIG_LVGL)
#include "mos_binfont_lvgl.h"
#include "mos_font_storage.h"
#endif
#if defined(CONFIG_LV_FONT_SIMSUN_16_CJK)
LV_FONT_DECLARE(lv_font_simsun_16_cjk);
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

/* Must be declared before apply_font_update_in_lvgl_thread within CONFIG_LVGL scope (C visibility).
 * 须在 CONFIG_LVGL 内 apply_font_update_in_lvgl_thread 之前声明（C 可见性）。 */
static lv_obj_t *welcome_container = NULL;
static lv_obj_t *welcome_label = NULL;
static lv_obj_t *protobuf_container = NULL;
static lv_obj_t *protobuf_label = NULL;
static lv_obj_t *protobuf_gbk_container = NULL;
static lv_obj_t *protobuf_xy_overlay_container = NULL;
static bool welcome_screen_active = true;
static bool welcome_screen_initializing = false;
static char last_protobuf_text[CAPTION_TEXT_MAX_CHARS];
static bool last_protobuf_text_valid = false;
static char s_last_welcome_text[160];
static bool s_last_welcome_text_valid = false;

#if defined(CONFIG_LVGL)
/* Dynamic-font label list.
 * 需要使用动态字体的标签列表。 */
static lv_obj_t *s_dynamic_font_labels[16] = {0};
static int s_dynamic_font_label_count = 0;

static void restore_welcome_screen_state(void);
static void update_welcome_label_with_battery(void);
static void update_protobuf_text_content(const char *text_content, uint32_t committed_seq);
static void protobuf_scroll_ascii_label_bottom_visible(void);
static void protobuf_container_set_welcome_scroll(bool welcome_active);
static void ensure_pattern4_scene_ready(void);
static void ensure_protobuf_scene_ready(void);
static void reset_display_text_caches(void);
static void hide_and_clear_protobuf_xy_overlay(void);
static void clear_current_display_text(void);
static void destroy_protobuf_scene(void);

/* Welcome/BLE text share the same top margin within Pattern 4. */
#define PROTOBUF_BLE_LABEL_YOFF 0

/* Copy text before lv_label_set_text.
 * If the input pointer aliases label internal text, LVGL v9 may skip relayout or trigger abnormal redraw.
 * 必须经拷贝再 lv_label_set_text；若传入指针与标签内部文本同源，LVGL v9 可能不刷新布局或引发异常重绘。 */
static void dynamic_label_relayout_text(lv_obj_t *obj)
{
    if (obj == NULL || lv_obj_get_class(obj) != &lv_label_class)
    {
        return;
    }

    const char *txt = lv_label_get_text(obj);
    if (txt == NULL)
    {
        return;
    }

    char buf[MAX_TEXT_LEN + 1];
    strncpy(buf, txt, sizeof(buf) - 1U);
    buf[sizeof(buf) - 1U] = '\0';
    lv_label_set_text(obj, buf);
}

/* Add a label to dynamic-font list.
 * 添加使用动态字体的标签。 */
static void add_dynamic_font_label(lv_obj_t *label)
{
    if (label == NULL || s_dynamic_font_label_count >= 16)
    {
        return;
    }

    /* Check whether it already exists.
     * 检查是否已存在。 */
    for (int i = 0; i < s_dynamic_font_label_count; i++)
    {
        if (s_dynamic_font_labels[i] == label)
        {
            return;
        }
    }

    s_dynamic_font_labels[s_dynamic_font_label_count++] = label;
}

static void remove_dynamic_font_label(lv_obj_t *label)
{
    if (label == NULL)
    {
        return;
    }

    for (int i = 0; i < s_dynamic_font_label_count; i++)
    {
        if (s_dynamic_font_labels[i] == label)
        {
            for (int j = i; j < s_dynamic_font_label_count - 1; j++)
            {
                s_dynamic_font_labels[j] = s_dynamic_font_labels[j + 1];
            }
            s_dynamic_font_labels[s_dynamic_font_label_count - 1] = NULL;
            s_dynamic_font_label_count--;
            return;
        }
    }
}

/* Font-switch callback.
 * 字体切换回调。 */
/* Note: this callback may run in shell thread; do not call LVGL API directly here.
 * 注意：此回调可能在 shell 线程中执行，不能直接调用 LVGL API。 */
static void on_font_changed(const lv_font_t *new_font)
{
    LOG_INF("Font changed callback called, sending update to LVGL thread");

    /* Send a command to LVGL thread so font updates run in the correct context.
     * 发送命令到 LVGL 线程，让其在正确上下文中更新字体。 */
    display_cmd_t cmd = {.type = LCD_CMD_UPDATE_DYNAMIC_FONT, .p.font_update = {.font_ptr = new_font}};
    mos_msgq_send(&lvgl_display_msgq, &cmd, MOS_OS_WAIT_FOREVER);

    LOG_INF("Font update command sent");
}

/* Apply font update in LVGL thread.
 * 在 LVGL 线程中实际执行字体更新。 */
static void apply_font_update_in_lvgl_thread(const lv_font_t *new_font)
{
    LOG_INF("Applying font update in LVGL thread for %d labels", s_dynamic_font_label_count);

    /* Calculate line spacing dynamically: 30% of font height.
     * 根据字体大小动态计算行间距：字体高度的 30%。 */
    if (new_font != NULL)
    {
        lv_coord_t dynamic_line_spacing = (lv_coord_t)(new_font->line_height * 30 / 100);
        LOG_DBG("Font height: %d, calculated line spacing: %d", new_font->line_height, dynamic_line_spacing);
        LOG_DBG("Font pointer: %p, get_glyph_dsc: %p, get_glyph_bitmap: %p", new_font, new_font->get_glyph_dsc,
                new_font->get_glyph_bitmap);

        /* LVGL v9 has no lv_font_set_default; update each label font directly.
         * LVGL v9 中没有 lv_font_set_default，直接对每个标签设置字体。 */

        for (int i = 0; i < s_dynamic_font_label_count; i++)
        {
            if (s_dynamic_font_labels[i] != NULL)
            {
                /* Update label font and line spacing in place, without recreating labels.
                 * 直接更新标签字体和行间距，不删除标签。 */
                lv_obj_set_style_text_font(s_dynamic_font_labels[i], new_font, 0);
                lv_obj_set_style_text_line_space(s_dynamic_font_labels[i], dynamic_line_spacing, 0);

                /* Force text relayout.
                 * 强制重新计算文本布局。 */
                lv_obj_update_layout(s_dynamic_font_labels[i]);

                LOG_DBG("Updated label %d with new font", i);
            }
        }

        /* After font switch, line_height and glyph width change.
         * Re-run wrapping via copied set_text (do not pass lv_label_get_text pointer directly).
         * 换字体后 line_height/字宽已变：经拷贝 set_text 触发 WRAP 重算（勿直接传入 lv_label_get_text 指针）。 */
        for (int i = 0; i < s_dynamic_font_label_count; i++)
        {
            /* welcome_label on welcome screen is handled later by update_welcome_label_with_battery().
             * 欢迎屏的 welcome_label 稍后通过 update_welcome_label_with_battery() 统一处理。 */
            if (welcome_screen_active && s_dynamic_font_labels[i] == welcome_label)
            {
                LOG_DBG("Skipping relayout for welcome_label (welcome screen active)");
                continue;
            }
            dynamic_label_relayout_text(s_dynamic_font_labels[i]);
        }

        /* CJK per-character pool uses old glyph height for coordinates.
         * Full-text relayout with the new font is required to avoid overlap artifacts.
         * CJK 逐字池坐标按旧字高排版；必须整段用新字库重排，否则会重叠错乱。 */
        last_protobuf_text_valid = false;
        if (welcome_screen_active && !welcome_screen_initializing)
        {
            update_welcome_label_with_battery();
            if (protobuf_gbk_container != NULL)
            {
                lv_obj_add_flag(protobuf_gbk_container, LV_OBJ_FLAG_HIDDEN);
            }
            if (welcome_label != NULL)
            {
                lv_obj_clear_flag(welcome_label, LV_OBJ_FLAG_HIDDEN);
            }
        }
        else
        {
            /* Even when last text is empty, relayout is still required.
             * Otherwise old CJK per-char layer may remain visible with stale coordinates.
             * last 为空也必须重跑：否则会保留 CJK 逐字层可见，坐标仍按旧字高，与新分区字模叠在一起。 */
            if (protobuf_container != NULL)
            {
                update_protobuf_text_content(last_protobuf_text, 0U);
            }
        }

        if (welcome_container != NULL && welcome_screen_active)
        {
            lv_obj_update_layout(welcome_container);
        }

        if (protobuf_container != NULL)
        {
            lv_obj_update_layout(protobuf_container);
            if (welcome_screen_active)
            {
                protobuf_container_set_welcome_scroll(true);
            }
            else
            {
                protobuf_container_set_welcome_scroll(false);
                protobuf_scroll_ascii_label_bottom_visible();
            }
        }

        /* Force full-screen redraw so all elements using new font are refreshed.
         * 强制整个屏幕刷新，确保所有使用新字体的内容都被更新。 */
        lv_obj_invalidate(lv_screen_active());

        LOG_DBG("Forced full screen refresh after font update");
    }
    else
    {
        LOG_WRN("new_font is NULL, skipping font update");
    }

    LOG_INF("Font update complete");
}
#endif

/* Global protobuf container references are declared above:
 * protobuf_container / protobuf_label / protobuf_gbk_container / welcome_screen_active / last_protobuf_*.
 * 全局 protobuf 文本容器引用见文件顶部。 */
/* DFU status text (one line below battery).
 * DFU 状态文字（电量下面一行）。 */
static lv_obj_t *dfu_status_label = NULL;
/* DFU progress bar: container (track) + fill rectangle (width by percentage), avoiding lv_bar always-full issue.
 * DFU 进度条：容器（背景条）+ 前景条（按百分比设宽），避免 lv_bar 显示满格问题。 */
static lv_obj_t *dfu_progress_bar = NULL; /* Track background / 背景轨道 */
static lv_obj_t *dfu_progress_fill = NULL; /* Fill foreground, width = percentage / 前景填充，宽度=百分比 */
static lv_coord_t dfu_progress_bar_w = 0; /* Track width for fill calculation / 轨道宽度（用于算填充宽度） */

/* welcome_screen_active 见文件顶部 */
static volatile bool lvgl_force_one_refresh = false; /* Force one refresh on next loop / 强制下一轮刷新一次 */
static uint32_t lvgl_min_refresh_ms = 10;
static volatile bool lvgl_freeze_refresh = false;
#define PROTOBUF_TEXT_MAX_CHARS CAPTION_TEXT_MAX_CHARS
#define PROTOBUF_TEXT_THROTTLE_MS 250U
#define PROTOBUF_TEXT_RENDER_MAX_CHARS 192U
#define PROTOBUF_TEXT_RENDER_MAX_LINES 8U
/* Throttle validation counters (printed once per second during traffic). */
static uint32_t s_pt_stats_window_start_ms = 0U;
static uint32_t s_pt_rx_count = 0U;
static uint32_t s_pt_commit_count = 0U;
static uint32_t s_pt_throttle_skip_count = 0U;
static uint32_t s_pt_dedup_skip_count = 0U;
static uint32_t s_caption_render_last_skip_log_ms = 0U;
static uint32_t s_caption_last_apply_ms = 0U;

#define PROTOBUF_GBK_LABEL_POOL_SIZE 256
static lv_obj_t *s_protobuf_gbk_label_pool[PROTOBUF_GBK_LABEL_POOL_SIZE];
static size_t s_protobuf_gbk_label_pool_used = 0;
/* Prevent frequent deinit/reload caused by missing-glyph probes (reduces sporadic stutter).
 * 防止缺字探测触发频繁 deinit/reload，减少偶发卡顿。 */
#define CJK_PROBE_RELOAD_COOLDOWN_MS 5000U
static uint32_t s_last_cjk_probe_reload_ms = 0U;
/* Business translation language pair (default zh<->en); reusable config entry for future app logic.
 * 业务翻译语种对（默认中英互译）；后续 app 可复用同一配置入口。 */
static display_biz_lang_t s_biz_src_lang = DISPLAY_BIZ_LANG_ZH;
static display_biz_lang_t s_biz_dst_lang = DISPLAY_BIZ_LANG_EN;

/* Pattern 5 XY text positioning area (global references).
 * Pattern 5 XY 文本定位区域（全局引用）。 */
static lv_obj_t *xy_text_container =
    NULL; /* 124x60 visible region for SSD1306 128x64 / 124x60 可视区域（适配 SSD1306 128x64） */
static lv_obj_t *current_xy_text_label = NULL; /* Current positioned text label / 当前定位文本标签 */
static lv_obj_t *gbk_test_label = NULL; /* Simple Chinese test label / 简单中文测试标签 */

#define WELCOME_BATTERY_REFRESH_MS (60 * 1000)
static struct k_work_delayable welcome_battery_work;
/* Forward declaration for k_work_init_delayable.
 * 前向声明，供 k_work_init_delayable 使用。 */
static void welcome_battery_work_handler(struct k_work *work);
/* Forward declaration for protobuf throttle telemetry helper. */
static void protobuf_text_log_throttle_stats_if_due(void);
static void protobuf_text_prepare_for_render(const char *text_content, char *out_text, size_t out_size)
{
    if (out_text == NULL || out_size == 0U)
    {
        return;
    }

    if (text_content == NULL)
    {
        out_text[0] = '\0';
        return;
    }

    /* Mirror the latest full text snapshot from the app as-is.
     * No line-tail or content-window trimming should happen here. */
    strncpy(out_text, text_content, out_size - 1U);
    out_text[out_size - 1U] = '\0';
}

void lv_example_scroll_text(void)
{
    /* Create a label.
     * 创建一个标签。 */
    lv_obj_t *label = lv_label_create(lv_screen_active());

    /* Set scroll mode (automatic horizontal scrolling).
     * 设置滚动模式（自动横向滚动）。 */
    /* lv_label_set_long_mode(label, LV_LABEL_LONG_SCROLL); */
    lv_label_set_long_mode(label, LV_LABEL_LONG_SCROLL_CIRCULAR);

    /* Set label width for SSD1306 visible area (128x64).
     * 设置标签区域宽度（SSD1306 可视区域 128x64）。 */
    lv_obj_set_width(label, 128); /* SSD1306 display width (was 640) / SSD1306 显示宽度（原640） */

    /* Set label position for SSD1306 128x64.
     * 设置标签位置（SSD1306 128x64）。 */
    lv_obj_set_pos(label, 0, 50); /* x/y position (was 0,410 on large displays) / x/y 位置（大屏曾用 0,410） */

    /* Set long text (triggers scrolling).
     * 设置长文本（会触发滚动）。 */
    lv_label_set_text(label, "!!!!!nRF5340 + NCS 3.0.0 + LVGL!!!!");

    lv_obj_set_style_text_color(label, display_get_text_color(), 0); /* Adaptive text color / 自适应文字颜色 */
#if defined(CONFIG_LVGL)
    lv_obj_set_style_text_font(label, mos_font_storage_get_lvgl_font(), 0); /* Use dynamic font / 使用动态字体 */
    add_dynamic_font_label(label);
#endif
    lv_obj_set_style_bg_color(lv_screen_active(), display_get_background_color(), 0);
}

/* Display on/off state management.
 * 显示开关状态管理。 */
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
    if (src_lang == DISPLAY_BIZ_LANG_UNKNOWN || dst_lang == DISPLAY_BIZ_LANG_UNKNOWN)
    {
        return -EINVAL;
    }

    s_biz_src_lang = src_lang;
    s_biz_dst_lang = dst_lang;
    LOG_INF("Business translation pair updated: src=%u dst=%u", (unsigned int)src_lang, (unsigned int)dst_lang);
    return 0;
}

void display_get_translation_pair(display_biz_lang_t *src_lang, display_biz_lang_t *dst_lang)
{
    if (src_lang != NULL)
    {
        *src_lang = s_biz_src_lang;
    }
    if (dst_lang != NULL)
    {
        *dst_lang = s_biz_dst_lang;
    }
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

    last_protobuf_text_valid = false;
    last_protobuf_text[0] = '\0';

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

#if defined(CONFIG_MOS_DISPLAY_TEXT_PAYLOAD_DIAG)
/* Support diagnostics: count hard line breaks in payload and print escaped preview (\\n visible).
 * 客诉排查：统计 payload 内硬换行并输出转义预览（\\n 可见）。 */
static void log_display_text_payload_diag(const char *text)
{
    if (text == NULL)
    {
        LOG_INF("[TEXT_PAYLOAD] (null)");
        return;
    }

    size_t len = strlen(text);
    size_t n_lf = 0U;
    size_t n_cr = 0U;
    int first_lf = -1;
    int first_cr = -1;
    const uint8_t *bytes = (const uint8_t *)text;

    for (size_t i = 0U; i < len; ++i)
    {
        if (bytes[i] == (uint8_t)'\n')
        {
            if (first_lf < 0)
            {
                first_lf = (int)i;
            }
            n_lf++;
        }
        if (bytes[i] == (uint8_t)'\r')
        {
            if (first_cr < 0)
            {
                first_cr = (int)i;
            }
            n_cr++;
        }
    }

#define TEXT_PAYLOAD_ESC_CAP 192U
    char esc[TEXT_PAYLOAD_ESC_CAP];
    size_t oi = 0U;
    const uint8_t *p = bytes;
    for (; *p != '\0' && oi + 6U < TEXT_PAYLOAD_ESC_CAP; ++p)
    {
        if (*p == (uint8_t)'\n')
        {
            esc[oi++] = '\\';
            esc[oi++] = 'n';
        }
        else if (*p == (uint8_t)'\r')
        {
            esc[oi++] = '\\';
            esc[oi++] = 'r';
        }
        else if (*p == (uint8_t)'\t')
        {
            esc[oi++] = '\\';
            esc[oi++] = 't';
        }
        else if (*p < 0x20u || *p == 0x7Fu)
        {
            int w = snprintf(esc + oi, TEXT_PAYLOAD_ESC_CAP - oi, "\\x%02x", (unsigned int)*p);
            if (w <= 0 || (size_t)w >= TEXT_PAYLOAD_ESC_CAP - oi)
            {
                break;
            }
            oi += (size_t)w;
        }
        else
        {
            esc[oi++] = (char)*p;
        }
    }
    esc[oi] = '\0';

    const char *trunc = (*p != '\0') ? "...(esc_trunc)" : "";

    LOG_INF("[TEXT_PAYLOAD] len=%zu LF=%zu CR=%zu first_LF_off=%d first_CR_off=%d esc=\"%s\"%s", len, n_lf, n_cr,
            first_lf, first_cr, esc, trunc);
#undef TEXT_PAYLOAD_ESC_CAP
}
#endif /* CONFIG_MOS_DISPLAY_TEXT_PAYLOAD_DIAG */

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

#if defined(CONFIG_MOS_DISPLAY_TEXT_PAYLOAD_DIAG)
    log_display_text_payload_diag(text_content);
#endif

    caption_state_ingest(text_content);
}

void display_submit_text_payload(uint16_t x, uint16_t y, const char *text_content, uint16_t font_size, uint32_t color)
{
    if (display_scene_get_pattern() == 5 || display_scene_get_mode() == DISPLAY_SCENE_MODE_XY)
    {
        uint32_t y_offset = (uint32_t)y + 80U;
        uint16_t y_clamped = (y_offset > 65535U) ? 65535U : (uint16_t)y_offset;
        uint16_t effective_font_size = (font_size > 0U) ? font_size : 12U;

        display_update_xy_text(x, y_clamped, text_content, effective_font_size, color);
        return;
    }

    display_update_protobuf_text(text_content);
}

void display_submit_scrolling_text_payload(const char *text_content)
{
    display_update_protobuf_text(text_content);
}

/* Direct A6N pattern APIs, thread-safe.
 * 直接 A6N 图案接口，线程安全。 */
void display_draw_horizontal_grayscale(void)
{
    display_cmd_t cmd = {.type = LCD_CMD_GRAYSCALE_HORIZONTAL};
    mos_msgq_send(&lvgl_display_msgq, &cmd, MOS_OS_WAIT_FOREVER);
}

void display_draw_vertical_grayscale(void)
{
    display_cmd_t cmd = {.type = LCD_CMD_GRAYSCALE_VERTICAL};
    mos_msgq_send(&lvgl_display_msgq, &cmd, MOS_OS_WAIT_FOREVER);
}

void display_draw_chess_pattern(void)
{
    display_cmd_t cmd = {.type = LCD_CMD_CHESS_PATTERN};
    mos_msgq_send(&lvgl_display_msgq, &cmd, MOS_OS_WAIT_FOREVER);
}

/* Pattern 5 XY text positioning, thread-safe.
 * Pattern 5 XY 文本定位，线程安全。 */
void display_update_xy_text(uint16_t x, uint16_t y, const char *text_content, uint16_t font_size, uint32_t color)
{
    if (!text_content)
    {
        LOG_ERR("Invalid text content pointer for XY text");
        return;
    }

    LOG_INF("Buffer: Filling XY text pos=(%u,%u) size=%u: %s", x, y, font_size, text_content);

    display_cmd_t cmd = {.type = LCD_CMD_UPDATE_XY_TEXT,
                         .p.xy_text = {
                             .x = x, .y = y, .font_size = font_size, .color = color, .text = {0}
                             /* Initialize text array / 初始化文本数组 */
                         }};

    /* Safely copy text with bounds checking.
     * 安全拷贝文本并做边界检查。 */
    size_t text_len = strlen(text_content);
    if (text_len > MAX_TEXT_LEN)
    {
        text_len = MAX_TEXT_LEN;
        LOG_WRN("XY text truncated to %d chars", MAX_TEXT_LEN);
    }

    strncpy(cmd.p.xy_text.text, text_content, text_len);
    cmd.p.xy_text.text[text_len] = '\0'; /* Ensure NUL termination / 保证 NUL 结尾 */

    /* Use 0 (no wait) timeout to avoid blocking shell threads - LVGL will process asynchronously */
    int ret = mos_msgq_send(&lvgl_display_msgq, &cmd, 0);
    if (ret != 0)
    {
        LOG_WRN("Failed to send XY text message to display queue (error: %d)", ret);
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
void lvgl_display_text(void)
{
    lv_obj_t *hello_world_label = lv_label_create(lv_screen_active());
    lv_label_set_text(hello_world_label, "Hello LVGL World");
    lv_obj_align(hello_world_label, LV_ALIGN_CENTER, 0, 0); /* Center align / 居中对齐 */
    /* lv_obj_align(hello_world_label, LV_TEXT_ALIGN_RIGHT, 0, 0); Right align / 右对齐 */
    /* lv_obj_align(hello_world_label, LV_TEXT_ALIGN_LEFT, 0, 0); Left align / 左对齐 */
    /* lv_obj_align(hello_world_label, LV_ALIGN_BOTTOM_MID, 0, 0); Bottom center / 底部居中对齐 */
    lv_obj_set_style_text_color(hello_world_label, display_get_text_color(),
                                0); /* Adaptive text color / 自适应文字颜色 */
#if defined(CONFIG_LVGL)
    lv_obj_set_style_text_font(hello_world_label, mos_font_storage_get_lvgl_font(),
                               0); /* Use dynamic font / 使用动态字体 */
    add_dynamic_font_label(hello_world_label);
#endif
    lv_obj_set_style_bg_color(lv_screen_active(), display_get_background_color(), 0);
}
static lv_timer_t *counter_timer; /* Pointer only / 指针即可 */
static lv_obj_t *acc_label;
static lv_obj_t *gyr_label;
static void counter_timer_cb(lv_timer_t *timer)
{
    // int *count = (int *)lv_timer_get_user_data(timer);
    // // lv_label_set_text_fmt(counter_label, "Count: %d", (*count)++);
    // char buf[64];
    // sprintf(buf, "ACC X=%.3f m/s Y=%.3f m/s Z=%.3f m/s",
    //         icm42688p_data.acc_ms2[0],
    //         icm42688p_data.acc_ms2[1],
    //         icm42688p_data.acc_ms2[2]);
    // lv_label_set_text(acc_label, buf);
    // memset(buf, 0, sizeof(buf));
    /* Update gyro label.
     * 更新陀螺仪标签。 */
    // sprintf(buf, "GYR X=%.4f dps Y=%.4f dps Z=%.4f dps",
    //         icm42688p_data.gyr_dps[0],
    //         icm42688p_data.gyr_dps[1],
    //         icm42688p_data.gyr_dps[2]);
    // lv_label_set_text(gyr_label, buf);
}

void ui_create(void)
{
    // counter_label = lv_label_create(lv_screen_active());
    acc_label = lv_label_create(lv_screen_active());
    lv_obj_align(acc_label, LV_TEXT_ALIGN_LEFT, 0, 320);
    gyr_label = lv_label_create(lv_screen_active());
    lv_obj_align(gyr_label, LV_TEXT_ALIGN_LEFT, 0, 380);

    /* lv_obj_align(counter_label, LV_TEXT_ALIGN_LEFT, 50, 320); Left align / 左对齐 */
    lv_obj_set_style_text_color(acc_label, display_get_text_color(), 0); /* Adaptive text color / 自适应文字颜色 */
#if defined(CONFIG_LVGL)
    lv_obj_set_style_text_font(acc_label, mos_font_storage_get_lvgl_font(), 0); /* Use dynamic font / 使用动态字体 */
    add_dynamic_font_label(acc_label);
#endif
    lv_obj_set_style_text_color(gyr_label, display_get_text_color(), 0); /* Adaptive text color / 自适应文字颜色 */
#if defined(CONFIG_LVGL)
    lv_obj_set_style_text_font(gyr_label, mos_font_storage_get_lvgl_font(), 0); /* Use dynamic font / 使用动态字体 */
    add_dynamic_font_label(gyr_label);
#endif
    lv_obj_set_style_bg_color(lv_screen_active(), display_get_background_color(), 0);
    /* Create periodic timer; pass count pointer via user_data.
     * 创建周期定时器，count 指针经 user_data 传入。 */
    static int count = 0;
    counter_timer = lv_timer_create(counter_timer_cb, 300, &count);
    /* 300 ms period, callback triggers each cycle / 300 为毫秒，回调每次触发 */
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
    LOG_INF("🖼️ welcome_label after init: %p", (void *)welcome_label);
}

/* 测试图案函数 / Test pattern functions */
static void create_chess_pattern(lv_obj_t *screen)
{
    /* 获取模块化显示配置以适配棋盘图案 / Get modular display configuration for adaptive chess pattern */
    const display_config_t *config = display_get_config();

    /* 使用配置中的棋盘格尺寸 / Use configuration-based chess square size */
    const int chess_size = config->patterns.chess_square_size;
    const int chess_cols = config->width / chess_size;
    const int chess_rows = config->height / chess_size;

    LOG_DBG("🏁 Creating adaptive chess pattern: %dx%d squares (%d cols x %d rows) for %s", chess_size, chess_size,
            chess_cols, chess_rows, config->name);

    for (int row = 0; row < chess_rows; row++)
    {
        for (int col = 0; col < chess_cols; col++)
        {
            /* 黑白格交替 / Alternate black and white squares */
            bool is_white = (row + col) % 2 == 0;

            lv_obj_t *square = lv_obj_create(screen);
            lv_obj_set_size(square, chess_size, chess_size);
            lv_obj_set_pos(square, col * chess_size, row * chess_size);
            lv_color_t color =
                is_white ? display_get_adjusted_color(lv_color_white()) : display_get_adjusted_color(lv_color_black());
            lv_obj_set_style_bg_color(square, color, 0);
            lv_obj_set_style_bg_opa(square, LV_OPA_COVER, 0);
            lv_obj_set_style_border_width(square, 0, 0);
            lv_obj_set_style_pad_all(square, 0, 0);
        }
    }
}

static void create_horizontal_zebra_pattern(lv_obj_t *screen)
{
    /* 获取模块化显示配置以适配横向条纹 / Get modular display configuration for adaptive horizontal bars */
    const display_config_t *config = display_get_config();

    /* 使用配置中的条纹厚度 / Use configuration-based bar thickness */
    const int stripe_height = config->patterns.bar_thickness;
    const int num_stripes = config->height / stripe_height;

    LOG_DBG("🦓 Creating adaptive horizontal zebra: %d stripes (%dpx height) for %s", num_stripes, stripe_height,
            config->name);

    for (int i = 0; i < num_stripes; i++)
    {
        bool is_white = i % 2 == 0;

        lv_obj_t *stripe = lv_obj_create(screen);
        lv_obj_set_size(stripe, config->width, stripe_height);
        lv_obj_set_pos(stripe, 0, i * stripe_height);
        lv_color_t color =
            is_white ? display_get_adjusted_color(lv_color_white()) : display_get_adjusted_color(lv_color_black());
        lv_obj_set_style_bg_color(stripe, color, 0);
        lv_obj_set_style_bg_opa(stripe, LV_OPA_COVER, 0);
        lv_obj_set_style_border_width(stripe, 0, 0);
        lv_obj_set_style_pad_all(stripe, 0, 0);
    }
}

static void create_vertical_zebra_pattern(lv_obj_t *screen)
{
    /* 获取模块化显示配置以适配纵向条纹 / Get modular display configuration for adaptive vertical bars */
    const display_config_t *config = display_get_config();

    /* 使用配置中的条纹厚度 / Use configuration-based bar thickness */
    const int stripe_width = config->patterns.bar_thickness;
    const int num_stripes = config->width / stripe_width;

    LOG_INF("🦓 Creating adaptive vertical zebra: %d stripes (%dpx width) for %s", num_stripes, stripe_width,
            config->name);

    for (int i = 0; i < num_stripes; i++)
    {
        bool is_white = i % 2 == 0;

        lv_obj_t *stripe = lv_obj_create(screen);
        lv_obj_set_size(stripe, stripe_width, config->height);
        lv_obj_set_pos(stripe, i * stripe_width, 0);
        lv_color_t color =
            is_white ? display_get_adjusted_color(lv_color_white()) : display_get_adjusted_color(lv_color_black());
        lv_obj_set_style_bg_color(stripe, color, 0);
        lv_obj_set_style_bg_opa(stripe, LV_OPA_COVER, 0);
        lv_obj_set_style_border_width(stripe, 0, 0);
        lv_obj_set_style_pad_all(stripe, 0, 0);
    }
}


static void anim_set_x_cb(void *obj, int32_t v)
{
    lv_obj_set_x((lv_obj_t *)obj, v);
}

static void create_center_rectangle_pattern_ssd1306(lv_obj_t *screen)
{
    const char *text = "Welcome to MentraOS NExFirmware!";
#if defined(CONFIG_LVGL)
    const lv_font_t *font = mos_font_storage_get_lvgl_font();
#else
    const lv_font_t *font = &lv_font_montserrat_18;
#endif
    const uint32_t ms_per_px = 25;
    const lv_coord_t sw = lv_obj_get_width(screen);
    const lv_coord_t sh = lv_obj_get_height(screen);

    lv_obj_set_style_bg_color(screen, lv_color_white(), 0);
    lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, 0);

    lv_obj_t *label = lv_label_create(screen);
    lv_obj_set_style_text_color(label, lv_color_black(), 0);
    lv_obj_set_style_text_font(label, font, 0);
    lv_label_set_text(label, text);

    lv_label_set_long_mode(label, LV_LABEL_LONG_CLIP);

    lv_obj_update_layout(label);
    lv_coord_t label_w = lv_obj_get_width(label);
    lv_coord_t label_h = lv_obj_get_height(label);

    lv_obj_set_y(label, (sh - label_h) / 2);

    const lv_coord_t x_start = sw;
    const lv_coord_t x_end = -label_w;

    uint32_t total_px = (uint32_t)(x_start - x_end);
    uint32_t anim_time_ms = total_px * ms_per_px;

    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, label);
    lv_anim_set_exec_cb(&a, anim_set_x_cb);
    lv_anim_set_values(&a, x_start, x_end);
    lv_anim_set_time(&a, anim_time_ms);
    lv_anim_set_path_cb(&a, lv_anim_path_linear);
    lv_anim_set_repeat_delay(&a, 250);
    lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
    lv_anim_start(&a);
}

/**
 * Return LVGL Bluetooth symbol for device name line on welcome screen.
 * 仅未连接时显示蓝牙图标，已连接时不显示。
 * LV_SYMBOL_* 位于 U+F000–F8FF，mos_binfont 对该区间固定走 Montserrat 18 fallback，不读外置 Flash glyf。
 */
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

/**
 * Return LVGL battery/charging symbol for icon+number display.
 * 与 get_ble_icon 相同：符号字形来自内置 Montserrat 18（binfont fallback），非外置 Flash 位图。
 */
static const char *get_battery_icon(uint32_t pct, bool charging)
{
#ifdef LV_SYMBOL_CHARGE
    if (charging)
    {
        return LV_SYMBOL_CHARGE;
    }
#endif
    /* 从高到低匹配，避免某一档宏未定义时错误落到下一档 */
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

#if defined(CONFIG_LVGL)
/** 欢迎屏文案。英文等在 Flash binfont；图标为 LV_SYMBOL_*，由 s_binfont_lvgl.fallback（Montserrat 18）绘制。 */
static void build_welcome_screen_text(char *buf, size_t buflen, const display_config_t *config)
{
    const char *device_name = get_ble_device_name();
    uint32_t battery_pct = protobuf_get_battery_level();
    bool charging = protobuf_get_charging_state();

    const char *ble_icon = get_ble_icon();
    const char *battery_icon = get_battery_icon(battery_pct, charging);

    /* 文案与当前外置字库语言一致（运行时 switch 后欢迎刷新会跟用户选择） */
    if (mos_binfont_get_current_language() == MOS_FONT_LANG_ZH_CN)
    {
        /* UTF-8：与 font_storage_zh_cn_18 分区配套；图标串可能为空 */
        if (config->width >= 500)
        {
            snprintf(buf, buflen,
                     "\xe6\xac\xa2\xe8\xbf\x8e\xe4\xbd\xbf\xe7\x94\xa8 MentraOS\n"
                     "Build V1.2.3 %s %s\n"
                     "\xe7\xad\x89\xe5\xbe\x85\xe8\xbf\x9e\xe6\x8e\xa5\n"
                     "\xe8\xae\xbe\xe5\xa4\x87\xe5\x90\x8d: %s %s\n"
                     "\xe7\x94\xb5\xe9\x87\x8f: %s %u%%",
                     __DATE__, __TIME__, ble_icon, device_name, battery_icon, (unsigned int)battery_pct);
        }
        else
        {
            snprintf(buf, buflen,
                     "\xe6\xac\xa2\xe8\xbf\x8e\xe4\xbd\xbf\xe7\x94\xa8 MentraOS\n"
                     "Build V1.2.3 %s %s\n"
                     "\xe7\xad\x89\xe5\xbe\x85\xe8\xbf\x9e\xe6\x8e\xa5\n"
                     "\xe8\xae\xbe\xe5\xa4\x87: %s %s\n"
                     "\xe7\x94\xb5\xe9\x87\x8f: %s %u%%",
                     __DATE__, __TIME__, ble_icon, device_name, battery_icon, (unsigned int)battery_pct);
        }
    }
    else
    {
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
}
#endif

#if defined(CONFIG_LVGL)
/* 欢迎屏：关闭父容器垂直滚动并把 scroll_y 清零。隐藏的大号 protobuf_gbk_container 仍参与内容高度时，
 * 开着滚动会导致视口落在错误区间；BLE/转写文案再打开垂直滚动。 */
static void protobuf_container_set_welcome_scroll(bool welcome_active)
{
    if (protobuf_container == NULL)
    {
        return;
    }
    if (welcome_active)
    {
        lv_obj_set_scroll_dir(protobuf_container, LV_DIR_NONE);
        lv_obj_scroll_to_y(protobuf_container, 0, LV_ANIM_OFF);
    }
    else
    {
        lv_obj_set_scroll_dir(protobuf_container, LV_DIR_VER);
    }
}

/* Welcome-screen state reset:
 * hide BLE/CJK content, show the shared welcome label, restore container scroll mode,
 * and request one redraw. This is separate from text refresh on purpose.
 * 欢迎界面状态恢复：隐藏 BLE/CJK 内容、显示欢迎标签、恢复容器滚动模式并请求重绘。
 * 故意与欢迎文案刷新分离。 */
static void restore_welcome_screen_state(void)
{
    ensure_pattern4_scene_ready();

    destroy_protobuf_scene();
    display_scene_set_mode(DISPLAY_SCENE_MODE_WELCOME);

    if (welcome_container != NULL)
    {
        lv_obj_clear_flag(welcome_container, LV_OBJ_FLAG_HIDDEN);
        lv_obj_invalidate(welcome_container);
    }

    if (welcome_label != NULL)
    {
        lv_obj_clear_flag(welcome_label, LV_OBJ_FLAG_HIDDEN);
        lv_obj_align(welcome_label, LV_ALIGN_TOP_LEFT, 0, 0);
    }
}

/* 欢迎屏：使用当前外置字库（与全局一致）。上电默认值见 prj.conf 的 MOS_WELCOME_LANG_* / PT_SIZE，
 * 对应 mos_binfont_lvgl.c 里 s_current_*；用户调用 mos_font_switch_language 后不再被欢迎刷新覆盖。
 * 未就绪时回退 secondary。须在 LVGL 线程调用。 */
static void f(lv_obj_t *label)
{
    if (label == NULL)
    {
        return;
    }

    const lv_font_t *use = mos_binfont_get_lvgl_font();
    const uint8_t cur_lang = mos_binfont_get_current_language();
    const uint8_t cur_pt = mos_binfont_get_current_size();

    if (use == NULL || !mos_binfont_is_initialized())
    {
        use = display_get_font("secondary");
        LOG_WRN("Welcome: binfont lang=%u pt=%u not ready, using built-in secondary @%p", cur_lang, cur_pt,
                (void *)use);
    }
    (void)cur_lang;
    (void)cur_pt;
    if (use != NULL)
    {
        lv_obj_set_style_text_font(label, use, 0);
    }
}

#endif

static void create_scrolling_text_container(lv_obj_t *screen)
{
    /* 获取模块化显示配置 / Get modular display configuration */
    const display_config_t *config = display_get_config();

    /* Pattern 4 默认只创建常驻欢迎容器；BLE 文本容器按需懒创建。 */
    lv_obj_t *container = lv_obj_create(screen);
    display_apply_container_config(container, screen, config);
    welcome_container = container;

    /* 欢迎容器默认不滚动。 */
    lv_obj_set_scroll_dir(container, LV_DIR_NONE);
    lv_obj_set_scrollbar_mode(container, LV_SCROLLBAR_MODE_OFF);

    lv_obj_set_style_bg_color(container, display_get_background_color(), 0);
    lv_obj_set_style_bg_opa(container, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(container, 0, 0);
    lv_obj_set_style_border_opa(container, LV_OPA_TRANSP, 0);
    // lv_obj_set_style_border_width(container, 2, 0);
    // lv_obj_set_style_border_color(container, display_get_text_color(), 0);
    // lv_obj_set_style_border_opa(container, LV_OPA_COVER, 0);

    /* 欢迎界面主文案标签。 */
    lv_obj_t *label = lv_label_create(container);
    LOG_INF("Welcome: label created @%p, container @%p, screen @%p", (void *)label, (void *)container, (void *)screen);

    lv_coord_t label_width = config->layout.usable_width - (config->layout.padding * 2);
    lv_obj_set_width(label, label_width);
    lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_LEFT, 0);

    LOG_INF("Welcome: label width set to %d (usable_width=%d, padding=%d)", (int)label_width,
            (int)config->layout.usable_width, (int)config->layout.padding);

    welcome_label = label;

    welcome_screen_initializing = true;

#if defined(CONFIG_LVGL)
    welcome_apply_preferred_font(label);
#else
    lv_obj_set_style_text_font(label, display_get_font("secondary"), 0);
#endif

    const char *initial_text;
    char display_text[160];

#if defined(CONFIG_LVGL)
    build_welcome_screen_text(display_text, sizeof(display_text), config);
    initial_text = display_text;
#else
    const char *device_name = get_ble_device_name();
    uint32_t battery_pct = protobuf_get_battery_level();
    bool charging = protobuf_get_charging_state();
    if (config->width >= 500)
    {
        snprintf(display_text, sizeof(display_text),
                 "Welcome to MentraOS\n"
                 "Build V1.2.3 %s %s\n"
                 "Waiting for connection\n"
                 "Device Name: %s %s\n"
                 "Battery: %s %u%%",
                 __DATE__, __TIME__, get_ble_icon(), device_name, get_battery_icon(battery_pct, charging),
                 (unsigned int)battery_pct);
    }
    else
    {
        snprintf(display_text, sizeof(display_text),
                 "Welcome to MentraOS\n"
                 "Build V1.2.3 %s %s\n"
                 "Waiting for connection\n"
                 "Device: %s %s\n"
                 "Battery: %s %u%%",
                 __DATE__, __TIME__, get_ble_icon(), device_name, get_battery_icon(battery_pct, charging),
                 (unsigned int)battery_pct);
    }
    initial_text = display_text;
#endif

    lv_obj_set_style_text_color(label, display_get_text_color(), 0);
    lv_obj_set_style_text_line_space(label, config->fonts.line_spacing, 0);

    LOG_INF("Welcome: text color and bg color styles set");

    lv_label_set_text(label, initial_text);
    lv_obj_update_layout(label);

    LOG_INF("Welcome text set: '%.50s...' (truncated)", initial_text);

    welcome_screen_active = true;
    display_scene_set_mode(DISPLAY_SCENE_MODE_WELCOME);
    welcome_screen_initializing = false;

    LOG_INF("Welcome screen initialized: label_ptr=%p, state=%d", (void *)label, welcome_screen_active);

    k_work_init_delayable(&welcome_battery_work, welcome_battery_work_handler);
    k_work_schedule(&welcome_battery_work, K_MSEC(WELCOME_BATTERY_REFRESH_MS));
#if defined(CONFIG_LVGL)
    add_dynamic_font_label(label);
#endif

    lv_obj_align(label, LV_ALIGN_TOP_LEFT, 0, 0);
    lv_obj_update_layout(label);
    lv_obj_clear_flag(label, LV_OBJ_FLAG_HIDDEN);
    LOG_INF("Welcome: label visibility set to visible");

    /* 检查 label 的 bounding box */
    lv_area_t label_area;
    lv_obj_get_coords(label, &label_area);
    LOG_INF("Welcome: label bounding box: (%d,%d) to (%d,%d), size=%dx%d", label_area.x1, label_area.y1, label_area.x2,
            label_area.y2, lv_area_get_width(&label_area), lv_area_get_height(&label_area));

    /* 检查 label 的内容尺寸 */
    lv_coord_t content_width = lv_obj_get_content_width(label);
    lv_coord_t content_height = lv_obj_get_content_height(label);
    LOG_INF("Welcome: label content size: %dx%d", (int)content_width, (int)content_height);

    /* 检查 label 的实际宽度和高度 */
    lv_coord_t label_w = lv_obj_get_width(label);
    lv_coord_t label_h = lv_obj_get_height(label);
    LOG_INF("Welcome: label actual size: %dx%d", (int)label_w, (int)label_h);

    lv_obj_invalidate(container);
    LOG_INF("Welcome: container invalidated to trigger rendering");

    dfu_status_label = lv_label_create(container);
    lv_label_set_text(dfu_status_label, "");
    lv_obj_set_width(dfu_status_label, config->layout.usable_width - (config->layout.padding * 2));
    lv_obj_set_style_text_font(dfu_status_label, display_get_font("secondary"), 0);
    lv_obj_set_style_text_color(dfu_status_label, display_get_text_color(), 0);
    lv_obj_set_style_text_align(dfu_status_label, LV_TEXT_ALIGN_LEFT, 0);
    lv_obj_align_to(dfu_status_label, label, LV_ALIGN_OUT_BOTTOM_LEFT, 0, 4);
    lv_obj_add_flag(dfu_status_label, LV_OBJ_FLAG_HIDDEN);
#if defined(CONFIG_LVGL)
    add_dynamic_font_label(dfu_status_label);
#endif

    dfu_progress_bar_w = (lv_coord_t)(config->layout.usable_width / 2);
    dfu_progress_bar = lv_obj_create(container);
    lv_obj_set_size(dfu_progress_bar, dfu_progress_bar_w, 12);
    lv_obj_align_to(dfu_progress_bar, dfu_status_label, LV_ALIGN_OUT_BOTTOM_MID, 0, 4);
    lv_obj_set_style_bg_color(dfu_progress_bar, display_get_background_color(), 0);
    lv_obj_set_style_bg_opa(dfu_progress_bar, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(dfu_progress_bar, 0, 0);
    lv_obj_set_style_radius(dfu_progress_bar, 4, 0);
    lv_obj_set_style_pad_all(dfu_progress_bar, 0, 0);
    dfu_progress_fill = lv_obj_create(dfu_progress_bar);
    lv_obj_set_size(dfu_progress_fill, 0, 12);
    lv_obj_align(dfu_progress_fill, LV_ALIGN_LEFT_MID, 0, 0);
    lv_obj_set_style_bg_color(dfu_progress_fill, display_get_text_color(), 0);
    lv_obj_set_style_bg_opa(dfu_progress_fill, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(dfu_progress_fill, 0, 0);
    lv_obj_set_style_radius(dfu_progress_fill, 4, 0);
    lv_obj_set_style_pad_all(dfu_progress_fill, 0, 0);
    lv_obj_add_flag(dfu_progress_bar, LV_OBJ_FLAG_HIDDEN);

    lv_obj_update_layout(container);
    LOG_INF("Welcome container ready: %dx%d with %s font", config->layout.usable_width, config->layout.usable_height,
            config->name);
}
/**
 * 确保 protobuf 场景就绪：如果尚未创建，则创建 BLE 文本容器和标签，并隐藏欢迎容器。
 * Ensure protobuf scene is ready: if not already created, create BLE text container and label, and hide welcome container.
 */
static void ensure_protobuf_scene_ready(void)
{
    if (protobuf_container != NULL && protobuf_label != NULL)
    {
        return;
    }

    ensure_pattern4_scene_ready();

    lv_obj_t *screen = lv_screen_active();
    const display_config_t *config = display_get_config();

    protobuf_container = lv_obj_create(screen);
    display_apply_container_config(protobuf_container, screen, config);
    lv_obj_set_scroll_dir(protobuf_container, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(protobuf_container, LV_SCROLLBAR_MODE_OFF);
    lv_obj_set_style_bg_color(protobuf_container, display_get_background_color(), 0);
    lv_obj_set_style_bg_opa(protobuf_container, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(protobuf_container, 0, 0);
    lv_obj_set_style_border_opa(protobuf_container, LV_OPA_TRANSP, 0);
    // lv_obj_set_style_border_width(protobuf_container, 2, 0);
    // lv_obj_set_style_border_color(protobuf_container, display_get_text_color(), 0);
    // lv_obj_set_style_border_opa(protobuf_container, LV_OPA_COVER, 0);

    protobuf_label = lv_label_create(protobuf_container);
    lv_obj_set_width(protobuf_label, config->layout.usable_width - (config->layout.padding * 2));
    lv_label_set_long_mode(protobuf_label, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_align(protobuf_label, LV_TEXT_ALIGN_LEFT, 0);
    lv_obj_set_style_text_color(protobuf_label, display_get_text_color(), 0);
    lv_obj_set_style_text_line_space(protobuf_label, config->fonts.line_spacing, 0);
    lv_obj_set_style_text_font(protobuf_label, display_get_font("secondary"), 0);
    lv_obj_align(protobuf_label, LV_ALIGN_TOP_LEFT, 0, PROTOBUF_BLE_LABEL_YOFF);
#if defined(CONFIG_LVGL)
    add_dynamic_font_label(protobuf_label);
#endif

    protobuf_gbk_container = lv_obj_create(protobuf_container);
    lv_obj_set_size(protobuf_gbk_container, config->layout.usable_width - (config->layout.padding * 2),
                    config->layout.usable_height - (config->layout.padding * 2));
    lv_obj_set_style_bg_opa(protobuf_gbk_container, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(protobuf_gbk_container, 0, 0);
    lv_obj_set_style_border_opa(protobuf_gbk_container, LV_OPA_TRANSP, 0);
    lv_obj_set_scroll_dir(protobuf_gbk_container, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(protobuf_gbk_container, LV_SCROLLBAR_MODE_AUTO);
    lv_obj_align(protobuf_gbk_container, LV_ALIGN_TOP_LEFT, 0, PROTOBUF_BLE_LABEL_YOFF);
    lv_obj_add_flag(protobuf_gbk_container, LV_OBJ_FLAG_HIDDEN);
    memset(s_protobuf_gbk_label_pool, 0, sizeof(s_protobuf_gbk_label_pool));
    s_protobuf_gbk_label_pool_used = 0;

    protobuf_xy_overlay_container = lv_obj_create(protobuf_container);
    lv_obj_set_size(protobuf_xy_overlay_container, config->layout.usable_width - (config->layout.padding * 2),
                    config->layout.usable_height - (config->layout.padding * 2));
    lv_obj_set_style_bg_opa(protobuf_xy_overlay_container, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(protobuf_xy_overlay_container, 0, 0);
    lv_obj_set_style_border_opa(protobuf_xy_overlay_container, LV_OPA_TRANSP, 0);
    lv_obj_set_style_pad_all(protobuf_xy_overlay_container, 0, 0);
    lv_obj_set_scroll_dir(protobuf_xy_overlay_container, LV_DIR_NONE);
    lv_obj_set_scrollbar_mode(protobuf_xy_overlay_container, LV_SCROLLBAR_MODE_OFF);
    lv_obj_align(protobuf_xy_overlay_container, LV_ALIGN_TOP_LEFT, 0, 0);
    lv_obj_add_flag(protobuf_xy_overlay_container, LV_OBJ_FLAG_HIDDEN);

    if (welcome_container != NULL)
    {
        lv_obj_add_flag(welcome_container, LV_OBJ_FLAG_HIDDEN);
    }

    lv_obj_update_layout(protobuf_container);
    LOG_INF("Text container ready: %dx%d", config->layout.usable_width, config->layout.usable_height);
}

static void destroy_protobuf_scene(void)
{
    if (protobuf_label != NULL)
    {
#if defined(CONFIG_LVGL)
        remove_dynamic_font_label(protobuf_label);
#endif
    }

    if (protobuf_container != NULL)
    {
        lv_obj_del(protobuf_container);
    }

    protobuf_container = NULL;
    protobuf_label = NULL;
    protobuf_gbk_container = NULL;
    protobuf_xy_overlay_container = NULL;
    current_xy_text_label = NULL;
    memset(s_protobuf_gbk_label_pool, 0, sizeof(s_protobuf_gbk_label_pool));
    s_protobuf_gbk_label_pool_used = 0;
}

/* Pattern 5：XY 文本定位区域，模块化配置 / Pattern 5 - XY Text Positioning Area with modular configuration */
static void create_xy_text_positioning_area(lv_obj_t *screen)
{
    /* 获取模块化显示配置 / Get modular display configuration */
    const display_config_t *config = display_get_config();

    /* 按模块化尺寸创建 XY 定位容器 / Create XY positioning container using modular dimensions */
    lv_obj_t *container = lv_obj_create(screen);

    /* 设置容器大小和位置 / Set container size and position */
    lv_obj_set_size(container, config->layout.usable_width, config->layout.usable_height);
    lv_obj_set_pos(container, config->layout.margin_left, config->layout.margin_top);

    /* 保存全局引用供 XY 文本定位 / Store global reference for XY text positioning */
    xy_text_container = container;

    /* 容器为静态定位区，不滚动 / Configure container as static positioning area - NO SCROLLING */
    lv_obj_set_scroll_dir(container, LV_DIR_NONE); /* 不滚动 / No scrolling */
    lv_obj_set_scrollbar_mode(container, LV_SCROLLBAR_MODE_OFF); /* 无滚动条 / No scrollbars */

    /* 容器样式：白底黑边 / White background, black border */
    lv_obj_set_style_bg_color(container, lv_color_white(), 0); /* 白底 / White background */
    lv_obj_set_style_bg_opa(container, LV_OPA_COVER, 0);
    lv_obj_set_style_border_color(container, lv_color_black(), 0); /* 黑边 / Black border */
    lv_obj_set_style_border_opa(container, LV_OPA_COVER, 0); /* 边框可见 / Visible border */
    lv_obj_set_style_border_width(container, 2, 0); /* 2px border */

    LOG_INF("📍 Pattern 5: XY Text Positioning Area created (%dx%d) for %s", config->layout.usable_width,
            config->layout.usable_height, config->name);
}

static int current_pattern = 4; /* 默认自动滚动容器（图案 4）/ Default to auto-scroll container (pattern 4) */
static const int num_patterns = 6; /* 从 5 增至 6（新增 Pattern 5 XY 文本定位）/ Increased from 5 to 6 (added Pattern 5:
                                      XY Text Positioning) */

/* 获取当前图案 ID 供条件逻辑使用 / Get current pattern ID for conditional logic */
int display_get_current_pattern(void)
{
    return display_scene_get_pattern();
}

bool display_is_welcome_screen_active(void)
{
    return display_scene_is_welcome_active();
}

/* lv_obj_del 子控件后，文件内缓存的 lv_obj_t* 全部悬空；必须清零，否则 BLE/protobuf 与 DFU 路径会 UAF。 */
static void tear_down_screen_child_global_refs(void)
{
    k_work_cancel_delayable(&welcome_battery_work);

    welcome_container = NULL;
    welcome_label = NULL;
    protobuf_container = NULL;
    protobuf_label = NULL;
    protobuf_gbk_container = NULL;
    protobuf_xy_overlay_container = NULL;

    dfu_status_label = NULL;
    dfu_progress_bar = NULL;
    dfu_progress_fill = NULL;
    dfu_progress_bar_w = 0;

    xy_text_container = NULL;
    current_xy_text_label = NULL;
    gbk_test_label = NULL;

#if defined(CONFIG_LVGL)
    memset(s_dynamic_font_labels, 0, sizeof(s_dynamic_font_labels));
    s_dynamic_font_label_count = 0;
#endif

    memset(s_protobuf_gbk_label_pool, 0, sizeof(s_protobuf_gbk_label_pool));
    s_protobuf_gbk_label_pool_used = 0;

    welcome_screen_active = false;
    welcome_screen_initializing = false;
    display_scene_set_mode(DISPLAY_SCENE_MODE_TEST);
}

static void ensure_pattern4_scene_ready(void)
{
    if (welcome_container != NULL && welcome_label != NULL)
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

    last_protobuf_text_valid = false;
    last_protobuf_text[0] = '\0';
    s_last_welcome_text_valid = false;
    s_last_welcome_text[0] = '\0';
}

static void hide_and_clear_protobuf_xy_overlay(void)
{
    if (protobuf_xy_overlay_container == NULL)
    {
        return;
    }

    if (lv_obj_get_child_cnt(protobuf_xy_overlay_container) > 0)
    {
        lv_obj_clean(protobuf_xy_overlay_container);
    }

    current_xy_text_label = NULL;
    lv_obj_add_flag(protobuf_xy_overlay_container, LV_OBJ_FLAG_HIDDEN);
}

static void clear_current_display_text(void)
{
    /* ClearDisplay 只清空当前活跃容器的显示内容，不删除当前活跃容器本身。 */
    bool clearing_welcome = welcome_screen_active;

    reset_display_text_caches();
    welcome_screen_active = clearing_welcome;
    welcome_screen_initializing = false;

    if (clearing_welcome)
    {
        if (welcome_label != NULL)
        {
            lv_label_set_text(welcome_label, "");
            lv_obj_clear_flag(welcome_label, LV_OBJ_FLAG_HIDDEN);
        }
        if (dfu_status_label != NULL)
        {
            lv_label_set_text(dfu_status_label, "");
            lv_obj_add_flag(dfu_status_label, LV_OBJ_FLAG_HIDDEN);
        }
        if (dfu_progress_fill != NULL)
        {
            lv_obj_set_width(dfu_progress_fill, 0);
        }
        if (dfu_progress_bar != NULL)
        {
            lv_obj_add_flag(dfu_progress_bar, LV_OBJ_FLAG_HIDDEN);
        }
        if (welcome_container != NULL)
        {
            lv_obj_invalidate(welcome_container);
        }
    }
    else
    {
        if (protobuf_label != NULL)
        {
            lv_label_set_text(protobuf_label, "");
            lv_obj_clear_flag(protobuf_label, LV_OBJ_FLAG_HIDDEN);
        }

        if (protobuf_gbk_container != NULL)
        {
            lv_obj_add_flag(protobuf_gbk_container, LV_OBJ_FLAG_HIDDEN);
            for (size_t index = 0; index < s_protobuf_gbk_label_pool_used; ++index)
            {
                if (s_protobuf_gbk_label_pool[index] != NULL)
                {
                    lv_obj_add_flag(s_protobuf_gbk_label_pool[index], LV_OBJ_FLAG_HIDDEN);
                }
            }
            s_protobuf_gbk_label_pool_used = 0;
        }

        hide_and_clear_protobuf_xy_overlay();

        if (protobuf_container != NULL)
        {
            lv_obj_scroll_to_y(protobuf_container, 0, LV_ANIM_OFF);
            lv_obj_invalidate(protobuf_container);
        }
    }

    if (xy_text_container != NULL)
    {
        if (lv_obj_get_child_cnt(xy_text_container) > 0)
        {
            lv_obj_clean(xy_text_container);
        }
        current_xy_text_label = NULL;
        lv_obj_invalidate(xy_text_container);
    }

    if (gbk_test_label != NULL)
    {
        lv_label_set_text(gbk_test_label, "");
        lv_obj_invalidate(gbk_test_label);
    }

    lv_obj_invalidate(lv_screen_active());
    lvgl_force_one_refresh = true;
}

static void show_test_pattern(int pattern_id)
{
    /* 仅由 LVGL 线程调用，无需加锁 / SAFE: Now called only from LVGL thread - no locking needed */
    /* 获取屏幕并设黑色背景 / Get screen and set black background */
    lv_obj_t *screen = lv_screen_active();

    /* 先快速删除屏幕上的所有子对象，避免长时间阻塞 / Quickly clear all children */
    lv_obj_t *child;
    while ((child = lv_obj_get_child(screen, 0)) != NULL)
    {
        lv_obj_del(child);
        /* 定期让出 CPU 防止完全阻塞 / Yield CPU periodically to prevent blocking */
        k_yield();
    }

    tear_down_screen_child_global_refs();

    lv_obj_set_style_bg_color(screen, display_get_background_color(), 0);
    lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, 0);
    // lv_obj_set_style_border_width(screen, 2, 0);
    // lv_obj_set_style_border_color(screen, display_get_text_color(), 0);
    // lv_obj_set_style_border_opa(screen, LV_OPA_COVER, 0);

    switch (pattern_id)
    {
        case 0:
            create_chess_pattern(screen);
            break;
        case 1:
            create_horizontal_zebra_pattern(screen);
            break;
        case 2:
            create_vertical_zebra_pattern(screen);
            break;
        case 3:
            create_center_rectangle_pattern_ssd1306(screen);
            break;
        case 4:
            create_scrolling_text_container(screen);
            break;
        case 5:
            create_xy_text_positioning_area(screen);
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
        case 5:
            display_scene_set_mode(DISPLAY_SCENE_MODE_XY);
            break;
        default:
            display_scene_set_mode(DISPLAY_SCENE_MODE_TEST);
            break;
    }
}

/** 仅标脏当前 pattern 下的根容器，用于软件视差等驱动参数变更后“刷新当前画面”而尽量不整屏刷 */
static void invalidate_current_visible_ui(void)
{
    lv_obj_t *screen = lv_screen_active();

    switch (current_pattern)
    {
        case 4:
            if (welcome_container != NULL && !lv_obj_has_flag(welcome_container, LV_OBJ_FLAG_HIDDEN))
            {
                lv_obj_invalidate(welcome_container);
            }
            if (protobuf_container != NULL)
            {
                lv_obj_invalidate(protobuf_container);
            }
            if (protobuf_gbk_container != NULL && !lv_obj_has_flag(protobuf_gbk_container, LV_OBJ_FLAG_HIDDEN))
            {
                lv_obj_invalidate(protobuf_gbk_container);
            }
            break;
        case 5:
            if (xy_text_container != NULL)
            {
                lv_obj_invalidate(xy_text_container);
            }
            break;
        default:
        {
            /* 图案 0–3：动态子控件挂在 screen 下，逐个标脏 */
            uint32_t n = lv_obj_get_child_cnt(screen);
            for (uint32_t i = 0; i < n; i++)
            {
                lv_obj_t *ch = lv_obj_get_child(screen, i);
                if (ch != NULL)
                {
                    lv_obj_invalidate(ch);
                }
            }
            break;
        }
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

    if (welcome_container == NULL && protobuf_container == NULL)
    {
        LOG_WRN("Pattern 4 containers not initialized");
        return;
    }

    lv_obj_t *screen = lv_screen_active();
    const display_config_t *config = display_get_config();

    /* Make a mutable copy of the current config */
    display_config_t tmp = *config;

    uint32_t total_available_margin = config->height - config->layout.usable_height;

    /* height 1 = top (zero margin), height 8 = bottom (max margin) */
    float mt_f = (float)total_available_margin * ((float)(height - 1) / 7.0f);
    uint32_t mt = (uint32_t)(mt_f + 0.5f);

    /* Clamp to uint16_t and screen bounds so it never goes off-screen */
    if (mt > UINT16_MAX)
        mt = UINT16_MAX;
    tmp.layout.margin_top = (uint16_t)mt;

    /* Keep container fully visible: margin_top + usable_height <= screen height */
    if ((uint32_t)tmp.layout.margin_top + (uint32_t)tmp.layout.usable_height > (uint32_t)tmp.height)
    {
        tmp.layout.margin_top = (tmp.height > tmp.layout.usable_height) ? (tmp.height - tmp.layout.usable_height) : 0;
    }

    display_set_margin_top(tmp.layout.margin_top);

    if (welcome_container != NULL)
    {
        (void)display_apply_container_config(welcome_container, screen, &tmp);
        lv_obj_update_layout(welcome_container);
    }

    if (protobuf_container != NULL)
    {
        (void)display_apply_container_config(protobuf_container, screen, &tmp);
        lv_obj_update_layout(protobuf_container);
    }

    LOG_INF("Applied margin_top=%u (height=%u)", tmp.layout.margin_top, height);
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
        uint8_t len = 1;

        if ((*p & 0x80u) == 0)
        {
            p += 1;
            continue;
        }
        else if ((*p & 0xE0u) == 0xC0u)
        {
            if ((p[1] & 0xC0u) != 0x80u)
            {
                return false;
            }
            code = ((uint32_t)(p[0] & 0x1Fu) << 6) | (uint32_t)(p[1] & 0x3Fu);
            len = 2;
        }
        else if ((*p & 0xF0u) == 0xE0u)
        {
            if ((p[1] & 0xC0u) != 0x80u || (p[2] & 0xC0u) != 0x80u)
            {
                return false;
            }
            code = ((uint32_t)(p[0] & 0x0Fu) << 12) | ((uint32_t)(p[1] & 0x3Fu) << 6) | (uint32_t)(p[2] & 0x3Fu);
            len = 3;
        }
        else if ((*p & 0xF8u) == 0xF0u)
        {
            if ((p[1] & 0xC0u) != 0x80u || (p[2] & 0xC0u) != 0x80u || (p[3] & 0xC0u) != 0x80u)
            {
                return false;
            }
            code = ((uint32_t)(p[0] & 0x07u) << 18) | ((uint32_t)(p[1] & 0x3Fu) << 12) | ((uint32_t)(p[2] & 0x3Fu) << 6)
                   | (uint32_t)(p[3] & 0x3Fu);
            len = 4;
        }
        else
        {
            return false;
        }

        *out_codepoint = code;
        return true;
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
            code = ((uint32_t)(p[0] & 0x07u) << 18) | ((uint32_t)(p[1] & 0x3Fu) << 12) | ((uint32_t)(p[2] & 0x3Fu) << 6)
                   | (uint32_t)(p[3] & 0x3Fu);
            len = 4;
        }

        /* 兼容常见 CJK 字符块 + 常用中日韩标点/全角字符 + 韩文 Hangul */
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

static bool utf8_first_cjk_codepoint(const char *text, uint32_t *out_codepoint)
{
    if (!text || !out_codepoint)
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
                return false;
            }
            code = ((uint32_t)(p[0] & 0x1Fu) << 6) | (uint32_t)(p[1] & 0x3Fu);
            len = 2;
        }
        else if ((*p & 0xF0u) == 0xE0u)
        {
            if ((p[1] & 0xC0u) != 0x80u || (p[2] & 0xC0u) != 0x80u)
            {
                return false;
            }
            code = ((uint32_t)(p[0] & 0x0Fu) << 12) | ((uint32_t)(p[1] & 0x3Fu) << 6) | (uint32_t)(p[2] & 0x3Fu);
            len = 3;
        }
        else if ((*p & 0xF8u) == 0xF0u)
        {
            if ((p[1] & 0xC0u) != 0x80u || (p[2] & 0xC0u) != 0x80u || (p[3] & 0xC0u) != 0x80u)
            {
                return false;
            }
            code = ((uint32_t)(p[0] & 0x07u) << 18) | ((uint32_t)(p[1] & 0x3Fu) << 12) | ((uint32_t)(p[2] & 0x3Fu) << 6)
                   | (uint32_t)(p[3] & 0x3Fu);
            len = 4;
        }

        if ((code >= 0x3400u && code <= 0x9FFFu) || (code >= 0xF900u && code <= 0xFAFFu)
            || (code >= 0x20000u && code <= 0x2EBEFu) || (code >= 0x3000u && code <= 0x303Fu)
            || (code >= 0xFF00u && code <= 0xFFEFu) || (code >= 0x1100u && code <= 0x11FFu)
            || (code >= 0x3130u && code <= 0x318Fu) || (code >= 0xAC00u && code <= 0xD7AFu))
        {
            *out_codepoint = code;
            return true;
        }

        p += len;
    }

    return false;
}

static bool is_cjk_codepoint(uint32_t code)
{
    /* 兼容常见 CJK 字符块 + 常用中日韩标点/全角字符 + 韩文 Hangul */
    return ((code >= 0x3400u && code <= 0x9FFFu) || (code >= 0xF900u && code <= 0xFAFFu)
            || (code >= 0x20000u && code <= 0x2EBEFu) || (code >= 0x3000u && code <= 0x303Fu)
            || (code >= 0xFF00u && code <= 0xFFEFu) || (code >= 0x1100u && code <= 0x11FFu)
            || (code >= 0x3130u && code <= 0x318Fu) || (code >= 0xAC00u && code <= 0xD7AFu));
}

/* Forward declaration for label pool helper */
static lv_obj_t *protobuf_gbk_acquire_label(lv_obj_t *parent, size_t index);

/* 中文字库逐字渲染（汉字/标点/ASCII）；max_width>0 时按宽度自动换行，否则仅按 \\n/\\r 换行 */
static void render_gbk_per_char(lv_obj_t *target_container, lv_coord_t x, lv_coord_t y, lv_coord_t max_width,
                                const char *render_text, const lv_font_t *gbk_font, const lv_font_t *font_primary,
                                lv_color_t text_color, lv_coord_t *out_end_x, lv_coord_t *out_end_y,
                                size_t *out_byte_len)
{
    const uint8_t *p = (const uint8_t *)render_text;
    const uint8_t *p_start = p;
    lv_coord_t cur_x = x;
    lv_coord_t cur_y = y;
    lv_coord_t line_h = (gbk_font ? gbk_font->line_height : 16);
    bool use_pool = (target_container == protobuf_gbk_container);
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
                break;
            code = ((uint32_t)(p[0] & 0x1Fu) << 6) | (uint32_t)(p[1] & 0x3Fu);
            len = 2;
        }
        else if ((*p & 0xF0u) == 0xE0u)
        {
            if ((p[1] & 0xC0u) != 0x80u || (p[2] & 0xC0u) != 0x80u)
                break;
            code = ((uint32_t)(p[0] & 0x0Fu) << 12) | ((uint32_t)(p[1] & 0x3Fu) << 6) | (uint32_t)(p[2] & 0x3Fu);
            len = 3;
        }
        else if ((*p & 0xF8u) == 0xF0u)
        {
            if ((p[1] & 0xC0u) != 0x80u || (p[2] & 0xC0u) != 0x80u || (p[3] & 0xC0u) != 0x80u)
                break;
            code = ((uint32_t)(p[0] & 0x07u) << 18) | ((uint32_t)(p[1] & 0x3Fu) << 12) | ((uint32_t)(p[2] & 0x3Fu) << 6)
                   | (uint32_t)(p[3] & 0x3Fu);
            len = 4;
        }

        if (code == '\n' || code == '\r')
        {
            cur_x = x;
            cur_y += (gbk_font ? gbk_font->line_height : 16);
            p += len;
            continue;
        }

        /* BLE 发什么就显示什么：不转换全角/半角标点 */
        char buf[5] = {0};
        if (code <= 0x7F)
        {
            buf[0] = (char)code;
            buf[1] = '\0';
        }
        else if (len > 0 && len <= 4)
        {
            memcpy(buf, p, len);
            buf[len] = '\0';
        }

        /* 先用当前语言字库，找不到再用辅助字库，实现中英混排。 */
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
            else if (gbk_font && lv_font_get_glyph_dsc(gbk_font, &dsc, (uint32_t)0x3F, 0))
            {
                has_glyph = true;
                active_font = gbk_font;
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
            LOG_WRN("Mixed render: glyph missing U+%04X, fallback to placeholder", (unsigned int)code);
        }

        if (!has_glyph)
        {
            lv_coord_t skip_adv = (code < 0x80u) ? (line_h / 2) : line_h;
            cur_x += skip_adv;
            p += len;
            continue;
        }

        lv_coord_t glyph_w = dsc.box_w;
        if (glyph_w == 0)
        {
            glyph_w = (lv_coord_t)((dsc.adv_w + 15) / 16);
        }

        /* 本字 advance */
        lv_coord_t adv = (lv_coord_t)((dsc.adv_w + 15) / 16);
        if (code >= 0x80u && glyph_w > 0 && (lv_coord_t)glyph_w < adv)
        {
            bool is_fullwidth_punct = (code >= 0x3000u && code <= 0x303Fu) || (code >= 0xFF00u && code <= 0xFFEFu);
            if (is_fullwidth_punct)
            {
                adv = (glyph_w + adv) / 2;
            }
            else
            {
                adv = glyph_w + 2;
            }
        }

        /* 按宽度自动换行：max_width>0 且本字超出右边界时换行 */
        if (max_width > 0 && (cur_x + adv) > max_width)
        {
            cur_x = x;
            cur_y += line_h;
        }

        lv_obj_t *lbl;
        if (use_pool)
        {
            lbl = protobuf_gbk_acquire_label(target_container, label_index);
            if (lbl == NULL)
            {
                LOG_WRN("GBK per-char: label pool exhausted at %u", (unsigned int)label_index);
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

    if (out_end_x)
    {
        *out_end_x = cur_x;
    }
    if (out_end_y)
    {
        *out_end_y = cur_y;
    }
    if (out_byte_len)
    {
        *out_byte_len = (size_t)(p - p_start);
    }

    // if (!use_pool)
    // {
    //     lv_obj_invalidate(target_container);
    // }

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

static lv_color_t color_from_rgb565(uint32_t color)
{
    uint16_t c = (uint16_t)color;
    uint8_t r = (c >> 11) & 0x1F;
    uint8_t g = (c >> 5) & 0x3F;
    uint8_t b = c & 0x1F;
    return lv_color_make((uint8_t)((r * 255U) / 31U), (uint8_t)((g * 255U) / 63U), (uint8_t)((b * 255U) / 31U));
}

/* 尝试提交待显示的 Protobuf 文本，返回是否成功提交（已提交但未必已渲染）。如果因节流而未提交，则根据 schedule_retry_if_throttled 决定是否安排后续重试。 */
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

        if (last_protobuf_text_valid && strcmp(latest_text, last_protobuf_text) == 0)
        {
            s_pt_dedup_skip_count++;
            return false;
        }

        update_protobuf_text_content(latest_text, pending_seq);
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

/* 多行 + 大字重：先刷新 label 布局，再按「标签底边贴视口底」滚动（仅依赖 get_scroll_bottom 易停在中间段） */
static void protobuf_scroll_ascii_label_bottom_visible(void)
{
    if (protobuf_container == NULL || protobuf_label == NULL)
    {
        return;
    }
    if (lv_obj_has_flag(protobuf_label, LV_OBJ_FLAG_HIDDEN))
    {
        return;
    }

    lv_obj_update_layout(protobuf_label);
    lv_obj_update_layout(protobuf_container);

    const lv_coord_t view_h = lv_obj_get_content_height(protobuf_container);
    const lv_coord_t ly = lv_obj_get_y(protobuf_label);
    const lv_coord_t lh = lv_obj_get_height(protobuf_label);
    lv_coord_t target = ly + lh - view_h;

    if (target < 0)
    {
        target = 0;
    }
    lv_obj_scroll_to_y(protobuf_container, target, LV_ANIM_OFF);
}

/* 在自动滚动容器中更新 protobuf 文本内容 / Update protobuf text content in the auto-scroll container */
static void update_protobuf_text_content(const char *text_content, uint32_t committed_seq)
{
    char render_text[PROTOBUF_TEXT_MAX_CHARS] = {0};

    if (!text_content)
    {
        LOG_ERR("Invalid text content pointer");
        return;
    }

    protobuf_text_prepare_for_render(text_content, render_text, sizeof(render_text));

    /* 内容与上次完全一致则跳过 */
    if (last_protobuf_text_valid && strcmp(render_text, last_protobuf_text) == 0)
    {
        return;
    }

    ensure_protobuf_scene_ready();

    if (!protobuf_container || !protobuf_label)
    {
        LOG_ERR("Protobuf container not initialized");
        return;
    }

    welcome_screen_active = false;
    display_scene_set_mode(DISPLAY_SCENE_MODE_CAPTION);
    if (welcome_container != NULL)
    {
        lv_obj_add_flag(welcome_container, LV_OBJ_FLAG_HIDDEN);
    }
#if defined(CONFIG_LVGL)
    protobuf_container_set_welcome_scroll(false);
#endif

    hide_and_clear_protobuf_xy_overlay();

    bool ascii_only = utf8_is_ascii_only(render_text);
    bool has_cjk = utf8_contains_cjk(render_text);

#if defined(CONFIG_LVGL)
    /* 临时屏蔽双语/中文逐字渲染：业务仅使用英文显示 */
    if (mos_binfont_get_current_language() != MOS_FONT_LANG_EN_US)
    {
        mos_font_size_t target_size = mos_font_get_current_size();
        if (target_size == 0U)
        {
            target_size = MOS_FONT_SIZE_18;
        }
        int switch_ret = mos_font_switch_language(MOS_FONT_LANG_EN_US, target_size);
        if (switch_ret != 0)
        {
            LOG_WRN("Force binfont to EN failed (lang=%u size=%u): %d", (unsigned int)MOS_FONT_LANG_EN_US,
                    (unsigned int)target_size, switch_ret);
        }
    }
#endif

    /* 按当前语言优先渲染：双语/中文逐字渲染暂时屏蔽（只走 label 路径）。 */
    if (0 && has_cjk)
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
            int switch_ret = mos_font_switch_language(preferred_lang, target_size);
            if (switch_ret == 0)
            {
                LOG_INF("Auto-switch binfont to lang=%u size=%u for multilingual text", (unsigned int)preferred_lang,
                        (unsigned int)target_size);
            }
            else
            {
                LOG_WRN("Auto-switch binfont failed (lang=%u size=%u): %d", (unsigned int)preferred_lang,
                        (unsigned int)target_size, switch_ret);
            }
        }

        const lv_font_t *gbk_font = display_get_font("gbk");
        const display_config_t *display_cfg = display_get_config();
        const lv_font_t *font_primary = NULL;
        if (display_cfg != NULL)
        {
            /* 辅助字库使用内置 secondary，避免与动态字库重复。 */
            font_primary = display_cfg->fonts.secondary;
        }

        /* Debug: 确认当前 binfont(通常是 zh_cn) 是否覆盖英文 ASCII。
         * 若缺失，则英文只能走 LVGL 18px secondary 兜底（除非未来支持同时保留中/英两套 binfont 实例）。 */
        if (gbk_font != NULL)
        {
            lv_font_glyph_dsc_t probe_dsc;
            bool has_ascii_A = lv_font_get_glyph_dsc(gbk_font, &probe_dsc, (uint32_t)'A', 0);
            bool has_ascii_q = lv_font_get_glyph_dsc(gbk_font, &probe_dsc, (uint32_t)'?', 0);
            LOG_DBG("CJK render: binfont lang=%u size=%u has_ascii_A=%d has_ascii_?=%d @%p",
                    (unsigned int)mos_binfont_get_current_language(), (unsigned int)mos_binfont_get_current_size(),
                    (int)has_ascii_A, (int)has_ascii_q, (void *)gbk_font);
        }

        if (gbk_font && has_cjk)
        {
            uint32_t probe_code = 0;
            lv_font_glyph_dsc_t probe_dsc;
            if (utf8_first_non_ascii_codepoint(render_text, &probe_code)
                && !lv_font_get_glyph_dsc(gbk_font, &probe_dsc, probe_code, 0))
            {
#if defined(CONFIG_LV_FONT_SIMSUN_16_CJK)
                LOG_WRN("CJK probe miss U+%04X on gbk font @%p, skip reload (simsun fallback enabled)",
                        (unsigned int)probe_code, (void *)gbk_font);
#else
                uint32_t now_ms = k_uptime_get_32();
                if ((now_ms - s_last_cjk_probe_reload_ms) >= CJK_PROBE_RELOAD_COOLDOWN_MS)
                {
                    s_last_cjk_probe_reload_ms = now_ms;
                    LOG_WRN("CJK probe miss U+%04X on current gbk font @%p, reloading binfont (cooldown %u ms)",
                            (unsigned int)probe_code, (void *)gbk_font, (unsigned int)CJK_PROBE_RELOAD_COOLDOWN_MS);
                    mos_binfont_lvgl_deinit();
                    gbk_font = mos_binfont_get_lvgl_font();
                    if (gbk_font != NULL)
                    {
                        if (lv_font_get_glyph_dsc(gbk_font, &probe_dsc, probe_code, 0))
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

        if (protobuf_gbk_container && gbk_font && has_cjk)
        {
            lv_obj_align(protobuf_gbk_container, LV_ALIGN_TOP_LEFT, 0, PROTOBUF_BLE_LABEL_YOFF);
            /* Use per-character GBK rendering for UTF-8 CJK text in protobuf path. */
            render_gbk_per_char(protobuf_gbk_container, 0, 0, lv_obj_get_content_width(protobuf_gbk_container),
                                render_text, gbk_font, font_primary, display_get_text_color(), NULL, NULL, NULL);

            lv_obj_clear_flag(protobuf_gbk_container, LV_OBJ_FLAG_HIDDEN);
            lv_obj_add_flag(protobuf_label, LV_OBJ_FLAG_HIDDEN);

            lv_obj_update_layout(protobuf_gbk_container);
            lv_obj_scroll_to_y(protobuf_gbk_container, lv_obj_get_scroll_bottom(protobuf_gbk_container), LV_ANIM_OFF);

            strncpy(last_protobuf_text, render_text, sizeof(last_protobuf_text) - 1U);
            last_protobuf_text[sizeof(last_protobuf_text) - 1U] = '\0';
            last_protobuf_text_valid = true;
            LOG_INF("[RENDER][CAPTION] commit seq=%u raw_len=%u render_len=%u scene=%d pattern=%d hidden=%d",
                    committed_seq, (unsigned int)strlen(text_content), (unsigned int)strlen(render_text),
                    (int)display_scene_get_mode(), display_scene_get_pattern(),
                    (int)lv_obj_has_flag(protobuf_gbk_container, LV_OBJ_FLAG_HIDDEN));
            return;
        }
    }

    if (protobuf_gbk_container)
    {
        lv_obj_add_flag(protobuf_gbk_container, LV_OBJ_FLAG_HIDDEN);
    }
    lv_obj_clear_flag(protobuf_label, LV_OBJ_FLAG_HIDDEN);

    /* 清空并更新：用新 protobuf 内容替换现有文本 / CLEAR AND UPDATE: Replace existing text with new protobuf content */
#if defined(CONFIG_LVGL)
    /* 对纯英文/ASCII：不要依赖当前 binfont（可能切到 zh_cn 后 ASCII 字形缺失），
     * 直接用内置 secondary（通常包含基础拉丁字符）。 */
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
                lv_obj_set_style_text_font(protobuf_label, display_cfg->fonts.secondary, 0);
            }
        }
    }
#endif
#if defined(CONFIG_LV_FONT_SIMSUN_16_CJK)
    /* label 路径需要额外兜底：当 binfont/g bk 字库不可用或探测失败时，至少保证 CJK 字形可显示 */
    if (has_cjk)
    {
        lv_obj_set_style_text_font(protobuf_label, &lv_font_simsun_16_cjk, 0);
    }
#endif
    lv_label_set_text(protobuf_label, render_text);

    /* 与欢迎屏一致：容器内容区顶左 + y；字号/行距由 apply_font 写入 style */
    lv_obj_align(protobuf_label, LV_ALIGN_TOP_LEFT, 0, PROTOBUF_BLE_LABEL_YOFF);

    protobuf_scroll_ascii_label_bottom_visible();

    /* Normal protobuf text updates need an explicit visible redraw hint as well.
     * Otherwise the LVGL object tree may have the latest text while the panel stays
     * on an older frame until another command forces a refresh. */
    lv_obj_invalidate(protobuf_label);
    if (protobuf_container != NULL)
    {
        lv_obj_invalidate(protobuf_container);
    }
    lvgl_force_one_refresh = true;

    strncpy(last_protobuf_text, render_text, sizeof(last_protobuf_text) - 1U);
    last_protobuf_text[sizeof(last_protobuf_text) - 1U] = '\0';
    last_protobuf_text_valid = true;
    LOG_INF("[RENDER][CAPTION] commit seq=%u raw_len=%u render_len=%u scene=%d pattern=%d hidden=%d", committed_seq,
            (unsigned int)strlen(text_content), (unsigned int)strlen(render_text), (int)display_scene_get_mode(),
            display_scene_get_pattern(), (int)lv_obj_has_flag(protobuf_label, LV_OBJ_FLAG_HIDDEN));
}

/* 用当前电量重建欢迎标签文案（60s 刷新）；仅由 LVGL 线程调用 / Rebuild welcome label text with current battery (60s
 * refresh); call from LVGL thread only */
static void update_welcome_label_with_battery(void)
{
    /* 仅当欢迎屏激活时刷新；不覆盖 BLE/其它内容 / Only refresh when welcome screen is active; do not overwrite
     * BLE/other content */
    if (!welcome_screen_active)
    {
        return;
    }
    if (!display_scene_is_welcome_active())
    {
        return;
    }

    /* 欢迎界面初始化期间不更新 / Skip update during welcome screen initialization */
    if (welcome_screen_initializing)
    {
        return;
    }

    ensure_pattern4_scene_ready();

    if (!welcome_label)
    {
        return;
    }

    hide_and_clear_protobuf_xy_overlay();

    const display_config_t *config = display_get_config();
    static char welcome_buf[160];

#if defined(CONFIG_LVGL)
    /* 先确保当前字库已懒加载，再按 mos_binfont_get_current_language() 组欢迎文案 */
    welcome_apply_preferred_font(welcome_label);
    build_welcome_screen_text(welcome_buf, sizeof(welcome_buf), config);
#else
    const char *device_name = get_ble_device_name();
    uint32_t battery_pct = protobuf_get_battery_level();
    bool charging = protobuf_get_charging_state();
    if (config->width >= 500)
    {
        snprintf(welcome_buf, sizeof(welcome_buf),
                 "Welcome to MentraOS\n"
                 "Build V1.2.3 %s %s\n"
                 "Waiting for connection\n"
                 "Device Name: %s %s\n"
                 "Battery: %s %u%%",
                 __DATE__, __TIME__, get_ble_icon(), device_name, get_battery_icon(battery_pct, charging),
                 (unsigned int)battery_pct);
    }
    else
    {
        snprintf(welcome_buf, sizeof(welcome_buf),
                 "Welcome to MentraOS\n"
                 "Build V1.2.3 %s %s\n"
                 "Waiting for connection\n"
                 "Device: %s %s\n"
                 "Battery: %s %u%%",
                 __DATE__, __TIME__, get_ble_icon(), device_name, get_battery_icon(battery_pct, charging),
                 (unsigned int)battery_pct);
    }
#endif

    /* 文案未变化时不重复 set_text / 不刷 INFO 日志，避免欢迎界面日志刷屏 */
    if (s_last_welcome_text_valid && (strncmp(s_last_welcome_text, welcome_buf, sizeof(s_last_welcome_text)) == 0))
    {
        return;
    }

    lv_label_set_text(welcome_label, welcome_buf);
    strncpy(s_last_welcome_text, welcome_buf, sizeof(s_last_welcome_text) - 1U);
    s_last_welcome_text[sizeof(s_last_welcome_text) - 1U] = '\0';
    s_last_welcome_text_valid = true;
}

static void welcome_battery_work_handler(struct k_work *work)
{
    display_cmd_t cmd = {.type = LCD_CMD_UPDATE_WELCOME_BATTERY};
    mos_msgq_send(&lvgl_display_msgq, &cmd,
                  (int64_t)100); /* 100 ms 超时；bal_os 使用 int64_t ms / 100 ms timeout; bal_os uses int64_t ms */
    k_work_schedule((struct k_work_delayable *)work, K_MSEC(WELCOME_BATTERY_REFRESH_MS));
}

/* Pattern 4 & 5：处理 XY 定位文本及字号控制 / Pattern 4 & 5 - Handle XY positioned text with font size control */
static void update_xy_positioned_text(uint16_t x, uint16_t y, const char *text_content, uint16_t font_size,
                                      uint32_t color)
{
    /* 必须仅在 LVGL 线程上下文中调用 / SAFETY: This function must only be called from LVGL thread context */
    if (!text_content)
    {
        LOG_ERR("Invalid XY text content pointer");
        return;
    }

    /* 标记不再显示欢迎界面，防止定时器覆盖测试内容 / Mark as non-welcome screen to prevent timer from overwriting test
     * content */
    welcome_screen_active = false;
    display_scene_set_mode(DISPLAY_SCENE_MODE_XY);

    lv_obj_t *target_container = NULL;

    /* 同时支持 Pattern 4（滚动容器）与 Pattern 5（XY 定位容器）/ Support both Pattern 4 (scrolling container) and
     * Pattern 5 (XY positioning container) */
    if (xy_text_container)
    {
        /* Pattern 5：XY 文本定位区域 / Pattern 5: XY Text Positioning Area */
        target_container = xy_text_container;
        LOG_INF("Using Pattern 5 XY text container");
    }
    else if (protobuf_xy_overlay_container)
    {
        /* Pattern 4：走独立 overlay，避免误删共享 protobuf/welcome 对象。 */
        target_container = protobuf_xy_overlay_container;
        LOG_INF("Using Pattern 4 XY overlay container");
    }
    else
    {
        /* Fallback: 直接渲染到screen / Fallback: render directly to screen */
        LOG_WRN("No container available, rendering directly to screen");
        target_container = lv_screen_active();
    }

#if defined(CONFIG_LVGL)
    if (protobuf_container != NULL && target_container == protobuf_xy_overlay_container)
    {
        protobuf_container_set_welcome_scroll(false);
    }
#endif

    /* 优化：仅当容器有子对象时才清理，避免不必要的循环 */
    /* Optimization: Only clean if container has children to avoid unnecessary loop */
    /* Ensure container clears to background to avoid ghosting */
    lv_obj_set_style_bg_color(target_container, display_get_background_color(), 0);
    lv_obj_set_style_bg_opa(target_container, LV_OPA_COVER, 0);
    if (lv_obj_get_child_cnt(target_container) > 0)
    {
        /* 使用 lv_obj_clean() 直接清空容器，LVGL v9自动处理资源释放 */
        /* Use lv_obj_clean() to clear container - LVGL v9 handles resource cleanup automatically */
        lv_obj_clean(target_container);
        current_xy_text_label = NULL;
        if (target_container == protobuf_xy_overlay_container)
        {
            lv_obj_clear_flag(protobuf_xy_overlay_container, LV_OBJ_FLAG_HIDDEN);
        }
        LOG_DBG("Cleared %d text labels from container", lv_obj_get_child_cnt(target_container));
    }
    else if (target_container == protobuf_xy_overlay_container)
    {
        lv_obj_clear_flag(protobuf_xy_overlay_container, LV_OBJ_FLAG_HIDDEN);
    }

    /* 校验坐标在容器范围内（580x420 可用区，10px 内边距）/ Validate coordinates within container bounds (580x420
     * usable, 10px padding) */
    const uint16_t max_x = 580; /* 600 - (2 * 10px 内边距)/ 600 - (2 * 10px padding) */
    const uint16_t max_y = 420; /* 440 - (2 * 10px 内边距)/ 440 - (2 * 10px padding) */

    LOG_INF("📍 Original XY: (%u,%u), max bounds: (%u,%u)", x, y, max_x, max_y);

    if (x >= max_x || y >= max_y)
    {
        LOG_WRN("XY coordinates out of bounds: (%u,%u) - max is (%u,%u)", x, y, max_x, max_y);
        /* 钳制到有效范围 / Clamp to valid range */
        x = (x >= max_x) ? max_x - 50 : x; /* 为文本留空 / Leave some space for text */
        y = (y >= max_y) ? max_y - 30 : y;
        LOG_WRN("📍 Clamped to: (%u,%u)", x, y);
    }

    bool use_gbk = true;
    bool use_gbk_chars = true;
    bool force_cjk = false;
    const char *render_text = text_content;
    /* 协议前缀 [cjk]/[cjkchars] 与手机端约定，此处走 GBK 字库 */
    if (strncmp(text_content, "[cjkchars]", 10) == 0)
    {
        force_cjk = true;
        render_text = text_content + 10;
        while (*render_text == ' ')
        {
            render_text++;
        }
        LOG_INF("GBK per-char mode detected, text='%.30s'", render_text);
    }
    else if (strncmp(text_content, "[cjk]", 5) == 0)
    {
        force_cjk = true;
        render_text = text_content + 5;
        while (*render_text == ' ')
        {
            render_text++;
        }
        LOG_INF("GBK mode detected, text='%.30s'", render_text);
    }

    /* 非 CJK 文字默认不走 GBK，留给 secondary/primary 字体处理 */
    if (!force_cjk && !utf8_contains_cjk(render_text))
    {
        use_gbk = false;
        use_gbk_chars = false;
    }

    const lv_font_t *font = use_gbk ? display_get_font("gbk") : display_get_font("secondary");
    if (!font)
    {
        LOG_WRN("%s font not available, falling back to primary font", use_gbk ? "gbk" : "secondary");
        font = display_get_font("primary"); /* 回退到主显示字体 / Fallback to primary display font */
    }
    /* GBK字库已加载，移除探针代码以避免性能开销 */
    if (use_gbk && font)
    {
        LOG_INF("Using GBK font @%p for rendering: '%.20s'", font, render_text);
    }
    lv_color_t text_color = color_from_rgb565(color);
    if (color == 0xFFFFu)
    {
        lv_color_t bg = display_get_background_color();
        uint16_t avg = (uint16_t)bg.red + (uint16_t)bg.green + (uint16_t)bg.blue;
        text_color = (avg > (3u * 128u)) ? lv_color_black() : lv_color_white();
        LOG_INF("Auto text color: bg=(%u,%u,%u) -> %s", bg.red, bg.green, bg.blue,
                (avg > (3u * 128u)) ? "black" : "white");
    }

    if (use_gbk_chars && font)
    {
        /* 不按宽度自动换行：max_width=0，仅按 \n/\r 换行，与手机 app 一致 */
        render_gbk_per_char(target_container, x, y, 0, render_text, font, NULL, text_color, NULL, NULL, NULL);
        lv_obj_invalidate(target_container);
    }
    else
    {
        /* 创建新的定位文本标签 / Create new positioned text label */
        current_xy_text_label = lv_label_create(target_container);
        lv_label_set_text(current_xy_text_label, render_text);

        /* 应用字体与样式：使用自适应文字颜色 / Apply font and styling: adaptive text color */
        lv_obj_set_style_text_font(current_xy_text_label, font, 0);
        lv_obj_set_style_text_color(current_xy_text_label, text_color, 0);
        lv_obj_set_style_bg_opa(current_xy_text_label, LV_OPA_TRANSP, 0); /* 透明背景 / Transparent background */

        /* 设置自动换行与宽度约束 / Set text wrapping and width constraints */
        lv_label_set_long_mode(current_xy_text_label, LV_LABEL_LONG_WRAP);
        lv_obj_set_width(current_xy_text_label, max_x - x); /* 在剩余宽度内换行 / Wrap within remaining width */

        /* 在指定坐标放置文本（相对容器内边距）/ Position the text at specified coordinates (relative to container
         * padding)
         */
        lv_obj_set_pos(current_xy_text_label, x, y);
    }

    const char *pattern_name = (target_container == xy_text_container) ? "Pattern 5" : "Pattern 4";
    const char *font_name = use_gbk ? "gbk" : "secondary";
    LOG_INF("📝 [%s] Cleared all text, positioned new at (%u,%u), %s_font, color:0x%06X: %.30s%s", pattern_name, x, y,
            font_name, color, render_text, strlen(render_text) > 30 ? "..." : "");

    /* 标记重绘，避免在回调中强制刷新导致卡死 */
    if (current_xy_text_label)
    {
        lv_obj_invalidate(current_xy_text_label);
    }

    /* Ensure refresh isn't frozen by previous tests */
    lvgl_freeze_refresh = false;
    lvgl_force_one_refresh = true;
    lvgl_min_refresh_ms = 100;
}

/* Simple GBK test: create a single label once and reuse it (minimal layout work) */
static void show_gbk_chars_test(void)
{
    /* Use UTF-8 byte escapes to avoid source encoding ambiguity */
    static const char *k_gbk_chars[] = {
        "\xE4\xBD\xA0", /* 你 */
        "\xE5\xA5\xBD", /* 好 */
        "!", /* ! */
        "\xE6\xAC\xA2", /* 欢 */
        "\xE8\xBF\x8E", /* 迎 */
        "\xE8\xBF\x9B", /* 进 */
        "\xE5\x85\xA5", /* 入 */
        "\xE5\xBC\x80", /* 开 */
        "\xE5\x8F\x91", /* 发 */
        "\xE8\x80\x85", /* 者 */
        "\xE6\xA8\xA1", /* 模 */
        "\xE5\xBC\x8F", /* 式 */
    };
    /* Unicode codepoints for width measurement */
    static const uint32_t k_gbk_codepoints[] = {
        0x4F60, 0x597D, 0x0021, 0x6B22, 0x8FCE, 0x8FDB, 0x5165, 0x5F00, 0x53D1, 0x8005, 0x6A21, 0x5F0F,
    };
    static lv_obj_t *gbk_chars_screen = NULL;
    static lv_obj_t *gbk_char_labels[ARRAY_SIZE(k_gbk_chars)] = {0};

    printk("GBK_TEST: start\r\n");
    LOG_INF("GBK_TEST: start");

    /* Disable welcome screen updates to avoid overwriting the test label */
    welcome_screen_active = false;
    display_scene_set_mode(DISPLAY_SCENE_MODE_TEST);
    k_work_cancel_delayable(&welcome_battery_work);

    if (!gbk_chars_screen)
    {
        printk("GBK_TEST: create screen\r\n");
        gbk_chars_screen = lv_obj_create(NULL);
        if (!gbk_chars_screen)
        {
            LOG_ERR("GBK_TEST: lv_obj_create(screen) failed");
            return;
        }
        lv_obj_set_style_bg_color(gbk_chars_screen, display_get_background_color(), 0);
        lv_obj_set_style_bg_opa(gbk_chars_screen, LV_OPA_COVER, 0);

        printk("GBK_TEST: create labels\r\n");
        for (size_t i = 0; i < ARRAY_SIZE(k_gbk_chars); i++)
        {
            gbk_char_labels[i] = lv_label_create(gbk_chars_screen);
            if (!gbk_char_labels[i])
            {
                LOG_ERR("GBK_TEST: lv_label_create failed at %u", (unsigned int)i);
                return;
            }
            lv_obj_set_style_text_color(gbk_char_labels[i], display_get_text_color(), 0);
        }
    }

    printk("GBK_TEST: screen load\r\n");
    lv_screen_load(gbk_chars_screen);
    printk("GBK_TEST: set text\r\n");

    const lv_font_t *font = display_get_font("gbk");
    if (!font)
    {
        font = display_get_font("primary");
    }
    if (!font)
    {
        LOG_ERR("GBK_TEST: no font available");
        return;
    }

    /* Center a horizontal row of per-character labels */
    lv_display_t *disp = lv_display_get_default();
    lv_coord_t disp_w = disp ? lv_display_get_horizontal_resolution(disp) : 640;
    lv_coord_t disp_h = disp ? lv_display_get_vertical_resolution(disp) : 480;

    /* Compute total width from glyph advances */
    lv_coord_t total_w = 0;
    for (size_t i = 0; i < ARRAY_SIZE(k_gbk_chars); i++)
    {
        lv_font_glyph_dsc_t dsc;
        lv_coord_t adv = (font && lv_font_get_glyph_dsc(font, &dsc, k_gbk_codepoints[i], 0))
                             ? (lv_coord_t)((dsc.adv_w + 15) / 16)
                             : 24;
        total_w += adv + 4;
    }
    if (total_w > 0)
        total_w -= 4;

    lv_coord_t start_x = (disp_w > total_w) ? (disp_w - total_w) / 2 : 0;
    lv_coord_t y = (disp_h > font->line_height) ? (disp_h - font->line_height) / 2 : 0;

    lv_coord_t x = start_x;
    for (size_t i = 0; i < ARRAY_SIZE(k_gbk_chars); i++)
    {
        if (gbk_char_labels[i])
        {
            lv_obj_set_style_text_font(gbk_char_labels[i], font, 0);
            lv_label_set_text_static(gbk_char_labels[i], k_gbk_chars[i]);

            lv_font_glyph_dsc_t dsc;
            lv_coord_t adv = (font && lv_font_get_glyph_dsc(font, &dsc, k_gbk_codepoints[i], 0))
                                 ? (lv_coord_t)((dsc.adv_w + 15) / 16)
                                 : 24;
            lv_obj_set_pos(gbk_char_labels[i], x, y);
            x += adv + 4;
        }
    }

    /* Throttle refresh to avoid starving shell when rendering GBK */
    lvgl_min_refresh_ms = 200;
    lvgl_force_one_refresh = true;
    lvgl_freeze_refresh = true;

    /* Lower LVGL thread priority to keep shell responsive */
    if (lvgl_thread_handle != NULL)
    {
        k_thread_priority_set(lvgl_thread_handle, LVGL_THREAD_PRIORITY + 4);
    }

    LOG_INF("GBK_TEST: end");
}

/* Simple GBK test: centered full sentence */
static void show_gbk_test_text(void)
{
    /* Use UTF-8 byte escapes to avoid source encoding ambiguity */
    static const char *k_gbk_text =
        "\xE4\xB8\xAD\xE5\x8D\x8E\xE4\xBA\xBA\xE5\x90\x8D\xE5\x85\xB1\xE5\x92\x8C\xE5\x9B\xBD!!!";
    static lv_obj_t *gbk_screen = NULL;

    printk("GBK_TEST: start\r\n");
    LOG_INF("GBK_TEST: start");

    /* Disable welcome screen updates to avoid overwriting the test label */
    welcome_screen_active = false;
    display_scene_set_mode(DISPLAY_SCENE_MODE_TEST);
    k_work_cancel_delayable(&welcome_battery_work);

    if (!gbk_screen)
    {
        printk("GBK_TEST: create screen\r\n");
        gbk_screen = lv_obj_create(NULL);
        if (!gbk_screen)
        {
            LOG_ERR("GBK_TEST: lv_obj_create(screen) failed");
            return;
        }
        lv_obj_set_style_bg_color(gbk_screen, display_get_background_color(), 0);
        lv_obj_set_style_bg_opa(gbk_screen, LV_OPA_COVER, 0);
    }

    /* show_test_pattern 可能已删掉 gbk_screen 子控件并把 gbk_test_label 置 NULL / May be cleared after pattern switch
     */
    if (!gbk_test_label)
    {
        printk("GBK_TEST: create label\r\n");
        gbk_test_label = lv_label_create(gbk_screen);
        if (!gbk_test_label)
        {
            LOG_ERR("GBK_TEST: lv_label_create failed");
            return;
        }
        lv_obj_set_style_text_color(gbk_test_label, display_get_text_color(), 0);

        printk("GBK_TEST: get font\r\n");
        const lv_font_t *font = display_get_font("gbk");
        if (!font)
        {
            font = display_get_font("primary");
        }
        if (!font)
        {
            LOG_ERR("GBK_TEST: no font available");
            return;
        }
        lv_obj_set_style_text_font(gbk_test_label, font, 0);
        lv_label_set_long_mode(gbk_test_label, LV_LABEL_LONG_WRAP);
        lv_obj_set_width(gbk_test_label, 600);
        lv_obj_align(gbk_test_label, LV_ALIGN_CENTER, 0, 0);
    }

    printk("GBK_TEST: screen load\r\n");
    lv_screen_load(gbk_screen);
    printk("GBK_TEST: set text\r\n");
    lv_label_set_text_static(gbk_test_label, k_gbk_text);
    lv_obj_move_foreground(gbk_test_label);
    lv_obj_invalidate(gbk_test_label);

    /* Throttle refresh to avoid starving shell when rendering GBK */
    lvgl_min_refresh_ms = 200;
    lvgl_force_one_refresh = true;
    lvgl_freeze_refresh = true;

    /* Lower LVGL thread priority to keep shell responsive */
    if (lvgl_thread_handle != NULL)
    {
        k_thread_priority_set(lvgl_thread_handle, LVGL_THREAD_PRIORITY + 4);
    }

    LOG_INF("GBK_TEST: end");
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
                    LOG_INF("LCD_CMD_OPEN - Simplified Init (Vendor Recommendation)");
                    a6n_power_on();
                    set_display_onoff(true);

                    /* 配置 Bank1 0x55 寄存器，关闭 Demura / Configure Bank1 0x55 - Disable Demura */
                    LOG_INF("🔧 Configuring Bank1 registers...");
                    a6n_write_reg(1, 0x55, 0x00); /* Bank1 0x55 = 0x00 (Demura 关闭 / Demura disabled) */
                    mos_delay_us(6);
                    a6n_write_reg(0, 0xD0, 0x0a); /* 鸿石 FAE 推荐配置 / Configure as recommended by Hongshi FAE */
                    mos_delay_us(6);

                    a6n_read_reg(0, 0, 0x62);
                    mos_delay_us(6);
                    a6n_read_reg(0, 1, 0x62);
                    mos_delay_us(6);
                    a6n_read_reg(0, 1, 0xf7);
                    mos_delay_us(6);
                    a6n_read_reg(0, 1, 0xf8);
                    mos_delay_us(6);
                    a6n_read_reg(0, 1, 0xe2);
                    mos_delay_us(6);

                    /* 配置 Bank0 寄存器 50%=127/255 / Configure Bank0 registers (50% = 127/255) */
                    /* a6n_set_brightness(0x7f); */
                    /* 初始亮度 30% / Set initial brightness to 30% */
                    mos_brightness_request_manual(30); /* 0-100 */
                    mos_delay_us(6);

                    /* 设置显示格式为 GRAY16 (4-bit) / Set display format to GRAY16 (4-bit) */
                    a6n_set_gray16_mode(); /* Bank0 0xBE = 0x84 */
                    mos_delay_us(6);

                    /* 设置水平镜像模式 / Set horizontal mirror mode */
                    int mirror_ret = a6n_set_mirror(MIRROR_HORZ);
                    if (mirror_ret < 0)
                    {
                        LOG_ERR("Failed to set mirror mode: %d", mirror_ret);
                    }
                    mos_delay_us(6);
                    a6n_read_reg(0, 1, 0xbe); /* Bank0 右光机 0xbe 寄存器 / Bank0, right engine, 0xbe register */
                    mos_delay_us(6);

                    a6n_write_reg(0, 0x60, 0x80); /* Bank0 0x60 = 0x80（待确认功能）/ Bank0 0x60 = 0x80 (TBD) */
                    mos_delay_us(6);

                    /* 配置自刷新帧率 90Hz (SPI≤32MHz) / Configure self-refresh rate to 90Hz (SPI≤32MHz) */
                    a6n_write_reg(0, 0x78, 0x0E); /* Bank0 OSC 时钟配置 / OSC clock config */
                    mos_delay_us(6);
                    a6n_write_reg(0, 0x7C, 0x13); /* Bank0 OSC 时钟配置 90Hz / OSC clock config (90Hz) */
                    mos_delay_us(6);

                    LOG_INF("LCD init complete - GRAY16 mode + 90Hz refresh rate configured");
                    mos_delay_ms(2);

                    /* 在打开显示前清屏，避免可见闪烁 / Clear screen BEFORE opening display to avoid visible flash */
                    /* A6N 上电后必须做一次全屏清屏才能正常工作 / A6N requires full screen clear after power-on for
                     * proper operation */
                    a6n_clear_screen(false);

                    mos_delay_ms(20);
                    /* 现在打开显示，屏幕已清屏无闪烁 / Now open display - screen already cleared, no flash */
                    a6n_open_display();

                    state_type = LCD_STATE_ON;

                    LOG_INF("🚀 About to call show_default_ui()...");
                    show_default_ui();
                    LOG_INF("✅ show_default_ui() completed");

                    LOG_INF("📊 Current pattern: %d", current_pattern);
                    LOG_INF("📊 protobuf_label: %p", (void *)protobuf_label);
                    LOG_INF("📊 welcome_screen_active: %d", welcome_screen_active);

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
                case LCD_CMD_UPDATE_XY_TEXT:
                    /* 处理 Pattern 5 的 XY 定位文本更新 / Handle XY positioned text updates for Pattern 5 */
                    LOG_INF("LCD_CMD_UPDATE_XY_TEXT - XY positioned text at (%u,%u)", cmd.p.xy_text.x, cmd.p.xy_text.y);
                    update_xy_positioned_text(cmd.p.xy_text.x, cmd.p.xy_text.y, cmd.p.xy_text.text,
                                              cmd.p.xy_text.font_size, cmd.p.xy_text.color);
                    break;
                case LCD_CMD_GBK_TEST:
                    LOG_INF("LCD_CMD_GBK_TEST - Show simple GBK test label");
                    show_gbk_test_text();
                    LOG_INF("LCD_CMD_GBK_TEST - Done");
                    break;
                case LCD_CMD_GBK_CHARS_TEST:
                    LOG_INF("LCD_CMD_GBK_CHARS_TEST - Show per-character GBK test");
                    show_gbk_chars_test();
                    LOG_INF("LCD_CMD_GBK_CHARS_TEST - Done");
                    break;
                case LCD_CMD_UPDATE_WELCOME_BATTERY:
                    /* 用当前电量刷新欢迎标签（60s 周期）/ Refresh welcome label with current battery (60s period) */
                    update_welcome_label_with_battery();
                    break;
                case LCD_CMD_SHOW_WELCOME_SCREEN:
                    /* 蓝牙断开后重新进入欢迎界面：隐藏 BLE 文案区，显示欢迎标签并刷新电量 */
                    welcome_screen_active = true;
                    display_scene_set_mode(DISPLAY_SCENE_MODE_WELCOME);
                    reset_display_text_caches();
                    restore_welcome_screen_state();
                    update_welcome_label_with_battery();
                    LOG_INF("📱 Welcome screen shown (BLE disconnected)");
                    break;
                case LCD_CMD_UPDATE_DFU_PROGRESS:
                    // 显示/隐藏并更新 DFU 进度条：前景条宽度 = 百分比，随 % 滑动
                    // Progress bar: fill width = percent and moves with %; show/hide based on flag
                    if (dfu_progress_bar != NULL && dfu_progress_fill != NULL)
                    {
                        if (cmd.p.dfu_progress.show)
                        {
                            lv_obj_clear_flag(dfu_progress_bar, LV_OBJ_FLAG_HIDDEN);
                            lv_coord_t fill_w = (dfu_progress_bar_w * (lv_coord_t)cmd.p.dfu_progress.percent) / 100;
                            if (fill_w < 0)
                            {
                                fill_w = 0;
                            }
                            lv_obj_set_width(dfu_progress_fill, fill_w);
                            lv_obj_invalidate(dfu_progress_bar);
                        }
                        else
                        {
                            lv_obj_add_flag(dfu_progress_bar, LV_OBJ_FLAG_HIDDEN);
                        }
                    }
                    break;
                case LCD_CMD_UPDATE_DFU_STATUS_TEXT:
                    /* 电量下面一行：显示/隐藏 DFU 状态文字 | Show/hide DFU status line below battery */
                    if (dfu_status_label != NULL)
                    {
                        if (cmd.p.protobuf_text.text[0] == '\0')
                        {
                            lv_obj_add_flag(dfu_status_label, LV_OBJ_FLAG_HIDDEN);
                        }
                        else
                        {
                            lv_label_set_text(dfu_status_label, cmd.p.protobuf_text.text);
                            lv_obj_clear_flag(dfu_status_label, LV_OBJ_FLAG_HIDDEN);
                        }
                    }
                    break;
                case LCD_CMD_CLEAR_DISPLAY:
                {
                    clear_current_display_text();
                    break;
                }
                case LCD_CMD_CLOSE:
                    if (get_display_onoff())
                    {
                        /* a6n_clear_screen(false); 清屏 / Clear screen */
                        /* lv_timer_handler(); scroll_text_stop(); set_display_onoff(false); a6n_power_off(); */
                    }
                    state_type = LCD_STATE_OFF;
                    break;
                case LCD_CMD_TEXT:
                {
                    // lv_obj_t *scr = lv_disp_get_scr_act(lv_disp_get_default());
                    lv_obj_t *lbl = lv_label_create(lv_screen_active());
                    lv_label_set_text(lbl, cmd.p.text.text);
                    // lv_label_set_text(lbl, "Hello, world lvgl!"); //test
                    lv_obj_set_style_text_color(lbl, lv_color_white(), LV_PART_MAIN);
#if defined(CONFIG_LVGL)
                    lv_obj_set_style_text_font(lbl, mos_font_storage_get_lvgl_font(),
                                               LV_PART_MAIN); /* 使用动态字体 / Use dynamic font */
                    add_dynamic_font_label(lbl);
#endif
                    lv_obj_set_pos(lbl, cmd.p.text.x, cmd.p.text.y);
                }
                break;
                case LCD_CMD_GRAYSCALE_HORIZONTAL:
                    /* 直接 A6N 横向灰度图案 / Handle direct A6N horizontal grayscale pattern */
                    /* LOG_INF("LCD_CMD_GRAYSCALE_HORIZONTAL - Drawing true 8-bit horizontal grayscale"); */
                    // if (a6n_draw_horizontal_grayscale_pattern() != 0)
                    // {
                    //     LOG_ERR("Failed to draw horizontal grayscale pattern");
                    // }
                    // break;
                case LCD_CMD_GRAYSCALE_VERTICAL:
                    /* 直接 A6N 纵向灰度图案 / Handle direct A6N vertical grayscale pattern */
                    /* LOG_INF("LCD_CMD_GRAYSCALE_VERTICAL - Drawing true 8-bit vertical grayscale"); */
                    // if (a6n_draw_vertical_grayscale_pattern() != 0)
                    // {
                    //     LOG_ERR("Failed to draw vertical grayscale pattern");
                    // }
                    // break;
                case LCD_CMD_CHESS_PATTERN:
                    /* 直接 A6N 棋盘图案 / Handle direct A6N chess pattern */
                    /* LOG_INF("LCD_CMD_CHESS_PATTERN - Drawing chess board pattern"); */
                    // if (a6n_draw_chess_pattern() != 0)
                    // {
                    //     LOG_ERR("Failed to draw chess pattern");
                    // }
                    // break;
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
                    lv_obj_invalidate(lv_screen_active());
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
