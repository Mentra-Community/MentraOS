/*
 * Copyright (c) MentraOS Contributors 2025
 * SPDX-License-Identifier: Apache-2.0
 */

#ifndef _MOS_FUEL_GAUGE_H_
#define _MOS_FUEL_GAUGE_H_

#include <stdbool.h>
#include <zephyr/device.h>

/**
 * @brief Initialize fuel gauge with charger device
 * 使用充电器设备初始化电量计
 * @param charger Pointer to charger device
 * @return 0 on success, negative error code on failure
 */
int fuel_gauge_init(const struct device *charger);

/**
 * @brief Update fuel gauge status
 * 更新电量计状态
 * @param charger Pointer to charger device
 * @param vbus_connected VBUS connection status
 * @return 0 on success, negative error code on failure
 */
int fuel_gauge_update(const struct device *charger, bool vbus_connected);

/**
 * @brief Initialize PM1300 PMIC device
 * 初始化PM1300 PMIC设备
 * @return 0 on success, negative error code on failure
 */
int pm1300_init(void);

/**
 * @brief Monitor battery status (one-shot read and sync to protobuf/display)
 * 监控电池状态（单次读取并同步到 protobuf/显示）
 */
void battery_monitor(void);

/**
 * @brief Get current charge status
 * 获取当前充电状态
 * @param chg_status Pointer to store charge status value
 * @return 0 on success, negative error code on failure
 */
int battery_get_charge_status(int32_t *chg_status);

/** Periodic monitor interval in ms (used by shell status). */
#define BATTERY_MONITOR_INTERVAL_MS 5000

/**
 * @brief Start battery monitoring automatically (e.g. from main after pm1300_init).
 *        One immediate read, then periodic updates every BATTERY_MONITOR_INTERVAL_MS.
 * 上电后自动启动电池监控：立即读一次，然后按间隔周期更新。
 */
void battery_monitor_auto_start(void);

/** Start periodic monitoring (e.g. from shell "battery monitor start"). */
void battery_monitor_start(void);

/** Stop periodic monitoring. */
void battery_monitor_stop(void);

/** True if periodic monitoring is running. */
bool battery_monitor_is_active(void);

#endif /* _MOS_FUEL_GAUGE_H_ */
