/*
 * @Author       : XK
 * @Date         : 2025-07-15 10:39:14
 * @LastEditTime : 2025-07-15 11:40:48
 * @FilePath     : bspal_key.c
 * @Description  :
 *
 * Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved.
 */
#include "bal_os.h"
#include "bsp_key.h"
#include "bspal_key.h"

#define TAG "BSPAL_KEY"

#define DEBOUNCE_MS 50       /* 去抖时间 */
#define LONG_PRESS_MS 2000    /* 长按判定阈值 */
#define CLICK_TIMEOUT_MS 400 /* 多击间隔超时 */


static struct k_timer debounce_timer;
static struct k_timer click_timer;

/* 稳定电平（去抖后） */
static bool last_level;
/* 记录按下时刻 */
static int64_t press_ts;
/* 短按计数（多击） */
static uint8_t click_cnt;

extern volatile bool debouncing;
void bspal_debounce_timer_start(void)
{
    xyzn_os_timer_start(&debounce_timer, false, DEBOUNCE_MS);
}
void bspal_click_timer_start(void)
{
    xyzn_os_timer_start(&click_timer, false, CLICK_TIMEOUT_MS);
}
void bspal_click_timer_stop(void)
{
    xyzn_os_timer_stop(&click_timer);
}
/*—— 多击超时处理 ——*/
static void click_timeout(struct k_timer *t)
{
    switch (click_cnt)
    {
    case 1:
        BSP_LOGI(TAG, "Single click"); // 短按
        break;
    case 2:
        BSP_LOGI(TAG, "Double click"); // 双击
        break;
    case 3:
        BSP_LOGI(TAG, "Triple click"); // 三击
        break;
    default:
        BSP_LOGI(TAG, "%d-click", click_cnt);
        break;
    }
    /* 清零，多击周期结束 */
    click_cnt = 0;
}

/*—— 去抖定时到期 ——*/
static void debounce_timeout(struct k_timer *t)
{
    bool level = gpio_key1_read();
    debouncing = false;
    /* 如果电平与上次稳定值相同，无需处理 */
    if (level == last_level)
    {
        return;
    }
    last_level = level;

    int64_t now = xyzn_os_uptime_get();
    if (level)
    {
        /* 按下稳定：记录时刻 */
        press_ts = now;
    }
    else
    {
        /* 抬起稳定：计算持续时间 */
        int64_t dt = now - press_ts;
        if (dt >= LONG_PRESS_MS)
        {
            /* 长按事件 */
            BSP_LOGI(TAG, " Long press (%.0lld ms)", dt);
            /* 长按取消多击统计 */
            click_cnt = 0;
            bspal_click_timer_stop();
        }
        else if (dt >= DEBOUNCE_MS)
        {
            /* 短按事件 */
            BSP_LOGI(TAG, " Short press (%.0lld ms)", dt);
            /* 累加多击，并重启多击定时 */
            click_cnt++;
            bspal_click_timer_start();
        }
    }
}

void bspal_key_init(void)
{
    BSP_LOGI(TAG, "BSPAL Key Init");
    last_level = gpio_key1_read();
    xyzn_os_timer_create(&debounce_timer, debounce_timeout);
    xyzn_os_timer_create(&click_timer, click_timeout);
}