#include <math.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/display.h>
#include <zephyr/kernel.h>

#include "lvgl_display.h"
#include <display/lcd/a6n.h>
#include <zephyr/logging/log.h>

#include "bal_os.h"
#include "display_translation_view.h"
#include "display_config.h"
#include "display_scene.h"
#include "display_view_support.h"
#include "display_welcome_view.h"
#include "display_xy_view.h"
#include "display_test_view.h"
#include "ui_font_policy.h"
#include "ui_framework.h"
#include "ui_lvgl_adapter.h"
#include "ui_pages.h"
#include "ui_runtime.h"
#include "translation_pipeline.h"
#include "main.h"
#include "mos_brightness.h"
#include "mos_lvgl_display.h"
#include "protobuf_handler.h"
#include "mos_binfont_lvgl.h"
#include "mos_font_storage.h"
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
static volatile bool lvgl_force_one_refresh = false; /* Force one refresh on next loop / 强制下一轮刷新一次 */
static uint32_t s_refresh_reasons = 0U;
/*
 * The next generic text commit should land on which text page.
 *
 * This is the small piece of runtime state that separates:
 * - generic protobuf text -> caption page
 * - explicit translation text -> translation page
 * 下一次通用文本提交应该落到哪个文本页面。
 *
 * 它就是当前用来区分这两条路径的那一点运行时状态：
 * - 通用 protobuf 文本 -> caption 页
 * - 显式 translation 文本 -> translation 页
 */
static volatile ui_page_type_t s_pending_text_target_page = UI_PAGE_CAPTION;

typedef enum
{
    DISPLAY_REFRESH_REASON_BUDGET = (1U << 0),
    DISPLAY_REFRESH_REASON_MESSAGE = (1U << 1),
    DISPLAY_REFRESH_REASON_TRANSLATION = (1U << 2),
    DISPLAY_REFRESH_REASON_CAPTION = DISPLAY_REFRESH_REASON_TRANSLATION, /* Legacy alias */
} display_refresh_reason_t;

static void display_request_refresh(display_refresh_reason_t reason)
{
    s_refresh_reasons |= (uint32_t)reason;
}

static uint32_t display_consume_refresh_reasons(void)
{
    uint32_t reasons = s_refresh_reasons;
    s_refresh_reasons = 0U;
    return reasons;
}

/* Labels that should be refreshed when the dynamic font changes. / 动态字体切换时需要一起刷新的标签列表。 */
static lv_obj_t *s_dynamic_font_labels[16] = {0};
static int s_dynamic_font_label_count = 0;

static void restore_welcome_screen_state(void);
static void update_welcome_label_with_battery(void);
static void update_protobuf_text_content(const char *text_content, uint32_t committed_seq);
static void reset_display_text_caches(void);
static void clear_current_display_text(void);
static void protobuf_container_set_welcome_scroll(bool welcome_active);

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

/* Track a label in the dynamic-font list. / 将标签加入动态字体跟踪列表。 */
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

void display_ui_register_dynamic_label(lv_obj_t *label)
{
    add_dynamic_font_label(label);
}

void display_ui_unregister_dynamic_label(lv_obj_t *label)
{
    remove_dynamic_font_label(label);
}

void display_ui_request_refresh(void)
{
    lvgl_force_one_refresh = true;
}

/* Font-switch callback.
 * This callback may run outside the LVGL thread, so it only enqueues work.
 * 字体切换回调。
 * 该回调可能运行在 LVGL 线程之外，因此这里只负责入队，不直接调用 LVGL API。
 */
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
            /* welcome label on welcome screen is handled later by update_welcome_label_with_battery().
             * 欢迎屏的 welcome_label 稍后通过 update_welcome_label_with_battery() 统一处理。 */
            if (display_welcome_view_is_active() && s_dynamic_font_labels[i] == display_welcome_view_get_label())
            {
                LOG_DBG("Skipping relayout for welcome_label (welcome screen active)");
                continue;
            }
            dynamic_label_relayout_text(s_dynamic_font_labels[i]);
        }

        /* CJK per-character pool uses old glyph height for coordinates.
         * Full-text relayout with the new font is required to avoid overlap artifacts.
         * CJK 逐字池坐标按旧字高排版；必须整段用新字库重排，否则会重叠错乱。 */
        display_translation_view_invalidate_last_text();
        if (display_welcome_view_is_active() && !display_welcome_view_is_initializing())
        {
            update_welcome_label_with_battery();
            if (display_translation_view_get_gbk_container() != NULL)
            {
                lv_obj_add_flag(display_translation_view_get_gbk_container(), LV_OBJ_FLAG_HIDDEN);
            }
            if (display_welcome_view_get_label() != NULL)
            {
                lv_obj_clear_flag(display_welcome_view_get_label(), LV_OBJ_FLAG_HIDDEN);
            }
        }
        else
        {
            /* Even when last text is empty, relayout is still required.
             * Otherwise old CJK per-char layer may remain visible with stale coordinates.
             * last 为空也必须重跑：否则会保留 CJK 逐字层可见，坐标仍按旧字高，与新分区字模叠在一起。 */
            if (display_translation_view_has_last_text())
            {
                update_protobuf_text_content(display_translation_view_get_last_text(), 0U);
            }
        }

        if (display_welcome_view_get_container() != NULL && display_welcome_view_is_active())
        {
            lv_obj_update_layout(display_welcome_view_get_container());
        }

        if (display_translation_view_get_container() != NULL)
        {
            lv_obj_update_layout(display_translation_view_get_container());
            if (display_welcome_view_is_active())
            {
                protobuf_container_set_welcome_scroll(true);
            }
            else
            {
                protobuf_container_set_welcome_scroll(false);
                display_translation_view_scroll_bottom_visible();
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

static uint32_t lvgl_min_refresh_ms = 10;
static volatile bool lvgl_freeze_refresh = false;
/* Business translation language pair (default en<->zh).
 * This is business metadata for translation features, not the protobuf input channel itself.
 * 业务翻译语种对（默认英中互译）。
 * 它描述翻译业务的语义语言对，不等于 protobuf 输入通道本身。
 */
static display_biz_lang_t s_biz_src_lang = DISPLAY_DEFAULT_TRANSLATION_SRC_LANG;
static display_biz_lang_t s_biz_dst_lang = DISPLAY_DEFAULT_TRANSLATION_DST_LANG;

#define WELCOME_BATTERY_REFRESH_MS (60 * 1000)
static struct k_work_delayable welcome_battery_work;
/* Forward declaration for k_work_init_delayable.
 * 前向声明，供 k_work_init_delayable 使用。 */
static void welcome_battery_work_handler(struct k_work *work);

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
    lv_obj_set_style_text_font(label, mos_font_storage_get_lvgl_font(), 0); /* Use dynamic font / 使用动态字体 */
    add_dynamic_font_label(label);
    lv_obj_set_style_bg_color(lv_screen_active(), display_get_background_color(), 0);
}

/* Display on/off state helpers. / 显示开关状态辅助函数。 */
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
    display_cmd_t cmd = {.type = LCD_CMD_NOTIFY_LANGUAGE_CHANGED};
    (void)mos_msgq_send(&lvgl_display_msgq, &cmd, (int64_t)50);
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
    display_cmd_t cmd = {.type = LCD_CMD_OPEN, .p.open = {.brightness = 9, .mirror = 0x08}};
    mos_msgq_send(&lvgl_display_msgq, &cmd, MOS_OS_WAIT_FOREVER);
}

void display_close(void)
{
    /* Reserved for future close-time cleanup. / 为后续关闭时清理预留。 */
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

void display_show_caption_screen(void)
{
    s_pending_text_target_page = UI_PAGE_CAPTION;

    display_cmd_t cmd = {.type = LCD_CMD_SHOW_CAPTION_SCREEN};
    int ret = mos_msgq_send(&lvgl_display_msgq, &cmd, 100);
    if (ret != 0)
    {
        LOG_WRN("Failed to enqueue caption screen command (error: %d)", ret);
    }
}

void display_show_translation_screen(void)
{
    s_pending_text_target_page = UI_PAGE_TRANSLATION;

    display_cmd_t cmd = {.type = LCD_CMD_SHOW_TRANSLATION_SCREEN};
    int ret = mos_msgq_send(&lvgl_display_msgq, &cmd, 100);
    if (ret != 0)
    {
        LOG_WRN("Failed to enqueue translation screen command (error: %d)", ret);
    }
}

void display_reset_protobuf_text_state(void)
{
    translation_pipeline_reset();

    LOG_INF("Reset protobuf/display-text state (pending + de-dup cache cleared)");
}

void display_reset_translation_text_state(void)
{
    display_reset_protobuf_text_state();
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
        .type = LCD_CMD_CYCLE_PATTERN,
        .p.pattern = {.pattern_id = DISPLAY_PATTERN_FIRST} /* Determined by LVGL thread / 由 LVGL 线程决定 */
    };
    mos_msgq_send(&lvgl_display_msgq, &cmd, MOS_OS_WAIT_FOREVER);
}

void display_show_test_pattern(display_pattern_id_t pattern_id)
{
    if (!display_pattern_id_is_valid((int)pattern_id))
    {
        LOG_WRN("Ignore invalid test pattern id: %d", (int)pattern_id);
        return;
    }

    display_cmd_t cmd = {
        .type = LCD_CMD_SHOW_PATTERN,
        .p.pattern = {.pattern_id = pattern_id},
    };
    mos_msgq_send(&lvgl_display_msgq, &cmd, MOS_OS_WAIT_FOREVER);
}

void display_update_height(uint16_t height)
{
    display_cmd_t cmd = {.type = LCD_CMD_UPDATE_HEIGHT, .p.height = {.height = height}};
    mos_msgq_send(&lvgl_display_msgq, &cmd, MOS_OS_WAIT_FOREVER);
}

/* Thread-safe generic protobuf/display-text update: ingest pending text, then wake LVGL thread.
 * Current production flow routes this generic text input to the caption page.
 * 线程安全通用 protobuf/显示文本更新：写入待显示文本，并唤醒 LVGL 线程。
 * 当前生产路径会把这类通用文本输入路由到 caption 页。 */
void display_update_protobuf_text(const char *text_content)
{
    s_pending_text_target_page = UI_PAGE_CAPTION;
    translation_pipeline_ingest(text_content);

    display_cmd_t cmd = {.type = LCD_CMD_UPDATE_PROTOBUF_TEXT};
    int ret = mos_msgq_send(&lvgl_display_msgq, &cmd, (int64_t)50);
    if (ret != 0)
    {
        LOG_WRN("Failed to enqueue translation text update (error: %d)", ret);
    }
}

void display_update_translation_text(const char *text_content)
{
    s_pending_text_target_page = UI_PAGE_TRANSLATION;
    translation_pipeline_ingest(text_content);

    display_cmd_t cmd = {.type = LCD_CMD_UPDATE_PROTOBUF_TEXT};
    int ret = mos_msgq_send(&lvgl_display_msgq, &cmd, (int64_t)50);
    if (ret != 0)
    {
        LOG_WRN("Failed to enqueue translation text update (error: %d)", ret);
    }
}

void display_submit_text_payload(uint16_t x, uint16_t y, const char *text_content, uint16_t font_size, uint32_t color)
{
    if (ui_runtime_page_is_active(UI_PAGE_TEXT_XY))
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

/* XY text positioning, thread-safe.
 * XY 文本定位，线程安全。 */
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

void display_submit_ui_event(const ui_event_t *event)
{
    if (event == NULL || event->type == UI_EVENT_NONE)
    {
        return;
    }

    display_cmd_t cmd = {.type = LCD_CMD_UI_EVENT, .p.ui_event = {.event = *event}};
    int ret = mos_msgq_send(&lvgl_display_msgq, &cmd, (int64_t)50);
    if (ret != 0)
    {
        LOG_WRN("Failed to enqueue UI event %d (error: %d)", (int)event->type, ret);
    }
}

void display_send_frame(void *data_ptr)
{
    ARG_UNUSED(data_ptr);
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
    lv_obj_set_style_text_font(hello_world_label, mos_font_storage_get_lvgl_font(),
                               0); /* Use dynamic font / 使用动态字体 */
    add_dynamic_font_label(hello_world_label);
    lv_obj_set_style_bg_color(lv_screen_active(), display_get_background_color(), 0);
}
static lv_timer_t *counter_timer; /* Timer handle only. / 仅保存定时器句柄。 */
static lv_obj_t *acc_label;
static lv_obj_t *gyr_label;
static void counter_timer_cb(lv_timer_t *timer)
{
    ARG_UNUSED(timer);
}

void ui_create(void)
{
    acc_label = lv_label_create(lv_screen_active());
    lv_obj_align(acc_label, LV_TEXT_ALIGN_LEFT, 0, 320);
    gyr_label = lv_label_create(lv_screen_active());
    lv_obj_align(gyr_label, LV_TEXT_ALIGN_LEFT, 0, 380);

    lv_obj_set_style_text_color(acc_label, display_get_text_color(), 0); /* Adaptive text color / 自适应文字颜色 */
    lv_obj_set_style_text_font(acc_label, mos_font_storage_get_lvgl_font(), 0); /* Use dynamic font / 使用动态字体 */
    add_dynamic_font_label(acc_label);
    lv_obj_set_style_text_color(gyr_label, display_get_text_color(), 0); /* Adaptive text color / 自适应文字颜色 */
    lv_obj_set_style_text_font(gyr_label, mos_font_storage_get_lvgl_font(), 0); /* Use dynamic font / 使用动态字体 */
    add_dynamic_font_label(gyr_label);
    lv_obj_set_style_bg_color(lv_screen_active(), display_get_background_color(), 0);
    /* Create periodic timer; pass count pointer via user_data.
     * 创建周期定时器，count 指针经 user_data 传入。 */
    static int count = 0;
    counter_timer = lv_timer_create(counter_timer_cb, 300, &count);
    /* 300 ms period, callback triggers each cycle / 300 为毫秒，回调每次触发 */
}

static lv_obj_t *cont = NULL;
static lv_anim_t anim;

/* Animation callback: scroll container vertically to v pixels.
 * 动画回调：将容器纵向滚动到 v 像素。 */
static void scroll_cb(void *var, int32_t v)
{
    LV_UNUSED(var);
    lv_obj_scroll_to_y(cont, v, LV_ANIM_OFF);
}

void scroll_text_create(lv_obj_t *parent, lv_coord_t x, lv_coord_t y, lv_coord_t w, lv_coord_t h, const char *txt,
                        const lv_font_t *font, uint32_t time_ms)
{
    /* Remove old area.
     * 移除旧区域。 */
    scroll_text_stop();

    /* Create scrollable container.
     * 创建可滚动容器。 */
    cont = lv_obj_create(parent);
    lv_obj_set_size(cont, w, h);
    lv_obj_set_pos(cont, x, y);
    lv_obj_set_scroll_dir(cont, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(cont, LV_SCROLLBAR_MODE_OFF);
    /* Set adaptive background color for container.
     * 设置容器背景为自适应背景色。 */
    lv_obj_set_style_bg_color(cont, display_get_background_color(), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(cont, LV_OPA_COVER, LV_PART_MAIN);

    /* Create label inside container.
     * 在容器中创建标签。 */
    lv_obj_t *label = lv_label_create(cont);
    lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(label, w);
    lv_label_set_text(label, txt);

    /* Set adaptive text color and specified font.
     * 设置文字为自适应颜色和指定字体。 */
    lv_obj_set_style_text_color(label, display_get_text_color(), LV_PART_MAIN);
    lv_obj_set_style_text_font(label, font, LV_PART_MAIN);

    /* Force label relayout to obtain accurate content height.
     * 强制标签布局更新，获取正确内容高度。 */
    lv_obj_update_layout(label);
    int32_t label_h = lv_obj_get_height(label);
    /* Scroll range = label height - container height.
     * 滚动范围 = 标签高度 - 容器高度。 */
    int32_t range = label_h - h;
    if (range <= 0)
        return;

    /* Initialize and start round-trip scroll animation.
     * 初始化并启动往返滚动动画。 */
    lv_anim_init(&anim);
    lv_anim_set_var(&anim, cont);
    lv_anim_set_exec_cb(&anim, scroll_cb);
    lv_anim_set_time(&anim, time_ms);
    lv_anim_set_values(&anim, 0, range);
    /* lv_anim_set_playback_duration(&anim, time_ms); Playback duration / 反向动画时间 */
    lv_anim_set_repeat_count(&anim, LV_ANIM_REPEAT_INFINITE);
    lv_anim_start(&anim);
}

void scroll_text_stop(void)
{
    if (cont)
    {
        lv_anim_del(cont, scroll_cb);
        lv_obj_del(cont);
        cont = NULL;
    }
}
/* 前向声明 / Forward declarations */
static void show_test_pattern(display_pattern_id_t pattern_id);

static void show_default_ui(void)
{
    const display_pattern_id_t welcome_pattern = ui_pages_default_pattern_for_page(UI_PAGE_WELCOME);

    LOG_INF("🖼️ Starting with scrolling 'Welcome to MentraOS NExFirmware!' text...");
    LOG_INF("🖼️ show_default_ui() called, pattern will be set to %d", welcome_pattern);

    /* Start from the default text-container page; shell diagnostic IDs remain 0..5. */
    show_test_pattern(welcome_pattern);

    LOG_INF("🖼️ Scrolling welcome message complete - should see animated text");
    LOG_INF("🖼️ welcome_label after init: %p", (void *)display_welcome_view_get_label());
}

/* 欢迎屏：关闭父容器垂直滚动并把 scroll_y 清零。隐藏的大号 protobuf_gbk_container 仍参与内容高度时，
 * 开着滚动会导致视口落在错误区间；BLE/转写文案再打开垂直滚动。 */
static void protobuf_container_set_welcome_scroll(bool welcome_active)
{
    display_translation_view_set_welcome_scroll(welcome_active);
}

/* Welcome-screen state reset:
 * hide BLE/CJK content, show the shared welcome label, restore container scroll mode,
 * and request one redraw. This is separate from text refresh on purpose.
 * 欢迎界面状态恢复：隐藏 BLE/CJK 内容、显示欢迎标签、恢复容器滚动模式并请求重绘。
 * 故意与欢迎文案刷新分离。 */
static void restore_welcome_screen_state(void)
{
    display_translation_view_destroy();
    display_welcome_view_restore(lv_screen_active());
}

static void create_scrolling_text_container(lv_obj_t *screen)
{
    display_welcome_view_ensure(screen);
    k_work_init_delayable(&welcome_battery_work, welcome_battery_work_handler);
    k_work_schedule(&welcome_battery_work, K_MSEC(WELCOME_BATTERY_REFRESH_MS));
}

static void display_prepare_welcome_page(lv_obj_t *screen)
{
    create_scrolling_text_container(screen);
}

static void display_refresh_welcome_page(void)
{
    update_welcome_label_with_battery();
}

static void display_render_translation_page(const char *text_content, uint32_t committed_seq)
{
    update_protobuf_text_content(text_content, committed_seq);
}

static int display_show_caption_page(void)
{
    int route_ret = ui_runtime_show_caption(NULL, NULL);
    if (route_ret != 0)
    {
        LOG_WRN("Failed to route caption page: %d", route_ret);
        display_welcome_view_set_active(false);
    }

    return route_ret;
}

static int display_show_translation_page(void)
{
    int route_ret = ui_runtime_show_translation(NULL, NULL);
    if (route_ret != 0)
    {
        LOG_WRN("Failed to route translation page: %d", route_ret);
        display_welcome_view_set_active(false);
    }

    return route_ret;
}

/* 获取当前图案 ID 供条件逻辑使用 / Get current pattern ID for conditional logic */
int display_get_current_pattern(void)
{
    return ui_runtime_current_pattern();
}

bool display_is_welcome_screen_active(void)
{
    return ui_runtime_page_is_active(UI_PAGE_WELCOME) && display_welcome_view_is_active();
}

/* lv_obj_del 子控件后，文件内缓存的 lv_obj_t* 全部悬空；必须清零，否则 BLE/protobuf 与 DFU 路径会 UAF。 */
static void tear_down_screen_child_global_refs(void)
{
    k_work_cancel_delayable(&welcome_battery_work);

    display_welcome_view_detach();
    display_translation_view_detach();
    display_xy_view_detach();
    display_test_view_detach();

    memset(s_dynamic_font_labels, 0, sizeof(s_dynamic_font_labels));
    s_dynamic_font_label_count = 0;

    ui_runtime_mark_test_context();
}

static void reset_display_text_caches(void)
{
    translation_pipeline_reset();
    display_welcome_view_reset_text_cache();
}

static void clear_current_display_text(void)
{
    /* ClearDisplay 只清空当前活跃容器的显示内容，不删除当前活跃容器本身。 */
    bool clearing_welcome = display_welcome_view_is_active();

    reset_display_text_caches();
    display_welcome_view_set_active(clearing_welcome);

    if (clearing_welcome)
    {
        display_welcome_view_clear();
    }
    else
    {
        display_translation_view_clear();
    }

    if (display_xy_view_get_container() != NULL)
    {
        display_xy_view_clear();
    }

    lv_obj_invalidate(lv_screen_active());
    lvgl_force_one_refresh = true;
}

static void show_test_pattern(display_pattern_id_t pattern_id)
{
    ui_lvgl_page_context_t page_context;
    int route_ret;

    if (!display_pattern_id_is_valid((int)pattern_id))
    {
        LOG_ERR("❌ Unknown pattern ID: %d", pattern_id);
        return;
    }

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

    page_context.screen = screen;
    page_context.pattern_id = pattern_id;
    route_ret = ui_runtime_show_test_pattern(pattern_id, &page_context);
    if (route_ret != 0)
    {
        LOG_ERR("Failed to show test pattern %d: %d", pattern_id, route_ret);
        return;
    }
}

/** 仅标脏当前 pattern 下的根容器，用于软件视差等驱动参数变更后“刷新当前画面”而尽量不整屏刷 */
static void invalidate_current_visible_ui(void)
{
    lv_obj_t *screen = lv_screen_active();

    switch (ui_runtime_current_pattern())
    {
        case DISPLAY_PATTERN_TEXT_CONTAINER:
            display_welcome_view_invalidate_visible();
            display_translation_view_invalidate_visible();
            break;
        case DISPLAY_PATTERN_XY_TEXT:
            display_xy_view_invalidate_visible();
            break;
        default:
        {
            /* Diagnostic patterns attach dynamic children directly to screen. */
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

    display_pattern_id_t next_pattern =
        (display_pattern_id_t)((ui_runtime_current_pattern() + 1) % DISPLAY_PATTERN_COUNT);
    LOG_INF("Pattern #%d", next_pattern); /* 简要日志 / Minimal log */
    show_test_pattern(next_pattern);
}

static void update_display_height(uint16_t height)
{
    if (height > 8)
        height = 8;

    LOG_INF("update_display_height - Thread-safe height update: %u", height);

    if (display_welcome_view_get_container() == NULL && display_translation_view_get_container() == NULL &&
        display_xy_view_get_container() == NULL)
    {
        LOG_WRN("Display scene containers not initialized");
        return;
    }

    lv_obj_t *screen = lv_screen_active();
    const display_config_t *config = display_get_config();

    /* Make a mutable copy of the current config */
    display_config_t tmp = *config;

    /* ABSOLUTE mapping: margin_top = 20 * height (no + / -) */
    uint32_t mt = (config->height - config->layout.usable_height) - (20u * (uint32_t)height);

    /* Clamp to uint16_t and screen bounds so it never goes off-screen */
    if (mt > UINT16_MAX)
        mt = UINT16_MAX;
    tmp.layout.margin_top = (uint16_t)mt;

    /* Keep container fully visible: margin_top + usable_height <= screen height */
    if ((uint32_t)tmp.layout.margin_top + (uint32_t)tmp.layout.usable_height > (uint32_t)tmp.height)
    {
        tmp.layout.margin_top = (tmp.height > tmp.layout.usable_height) ? (tmp.height - tmp.layout.usable_height) : 0;
    }

    display_welcome_view_apply_config(screen, &tmp);
    display_translation_view_apply_config(screen, &tmp);
    display_xy_view_apply_config(screen, &tmp);

    LOG_INF("Applied margin_top=%u (height=%u)", tmp.layout.margin_top, height);
}

/* 在自动滚动容器中更新 protobuf 文本内容 / Update protobuf text content in the auto-scroll container */
static void update_protobuf_text_content(const char *text_content, uint32_t committed_seq)
{
    /*
     * Both caption and translation currently reuse the same low-level text view.
     * The target page is chosen here before the shared renderer is called.
     * caption 和 translation 当前共用同一套底层文本视图。
     * 因此先在这里决定目标页面，再调用共享渲染实现。
     */
    if (s_pending_text_target_page == UI_PAGE_TRANSLATION)
    {
        (void)display_show_translation_page();
    }
    else
    {
        (void)display_show_caption_page();
    }

    display_translation_view_render_text(text_content, committed_seq, s_biz_src_lang, s_biz_dst_lang,
                                     display_welcome_view_get_container());
}

/* 用当前电量重建欢迎标签文案（60s 刷新）；仅由 LVGL 线程调用 / Rebuild welcome label text with current battery (60s
 * refresh); call from LVGL thread only */
static void update_welcome_label_with_battery(void)
{
    display_welcome_view_update_battery();
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
    display_welcome_view_set_active(false);
    (void)ui_runtime_show_xy(NULL, NULL);
    if (display_translation_view_get_container() != NULL && display_translation_view_get_xy_overlay_container() != NULL)
    {
        protobuf_container_set_welcome_scroll(false);
    }

    display_xy_view_update_text(x, y, text_content, font_size, color,
                                display_translation_view_get_xy_overlay_container(),
                                display_translation_view_get_container(), NULL);

    /* Ensure refresh isn't frozen by previous tests */
    lvgl_freeze_refresh = false;
    lvgl_force_one_refresh = true;
    lvgl_min_refresh_ms = 100;
}

/* Simple GBK test: create a single label once and reuse it (minimal layout work) */
static void show_gbk_chars_test(void)
{
    display_welcome_view_set_active(false);
    ui_runtime_mark_test_context();
    k_work_cancel_delayable(&welcome_battery_work);
    display_test_view_show_gbk_chars();
    lvgl_min_refresh_ms = 200;
    lvgl_force_one_refresh = true;
    lvgl_freeze_refresh = true;
    if (lvgl_thread_handle != NULL)
    {
        k_thread_priority_set(lvgl_thread_handle, LVGL_THREAD_PRIORITY + 4);
    }
}

/* Simple GBK test: centered full sentence */
static void show_gbk_test_text(void)
{
    display_welcome_view_set_active(false);
    ui_runtime_mark_test_context();
    k_work_cancel_delayable(&welcome_battery_work);
    display_test_view_show_gbk_text();
    lvgl_min_refresh_ms = 200;
    lvgl_force_one_refresh = true;
    lvgl_freeze_refresh = true;
    if (lvgl_thread_handle != NULL)
    {
        k_thread_priority_set(lvgl_thread_handle, LVGL_THREAD_PRIORITY + 4);
    }
}

static void handle_open_command(display_state_t *state_type)
{
    LOG_INF("LCD_CMD_OPEN - Simplified Init (Vendor Recommendation)");
    a6n_power_on();
    set_display_onoff(true);

    LOG_INF("🔧 Configuring Bank1 registers...");
    a6n_write_reg(1, 0x55, 0x00);
    mos_delay_us(6);
    a6n_write_reg(0, 0xD0, 0x0a);
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

    mos_brightness_request_manual(30);
    mos_delay_us(6);

    a6n_set_gray16_mode();
    mos_delay_us(6);

    int mirror_ret = a6n_set_mirror(MIRROR_HORZ);
    if (mirror_ret < 0)
    {
        LOG_ERR("Failed to set mirror mode: %d", mirror_ret);
    }
    mos_delay_us(6);
    a6n_read_reg(0, 1, 0xbe);
    mos_delay_us(6);

    a6n_write_reg(0, 0x60, 0x80);
    mos_delay_us(6);

    a6n_write_reg(0, 0x78, 0x0E);
    mos_delay_us(6);
    a6n_write_reg(0, 0x7C, 0x13);
    mos_delay_us(6);

    LOG_INF("LCD init complete - GRAY16 mode + 90Hz refresh rate configured");
    mos_delay_ms(2);

    a6n_clear_screen(false);
    mos_delay_ms(20);
    a6n_open_display();

    *state_type = LCD_STATE_ON;

    LOG_INF("🚀 About to call show_default_ui()...");
    show_default_ui();
    LOG_INF("✅ show_default_ui() completed");

    LOG_INF("📊 Current pattern: %d", ui_runtime_current_pattern());
    LOG_INF("📊 translation_label: %p", (void *)display_translation_view_get_label());
    LOG_INF("📊 welcome_screen_active: %d", display_welcome_view_is_active());
}

static void handle_pattern_command(const display_cmd_t *cmd)
{
    switch (cmd->type)
    {
        case LCD_CMD_CYCLE_PATTERN:
            LOG_INF("LCD_CMD_CYCLE_PATTERN - Thread-safe pattern cycling");
            cycle_test_pattern();
            break;
        case LCD_CMD_UPDATE_HEIGHT:
            LOG_INF("LCD_CMD_UPDATE_HEIGHT - Thread-safe height update: %u", cmd->p.height.height);
            update_display_height(cmd->p.height.height);
            break;
        case LCD_CMD_SHOW_PATTERN:
            LOG_INF("LCD_CMD_SHOW_PATTERN - Showing pattern %d", cmd->p.pattern.pattern_id);
            show_test_pattern(cmd->p.pattern.pattern_id);
            break;
        case LCD_CMD_GRAYSCALE_HORIZONTAL:
        case LCD_CMD_GRAYSCALE_VERTICAL:
        case LCD_CMD_CHESS_PATTERN:
            /* Reserved direct-pattern commands.
             * 预留给直接图案命令。 */
            break;
        default:
            break;
    }
}

static void handle_text_command(const display_cmd_t *cmd)
{
    switch (cmd->type)
    {
        case LCD_CMD_UPDATE_PROTOBUF_TEXT:
            /*
             * Same text pipeline, different business page.
             * The pending target page tells us whether the queued text should
             * be shown as generic caption text or as translation text.
             * 同一套文本流水线，不同的业务页面。
             * 这里通过待处理目标页来判断，队列里的文本应该落到 caption 还是 translation。
             */
            if (s_pending_text_target_page == UI_PAGE_TRANSLATION)
            {
                (void)display_show_translation_page();
            }
            else
            {
                (void)display_show_caption_page();
            }
            translation_pipeline_service_pending();
            translation_pipeline_log_stats_if_due();
            break;
        case LCD_CMD_SHOW_CAPTION_SCREEN:
            (void)display_show_caption_page();
            break;
        case LCD_CMD_SHOW_TRANSLATION_SCREEN:
            (void)display_show_translation_page();
            break;
        case LCD_CMD_UPDATE_XY_TEXT:
            LOG_INF("LCD_CMD_UPDATE_XY_TEXT - XY positioned text at (%u,%u)", cmd->p.xy_text.x, cmd->p.xy_text.y);
            update_xy_positioned_text(cmd->p.xy_text.x, cmd->p.xy_text.y, cmd->p.xy_text.text, cmd->p.xy_text.font_size,
                                      cmd->p.xy_text.color);
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
        case LCD_CMD_CLEAR_DISPLAY:
            clear_current_display_text();
            break;
        case LCD_CMD_TEXT:
        {
            lv_obj_t *lbl = lv_label_create(lv_screen_active());
            lv_label_set_text(lbl, cmd->p.text.text);
            lv_obj_set_style_text_color(lbl, lv_color_white(), LV_PART_MAIN);
            lv_obj_set_style_text_font(lbl, mos_font_storage_get_lvgl_font(), LV_PART_MAIN);
            add_dynamic_font_label(lbl);
            lv_obj_set_pos(lbl, cmd->p.text.x, cmd->p.text.y);
            break;
        }
        default:
            break;
    }
}

static void handle_welcome_command(const display_cmd_t *cmd)
{
    switch (cmd->type)
    {
        case LCD_CMD_UPDATE_WELCOME_BATTERY:
            update_welcome_label_with_battery();
            break;
        case LCD_CMD_SHOW_WELCOME_SCREEN:
        {
            const display_pattern_id_t welcome_pattern = ui_pages_default_pattern_for_page(UI_PAGE_WELCOME);
            ui_lvgl_page_context_t page_context = {.screen = lv_screen_active(), .pattern_id = welcome_pattern};
            int route_ret;

            reset_display_text_caches();
            route_ret = ui_runtime_show_welcome(&page_context);
            if (route_ret != 0)
            {
                LOG_WRN("Failed to route welcome page: %d", route_ret);
                restore_welcome_screen_state();
            }
            update_welcome_label_with_battery();
            LOG_INF("📱 Welcome screen shown (BLE disconnected)");
            break;
        }
        case LCD_CMD_UPDATE_DFU_PROGRESS:
            if (display_welcome_view_get_dfu_progress_bar() != NULL &&
                display_welcome_view_get_dfu_progress_fill() != NULL)
            {
                if (cmd->p.dfu_progress.show)
                {
                    lv_obj_clear_flag(display_welcome_view_get_dfu_progress_bar(), LV_OBJ_FLAG_HIDDEN);
                    lv_coord_t fill_w =
                        (display_welcome_view_get_dfu_progress_bar_width() * (lv_coord_t)cmd->p.dfu_progress.percent) /
                        100;
                    if (fill_w < 0)
                    {
                        fill_w = 0;
                    }
                    lv_obj_set_width(display_welcome_view_get_dfu_progress_fill(), fill_w);
                    lv_obj_invalidate(display_welcome_view_get_dfu_progress_bar());
                }
                else
                {
                    lv_obj_add_flag(display_welcome_view_get_dfu_progress_bar(), LV_OBJ_FLAG_HIDDEN);
                }
            }
            break;
        case LCD_CMD_UPDATE_DFU_STATUS_TEXT:
            if (display_welcome_view_get_dfu_status_label() != NULL)
            {
                if (cmd->p.protobuf_text.text[0] == '\0')
                {
                    lv_obj_add_flag(display_welcome_view_get_dfu_status_label(), LV_OBJ_FLAG_HIDDEN);
                }
                else
                {
                    lv_label_set_text(display_welcome_view_get_dfu_status_label(), cmd->p.protobuf_text.text);
                    lv_obj_clear_flag(display_welcome_view_get_dfu_status_label(), LV_OBJ_FLAG_HIDDEN);
                }
            }
            break;
        default:
            break;
    }
}

static void handle_system_command(const display_cmd_t *cmd, display_state_t *state_type)
{
    switch (cmd->type)
    {
        case LCD_CMD_INIT:
            break;
        case LCD_CMD_DATA:
            break;
        case LCD_CMD_CLOSE:
            if (get_display_onoff())
            {
                /* Reserved close-time display cleanup.
                 * 预留关闭时显示清理。 */
            }
            *state_type = LCD_STATE_OFF;
            break;
        case LCD_CMD_UPDATE_DYNAMIC_FONT:
            LOG_INF("LCD_CMD_UPDATE_DYNAMIC_FONT - Applying font update in LVGL thread");
            apply_font_update_in_lvgl_thread(cmd->p.font_update.font_ptr);
            break;
        case LCD_CMD_INVALIDATE_FULL_SCREEN:
            lvgl_force_one_refresh = true;
            lv_obj_invalidate(lv_screen_active());
            break;
        case LCD_CMD_INVALIDATE_VISIBLE_UI:
            lvgl_force_one_refresh = true;
            invalidate_current_visible_ui();
            break;
        case LCD_CMD_NOTIFY_LANGUAGE_CHANGED:
            if (ui_framework_notify_language_changed(NULL) != 0)
            {
                LOG_WRN("Current UI page did not handle language change cleanly");
            }
            lvgl_force_one_refresh = true;
            invalidate_current_visible_ui();
            break;
        case LCD_CMD_UI_EVENT:
        {
            int ret = ui_runtime_dispatch_event(&cmd->p.ui_event.event, NULL);
            if (ret != 0 && ret != -ENOSYS && ret != -ENODATA)
            {
                LOG_WRN("UI event %d dispatch failed: %d", (int)cmd->p.ui_event.event.type, ret);
            }
            lvgl_force_one_refresh = true;
            invalidate_current_visible_ui();
            break;
        }
        default:
            break;
    }
}

static void process_display_command(const display_cmd_t *cmd, display_state_t *state_type)
{
    switch (cmd->type)
    {
        case LCD_CMD_OPEN:
            handle_open_command(state_type);
            break;
        case LCD_CMD_CYCLE_PATTERN:
        case LCD_CMD_UPDATE_HEIGHT:
        case LCD_CMD_SHOW_PATTERN:
        case LCD_CMD_GRAYSCALE_HORIZONTAL:
        case LCD_CMD_GRAYSCALE_VERTICAL:
        case LCD_CMD_CHESS_PATTERN:
            handle_pattern_command(cmd);
            break;
        case LCD_CMD_UPDATE_PROTOBUF_TEXT:
        case LCD_CMD_SHOW_CAPTION_SCREEN:
        case LCD_CMD_SHOW_TRANSLATION_SCREEN:
        case LCD_CMD_UPDATE_XY_TEXT:
        case LCD_CMD_GBK_TEST:
        case LCD_CMD_GBK_CHARS_TEST:
        case LCD_CMD_CLEAR_DISPLAY:
        case LCD_CMD_TEXT:
            handle_text_command(cmd);
            break;
        case LCD_CMD_UPDATE_WELCOME_BATTERY:
        case LCD_CMD_SHOW_WELCOME_SCREEN:
        case LCD_CMD_UPDATE_DFU_PROGRESS:
        case LCD_CMD_UPDATE_DFU_STATUS_TEXT:
            handle_welcome_command(cmd);
            break;
        case LCD_CMD_INIT:
        case LCD_CMD_DATA:
        case LCD_CMD_CLOSE:
        case LCD_CMD_UPDATE_DYNAMIC_FONT:
        case LCD_CMD_INVALIDATE_FULL_SCREEN:
        case LCD_CMD_INVALIDATE_VISIBLE_UI:
        case LCD_CMD_NOTIFY_LANGUAGE_CHANGED:
        case LCD_CMD_UI_EVENT:
            handle_system_command(cmd, state_type);
            break;
        default:
            break;
    }
}
/* Initialize display runtime state:
 * config, font callback, scene reset, framework init, text pipeline init, page registration, and display sem sync.
 * 初始化显示运行时状态：
 * 包括配置、字体回调、场景重置、框架初始化、文本流水线初始化、页面注册以及显示信号量同步。
 */
static int initialize_display_runtime(const struct device *display_dev)
{
    ARG_UNUSED(display_dev);

    int config_result = display_config_init();
    if (config_result != 0)
    {
        LOG_ERR("Failed to initialize display configuration: %d", config_result);
        return config_result;
    }

    mos_font_register_change_callback(on_font_changed);

    display_scene_reset();
    ui_framework_init();
    translation_pipeline_init(update_protobuf_text_content);
    translation_pipeline_reset();
    display_welcome_view_reset_state();
    display_translation_view_reset_state();
    display_xy_view_reset_state();
    display_test_view_reset_state();

    const ui_lvgl_adapter_hooks_t adapter_hooks = {
        .prepare_welcome = display_prepare_welcome_page,
        .refresh_welcome = display_refresh_welcome_page,
        .render_translation = display_render_translation_page,
    };
    int page_result = ui_lvgl_adapter_register_pages(&adapter_hooks);
    if (page_result != 0)
    {
        LOG_ERR("Failed to register UI page descriptors: %d", page_result);
        return page_result;
    }

    if (a6n_init_sem_take() != 0)
    {
        LOG_ERR("Failed to a6n_init_sem_take err");
        return -1;
    }

    return 0;
}

void lvgl_display_init(void *p1, void *p2, void *p3)
{
    const struct device *display_dev;
    display_dev = DEVICE_DT_GET(DT_CHOSEN(zephyr_display));
    if (!device_is_ready(display_dev))
    {
        LOG_INF("display_dev Device not ready, aborting test");
        return;
    }

    if (initialize_display_runtime(display_dev) != 0)
    {
        return;
    }

    const display_config_t *config = display_get_config();
    LOG_INF("🖼️ Display configuration loaded: %s (%dx%d)", config->name, config->width, config->height);
    static uint32_t last_refresh_ms;
    display_state_t state_type = LCD_STATE_INIT;
    display_cmd_t cmd;
    display_open();
    while (1)
    {
        /* 到预算了，允许本轮刷一次 / When budgeted, allow one refresh this round */
        if (state_type == LCD_STATE_ON && ((k_uptime_get_32() - last_refresh_ms) >= lvgl_min_refresh_ms))
        {
            display_request_refresh(DISPLAY_REFRESH_REASON_BUDGET);
        }

        /* 处理消息（仍给其它任务时间）/ Handle message (still give other tasks time) */
        int err = mos_msgq_receive(&lvgl_display_msgq, &cmd, LVGL_TICK_MS);
        if (err == 0)
        {
            process_display_command(&cmd, &state_type);
            if (state_type == LCD_STATE_ON)
            {
                display_request_refresh(DISPLAY_REFRESH_REASON_MESSAGE);
            }
        }
        if (state_type == LCD_STATE_ON)
        {
            if (translation_pipeline_service_pending())
            {
                display_request_refresh(DISPLAY_REFRESH_REASON_TRANSLATION);
            }
        }
        bool refresh_requested = (display_consume_refresh_reasons() != 0U); /* Whether a refresh was requested. / 是否已有刷新请求。 */
        if (state_type == LCD_STATE_ON && (refresh_requested || lvgl_force_one_refresh))
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
    lvgl_thread_handle = k_thread_create(&lvgl_thread_data,
        lvgl_stack_area, 
        K_THREAD_STACK_SIZEOF(lvgl_stack_area),                          
        lvgl_display_init, 
        NULL, NULL, NULL, 
        LVGL_THREAD_PRIORITY, 
        0, K_NO_WAIT);
    k_thread_name_set(lvgl_thread_handle, TASK_LVGL_NAME);
}
