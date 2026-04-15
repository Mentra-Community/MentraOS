/***
 * @Author       : Cole
 * @Date         : 2026-04-15 10:46:58
 * @LastEditTime : 2026-04-15 11:21:18
 * @FilePath     : mos_brightness.h
 * @Description  :
 * @ Copyright (c) MentraOS Contributors 2026
 * @ SPDX-License-Identifier: Apache-2.0
 */


#ifndef MOS_BRIGHTNESS_H_
#define MOS_BRIGHTNESS_H_

#include <stdbool.h>
#include <stdint.h>

typedef struct
{
	uint32_t current_level_percent;
	bool auto_enabled;
	float multiplier;
	float last_lux;
	float filtered_lux;
	int last_sensor_error;
	bool sample_log_enabled;
} mos_brightness_status_t;

/**
 * @brief Submit a manual brightness request
 *
 * The brightness component owns all internal state. Callers do not mutate
 * internal fields directly; they submit a manual request and the component
 * applies it, disabling AUTO mode if necessary.
 *
 * @param level_percent  Manual brightness level (0-100%; values above 100 are clamped)
 */
void mos_brightness_request_manual(uint32_t level_percent);

/**
 * @brief Submit an AUTO enable/disable request
 *
 * When enabled: OPT3006 is polled every 1500 ms; brightness follows a
 * piecewise linear lux-to-percent curve scaled by the current multiplier.
 * When disabled: the last manually-requested brightness level is restored.
 *
 * @param enabled  true to start AUTO polling, false to restore manual level
 */
void mos_brightness_request_auto_enabled(bool enabled);

/**
 * @brief Submit an AUTO multiplier update request
 *
 * Scales the lux-to-percent mapping curve output. AUTO brightness still respects
 * the calibrated minimum/maximum brightness limits after multiplier scaling.
 * Values outside [0.10, 3.00] are clamped.
 *
 * @param multiplier  sensitivity scale factor
 */
void mos_brightness_request_multiplier(float multiplier);

/**
 * @brief Enable or disable per-sample AUTO brightness logging
 *
 * The sample log is intentionally off by default because AUTO polls every
 * 1500 ms. Enable it from shell only when collecting tuning logs.
 *
 * @param enabled  true to print each AUTO sample at info level
 */
void mos_brightness_set_sample_log_enabled(bool enabled);

/**
 * @brief Read a snapshot of brightness state for UI/debugging
 *
 * This is the only public read API. External code should not depend on
 * individual internal fields or derive state transitions itself.
 *
 * @param status  Output snapshot pointer
 */
void mos_brightness_get_status(mos_brightness_status_t *status);

#endif /* MOS_BRIGHTNESS_H_ */
