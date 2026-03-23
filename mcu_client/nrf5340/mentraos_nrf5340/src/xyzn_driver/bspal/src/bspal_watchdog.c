/*
 * @Author       : XK
 * @Date         : 2025-07-16 16:22:25
 * @LastEditTime : 2025-07-16 16:48:40
 * @FilePath     : bspal_watchdog.c
 * @Description  :
 *
 * Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved.
 */

#include <zephyr/device.h>
#include <zephyr/drivers/watchdog.h>
#include "bspal_watchdog.h"
#include "bal_os.h"
#include "bsp_log.h"
#include "bspal_watchdog.h"

#define TAG "BSPAL_WATCHDOG"

#ifndef WDT_ALLOW_CALLBACK
#define WDT_ALLOW_CALLBACK 1
#endif

#ifndef WDT_MAX_WINDOW
#define WDT_MAX_WINDOW (30 * 1000U)
#endif

#ifndef WDT_MIN_WINDOW
#define WDT_MIN_WINDOW 0U
#endif

#ifndef WDT_OPT
#define WDT_OPT WDT_OPT_PAUSE_HALTED_BY_DBG
#endif

struct wdt_data_storage
{
    const struct device *wdt_drv;
    int wdt_channel_id;
    // struct k_work_delayable system_workqueue_work;
};
static struct wdt_data_storage wdt_data;

void primary_feed_worker(void)
{
    int err = wdt_feed(wdt_data.wdt_drv, wdt_data.wdt_channel_id);
    if (err)
    {
        BSP_LOGE(TAG, "Cannot feed watchdog. Error code: %d", err);
    }
    else
    {
        BSP_LOGI(TAG, "Cannot feed watchdog. OK code: %d", err);
    }
}
#if WDT_ALLOW_CALLBACK
static void wdt_callback(const struct device *wdt_dev, int channel_id)
{
    static bool handled_event;

    if (handled_event)
    {
        return;
    }

    wdt_feed(wdt_dev, channel_id);

    BSP_LOGI(TAG, "Handled things..ready to reset");
    handled_event = true;
}
#endif /* WDT_ALLOW_CALLBACK */
int bspal_watchdog_init(void)
{
    BSP_LOGI(TAG, "Initializing watchdog...");
    int err;
    wdt_data.wdt_drv = DEVICE_DT_GET(DT_ALIAS(watchdog0));
    if (!device_is_ready(wdt_data.wdt_drv))
    {
        BSP_LOGE(TAG, "%s: device not ready", wdt_data.wdt_drv->name);
        return XYZN_OS_ERROR;
    }

    struct wdt_timeout_cfg wdt_config = {
        /* Reset SoC when watchdog timer expires. */
        .flags = WDT_FLAG_RESET_SOC,

        /* Expire watchdog after max window */
        .window.min = WDT_MIN_WINDOW,
        .window.max = WDT_MAX_WINDOW,
    };
#if WDT_ALLOW_CALLBACK
    /* Set up watchdog callback. */
    wdt_config.callback = wdt_callback;

    BSP_LOGI(TAG, "Attempting to test pre-reset callback");
#else  /* WDT_ALLOW_CALLBACK */
    BSP_LOGI(TAG, "Callback in RESET_SOC disabled for this platform");
#endif /* WDT_ALLOW_CALLBACK */

    wdt_data.wdt_channel_id = wdt_install_timeout(wdt_data.wdt_drv, &wdt_config);
    if (wdt_data.wdt_channel_id < 0)
    {
        BSP_LOGE(TAG, "Watchdog install error");
        return XYZN_OS_ERROR;
    }

    err = wdt_setup(wdt_data.wdt_drv, WDT_OPT);
    if (err < 0)
    {
        BSP_LOGE(TAG, "Watchdog setup error");
        return XYZN_OS_ERROR;
    }

    return 0;
}