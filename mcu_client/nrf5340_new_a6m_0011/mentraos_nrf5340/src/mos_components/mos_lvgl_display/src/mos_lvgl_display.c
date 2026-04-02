/*
 * @Author       : Cole
 * @Date         : 2025-07-31 10:40:40
 * @LastEditTime : 2025-08-20 17:53:18
 * @FilePath     : mos_lvgl_display.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2025
 *  SPDX-License-Identifier: Apache-2.0
 */



#include <display/lcd/a6m_0011.h>
#include <math.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/display.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include "bspal_icm42688p.h"
#include "lvgl_display.h"
#include "task_ble_receive.h"
#include "bal_os.h"
#include "mos_lvgl_display.h"

#define LOG_MODULE_NAME MOS_LVGL
LOG_MODULE_REGISTER(LOG_MODULE_NAME);

#define TASK_LVGL_NAME "MOS_LVGL"

#define LVGL_THREAD_STACK_SIZE (4096 * 2)
#define LVGL_THREAD_PRIORITY   5
K_THREAD_STACK_DEFINE(lvgl_stack_area, LVGL_THREAD_STACK_SIZE);
static struct k_thread lvgl_thread_data;
k_tid_t                lvgl_thread_handle;

static K_SEM_DEFINE(lvgl_display_sem, 0, 1);

#define DISPLAY_CMD_QSZ 16
K_MSGQ_DEFINE(display_msgq, sizeof(display_cmd_t), DISPLAY_CMD_QSZ, 4);

#define LVGL_TICK_MS 5
static struct k_timer fps_timer;
static uint32_t       frame_count = 0;

static volatile bool display_onoff = false;

static void fps_timer_cb(struct k_timer *timer_id)
{
    uint32_t fps = frame_count;
    frame_count  = 0;
    LOG_INF("LVGL FPS: %d", fps);
}

void lv_example_scroll_text(void)
{
    lv_obj_t *label = lv_label_create(lv_screen_active());

    // 设置滚动模式（自动横向滚动）; set long mode to scroll text
    // lv_label_set_long_mode(label, LV_LABEL_LONG_SCROLL);
    lv_label_set_long_mode(label, LV_LABEL_LONG_SCROLL_CIRCULAR);

    // 设置标签区域宽度（可视区域）; set label area width
    lv_obj_set_width(label, 640);

    // 设置标签位置; set label position
    lv_obj_set_pos(label, 0, 410);

    // 设置长文本（会触发滚动）; set long text
    lv_label_set_text(label, "!!!!!nRF5340 + NCS 3.0.0 + LVGL!!!!");

    lv_obj_set_style_text_color(label, lv_color_white(), 0);
    lv_obj_set_style_text_font(label, &lv_font_montserrat_48, 0);
    lv_obj_set_style_bg_color(lv_screen_active(), lv_color_black(), 0);
}

/**
 * @brief set display onoff
 * @param state  true to turn on display, false to turn off display
 */
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
    mos_sem_take(&lvgl_display_sem, time);
}

void display_open(void)
{
    // display_cmd_t cmd = {.type = LCD_CMD_OPEN, .param = NULL};
    display_cmd_t cmd = {.type = LCD_CMD_OPEN, .p.open = {.brightness = 9, .mirror = 0x08}};
    mos_msgq_send(&display_msgq, &cmd, MOS_OS_WAIT_FOREVER);
}

void display_close(void)
{
    // display_cmd_t cmd = {.type = LCD_CMD_CLOSE, .param = NULL};
    // mos_msgq_sendsplay_msgq, &cmd, MOS_OS_WAIT_FOREVER);
}

void display_send_frame(void *data_ptr)
{
    // display_cmd_t cmd = {.type = LCD_CMD_DATA, .param = data_ptr};
    // mos_msgq_send(&display_msgq, &cmd, MOS_OS_WAIT_FOREVER);
}
void lvgl_dispaly_text(void)
{
    lv_obj_t *hello_world_label = lv_label_create(lv_screen_active());
    lv_label_set_text(hello_world_label, "Hello LVGL World");
    lv_obj_align(hello_world_label, LV_ALIGN_CENTER, 0, 0);  // 居中对齐； Center alignment;
    // lv_obj_align(hello_world_label, LV_TEXT_ALIGN_RIGHT, 0, 0); // 右对齐； Right alignment;
    // lv_obj_align(hello_world_label, LV_TEXT_ALIGN_LEFT, 0, 0);  // 左对齐； Left alignment;
    // lv_obj_align(hello_world_label, LV_ALIGN_BOTTOM_MID, 0, 0); // 底部居中对齐； Bottom center alignment;
    lv_obj_set_style_text_color(hello_world_label, lv_color_white(), 0);
    lv_obj_set_style_text_font(hello_world_label, &lv_font_montserrat_48, 0);
    lv_obj_set_style_bg_color(lv_screen_active(), lv_color_black(), 0);
}
static lv_obj_t   *counter_label;
static lv_timer_t *counter_timer;
static lv_obj_t   *acc_label;
static lv_obj_t   *gyr_label;
static void        counter_timer_cb(lv_timer_t *timer)
{
    int *count = (int *)lv_timer_get_user_data(timer);
    // lv_label_set_text_fmt(counter_label, "Count: %d", (*count)++);
    char buf[64];
    sprintf(buf, "ACC X=%.3f m/s Y=%.3f m/s Z=%.3f m/s", icm42688p_data.acc_ms2[0], icm42688p_data.acc_ms2[1],
            icm42688p_data.acc_ms2[2]);
    lv_label_set_text(acc_label, buf);
    memset(buf, 0, sizeof(buf));

    sprintf(buf, "GYR X=%.4f dps Y=%.4f dps Z=%.4f dps", icm42688p_data.gyr_dps[0], icm42688p_data.gyr_dps[1],
            icm42688p_data.gyr_dps[2]);
    lv_label_set_text(gyr_label, buf);
}

void ui_create(void)
{
    // counter_label = lv_label_create(lv_screen_active());
    acc_label = lv_label_create(lv_screen_active());
    lv_obj_align(acc_label, LV_TEXT_ALIGN_LEFT, 0, 320);
    gyr_label = lv_label_create(lv_screen_active());
    lv_obj_align(gyr_label, LV_TEXT_ALIGN_LEFT, 0, 380);

    // lv_obj_align(counter_label, LV_TEXT_ALIGN_LEFT, 50, 320);
    lv_obj_set_style_text_color(acc_label, lv_color_white(), 0);
    lv_obj_set_style_text_font(acc_label, &lv_font_montserrat_30, 0);
    lv_obj_set_style_text_color(gyr_label, lv_color_white(), 0);
    lv_obj_set_style_text_font(gyr_label, &lv_font_montserrat_30, 0);
    lv_obj_set_style_bg_color(lv_screen_active(), lv_color_black(), 0);
    static int count = 0;
    counter_timer    = lv_timer_create(counter_timer_cb, 300, &count);
}

/****************************************************/
static lv_obj_t *cont = NULL;
static lv_anim_t anim;

/**
 * @brief 动画回调，将容器纵向滚动到 v 像素; animation callback, scroll container vertically to v pixels
 */
static void scroll_cb(void *var, int32_t v)
{
    LV_UNUSED(var);
    lv_obj_scroll_to_y(cont, v, LV_ANIM_OFF);
}
/**
 * @brief Create a vertically scrolling long text in the specified area
 * @param parent  Parent object, typically use lv_scr_act()
 * @param x       X coordinate of the top-left corner of the area
 * @param y       Y coordinate of the top-left corner of the area
 * @param w       Width of the area (in pixels)
 * @param h       Height of the area (in pixels)
 * @param txt     Text to be scrolled and displayed
 * @param font    Pointer to the font, e.g., &lv_font_montserrat_48
 * @param time_ms Time (in milliseconds) to scroll to the end and return
 */
void scroll_text_create(lv_obj_t *parent, lv_coord_t x, lv_coord_t y, lv_coord_t w, lv_coord_t h, const char *txt,
                        const lv_font_t *font, uint32_t time_ms)
{
    scroll_text_stop();  // Stop any existing scrolling text

    cont = lv_obj_create(parent);
    lv_obj_set_size(cont, w, h);
    lv_obj_set_pos(cont, x, y);
    lv_obj_set_scroll_dir(cont, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(cont, LV_SCROLLBAR_MODE_OFF);

    lv_obj_set_style_bg_color(cont, lv_color_black(), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(cont, LV_OPA_COVER, LV_PART_MAIN);

    lv_obj_t *label = lv_label_create(cont);
    lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(label, w);
    lv_label_set_text(label, txt);

    lv_obj_set_style_text_color(label, lv_color_white(), LV_PART_MAIN);
    lv_obj_set_style_text_font(label, font, LV_PART_MAIN);

    // 强制标签布局更新，获取正确的内容高度; Force label layout update to get correct content height
    lv_obj_update_layout(label);
    int32_t label_h = lv_obj_get_height(label);
    // 计算滚动范围 = 标签高度 - 容器高度; calculate scroll range = label height - container height
    int32_t range = label_h - h;
    if (range <= 0)
        return;

    // 初始化并启动往返滚动动画; initialize and start ping-pong scroll animation
    lv_anim_init(&anim);
    lv_anim_set_var(&anim, cont);
    lv_anim_set_exec_cb(&anim, scroll_cb);
    lv_anim_set_time(&anim, time_ms);
    lv_anim_set_values(&anim, 0, range);
    // lv_anim_set_playback_duration(&anim, time_ms); // 反向动画时间; playback animation duration
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
void handle_display_text(const mentraos_ble_DisplayText *txt)
{
    display_cmd_t cmd;

    cmd.type = LCD_CMD_TEXT;
    // LOG_INF("show text: %s", (char *)txt->text.arg);
    // LOG_INF("Text: \"%s\" (length: %zu)", txt->text, strlen(txt->text));
    LOG_HEXDUMP_INF((char *)txt->text.arg, MAX_TEXT_LEN,"display_text");
    // strncpy(cmd.p.text.text, (char *)txt->text.arg, MAX_TEXT_LEN);
    memcpy(cmd.p.text.text, (char *)txt->text.arg, MAX_TEXT_LEN);
    cmd.p.text.text[MAX_TEXT_LEN] = '\0';

    cmd.p.text.x          = txt->x;
    cmd.p.text.y          = 260;  // test  // txt->y;
    cmd.p.text.font_code  = txt->font_code;
    cmd.p.text.font_color = txt->color;
    cmd.p.text.size       = txt->size;

    if (mos_msgq_send(&display_msgq, &cmd, MOS_OS_WAIT_ON) != 0)
    {
        LOG_ERR("UI queue full, drop text");
    }
}

/****************************************************/
static void show_default_ui(void)
{
    // 强制 LVGL 下一次做整屏刷新; force LVGL to do a full-screen refresh next time
    // lv_disp_set_full_refresh(lv_disp_get_default(), true);
    char *txt =
        "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Pellentesque fringilla, lorem dapibus fringilla "
        "feugiat, justo arcu volutpat magna, vitae ultricies metus tortor nec est. Fusce ut tellus arcu. Fusce eu "
        "rutrum metus, nec porta felis. Sed sed ligula laoreet, sodales lacus blandit, elementum justo. Sed posuere "
        "quam ut pellentesque ullamcorper. In quis consequat magna. Etiam quis turpis nec lorem dictum finibus. Donec "
        "mattis enim dolor, consequat lacinia nisi scelerisque id. Nulla euismod, purus sit amet accumsan tempus, "
        "lorem lectus euismod dolor, sit amet facilisis nisl quam elementum nisi. Curabitur et massa eget lorem "
        "lacinia scelerisque eget vitae felis. Nulla facilisi.\n\n"
        "Vivamus auctor sit amet ante id rhoncus. Duis a dolor neque. Mauris eu ornare tortor. Vivamus consequat, "
        "ipsum a volutpat congue, sem libero laoreet nulla, malesuada efficitur leo orci a est. Donec tincidunt nulla "
        "nibh, quis pretium mi fermentum quis. Fusce a mattis libero. Curabitur in felis suscipit, ultrices diam "
        "imperdiet, vestibulum arcu. Praesent id faucibus turpis. Pellentesque sed massa tincidunt, interdum purus "
        "tempus, pellentesque risus. Fusce feugiat magna eget nisl eleifend efficitur. Mauris ut convallis justo. "
        "Integer malesuada rutrum orci non tincidunt.\n\n"
        "Nullam aliquet leo sit amet volutpat tincidunt. Mauris ac accumsan nibh. Morbi accumsan commodo leo, at "
        "hendrerit massa hendrerit et. Aliquam nec sodales ex. Morbi at aliquet sem. Sed at magna ut felis mollis "
        "dictum ut ac orci. Nunc id lorem lacus. Vivamus id accumsan dolor, sed suscipit nulla. Pellentesque dictum "
        "erat non bibendum tempor. Fusce arcu risus, eleifend in lacus a, iaculis fermentum sapien. Praesent sodales "
        "libero vitae massa suscipit tincidunt. Aliquam quis arcu urna. Nunc sit amet mi leo.\n\n";
    lv_obj_clean(lv_screen_active());

    ui_create();

    // lv_example_scroll_text();
    // lvgl_dispaly_text();
    /*********************************/
    scroll_text_create(lv_scr_act(), 0, 120,  // x, y
                       640, 200,              // w, h
                       txt, &lv_font_montserrat_30,
                       30000);  // 往返周期 30000ms; ping-pong cycle 30000ms；

    // LV_IMG_DECLARE(my_img);   // 由 LVGL 的 img converter 工具生成 C 数组; generated C array by LVGL's img converter
    // tool lv_obj_t *img = lv_img_create(lv_scr_act());
    // lv_img_set_src(img, &my_img);
    // lv_obj_align(img, LV_ALIGN_CENTER, 0, 0);

    /********************************************** */
    // lv_demo_benchmark();
    // 立刻执行一次 LVGL 刷新; immediately execute one LVGL refresh
    lv_timer_handler();
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
    if (a6m_0011_init_sem_take() != 0)
    {
        LOG_ERR("Failed to a6m_0011_init_sem_take err");
        return;
    }

    mos_timer_create(&fps_timer, fps_timer_cb);
    mos_timer_start(&fps_timer, true, 1000);

    display_state_t state_type = LCD_STATE_INIT;
    display_cmd_t   cmd;
    display_open();  // test
    while (1)
    {
        frame_count++;
        if (state_type == LCD_STATE_ON)
        {
            lv_timer_handler();
        }
        /* 2) 尝试读命令——最多等 LVGL_TICK_MS ; try to read command, wait for LVGL_TICK_MS */
        int err = mos_msgq_receive(&display_msgq, &cmd, LVGL_TICK_MS);
        if (err != 0)
        {
            // 超时或队列空，没有新命令，直接下一次循环; timeout or queue empty, no new command, go to the next loop
            continue;
        }
        switch (cmd.type)
        {
            case LCD_CMD_INIT:
                // state_type = LCD_STATE_OFF;
                break;
            case LCD_CMD_OPEN:
                LOG_INF("LCD_CMD_OPEN");
                a6m_0011_power_on(); 
                set_display_onoff(true);

                a6m_0011_read_reg(0x00);
                a6m_0011_read_reg(0xBE);
                a6m_0011_read_reg(0xE2);

                a6m_0011_set_brightness(0x3A);
                a6m_0011_write_reg(0xBE, 0x82);
                mos_delay_us(6);
                a6m_0011_write_reg(0X60, 0X80);
                mos_delay_us(6);
                a6m_0011_write_reg(0X78, 0X0E);
                mos_delay_us(6);
                a6m_0011_write_reg(0X7C, 0X13);
                mos_delay_us(6);
                a6m_0011_write_reg(0XDD, 0X00); // clear border start
                mos_delay_us(6);
                a6m_0011_write_reg(0XDE, 0X00);
                mos_delay_us(6);
                a6m_0011_write_reg(0XC3, 0X80);
                mos_delay_ms(20);
                a6m_0011_write_reg(0XDD, 0X81);
                mos_delay_us(6);
                a6m_0011_write_reg(0XDE, 0X01);
                mos_delay_us(6);
                a6m_0011_write_reg(0XC3, 0X00); // clear border end
                mos_delay_us(6);
                a6m_0011_set_mirror(MIRROR_HORZ);
                mos_delay_ms(2);
                // a6m_0011_write_reg(0xE2, 0x19);
                // mos_delay_ms(2);
                a6m_0011_open_display();
                // a6m_0011_set_shift(MOVE_DEFAULT, 0);
                a6m_0011_clear_screen(false);
                state_type = LCD_STATE_ON;

                show_default_ui();  // 显示默认图像; test show default UI
                break;
            case LCD_CMD_DATA:
                break;
            case LCD_CMD_CLOSE:
                if (get_display_onoff())
                {
                    // a6m_0011_clear_screen(false); // 清屏
                    // lv_timer_handler();
                    scroll_text_stop();
                    set_display_onoff(false);
                    a6m_0011_power_off();
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
                lv_obj_set_style_text_font(lbl, &lv_font_montserrat_30, LV_PART_MAIN);
                lv_obj_set_pos(lbl, cmd.p.text.x, cmd.p.text.y);
            }
            break;
            default:
                break;
        }
        /* 处理完命令后，立即再刷一次画面，保证命令效果能马上显现; After processing the command, refresh the screen
         * again immediately to ensure the effect is visible After processing the command, immediately refresh the
         * screen to ensure the command effect is displayed immediately */
        if (state_type == LCD_STATE_ON)
        {
            lv_timer_handler();
        }
    }
}

void lvgl_dispaly_thread(void)
{
    lvgl_thread_handle = k_thread_create(&lvgl_thread_data, lvgl_stack_area, K_THREAD_STACK_SIZEOF(lvgl_stack_area),
                                         lvgl_dispaly_init, NULL, NULL, NULL, LVGL_THREAD_PRIORITY, 0, K_NO_WAIT);
    k_thread_name_set(lvgl_thread_handle, TASK_LVGL_NAME);
}