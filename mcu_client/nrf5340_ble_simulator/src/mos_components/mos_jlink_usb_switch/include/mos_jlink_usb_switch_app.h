/*** 
 * @Author       : Cole
 * @Date         : 2026-01-26 14:16:14
 * @LastEditTime : 2026-01-26 14:21:18
 * @FilePath     : mos_jlink_usb_switch_app.h
 * @Description  : 
 * @
 * @ Copyright (c) MentraOS Contributors 2026 
 * @ SPDX-License-Identifier: Apache-2.0
 */



#ifndef MOS_JLINK_USB_SWITCH_APP_H_
#define MOS_JLINK_USB_SWITCH_APP_H_

#include <stdbool.h>

/**
 * @brief Initialize J-Link/USB switch application logic | 初始化J-Link/USB切换应用逻辑
 * @return 0 on success, negative error code on failure
 * @return 成功返回0，失败返回负数错误码
 */
int mos_jlink_usb_switch_app_init(void);

/**
 * @brief Set J-Link/USB switch based on USB connection status | 根据USB连接状态设置J-Link/USB切换
 * @param usb_connected true if USB is connected (set to USB mode/HIGH), false for J-Link mode (LOW)
 * @param usb_connected true表示USB已连接（设置为USB模式/高电平），false为J-Link模式（低电平）
 * @return 0 on success, negative error code on failure
 * @return 成功返回0，失败返回负数错误码
 */
int mos_jlink_usb_switch_app_set_by_usb_status(bool usb_connected);

/**
 * @brief Set J-Link/USB switch to USB mode | 设置J-Link/USB切换为USB模式
 * @return 0 on success, negative error code on failure
 * @return 成功返回0，失败返回负数错误码
 */
int mos_jlink_usb_switch_app_set_usb_mode(void);

/**
 * @brief Set J-Link/USB switch to J-Link mode | 设置J-Link/USB切换为J-Link模式
 * @return 0 on success, negative error code on failure
 * @return 成功返回0，失败返回负数错误码
 */
int mos_jlink_usb_switch_app_set_jlink_mode(void);

/**
 * @brief Toggle J-Link/USB switch mode | 切换J-Link/USB切换模式
 * @return 0 on success, negative error code on failure
 * @return 成功返回0，失败返回负数错误码
 */
int mos_jlink_usb_switch_app_toggle(void);

/**
 * @brief Get current J-Link/USB switch mode | 获取当前J-Link/USB切换模式
 * @return true if J-Link mode, false if USB mode
 * @return 如果为J-Link模式返回true，如果为USB模式返回false
 */
bool mos_jlink_usb_switch_app_is_jlink_mode(void);

#endif  // MOS_JLINK_USB_SWITCH_APP_H_
