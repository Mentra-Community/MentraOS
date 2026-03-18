/***
 * @Author       : Cole
 * @Date         : 2026-01-24 11:14:00
 * @LastEditTime : 2026-01-26 09:46:21
 * @FilePath     : mos_button.h
 * @Description  :
 * @
 * @ Copyright (c) MentraOS Contributors 2026
 * @ SPDX-License-Identifier: Apache-2.0
 */

#ifndef MOS_BUTTON_H_
#define MOS_BUTTON_H_

#include <stdbool.h>
#include <zephyr/device.h>
#include <zephyr/drivers/gpio.h>

/**
 * @brief Button state | 按键状态
 */
typedef enum
{
    MOS_BUTTON_STATE_RELEASED = 0,  // Button released (not pressed) | 按键释放（未按下）
    MOS_BUTTON_STATE_PRESSED  = 1,  // Button pressed | 按键按下
} mos_button_state_t;

/**
 * @brief Button event callback type | 按键事件回调类型
 * @param state Current button state | 当前按键状态
 */
typedef void (*mos_button_callback_t)(mos_button_state_t state);

/**
 * @brief Initialize button driver | 初始化按键驱动
 * @return 0 on success, negative error code on failure
 * @return 成功返回0，失败返回负数错误码
 * @note Configures P0.23 GPIO as input with pull-up
 * @note 配置 P0.23 GPIO 为输入模式，上拉
 */
int mos_button_init(void);

/**
 * @brief Check if button is pressed | 检查按键是否按下
 * @return true if button is pressed, false otherwise
 * @return 按键按下返回true，否则返回false
 */
bool mos_button_is_pressed(void);

/**
 * @brief Get current button state | 获取当前按键状态
 * @return Current button state | 当前按键状态
 */
mos_button_state_t mos_button_get_state(void);

/**
 * @brief Register button event callback | 注册按键事件回调
 * @param callback Callback function to be called on button state change
 * @param callback 按键状态变化时调用的回调函数
 * @return 0 on success, negative error code on failure
 * @return 成功返回0，失败返回负数错误码
 * @note Only one callback can be registered at a time
 * @note 同时只能注册一个回调函数
 */
int mos_button_register_callback(mos_button_callback_t callback);

/**
 * @brief Unregister button event callback | 注销按键事件回调
 */
void mos_button_unregister_callback(void);

/**
 * @brief Configure button GPIO for System OFF wakeup | 配置按键GPIO用于System OFF唤醒
 * @return 0 on success, negative error code on failure
 * @return 成功返回0，失败返回负数错误码
 * @note Configures GPIO SENSE for low-power wakeup detection
 * @note 配置GPIO SENSE用于低功耗唤醒检测
 */
int mos_button_configure_wakeup(void);

/**
 * @brief Re-enable button interrupt | 重新使能按键中断
 * @return 0 on success, negative error code on failure
 * @return 成功返回0，失败返回负数错误码
 * @note Should be called after processing button interrupt event
 * @note 应在处理完按键中断事件后调用
 */
int mos_button_re_enable_interrupt(void);

/**
 * @brief Configure button GPIO for polling (input mode, no interrupt) | 配置按键GPIO用于轮询（输入模式，无中断）
 * @return 0 on success, negative error code on failure
 * @return 成功返回0，失败返回负数错误码
 * @note Used when interrupt is disabled and we need to poll button state | 当中断已禁用且需要轮询按键状态时使用
 */
int mos_button_configure_for_polling(void);

#endif  // MOS_BUTTON_H_
