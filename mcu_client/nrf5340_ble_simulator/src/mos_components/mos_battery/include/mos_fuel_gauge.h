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
 * @brief Monitor battery status
 * 监控电池状态
 */
void battery_monitor(void);

/**
 * @brief Get current charge status
 * 获取当前充电状态
 * @param chg_status Pointer to store charge status value
 * @return 0 on success, negative error code on failure
 */
int battery_get_charge_status(int32_t *chg_status);

/**
 * @brief Get current battery state of charge percentage
 * 获取当前电池电量百分比
 * @return Battery SoC as integer percentage (0-100), or negative error code on failure
 */
int battery_get_soc_percentage(void);

/**
 * @brief Check if battery is currently charging
 * 检查电池是否正在充电
 * @return true if charging, false if not charging or error
 */
bool battery_is_charging(void);

#endif /* _MOS_FUEL_GAUGE_H_ */
