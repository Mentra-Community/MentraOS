/*** 
 * @Author       : Cole
 * @Date         : 2026-01-26 14:15:52
 * @LastEditTime : 2026-01-26 14:22:19
 * @FilePath     : mos_jlink_usb_switch.h
 * @Description  : 
 * @
 * @ Copyright (c) MentraOS Contributors 2026 
 * @ SPDX-License-Identifier: Apache-2.0
 */


#ifndef MOS_JLINK_USB_SWITCH_H_
#define MOS_JLINK_USB_SWITCH_H_

#include <stdbool.h>
#include <zephyr/device.h>
#include <zephyr/drivers/gpio.h>

/**
 * @brief J-Link/USB switch mode | J-Link/USB切换模式
 */
typedef enum
{
    MOS_JLINK_USB_MODE_USB    = 0,  // USB mode (GPIO HIGH) | USB模式（高电平）
    MOS_JLINK_USB_MODE_JLINK  = 1,  // J-Link mode (GPIO LOW) | J-Link模式（低电平）
} mos_jlink_usb_mode_t;

/**
 * @brief Initialize J-Link/USB switch driver | 初始化J-Link/USB切换驱动
 * @return 0 on success, negative error code on failure
 * @return 成功返回0，失败返回负数错误码
 */
int mos_jlink_usb_switch_init(void);

/**
 * @brief Set J-Link/USB switch mode | 设置J-Link/USB切换模式
 * @param mode Switch mode (USB or J-Link) | 切换模式（USB或J-Link）
 * @return 0 on success, negative error code on failure
 * @return 成功返回0，失败返回负数错误码
 */
int mos_jlink_usb_switch_set_mode(mos_jlink_usb_mode_t mode);

/**
 * @brief Get current J-Link/USB switch mode | 获取当前J-Link/USB切换模式
 * @return Current switch mode | 当前切换模式
 */
mos_jlink_usb_mode_t mos_jlink_usb_switch_get_mode(void);

/**
 * @brief Check if J-Link/USB switch is initialized | 检查J-Link/USB切换是否已初始化
 * @return true if initialized, false otherwise
 * @return 如果已初始化返回true，否则返回false
 */
bool mos_jlink_usb_switch_is_initialized(void);

#endif  // MOS_JLINK_USB_SWITCH_H_
