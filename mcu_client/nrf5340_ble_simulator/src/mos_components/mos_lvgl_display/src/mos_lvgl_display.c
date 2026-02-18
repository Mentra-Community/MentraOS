/*
 * @Author       : Cole
 * @Date         : 2026-01-30 09:30:43
 * @LastEditTime : 2026-01-31 10:28:20
 * @FilePath     : mos_lvgl_display.c
 * @Description  : 
 * 
 *  Copyright (c) MentraOS Contributors 2026 
 *  SPDX-License-Identifier: Apache-2.0
 */


#include <math.h>
#include <string.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/display.h>
#include <zephyr/kernel.h>

#include "lvgl_display.h"
// #include <lvgl.h>
#include <display/lcd/a6n.h>

#include "bal_os.h"
#include "display_config.h"   
#include "mos_lvgl_display.h"
#include "main.h"             
#include "protobuf_handler.h"

#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(mos_lvgl_display, LOG_LEVEL_DBG);

#define TASK_LVGL_NAME "MOS_LVGL"

#define LVGL_THREAD_STACK_SIZE (4096 * 4)
#define LVGL_THREAD_PRIORITY   6
K_THREAD_STACK_DEFINE(lvgl_stack_area, LVGL_THREAD_STACK_SIZE);
static struct k_thread lvgl_thread_data;
k_tid_t                lvgl_thread_handle;

static K_SEM_DEFINE(lvgl_display_sem, 0, 1);

#define DISPLAY_CMD_QSZ 16
K_MSGQ_DEFINE(lvgl_display_msgq, sizeof(display_cmd_t), DISPLAY_CMD_QSZ, 4);

#define LVGL_TICK_MS 5

static volatile bool display_onoff = false;

/* 全局 protobuf 文本容器引用 / Global references for protobuf text container */
static lv_obj_t *protobuf_container = NULL;
static lv_obj_t *protobuf_label     = NULL;
/* DFU 状态文字（电量下面一行）/ DFU status text (one line below battery) */
static lv_obj_t *dfu_status_label   = NULL;
/* DFU 进度条：容器(背景条) + 前景条(按 % 设宽度)，避免 lv_bar 显示满格问题 | DFU progress: container + fill rect by % */
static lv_obj_t *dfu_progress_bar   = NULL;  /* 背景轨道 / track */
static lv_obj_t *dfu_progress_fill  = NULL;  /* 前景填充，宽度 = 百分比 | fill, width = percent */
static lv_coord_t dfu_progress_bar_w = 0;    /* 轨道宽度，用于算填充宽度 | track width for fill % */

/* 仅欢迎屏时刷新电量；避免覆盖 BLE 等内容 / Only refresh welcome+battery when welcome screen is active; avoid overwriting BLE/other content */
static bool welcome_screen_active = true;

/* Pattern 5 XY 文本定位区域（全局引用）/ Pattern 5 XY Text Positioning Area (Global references) */
static lv_obj_t *xy_text_container     = NULL;  /* 124x60 可视区域，适配 SSD1306 128x64 / 124x60 bordered viewing area for SSD1306 128x64 */
static lv_obj_t *current_xy_text_label = NULL;  /* 当前定位文本标签 / Current positioned text label */


#define WELCOME_BATTERY_REFRESH_MS (60 * 1000)
static struct k_work_delayable welcome_battery_work;
static void welcome_battery_work_handler(struct k_work *work);  /* 前向声明，供 k_work_init_delayable / forward decl for k_work_init_delayable */

void lv_example_scroll_text(void)
{
    /* 创建一个标签 / Create a label */
    lv_obj_t *label = lv_label_create(lv_screen_active());

    /* 设置滚动模式（自动横向滚动）/ Set scroll mode (auto horizontal scroll) */
    /* lv_label_set_long_mode(label, LV_LABEL_LONG_SCROLL); */
    lv_label_set_long_mode(label, LV_LABEL_LONG_SCROLL_CIRCULAR);

    /* 设置标签区域宽度（可视区域）SSD1306 128x64 / Set label width (visible area) SSD1306 128x64 */
    lv_obj_set_width(label, 128);  /* SSD1306 显示宽度（原 640）/ SSD1306 display width (was 640) */

    /* 设置标签位置 SSD1306 128x64 / Set label position SSD1306 128x64 */
    lv_obj_set_pos(label, 0, 50);  /* x/y 位置（大屏曾用 0,410）/ x/y position (was 0, 410 for larger display) */

    /* 设置长文本（会触发滚动）/ Set long text (triggers scrolling) */
    lv_label_set_text(label, "!!!!!nRF5340 + NCS 3.0.0 + LVGL!!!!");

    lv_obj_set_style_text_color(label, display_get_text_color(), 0);  /* 自适应文字颜色 / Use adaptive text color */
    lv_obj_set_style_text_font(label, &lv_font_montserrat_12, 0);  /* 小字体适配 SSD1306（原 48）/ Smaller font for SSD1306 (was 48) */
    lv_obj_set_style_bg_color(lv_screen_active(), display_get_background_color(), 0);
}

/* 显示开关状态管理 / Display on/off state management */
void set_display_onoff(bool state)
{
    display_onoff = state;
}
bool get_display_onoff(void)
{
    return display_onoff;
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
    display_cmd_t cmd = { .type = LCD_CMD_UPDATE_WELCOME_BATTERY };
    (void)mos_msgq_send(&lvgl_display_msgq, &cmd, (int64_t)50);  /* 50 ms 非阻塞 / 50 ms, non-blocking */
}

/* 线程安全：回到欢迎界面（如 BLE 断开后）| Thread-safe: return to welcome screen (e.g. after BLE disconnect) */
void display_show_welcome_screen(void)
{
    display_cmd_t cmd = { .type = LCD_CMD_SHOW_WELCOME_SCREEN };
    (void)mos_msgq_send(&lvgl_display_msgq, &cmd, (int64_t)100);
}

/* 线程安全：更新欢迎界面 DFU 进度条（电量下方）| Thread-safe: update DFU progress bar on welcome screen (below battery) */
void display_update_dfu_progress(uint8_t show, uint8_t percent)
{
    display_cmd_t cmd = {
        .type = LCD_CMD_UPDATE_DFU_PROGRESS,
        .p.dfu_progress = { .show = show, .percent = percent }
    };
    (void)mos_msgq_send(&lvgl_display_msgq, &cmd, (int64_t)50);
}

/* 线程安全：更新电量下方一行 DFU 状态文字（如 "DFU Updating... 45%"）；text 为空或 NULL 则隐藏 
| Thread-safe: update DFU status line below battery; empty/NULL = hide */
void display_update_dfu_status_text(const char *text)
{
    display_cmd_t cmd = { .type = LCD_CMD_UPDATE_DFU_STATUS_TEXT };
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

/* 线程安全图案切换：发消息到 LVGL 线程 / Thread-safe pattern cycling - sends message to LVGL thread */
void display_cycle_pattern(void)
{
    display_cmd_t cmd = {
        .type = LCD_CMD_CYCLE_PATTERN, .p.pattern = {.pattern_id = 0}  /* 由 LVGL 线程决定 / Will be determined by LVGL thread */
    };
    mos_msgq_send(&lvgl_display_msgq, &cmd, MOS_OS_WAIT_FOREVER);
}

void display_update_height(uint16_t height) {
    display_cmd_t cmd = {
        .type = LCD_CMD_UPDATE_HEIGHT, .p.height = {.height = height}
    };
    mos_msgq_send(&lvgl_display_msgq, &cmd, MOS_OS_WAIT_FOREVER);
}

/* 线程安全 protobuf 文本更新：发消息到 LVGL 线程 / Thread-safe protobuf text update - sends message to LVGL thread */
void display_update_protobuf_text(const char *text_content)
{
    if (!text_content)
    {
        LOG_ERR("Invalid text content pointer");
        return;
    }

    display_cmd_t cmd = {
        .type = LCD_CMD_UPDATE_PROTOBUF_TEXT, .p = {.protobuf_text = {{0}}}  /* 嵌套大括号正确初始化 / Proper initialization with nested braces */
    };

    /* 安全拷贝文本并做边界检查 / Safely copy text content with bounds checking */
    size_t text_len = strlen(text_content);
    if (text_len > MAX_TEXT_LEN)
    {
        text_len = MAX_TEXT_LEN;
        LOG_WRN( "Protobuf text truncated to %d chars", MAX_TEXT_LEN);
    }

    strncpy(cmd.p.protobuf_text.text, text_content, text_len);
    cmd.p.protobuf_text.text[text_len] = '\0';  /* 保证 NUL 结尾 / Ensure null termination */

    mos_msgq_send(&lvgl_display_msgq, &cmd, MOS_OS_WAIT_FOREVER);
}

/* 直接 A6N 图案接口，线程安全 / Direct A6N pattern functions - Thread-safe */
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

/* Pattern 5 XY 文本定位，线程安全 / Pattern 5 XY Text Positioning - Thread-safe function */
void display_update_xy_text(uint16_t x, uint16_t y, const char *text_content, uint16_t font_size, uint32_t color)
{
    if (!text_content)
    {
        LOG_ERR("Invalid XY text content pointer");
        return;
    }

    display_cmd_t cmd = {
        .type      = LCD_CMD_UPDATE_XY_TEXT,
        .p.xy_text = {
            .x = x, .y = y, .font_size = font_size, .color = color, .text = {0}  /* 初始化文本数组 / Initialize text array */
        }};

    /* 安全拷贝文本并做边界检查 / Safely copy text content with bounds checking */
    size_t text_len = strlen(text_content);
    if (text_len > MAX_TEXT_LEN)
    {
        text_len = MAX_TEXT_LEN;
        LOG_WRN( "XY text truncated to %d chars", MAX_TEXT_LEN);
    }

    strncpy(cmd.p.xy_text.text, text_content, text_len);
    cmd.p.xy_text.text[text_len] = '\0';  /* 保证 NUL 结尾 / Ensure null termination */

    mos_msgq_send(&lvgl_display_msgq, &cmd, MOS_OS_WAIT_FOREVER);
}

void display_clear_screen(void)
{
    display_cmd_t cmd = {.type = LCD_CMD_CLEAR_DISPLAY};
    mos_msgq_send(&lvgl_display_msgq, &cmd, MOS_OS_WAIT_FOREVER);
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
    lv_obj_align(hello_world_label, LV_ALIGN_CENTER, 0, 0);  /* 居中对齐 / Center align */
    /* lv_obj_align(hello_world_label, LV_TEXT_ALIGN_RIGHT, 0, 0); 右对齐 / Right align */
    /* lv_obj_align(hello_world_label, LV_TEXT_ALIGN_LEFT, 0, 0); 左对齐 / Left align */
    /* lv_obj_align(hello_world_label, LV_ALIGN_BOTTOM_MID, 0, 0); 底部居中对齐 / Bottom center */
    lv_obj_set_style_text_color(hello_world_label, display_get_text_color(), 0);  /* 自适应文字颜色 / Use adaptive text color */
    lv_obj_set_style_text_font(hello_world_label, &lv_font_montserrat_14, 0);  /* 原 48，现 14 省内存 / Was 48, using 14 for memory */
    lv_obj_set_style_bg_color(lv_screen_active(), display_get_background_color(), 0);
}
static lv_obj_t   *counter_label;
static lv_timer_t *counter_timer;  /* 指针即可 / Pointer only */
static lv_obj_t   *acc_label;
static lv_obj_t   *gyr_label;
static void  counter_timer_cb(lv_timer_t *timer)
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
    /* 更新陀螺仪标签 / Update gyro label */
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

    /* lv_obj_align(counter_label, LV_TEXT_ALIGN_LEFT, 50, 320); 左对齐 / Left align */
    lv_obj_set_style_text_color(acc_label, display_get_text_color(), 0);  /* 自适应文字颜色 / Use adaptive text color */
    lv_obj_set_style_text_font(acc_label, &lv_font_montserrat_14, 0);  /* 原 30，现 14 省内存 / Was 30, using 14 for memory */
    lv_obj_set_style_text_color(gyr_label, display_get_text_color(), 0);  /* 自适应文字颜色 / Use adaptive text color */
    lv_obj_set_style_text_font(gyr_label, &lv_font_montserrat_14, 0);  /* 原 30，现 14 省内存 / Was 30, using 14 for memory */
    lv_obj_set_style_bg_color(lv_screen_active(), display_get_background_color(), 0);
    /* 创建 100ms 周期定时器，count 指针经 user_data 传入 / Create 100ms period timer, pass count via user_data */
    static int count = 0;
    counter_timer    = lv_timer_create(counter_timer_cb, 300, &count);
    /* 300 为毫秒，回调每次触发 / 300 is ms, callback triggered each time */
}

/****************************************************/
static lv_obj_t *cont = NULL;
static lv_anim_t anim;

/* 动画回调：将容器纵向滚动到 v 像素 / Animation callback: scroll container vertically to v pixels */
static void scroll_cb(void *var, int32_t v)
{
    LV_UNUSED(var);
    lv_obj_scroll_to_y(cont, v, LV_ANIM_OFF);
}

void scroll_text_create(lv_obj_t *parent, lv_coord_t x, lv_coord_t y, lv_coord_t w, lv_coord_t h, const char *txt,
                        const lv_font_t *font, uint32_t time_ms)
{
    /* 移除旧区域 / Remove old area */
    scroll_text_stop();

    /* 创建可滚动容器 / Create scrollable container */
    cont = lv_obj_create(parent);
    lv_obj_set_size(cont, w, h);
    lv_obj_set_pos(cont, x, y);
    lv_obj_set_scroll_dir(cont, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(cont, LV_SCROLLBAR_MODE_OFF);
    /* 设置容器背景为自适应背景色 / Set container background to adaptive color */
    lv_obj_set_style_bg_color(cont, display_get_background_color(), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(cont, LV_OPA_COVER, LV_PART_MAIN);

    /* 在容器中创建标签 / Create label inside container */
    lv_obj_t *label = lv_label_create(cont);
    lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(label, w);
    lv_label_set_text(label, txt);

    /* 设置文字为自适应颜色和指定字体 / Set text to adaptive color and given font */
    lv_obj_set_style_text_color(label, display_get_text_color(), LV_PART_MAIN);
    lv_obj_set_style_text_font(label, font, LV_PART_MAIN);

    /* 强制标签布局更新，获取正确内容高度 / Force label layout update to get content height */
    lv_obj_update_layout(label);
    int32_t label_h = lv_obj_get_height(label);
    /* 滚动范围 = 标签高度 - 容器高度 / Scroll range = label height - container height */
    int32_t range = label_h - h;
    if (range <= 0)
        return;

    /* 初始化并启动往返滚动动画 / Init and start round-trip scroll animation */
    lv_anim_init(&anim);
    lv_anim_set_var(&anim, cont);
    lv_anim_set_exec_cb(&anim, scroll_cb);
    lv_anim_set_time(&anim, time_ms);
    lv_anim_set_values(&anim, 0, range);
    /* lv_anim_set_playback_duration(&anim, time_ms); 反向动画时间 / Playback duration */
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
// void handle_display_text(const mentraos_ble_DisplayText *txt)
// {
//     display_cmd_t cmd;

//     cmd.type = LCD_CMD_TEXT;
//     LOG_INF("show text: %s", (char *)txt->text.arg);
//     // /* txt->text.arg 已由 decode_string 填入 NUL 结尾字符串 */
//     // // strncpy(cmd.p.text.text, (char *)txt->text.arg, MAX_TEXT_LEN);
//     memcpy(cmd.p.text.text, (char *)txt->text.arg, MAX_TEXT_LEN);
//     cmd.p.text.text[MAX_TEXT_LEN] = '\0';

//     cmd.p.text.x = txt->x;
//     cmd.p.text.y = 260; // test  // txt->y;
//     cmd.p.text.font_code = txt->font_code;
//     cmd.p.text.font_color = txt->color;
//     cmd.p.text.size = txt->size;
//     // 非阻塞入队，队满则丢弃并打印警告
//     if (mos_msgq_send(&lvgl_display_msgq, &cmd, MOS_OS_WAIT_ON) != 0)
//     {
//         LOG_ERR("UI queue full, drop text");
//     }
// }

/****************************************************/
/* 前向声明 / Forward declarations */
static void show_test_pattern(int pattern_id);

static void show_default_ui(void)
{
    LOG_INF("🖼️ Starting with scrolling 'Welcome to MentraOS NExFirmware!' text...");
    /* 从图案 3（滚动欢迎文案）开始，进阶文本动画 / Start with pattern 3 (scrolling welcome text) - advanced text animation */
    show_test_pattern(4);

    LOG_INF("🖼️ Scrolling welcome message complete - should see animated text");
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

    LOG_DBG("🏁 Creating adaptive chess pattern: %dx%d squares (%d cols x %d rows) for %s", 
             chess_size, chess_size, chess_cols, chess_rows, config->name);

    for (int row = 0; row < chess_rows; row++)
    {
        for (int col = 0; col < chess_cols; col++)
        {
            /* 黑白格交替 / Alternate black and white squares */
            bool is_white = (row + col) % 2 == 0;

            lv_obj_t *square = lv_obj_create(screen);
            lv_obj_set_size(square, chess_size, chess_size);
            lv_obj_set_pos(square, col * chess_size, row * chess_size);
            lv_color_t color = is_white ? display_get_adjusted_color(lv_color_white()) : display_get_adjusted_color(lv_color_black());
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
    const int num_stripes   = config->height / stripe_height;

    LOG_DBG("🦓 Creating adaptive horizontal zebra: %d stripes (%dpx height) for %s", 
             num_stripes, stripe_height, config->name);

    for (int i = 0; i < num_stripes; i++)
    {
        bool is_white = i % 2 == 0;

        lv_obj_t *stripe = lv_obj_create(screen);
        lv_obj_set_size(stripe, config->width, stripe_height);
        lv_obj_set_pos(stripe, 0, i * stripe_height);
        lv_color_t color = is_white ? display_get_adjusted_color(lv_color_white()) : display_get_adjusted_color(lv_color_black());
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
    const int num_stripes  = config->width / stripe_width;

    LOG_INF("🦓 Creating adaptive vertical zebra: %d stripes (%dpx width) for %s", 
             num_stripes, stripe_width, config->name);

    for (int i = 0; i < num_stripes; i++)
    {
        bool is_white = i % 2 == 0;

        lv_obj_t *stripe = lv_obj_create(screen);
        lv_obj_set_size(stripe, stripe_width, config->height);
        lv_obj_set_pos(stripe, i * stripe_width, 0);
        lv_color_t color = is_white ? display_get_adjusted_color(lv_color_white()) : display_get_adjusted_color(lv_color_black());
        lv_obj_set_style_bg_color(stripe, color, 0);
        lv_obj_set_style_bg_opa(stripe, LV_OPA_COVER, 0);
        lv_obj_set_style_border_width(stripe, 0, 0);
        lv_obj_set_style_pad_all(stripe, 0, 0);
    }
}

/* 平滑滚动动画用全局变量 / Global variables for smooth scrolling animation */
static lv_obj_t *scrolling_welcome_label = NULL;
static lv_anim_t welcome_scroll_anim;

/* 平滑横向滚动动画回调 / Animation callback for smooth horizontal scrolling */
static void welcome_scroll_anim_cb(void *var, int32_t v)
{
    lv_obj_set_x((lv_obj_t *)var, v);
}

/* 动画结束回调，用于重新开始滚动 / Animation ready callback to restart the scroll */
static void welcome_scroll_ready_cb(lv_anim_t *a)
{
    if (scrolling_welcome_label == NULL)
        return;

    /* 重启动画以实现无限循环 / Restart the animation for infinite loop */
    lv_anim_init(&welcome_scroll_anim);
    lv_anim_set_var(&welcome_scroll_anim, scrolling_welcome_label);
    lv_anim_set_exec_cb(&welcome_scroll_anim, welcome_scroll_anim_cb);
    lv_anim_set_time(&welcome_scroll_anim, 8000);  /* 全程 8 秒 / 8 seconds for full traverse */
    lv_anim_set_repeat_count(&welcome_scroll_anim, LV_ANIM_REPEAT_INFINITE);
    lv_anim_set_path_cb(&welcome_scroll_anim, lv_anim_path_linear);
    lv_anim_set_ready_cb(&welcome_scroll_anim, welcome_scroll_ready_cb);

    /* 从右边缘滚到左边缘 / Start from right edge, move to left edge */
    lv_anim_set_values(&welcome_scroll_anim, 640, -600);  /* 起点 640px，终点 -600px / Start at 640px, end at -600px */

    lv_anim_start(&welcome_scroll_anim);
}

static void create_center_rectangle_pattern(lv_obj_t *screen)
{
    /* 创建滚动文本标签 / Create a scrolling text label */
    scrolling_welcome_label = lv_label_create(screen);
    lv_label_set_text(scrolling_welcome_label, "Welcome to MentraOS NExFirmware!");

    /* 设置文本属性 / Set text properties */
    lv_obj_set_style_text_color(scrolling_welcome_label, display_get_text_color(), 0);  /* 自适应文字颜色 / Use adaptive text color */
    lv_obj_set_style_text_font(scrolling_welcome_label, &lv_font_montserrat_14,  /* 原 48，现 14 省内存 / Was 48, using 14 for memory */
                               0);

    /* 使用普通模式，无内置滚动 / Use normal mode, no built-in scrolling */
    lv_label_set_long_mode(scrolling_welcome_label, LV_LABEL_LONG_CLIP);

    /* 固定宽度以容纳文本 / Set fixed width to contain the text */
    lv_obj_set_width(scrolling_welcome_label, 600);  /* 足够容纳全文 / Wide enough to contain full text */

    /* 垂直居中，水平方向由动画控制 / Center vertically, position animated horizontally */
    lv_obj_set_y(scrolling_welcome_label, (480 - lv_obj_get_height(scrolling_welcome_label)) / 2);

    /* 可选：加背景便于观看 / Optional: Add background for better visibility */
    lv_obj_set_style_bg_color(scrolling_welcome_label, display_get_background_color(), 0);
    lv_obj_set_style_bg_opa(scrolling_welcome_label, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(scrolling_welcome_label, 15, 0);  /* 内边距 / Add padding */
    lv_obj_set_style_radius(scrolling_welcome_label, 5, 0);    /* 圆角 / Rounded corners */

    /* 启动无限平滑横向滚动动画 / Start infinite smooth horizontal scrolling animation */
    lv_anim_init(&welcome_scroll_anim);
    lv_anim_set_var(&welcome_scroll_anim, scrolling_welcome_label);
    lv_anim_set_exec_cb(&welcome_scroll_anim, welcome_scroll_anim_cb);
    lv_anim_set_time(&welcome_scroll_anim, 8000);  /* 全程 8 秒 / 8 seconds for full traverse */
    lv_anim_set_repeat_count(&welcome_scroll_anim, LV_ANIM_REPEAT_INFINITE);
    lv_anim_set_path_cb(&welcome_scroll_anim, lv_anim_path_linear);
    lv_anim_set_ready_cb(&welcome_scroll_anim, welcome_scroll_ready_cb);

    /* 从屏幕右边缘滚到左边缘 / Start from right edge of screen, move to left edge */
    lv_anim_set_values(&welcome_scroll_anim, 640, -600);  /* 起点 640px（右缘），终点 -600px（左缘）/ Start 640px (right), end -600px (left) */

    lv_anim_start(&welcome_scroll_anim);

    LOG_DBG("🔄 Started infinite smooth horizontal scrolling animation for welcome text");
}

static void anim_set_x_cb(void *obj, int32_t v) 
{ 
    lv_obj_set_x((lv_obj_t *)obj, v); 
}

static void create_center_rectangle_pattern_ssd1306(lv_obj_t *screen)
{
    const char *text = "Welcome to MentraOS NExFirmware!";
    const lv_font_t *font = &lv_font_montserrat_12;   
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
    const lv_coord_t x_end   = -label_w;   

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
 * 返回电量/充电图标字符串，用于“图标+数字”显示。
 * @param pct       Battery percentage (0-100)
 * @param charging  Charging state
 * @return          LVGL symbol string
 */
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
    if (pct >= 50)
    {
        return LV_SYMBOL_BATTERY_2;
    }
    if (pct >= 25)
    {
        return LV_SYMBOL_BATTERY_1;
    }
    return LV_SYMBOL_BATTERY_EMPTY;
#else
    (void)pct;
    (void)charging;
    return "";
#endif
}

static void create_scrolling_text_container(lv_obj_t *screen)
{
    /* 获取模块化显示配置 / Get modular display configuration */
    const display_config_t *config = display_get_config();
    
    /* 按模块化尺寸创建可滚动容器 / Create scrollable container using modular dimensions */
    lv_obj_t *container = lv_obj_create(screen);
    display_apply_container_config(container, screen, config);

    /* 保存全局引用供 protobuf 文本更新 / Store global reference for protobuf text updates */
    protobuf_container = container;

    /* 配置容器滚动：无滚动条、最小边框 / Configure container scrolling - NO SCROLLBARS, minimal borders */
    lv_obj_set_scroll_dir(container, LV_DIR_VER);                 /* 仅垂直滚动 / Vertical scrolling only */
    lv_obj_set_scrollbar_mode(container, LV_SCROLLBAR_MODE_OFF);  /* 无滚动条 / NO SCROLLBARS */

    /* 按配置设置容器样式 / Style the container using configuration values */
    lv_obj_set_style_bg_color(container, lv_color_white(), 0);
    lv_obj_set_style_bg_opa(container, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(container, 0, 0); /* 隐藏边框 / Hide border */
    lv_obj_set_style_border_opa(container, LV_OPA_TRANSP, 0); /* 边框透明 / Make border transparent */

    /* 在容器内创建 protobuf 文本标签 / Create label inside container with protobuf text */
    lv_obj_t *label = lv_label_create(container);
    lv_obj_set_width(label, config->layout.usable_width - (config->layout.padding * 2));
    lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);  /* 自动换行适应宽度 / Wrap text to fit width */

    /* 保存全局引用供 protobuf 文本更新 / Store global reference for protobuf text updates */
    protobuf_label = label;

    /* 未连接/未配对时初始文案（含电量行）/ Set initial text for disconnected/unpaired state (with battery line) */
    const char *initial_text;
    const char *device_name = get_ble_device_name();  /* 获取动态 BLE 设备名 / Get dynamic BLE device name */
    uint32_t battery_pct = protobuf_get_battery_level();
    bool charging = protobuf_get_charging_state();
    static char large_display_text[160];
    static char small_display_text[96];

    if (config->width >= 500)
    {
        /* Large display: icon + number, BLE icon before device name. 大屏：图标+数字，设备名前显示蓝牙图标 */
        snprintf(large_display_text, sizeof(large_display_text),
                 "Welcome to MentraOS\n"
                 "Build V1.2.3 %s %s\n"
                 "Waiting for connection\n"
                 "Device Name: %s %s\n"
                 "Battery: %s %u%%", __DATE__, __TIME__,
                 get_ble_icon(), device_name,
                 get_battery_icon(battery_pct, charging), (unsigned int)battery_pct);
        initial_text = large_display_text;
    }
    else
    {
        /* Small display: icon + number, BLE icon before device name. 小屏：图标+数字，设备名前显示蓝牙图标 */
        snprintf(small_display_text, sizeof(small_display_text),
                 "Welcome to MentraOS\n"
                 "Build V1.2.3 %s %s\n"
                 "Waiting for connection\n"
                 "Device: %s %s\n"
                 "Battery: %s %u%%", __DATE__, __TIME__,
                 get_ble_icon(), device_name,
                 get_battery_icon(battery_pct, charging), (unsigned int)battery_pct);
        initial_text = small_display_text;
    }

    lv_label_set_text(label, initial_text);

    /* 首次显示时视为欢迎屏激活 / Ensure welcome screen is considered active when we first show it */
    welcome_screen_active = true;

    /* 启动 60s 周期刷新欢迎文案（含电量行）/ Start 60s periodic refresh of welcome text (battery line) */
    k_work_init_delayable(&welcome_battery_work, welcome_battery_work_handler);
    k_work_schedule(&welcome_battery_work, K_MSEC(WELCOME_BATTERY_REFRESH_MS));

    /* 按模块化字体配置设置标签样式 / Style the label using modular font configuration */
    lv_obj_set_style_text_color(label, lv_color_black(), 0);
    lv_obj_set_style_text_font(label, display_get_font("secondary"), 0);  /* 使用 montserrat_24 / Now uses montserrat_24 */
    lv_obj_set_style_text_line_space(label, config->fonts.line_spacing, 0);

    /* 与 BLE 文案同高（距顶 80px）避免被裁 / Align welcome text to same height as BLE text (80px from top) so it isn't cut off */
    lv_obj_align(label, LV_ALIGN_TOP_MID, 0, 80);

    /* DFU 状态文字：电量下面一行，居中显示，初始隐藏 | DFU status line below battery, center-aligned, initially hidden */
    dfu_status_label = lv_label_create(container);
    lv_label_set_text(dfu_status_label, "");
    lv_obj_set_width(dfu_status_label, config->layout.usable_width - (config->layout.padding * 2));
    lv_obj_set_style_text_font(dfu_status_label, display_get_font("secondary"), 0);
    lv_obj_set_style_text_color(dfu_status_label, lv_color_black(), 0);
    lv_obj_set_style_text_align(dfu_status_label, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align_to(dfu_status_label, label, LV_ALIGN_OUT_BOTTOM_MID, 0, 4);
    lv_obj_add_flag(dfu_status_label, LV_OBJ_FLAG_HIDDEN);

    /* DFU 进度条：单色显示（亮/暗），轨道=背景色、填充=文字色 | Progress bar: monochrome (bright/dark), track=bg, fill=text color */
    dfu_progress_bar_w = (lv_coord_t)(config->layout.usable_width / 2);
    dfu_progress_bar   = lv_obj_create(container);
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

    /* 自动滚到底部以显示最新内容 / AUTO-SCROLL TO BOTTOM to show latest content */
    lv_obj_update_layout(container);  /* 确保布局已计算 / Ensure layout is calculated */
    LOG_INF("📝 Created adaptive scrolling container: %dx%d with %s font", 
             config->layout.usable_width, config->layout.usable_height, config->name);
}

/* Pattern 5：XY 文本定位区域，模块化配置 / Pattern 5 - XY Text Positioning Area with modular configuration */
static void create_xy_text_positioning_area(lv_obj_t *screen)
{
    /* 获取模块化显示配置 / Get modular display configuration */
    const display_config_t *config = display_get_config();
    
    /* 按模块化尺寸创建 XY 定位容器 / Create XY positioning container using modular dimensions */
    lv_obj_t *container = lv_obj_create(screen);
    display_apply_container_config(container, screen, config);

    /* 保存全局引用供 XY 文本定位 / Store global reference for XY text positioning */
    xy_text_container = container;

    /* 容器为静态定位区，不滚动 / Configure container as static positioning area - NO SCROLLING */
    lv_obj_set_scroll_dir(container, LV_DIR_NONE);                /* 不滚动 / No scrolling */
    lv_obj_set_scrollbar_mode(container, LV_SCROLLBAR_MODE_OFF);  /* 无滚动条 / No scrollbars */

    /* 容器样式：可见边框便于定位参考 / Style the container with visible border for positioning reference */
    lv_obj_set_style_bg_color(container, lv_color_white(), 0);  /* 白底 / White background */
    lv_obj_set_style_bg_opa(container, LV_OPA_COVER, 0);
    lv_obj_set_style_border_color(container, lv_color_black(), 0);  /* 黑边 / Black border */
    lv_obj_set_style_border_opa(container, LV_OPA_COVER, 0);        /* 边框可见 / Visible border */
    lv_obj_set_style_radius(container, config->layout.border_width, 0);  /* 自适应圆角 / Adaptive radius */

    /* 空容器：无默认文案，供 XY 定位消息使用 / EMPTY CONTAINER: No default text - ready for XY positioned messages */

    LOG_INF("📍 Pattern 5: XY Text Positioning Area created (%dx%d) for %s", 
             config->layout.usable_width, config->layout.usable_height, config->name);
}

static int       current_pattern = 4;  /* 默认自动滚动容器（图案 4）/ Default to auto-scroll container (pattern 4) */
static const int num_patterns    = 6;  /* 从 5 增至 6（新增 Pattern 5 XY 文本定位）/ Increased from 5 to 6 (added Pattern 5: XY Text Positioning) */

/* 获取当前图案 ID 供条件逻辑使用 / Get current pattern ID for conditional logic */
int display_get_current_pattern(void)
{
    return current_pattern;
}

static void show_test_pattern(int pattern_id)
{
    /* 仅由 LVGL 线程调用，无需加锁 / SAFE: Now called only from LVGL thread - no locking needed */

    /* 先清除所有已有对象，在 LVGL 线程上下文中安全 / Clear all existing objects first - safe in LVGL thread context */
    lv_obj_clean(lv_screen_active());

    /* 获取屏幕并设黑色背景 / Get screen and set black background */
    lv_obj_t *screen = lv_screen_active();
    lv_obj_set_style_bg_color(screen, display_get_background_color(), 0);
    lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, 0);

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
            // create_center_rectangle_pattern(screen);
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

    /* 强制 LVGL 立即渲染 / Force LVGL to render everything immediately */
    /* lv_timer_handler(); */

    /* 在 LVGL 线程上下文中无需解锁 / SAFE: No unlock needed - running in LVGL thread context */

    /* 可选小延时供显示处理 / Small delay for display processing */
    /* k_msleep(100); */
}
void cycle_test_pattern(void)
{
    /* 防抖：避免快速切换导致冲突 / SAFETY: Prevent rapid cycling that could cause conflicts */
    static int64_t last_cycle_time = 0;
    int64_t        current_time    = k_uptime_get();

    if (current_time - last_cycle_time < 1000)
    {  /* 1 秒防抖 / 1 second debounce */
        return;
    }
    last_cycle_time = current_time;

    current_pattern = (current_pattern + 1) % num_patterns;
    LOG_INF("Pattern #%d", current_pattern);  /* 简要日志 / Minimal log */
    show_test_pattern(current_pattern);
}

static void update_display_height(uint16_t height)
{
    if (height > 8) height = 8;

    LOG_INF("update_display_height - Thread-safe height update: %u", height);

    if (!protobuf_container)
    {
        LOG_WRN("protobuf_container not initialized");
        return;
    }

    lv_obj_t *screen = lv_screen_active();
    const display_config_t *config = display_get_config();

    /* Make a mutable copy of the current config */
    display_config_t tmp = *config;

    /* ABSOLUTE mapping: margin_top = 20 * height (no + / -) */
    uint32_t mt = (config->height - config->layout.usable_height) - (20u * (uint32_t)height);

    /* Clamp to uint16_t and screen bounds so it never goes off-screen */
    if (mt > UINT16_MAX) mt = UINT16_MAX;
    tmp.layout.margin_top = (uint16_t)mt;

    /* Keep container fully visible: margin_top + usable_height <= screen height */
    if ((uint32_t)tmp.layout.margin_top + (uint32_t)tmp.layout.usable_height > (uint32_t)tmp.height)
    {
        tmp.layout.margin_top =
            (tmp.height > tmp.layout.usable_height) ? (tmp.height - tmp.layout.usable_height) : 0;
    }

    /* Apply to the existing container */
    (void)display_apply_container_config(protobuf_container, screen, &tmp);

    /* Recompute layout */
    lv_obj_update_layout(protobuf_container);

    LOG_INF("Applied margin_top=%u (height=%u)", tmp.layout.margin_top, height);
}

/* 在自动滚动容器中更新 protobuf 文本内容 / Update protobuf text content in the auto-scroll container */
static void update_protobuf_text_content(const char *text_content)
{
    /* 必须仅在 LVGL 线程上下文中调用 / SAFETY: This function must only be called from LVGL thread context */

    if (!text_content)
    {
        LOG_ERR("Invalid text content pointer");
        return;
    }

    /* 确认全局引用有效 / Verify we have valid global references */
    if (!protobuf_container || !protobuf_label)
    {
        LOG_ERR("Protobuf container not initialized");
        return;
    }

    /* 标记当前为 BLE/其它内容，不再用欢迎+电量刷新覆盖 / Mark that we are showing BLE/other content - do not overwrite with welcome+battery refresh */
    welcome_screen_active = false;

    /* 清空并更新：用新 protobuf 内容替换现有文本 / CLEAR AND UPDATE: Replace existing text with new protobuf content */
    lv_label_set_text(protobuf_label, text_content);

    /* BLE 文本偏移：标签距顶 100px（欢迎文案保持居中）/ BLE text offset: position label 100px down from top (welcome message stays centered) */
    lv_obj_align(protobuf_label, LV_ALIGN_TOP_MID, 0, 0);

    /* 自动滚到底部显示最新内容 / AUTO-SCROLL TO BOTTOM: Show latest content */
    lv_obj_update_layout(protobuf_container);  /* 确保布局已计算 / Ensure layout is calculated */
    // lv_obj_scroll_to_y(protobuf_container, lv_obj_get_scroll_bottom(protobuf_container), LV_ANIM_OFF);

    LOG_INF("📱 Protobuf text updated: %.50s%s", text_content, strlen(text_content) > 50 ? "..." : "");
}

/* 用当前电量重建欢迎标签文案（60s 刷新）；仅由 LVGL 线程调用 / Rebuild welcome label text with current battery (60s refresh); call from LVGL thread only */
static void update_welcome_label_with_battery(void)
{
    if (!protobuf_label)
    {
        return;
    }

    /* 仅当欢迎屏激活时刷新；不覆盖 BLE/其它内容 / Only refresh when welcome screen is active; do not overwrite BLE/other content */
    if (!welcome_screen_active)
    {
        return;
    }

    const display_config_t *config = display_get_config();
    const char *device_name = get_ble_device_name();
    uint32_t battery_pct = protobuf_get_battery_level();
    bool charging = protobuf_get_charging_state();

    static char welcome_buf[160];
    if (config->width >= 500)
    {
        snprintf(welcome_buf, sizeof(welcome_buf),
                 "Welcome to MentraOS\n"
                 "Build V1.2.3 %s %s\n"
                 "Waiting for connection\n"
                 "Device Name: %s %s\n"
                 "Battery: %s %u%%", __DATE__, __TIME__,
                 get_ble_icon(), device_name,
                 get_battery_icon(battery_pct, charging), (unsigned int)battery_pct);
    }
    else
    {
        snprintf(welcome_buf, sizeof(welcome_buf),
                 "Welcome to MentraOS\n"
                 "Build V1.2.3 %s %s\n"
                 "Waiting for connection\n"
                 "Device: %s %s\n"
                 "Battery: %s %u%%", __DATE__, __TIME__,
                 get_ble_icon(), device_name,
                 get_battery_icon(battery_pct, charging), (unsigned int)battery_pct);
    }

    lv_label_set_text(protobuf_label, welcome_buf);
}

static void welcome_battery_work_handler(struct k_work *work)
{
    display_cmd_t cmd = { .type = LCD_CMD_UPDATE_WELCOME_BATTERY };
    mos_msgq_send(&lvgl_display_msgq, &cmd, (int64_t)100);  /* 100 ms 超时；bal_os 使用 int64_t ms / 100 ms timeout; bal_os uses int64_t ms */
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

    lv_obj_t *target_container = NULL;
    
    /* 同时支持 Pattern 4（滚动容器）与 Pattern 5（XY 定位容器）/ Support both Pattern 4 (scrolling container) and Pattern 5 (XY positioning container) */
    if (xy_text_container)
    {
        /* Pattern 5：XY 文本定位区域 / Pattern 5: XY Text Positioning Area */
        target_container = xy_text_container;
        LOG_DBG("Using Pattern 5 XY text container");
    }
    else if (protobuf_container)
    {
        /* Pattern 4：滚动文本容器 / Pattern 4: Scrolling Text Container */
        target_container = protobuf_container;
        LOG_DBG("Using Pattern 4 scrolling text container");
    }
    else
    {
        LOG_ERR("No valid text container available - must be in Pattern 4 or Pattern 5");
        return;
    }

    /* 添加新文本前清空所有旧文本 / CLEAR ALL PREVIOUS TEXT CONTENT before adding new text */
    lv_obj_clean(target_container);  /* 移除容器内所有子对象 / Remove all children from container */
    current_xy_text_label = NULL;     /* 容器已空，重置引用 / Reset reference since container is now empty */

    /* 校验坐标在容器范围内（580x420 可用区，10px 内边距）/ Validate coordinates within container bounds (580x420 usable, 10px padding) */
    const uint16_t max_x = 580;  /* 600 - (2 * 10px 内边距)/ 600 - (2 * 10px padding) */
    const uint16_t max_y = 420;  /* 440 - (2 * 10px 内边距)/ 440 - (2 * 10px padding) */

    LOG_INF("📍 Original XY: (%u,%u), max bounds: (%u,%u)", x, y, max_x, max_y);

    if (x >= max_x || y >= max_y)
    {
        LOG_WRN( "XY coordinates out of bounds: (%u,%u) - max is (%u,%u)", x, y, max_x, max_y);
        /* 钳制到有效范围 / Clamp to valid range */
        x = (x >= max_x) ? max_x - 50 : x;  /* 为文本留空 / Leave some space for text */
        y = (y >= max_y) ? max_y - 30 : y;
        LOG_WRN( "📍 Clamped to: (%u,%u)", x, y);
    }


    const lv_font_t *font = display_get_font("secondary");  
    if (!font)
    {
        LOG_WRN("secondary font not available, falling back to primary font");
        font = display_get_font("primary");  /* 回退到主显示字体 / Fallback to primary display font */
    }

    /* 创建新的定位文本标签 / Create new positioned text label */
    current_xy_text_label = lv_label_create(target_container);
    lv_label_set_text(current_xy_text_label, text_content);

    /* 应用字体与样式，与 Pattern 4 一致：白底黑字 / Apply font and styling - SAME AS PATTERN 4: black text on white background */
    lv_obj_set_style_text_font(current_xy_text_label, font, 0);
    lv_obj_set_style_text_color(current_xy_text_label, lv_color_black(), 0);  /* 黑字便于观看 / Black text for visibility */
    lv_obj_set_style_bg_opa(current_xy_text_label, LV_OPA_TRANSP, 0);         /* 透明背景 / Transparent background */

    /* 设置自动换行与宽度约束 / Set text wrapping and width constraints */
    lv_label_set_long_mode(current_xy_text_label, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(current_xy_text_label, max_x - x);  /* 在剩余宽度内换行 / Wrap within remaining width */

    /* 在指定坐标放置文本（相对容器内边距）/ Position the text at specified coordinates (relative to container padding) */
    lv_obj_set_pos(current_xy_text_label, x, y);

    const char *pattern_name = (target_container == xy_text_container) ? "Pattern 5" : "Pattern 4";
    LOG_INF("📝 [%s] Cleared all text, positioned new at (%u,%u), secondary_font, color:0x%06X: %.30s%s", 
             pattern_name, x, y, color, text_content, strlen(text_content) > 30 ? "..." : "");
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
    
    const display_config_t *config = display_get_config();
    LOG_INF("🖼️ Display configuration loaded: %s (%dx%d)", 
             config->name, config->width, config->height);
    if (a6n_init_sem_take() != 0)  /* 等待屏幕 SPI 初始化完成 / Wait for screen SPI init complete */
    {
        LOG_ERR("Failed to a6n_init_sem_take err");
        return;
    }
    static uint32_t last_refresh_ms;
    display_state_t state_type = LCD_STATE_INIT;
    display_cmd_t   cmd;
    display_open();
    while (1)
    {
        bool need_refresh = false;
        /* 到预算了，允许本轮刷一次 / When budgeted, allow one refresh this round */
        if (state_type == LCD_STATE_ON && ((k_uptime_get_32() - last_refresh_ms) >= 10))
        {
            need_refresh = true;
        }

        /* 处理消息（仍给其它任务时间）/ Handle message (still give other tasks time) */
        int err = mos_msgq_receive(&lvgl_display_msgq, &cmd, LVGL_TICK_MS);
        if (err == 0)
        {
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
                    a6n_write_reg(1, 0x55, 0x00);  /* Bank1 0x55 = 0x00 (Demura 关闭 / Demura disabled) */
                    mos_delay_us(6);
                    a6n_write_reg(0, 0xD0, 0x0a);  /* 鸿石 FAE 推荐配置 / Configure as recommended by Hongshi FAE */
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
                    protobuf_set_brightness_level(30);
                    mos_delay_us(6);
                    
                    /* 设置显示格式为 GRAY16 (4-bit) / Set display format to GRAY16 (4-bit) */
                    a6n_set_gray16_mode();      /* Bank0 0xBE = 0x84 */
                    mos_delay_us(6);
                    
                    /* 设置水平镜像模式 / Set horizontal mirror mode */
                    int mirror_ret = a6n_set_mirror(MIRROR_HORZ);
                    if (mirror_ret < 0)
                    {
                        LOG_ERR("Failed to set mirror mode: %d", mirror_ret);
                    }
                    mos_delay_us(6);
                    a6n_read_reg(0, 1, 0xbe);   /* Bank0 右光机 0xbe 寄存器 / Bank0, right engine, 0xbe register */
                    mos_delay_us(6);
                    
                    a6n_write_reg(0, 0x60, 0x80);  /* Bank0 0x60 = 0x80（待确认功能）/ Bank0 0x60 = 0x80 (TBD) */
                    mos_delay_us(6);
                    
                    /* 配置自刷新帧率 90Hz (SPI≤32MHz) / Configure self-refresh rate to 90Hz (SPI≤32MHz) */
                    a6n_write_reg(0, 0x78, 0x0E);  /* Bank0 OSC 时钟配置 / OSC clock config */
                    mos_delay_us(6);
                    a6n_write_reg(0, 0x7C, 0x13);  /* Bank0 OSC 时钟配置 90Hz / OSC clock config (90Hz) */
                    mos_delay_us(6);
                    
                    LOG_INF("LCD init complete - GRAY16 mode + 90Hz refresh rate configured");
                    mos_delay_ms(2);
                    
                    /* 在打开显示前清屏，避免可见闪烁 / Clear screen BEFORE opening display to avoid visible flash */
                    /* A6N 上电后必须做一次全屏清屏才能正常工作 / A6N requires full screen clear after power-on for proper operation */
                    a6n_clear_screen(false);
                    
                    mos_delay_ms(20);
                    /* 现在打开显示，屏幕已清屏无闪烁 / Now open display - screen already cleared, no flash */
                    a6n_open_display();
     
                    state_type = LCD_STATE_ON;

                    LOG_INF("🚀 About to call show_default_ui()...");
                    show_default_ui();  
                    LOG_INF("✅ show_default_ui() completed");
                    break;
                case LCD_CMD_DATA:
                    break;
                case LCD_CMD_CYCLE_PATTERN:
                    /* 在 LVGL 线程内安全处理图案切换 / Handle pattern cycling safely in LVGL thread */
                    LOG_INF("LCD_CMD_CYCLE_PATTERN - Thread-safe pattern cycling");
                    cycle_test_pattern();  /* 现由 LVGL 线程上下文调用 / Now called from LVGL thread context */
                    break;
                case LCD_CMD_UPDATE_HEIGHT:
                    /* 在 LVGL 线程内安全处理高度更新 / Handle height updates safely in LVGL thread */
                    LOG_INF("LCD_CMD_UPDATE_HEIGHT - Thread-safe height update: %u", cmd.p.height.height);
                    update_display_height(cmd.p.height.height);
                    break;
                case LCD_CMD_UPDATE_PROTOBUF_TEXT:
                    /* 在 LVGL 线程内安全处理 protobuf 文本更新 / Handle protobuf text updates safely in LVGL thread */
                    update_protobuf_text_content(cmd.p.protobuf_text.text);
                    break;
                case LCD_CMD_UPDATE_XY_TEXT:
                    /* 处理 Pattern 5 的 XY 定位文本更新 / Handle XY positioned text updates for Pattern 5 */
                    LOG_INF("LCD_CMD_UPDATE_XY_TEXT - XY positioned text at (%u,%u)", cmd.p.xy_text.x,
                             cmd.p.xy_text.y);
                    update_xy_positioned_text(cmd.p.xy_text.x, cmd.p.xy_text.y, cmd.p.xy_text.text,
                                              cmd.p.xy_text.font_size, cmd.p.xy_text.color);
                    break;
                case LCD_CMD_UPDATE_WELCOME_BATTERY:
                    /* 用当前电量刷新欢迎标签（60s 周期）/ Refresh welcome label with current battery (60s period) */
                    update_welcome_label_with_battery();
                    break;
                case LCD_CMD_SHOW_WELCOME_SCREEN:
                    /* 回到欢迎界面（如 BLE 断开后）/ Return to welcome screen (e.g. after BLE disconnect) */
                    welcome_screen_active = true;
                    update_welcome_label_with_battery();
                    break;
                case LCD_CMD_UPDATE_DFU_PROGRESS:
                    /* 显示/隐藏并更新 DFU 进度条：前景条宽度 = 百分比，随 % 滑动 | Progress bar: fill width = percent */
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
                    // NOTE: Not clearing the active screen because that would orphan the protobuf container and label and cause a crash.
                    // If we need to clear lvgl for some reason in future. We would reinitialize the lvgl display.
                    
                    a6n_clear_screen(false);  // Clear to black
                    break;
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
                    lv_obj_set_style_text_font(lbl, &lv_font_montserrat_14, LV_PART_MAIN);  /* 原 30，现 14 省内存 / Was 30, using 14 for memory */
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
                    /* 处理指定图案选择 / Handle specific pattern selection */
                    LOG_INF("LCD_CMD_SHOW_PATTERN - Showing pattern %d", cmd.p.pattern.pattern_id);
                    current_pattern = cmd.p.pattern.pattern_id;  /* 更新当前图案 / Update current pattern */
                    show_test_pattern(cmd.p.pattern.pattern_id);
                    break;
                default:
                    break;
            }
            if (state_type == LCD_STATE_ON)
                need_refresh = true;
        }

        if (state_type == LCD_STATE_ON && need_refresh)
        {
            lv_timer_handler();  /* 每轮只刷一次 / Only refresh once per round */
            last_refresh_ms = k_uptime_get_32();
        }
    }
}

void lvgl_display_thread(void)
{
    /* 启动 LVGL 专用线程 / Start LVGL dedicated thread */
    lvgl_thread_handle = k_thread_create(&lvgl_thread_data,
                                         lvgl_stack_area,
                                         K_THREAD_STACK_SIZEOF(lvgl_stack_area),
                                         lvgl_dispaly_init,
                                         NULL,
                                         NULL,
                                         NULL,
                                         LVGL_THREAD_PRIORITY,
                                         0,
                                         K_NO_WAIT);
    k_thread_name_set(lvgl_thread_handle, TASK_LVGL_NAME);
}