/*
 * @Author       : Cole
 * @Date         : 2026-01-26 14:16:02
 * @LastEditTime : 2026-01-26 14:22:35
 * @FilePath     : mos_jlink_usb_switch.c
 * @Description  : 
 * 
 *  Copyright (c) MentraOS Contributors 2026 
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "mos_jlink_usb_switch.h"

#include <zephyr/device.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/devicetree.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(mos_jlink_usb_switch, LOG_LEVEL_INF);

/* Device tree node for J-Link/USB switch GPIO | J-Link/USB切换GPIO的设备树节点 */
#define USER_NODE DT_PATH(zephyr_user)

#if !DT_NODE_EXISTS(USER_NODE) || !DT_NODE_HAS_PROP(USER_NODE, jlink_usb_switch_gpios)
#error "J-Link/USB switch GPIO not defined in device tree. Add 'jlink_usb_switch-gpios = <&gpio1 11 GPIO_ACTIVE_HIGH>;' to zephyr,user node"
#endif

/* GPIO device spec | GPIO设备规格 */
static const struct gpio_dt_spec jlink_usb_switch_gpio = GPIO_DT_SPEC_GET(USER_NODE, jlink_usb_switch_gpios);

/* Driver state | 驱动状态 */
static bool                    jlink_usb_switch_initialized = false;
static mos_jlink_usb_mode_t    current_mode                 = MOS_JLINK_USB_MODE_USB;

int mos_jlink_usb_switch_init(void)
{
    int ret;

    if (jlink_usb_switch_initialized)
    {
        LOG_WRN("J-Link/USB switch already initialized");
        return 0;
    }

    if (!gpio_is_ready_dt(&jlink_usb_switch_gpio))
    {
        LOG_ERR("J-Link/USB switch GPIO port not ready");
        return -ENODEV;
    }

    /* Configure as output, initial state HIGH (USB mode) | 配置为输出，初始状态为高电平（USB模式）*/
    /* Hardware logic: HIGH = USB, LOW = J-Link | 硬件逻辑：高电平=USB，低电平=J-Link */
    ret = gpio_pin_configure_dt(&jlink_usb_switch_gpio, GPIO_OUTPUT_ACTIVE);
    if (ret != 0)
    {
        LOG_ERR("Failed to configure J-Link/USB switch GPIO: %d", ret);
        return ret;
    }

    /* Explicitly set to HIGH to ensure initial state (USB mode) | 显式设置为高电平确保初始状态（USB模式）*/
    ret = gpio_pin_set_dt(&jlink_usb_switch_gpio, 1);
    if (ret != 0)
    {
        LOG_ERR("Failed to set J-Link/USB switch GPIO to HIGH: %d", ret);
        return ret;
    }

    current_mode                 = MOS_JLINK_USB_MODE_USB;
    jlink_usb_switch_initialized = true;
    LOG_INF("J-Link/USB switch driver initialized (P1.%d), initial state: HIGH (USB mode)", jlink_usb_switch_gpio.pin);

    return 0;
}

int mos_jlink_usb_switch_set_mode(mos_jlink_usb_mode_t mode)
{
    int ret;

    if (!jlink_usb_switch_initialized)
    {
        LOG_ERR("J-Link/USB switch not initialized");
        return -ENODEV;
    }

    if (!gpio_is_ready_dt(&jlink_usb_switch_gpio))
    {
        LOG_ERR("J-Link/USB switch GPIO not ready");
        return -ENODEV;
    }

    /* Hardware logic: HIGH = USB, LOW = J-Link | 硬件逻辑：高电平=USB，低电平=J-Link */
    bool jlink_mode = (mode == MOS_JLINK_USB_MODE_JLINK);
    ret = gpio_pin_set_dt(&jlink_usb_switch_gpio, jlink_mode ? 0 : 1);
    if (ret != 0)
    {
        LOG_ERR("Failed to set J-Link/USB switch GPIO to %s: %d",
                jlink_mode ? "LOW (J-Link)" : "HIGH (USB)", ret);
        return ret;
    }

    current_mode = mode;
    LOG_INF("J-Link/USB switch (P1.%d) set to %s (%s mode)",
            jlink_usb_switch_gpio.pin,
            jlink_mode ? "LOW" : "HIGH",
            jlink_mode ? "J-Link" : "USB");

    return 0;
}

mos_jlink_usb_mode_t mos_jlink_usb_switch_get_mode(void)
{
    return current_mode;
}

bool mos_jlink_usb_switch_is_initialized(void)
{
    return jlink_usb_switch_initialized;
}
