/***
 * @Author       : Cole
 * @Date         : 2026-01-26
 * @LastEditTime : 2026-01-26
 * @FilePath     : mos_npm1300_ldsw.h
 * @Description  : nPM1300 LDSW1 (Load Switch) control driver
 * 
 * @ Copyright (c) MentraOS Contributors 2026
 * @ SPDX-License-Identifier: Apache-2.0
 */

#ifndef MOS_NPM1300_LDSW_H
#define MOS_NPM1300_LDSW_H

#include <stdbool.h>
#include <stdint.h>

/**
 * @brief Initialize nPM1300 LDSW1 driver
 * 
 * @return 0 on success, negative error code on failure
 * @return 成功返回0，失败返回负数错误码
 */
int mos_npm1300_ldsw1_init(void);

/**
 * @brief Enable LDSW1 (turn on load switch)
 * 
 * Powers on the device connected to LDSW1
 * 给连接到LDSW1的设备上电
 * 
 * @return 0 on success, negative error code on failure
 * @return 成功返回0，失败返回负数错误码
 */
int mos_npm1300_ldsw1_enable(void);

/**
 * @brief Disable LDSW1 (turn off load switch)
 * 
 * Powers off the device connected to LDSW1
 * 给连接到LDSW1的设备断电
 * 
 * @return 0 on success, negative error code on failure
 * @return 成功返回0，失败返回负数错误码
 */
int mos_npm1300_ldsw1_disable(void);

/**
 * @brief Check if LDSW1 is enabled
 * 
 * @return true if LDSW1 is enabled, false otherwise
 * @return 如果LDSW1已使能返回true，否则返回false
 */
bool mos_npm1300_ldsw1_is_enabled(void);

#endif /* MOS_NPM1300_LDSW_H */
