/*** 
 * @Author       : Cole
 * @Date         : 2025-07-31 10:46:08
 * @LastEditTime : 2025-08-19 20:47:29
 * @FilePath     : mos_fuel_gauge.h
 * @Description  : 
 * @
 * @ Copyright (c) MentraOS Contributors 2025 
 * @ SPDX-License-Identifier: Apache-2.0
 */

#ifndef _MOS_FUEL_GAUGE_H_
#define _MOS_FUEL_GAUGE_H_
#include <zephyr/kernel.h>
#include <stdbool.h>
int fuel_gauge_init(const struct device *charger);

int fuel_gauge_update(const struct device *charger, bool vbus_connected);

int pm1300_init(void);

void batter_monitor(void);
#endif /* _MOS_FUEL_GAUGE_H_ */
