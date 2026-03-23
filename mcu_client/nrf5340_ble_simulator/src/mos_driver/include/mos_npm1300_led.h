/***
 * @Author       : Cole
 * @Date         : 2025-11-22 14:02:36
 * @LastEditTime : 2025-11-22 14:18:38
 * @FilePath     : mos_npm1300_led.h
 * @Description  :
 * @
 * @ Copyright (c) MentraOS Contributors 2025
 * @ SPDX-License-Identifier: Apache-2.0
 */


#ifndef MOS_NPM1300_LED_H_
#define MOS_NPM1300_LED_H_

#include <stdbool.h>
#include <stdint.h>
#include <zephyr/device.h>
#include <zephyr/kernel.h>

/* LED IDs - nPM1300 has 3 LEDs (led0, led1, led2) */
#define NPM1300_LED0    0
#define NPM1300_LED1    1
#define NPM1300_LED2    2
#define NPM1300_LED_MAX 3

/* LED blinking timing */
#define NPM1300_LED_ON_TIME_MS 100       /* LED on time: fixed 100ms */

/* Default blinking interval (milliseconds) */
#define NPM1300_LED_DEFAULT_INTERVAL_MS 500 /* Default: 500ms interval (100ms on, 400ms off) */

/* Minimum and maximum blinking interval (milliseconds) */
#define NPM1300_LED_MIN_INTERVAL_MS 100   /* Minimum: 100ms interval (100ms on, 0ms off) */
#define NPM1300_LED_MAX_INTERVAL_MS 10000 /* Maximum: 10000ms (10 seconds) interval */

/**
 * @brief Initialize nPM1300 LED driver
 *
 * @return 0 on success, negative error code on failure
 */
int npm1300_led_init(void);

/**
 * @brief Turn LED on (solid)
 *
 * @param led_id LED ID (0-2)
 * @return 0 on success, negative error code on failure
 */
int npm1300_led_on(uint8_t led_id);

/**
 * @brief Turn LED off
 *
 * @param led_id LED ID (0-2)
 * @return 0 on success, negative error code on failure
 */
int npm1300_led_off(uint8_t led_id);

/**
 * @brief Start blinking LED with specified interval
 *
 * @param led_id LED ID (0-2)
 * @param interval_ms Blinking interval in milliseconds (time between each blink)
 *                    Example: 100ms = blink every 100ms, 3000ms = blink every 3 seconds
 * @return 0 on success, negative error code on failure
 */
int npm1300_led_blink(uint8_t led_id, uint32_t interval_ms);

/**
 * @brief Stop blinking LED (turns LED off)
 *
 * @param led_id LED ID (0-2)
 * @return 0 on success, negative error code on failure
 */
int npm1300_led_stop_blink(uint8_t led_id);

/**
 * @brief Get current LED state
 *
 * @param led_id LED ID (0-2)
 * @return true if LED is on or blinking, false if off
 */
bool npm1300_led_is_on(uint8_t led_id);

/**
 * @brief Get blinking status
 *
 * @param led_id LED ID (0-2)
 * @return true if LED is blinking, false otherwise
 */
bool npm1300_led_is_blinking(uint8_t led_id);

#endif /* MOS_NPM1300_LED_H_ */

