/*** 
 * @Author       : Cole
 * @Date         : 2026-01-24 11:14:00
 * @LastEditTime : 2026-01-26 13:49:26
 * @FilePath     : mos_button_app.h
 * @Description  : 
 * @
 * @ Copyright (c) MentraOS Contributors 2026 
 * @ SPDX-License-Identifier: Apache-2.0
 */

#ifndef MOS_BUTTON_APP_H_
#define MOS_BUTTON_APP_H_

#include <stdbool.h>
#include <stdint.h>

/**
 * @brief Button press type | 按键按下类型
 */
typedef enum
{
    MOS_BUTTON_PRESS_SHORT  = 0,  // Short press (< 2.5 seconds) | 短按（< 2.5秒）
    MOS_BUTTON_PRESS_LONG   = 1,  // Long press (>= 2.5 seconds) | 长按（>= 2.5秒）
} mos_button_press_type_t;

/**
 * @brief Button event callback type | 按键事件回调类型
 * @param press_type Type of button press | 按键按下类型
 */
typedef void (*mos_button_app_callback_t)(mos_button_press_type_t press_type);

/**
 * @brief Initialize button application logic | 初始化按键应用逻辑
 * @return 0 on success, negative error code on failure
 * @return 成功返回0，失败返回负数错误码
 */
int mos_button_app_init(void);

/**
 * @brief Register button event callback | 注册按键事件回调
 * @param callback Callback function to be called on button events
 * @param callback 按键事件时调用的回调函数
 * @return 0 on success, negative error code on failure
 * @return 成功返回0，失败返回负数错误码
 */
int mos_button_app_register_callback(mos_button_app_callback_t callback);

/**
 * @brief Unregister button event callback | 注销按键事件回调
 */
void mos_button_app_unregister_callback(void);

/**
 * @brief Enter System OFF deep sleep mode | 进入System OFF深度休眠模式
 * @return 0 on success, negative error code on failure
 * @return 成功返回0，失败返回负数错误码
 * @note This function will not return if successful (device enters sleep)
 * @note 如果成功，此函数不会返回（设备进入休眠）
 */
int mos_button_app_enter_sleep(void);

/**
 * @brief Check if device is waking from System OFF | 检查设备是否从System OFF唤醒
 * @return true if waking from System OFF, false otherwise
 * @return 如果从System OFF唤醒返回true，否则返回false
 * @note This function clears the reset reason, so should only be called once | 此函数会清除复位原因，因此只应调用一次
 */
bool mos_button_app_is_waking_from_sleep(void);

/**
 * @brief Check wakeup state and button immediately after wakeup (before full initialization) | 唤醒后立即检查唤醒状态和按键（在完整初始化之前）
 * @return true if device woke from sleep, false otherwise
 * @return 如果设备从休眠唤醒返回true，否则返回false
 * @note This should be called as early as possible in main() after wakeup | 这应在 main() 中唤醒后尽可能早地调用
 * @note Records the wakeup time if button is already pressed on wakeup | 如果唤醒时按键已按下，记录唤醒时间
 * @note This function calls mos_button_app_is_waking_from_sleep() internally, so don't call it again | 此函数内部调用mos_button_app_is_waking_from_sleep()，所以不要再次调用
 */
bool mos_button_app_check_wakeup_state(void);

/**
 * @brief Wait for button long press (2500ms) to power on | 等待按键长按（2500ms）以开机
 * @param timeout_ms Maximum time to wait in milliseconds | 最大等待时间（毫秒）
 * @return 0 if long press detected, negative error code on timeout or failure
 * @return 如果检测到长按返回0，超时或失败返回负数错误码
 * @note This function should be called after System OFF wakeup | 此函数应在System OFF唤醒后调用
 * @note If long press is not detected within timeout, device will enter sleep again | 如果在超时时间内未检测到长按，设备将再次进入休眠
 * @note Uses wakeup button press time if button was already pressed on wakeup | 如果唤醒时按键已按下，使用唤醒按键按下时间
 */
int mos_button_app_wait_for_power_on(uint32_t timeout_ms);

#endif  // MOS_BUTTON_APP_H_
