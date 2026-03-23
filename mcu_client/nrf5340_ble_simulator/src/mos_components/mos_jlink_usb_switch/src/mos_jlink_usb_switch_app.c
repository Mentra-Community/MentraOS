/*
 * @Author       : Cole
 * @Date         : 2026-01-26 14:16:26
 * @LastEditTime : 2026-01-26 14:21:30
 * @FilePath     : mos_jlink_usb_switch_app.c
 * @Description  : 
 * 
 *  Copyright (c) MentraOS Contributors 2026 
 *  SPDX-License-Identifier: Apache-2.0
 */


#include "mos_jlink_usb_switch_app.h"

#include "mos_jlink_usb_switch.h"

#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(mos_jlink_usb_switch_app, LOG_LEVEL_INF);

/* Application state | 应用状态 */
static bool app_initialized = false;

int mos_jlink_usb_switch_app_init(void)
{
    int ret;

    if (app_initialized)
    {
        LOG_WRN("J-Link/USB switch app already initialized");
        return 0;
    }

    /* Initialize driver | 初始化驱动 */
    ret = mos_jlink_usb_switch_init();
    if (ret != 0)
    {
        LOG_ERR("Failed to initialize J-Link/USB switch driver: %d", ret);
        return ret;
    }

    app_initialized = true;
    LOG_INF("J-Link/USB switch application logic initialized");

    return 0;
}

int mos_jlink_usb_switch_app_set_by_usb_status(bool usb_connected)
{
    if (!app_initialized)
    {
        LOG_ERR("J-Link/USB switch app not initialized");
        return -ENODEV;
    }

    /* USB connected = USB mode (HIGH), USB disconnected = J-Link mode (LOW) | USB连接=USB模式（高电平），USB断开=J-Link模式（低电平）*/
    mos_jlink_usb_mode_t mode = usb_connected ? MOS_JLINK_USB_MODE_USB : MOS_JLINK_USB_MODE_JLINK;
    return mos_jlink_usb_switch_set_mode(mode);
}

int mos_jlink_usb_switch_app_set_usb_mode(void)
{
    if (!app_initialized)
    {
        LOG_ERR("J-Link/USB switch app not initialized");
        return -ENODEV;
    }

    return mos_jlink_usb_switch_set_mode(MOS_JLINK_USB_MODE_USB);
}

int mos_jlink_usb_switch_app_set_jlink_mode(void)
{
    if (!app_initialized)
    {
        LOG_ERR("J-Link/USB switch app not initialized");
        return -ENODEV;
    }

    return mos_jlink_usb_switch_set_mode(MOS_JLINK_USB_MODE_JLINK);
}

int mos_jlink_usb_switch_app_toggle(void)
{
    if (!app_initialized)
    {
        LOG_ERR("J-Link/USB switch app not initialized");
        return -ENODEV;
    }

    mos_jlink_usb_mode_t current_mode = mos_jlink_usb_switch_get_mode();
    mos_jlink_usb_mode_t new_mode     = (current_mode == MOS_JLINK_USB_MODE_USB) ? MOS_JLINK_USB_MODE_JLINK : MOS_JLINK_USB_MODE_USB;

    return mos_jlink_usb_switch_set_mode(new_mode);
}

bool mos_jlink_usb_switch_app_is_jlink_mode(void)
{
    if (!app_initialized)
    {
        return false;
    }

    return (mos_jlink_usb_switch_get_mode() == MOS_JLINK_USB_MODE_JLINK);
}
