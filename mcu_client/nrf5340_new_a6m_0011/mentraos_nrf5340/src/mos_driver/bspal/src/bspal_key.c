/*
 * @Author       : Cole
 * @Date         : 2025-07-31 10:40:40
 * @LastEditTime : 2025-08-20 10:23:08
 * @FilePath     : bspal_key.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2025
 *  SPDX-License-Identifier: Apache-2.0
 */


#include "bal_os.h"
#include "bsp_key.h"
#include <zephyr/logging/log.h>
#include "bspal_key.h"

#define LOG_MODULE_NAME BSPAL_KEY
LOG_MODULE_REGISTER(LOG_MODULE_NAME);


#define DEBOUNCE_MS      50   /* 去抖延时 debounce delay */
#define LONG_PRESS_MS    2000 /* 长按判定阈值; Long press threshold */
#define CLICK_TIMEOUT_MS 400  /* 多击间隔超时; Multi-click interval timeout */

static struct k_timer debounce_timer;
static struct k_timer click_timer;

/* 稳定电平（去抖后）; Stable level (after debouncing) */
static bool last_level;
/* 记录按下时刻 ; Record the press timestamp */
static int64_t press_ts;
/* 短按计数（多击） ; Short press count (multi-click) */
static uint8_t click_cnt;

extern volatile bool debouncing;
void                 bspal_debounce_timer_start(void)
{
    mos_timer_start(&debounce_timer, false, DEBOUNCE_MS);
}
void bspal_click_timer_start(void)
{
    mos_timer_start(&click_timer, false, CLICK_TIMEOUT_MS);
}
void bspal_click_timer_stop(void)
{
    mos_timer_stop(&click_timer);
}

static void click_timeout(struct k_timer *t)
{
    switch (click_cnt)
    {
        case 1:
            LOG_INF("Single click");
            break;
        case 2:
            LOG_INF("Double click");
            break;
        case 3:
            LOG_INF("Triple click");
            break;
        default:
            LOG_INF("%d-click", click_cnt);
            break;
    }

    click_cnt = 0;  // 重置多击计数; Reset multi-click count
}

static void debounce_timeout(struct k_timer *t)
{
    bool level = gpio_key1_read();
    debouncing = false;
    /* 如果电平与上次稳定值相同，无需处理 */
    // If the level is the same as the last stable value, no processing is needed
    if (level == last_level)
    {
        return;
    }
    last_level = level;

    int64_t now = mos_uptime_get();
    if (level)
    {
        /* 按下稳定：记录时刻 */
        // If the level is stable, record the timestamp
        press_ts = now;
    }
    else
    {
        /* 抬起稳定：计算持续时间 */
        // If the level is stable, calculate the duration
        int64_t dt = now - press_ts;
        if (dt >= LONG_PRESS_MS)
        {
            /* 长按事件 */
            // Long press event
            LOG_INF(" Long press (%.0lld ms)", dt);
            /* 长按取消多击统计 */
            // Cancel multi-click statistics for long press
            click_cnt = 0;
            bspal_click_timer_stop();
        }
        else if (dt >= DEBOUNCE_MS)
        {
            /* 短按事件 */
            // Short press event
            LOG_INF(" Short press (%.0lld ms)", dt);
            /* 累加多击，并重启多击定时 */
            // Accumulate multi-click and restart multi-click timer
            click_cnt++;
            bspal_click_timer_start();
        }
    }
}

void bspal_key_init(void)
{
    LOG_INF("BSPAL Key Init");
    last_level = gpio_key1_read();
    mos_timer_create(&debounce_timer, debounce_timeout);
    mos_timer_create(&click_timer, click_timeout);
}