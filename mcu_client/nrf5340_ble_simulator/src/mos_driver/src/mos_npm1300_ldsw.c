/*
 * @Author       : Cole
 * @Date         : 2026-01-26
 * @LastEditTime : 2026-01-26
 * @FilePath     : mos_npm1300_ldsw.c
 * @Description  : nPM1300 LDSW1 (Load Switch) control driver
 * 
 *  Copyright (c) MentraOS Contributors 2026 
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "mos_npm1300_ldsw.h"

#include <zephyr/drivers/regulator.h>
#include <zephyr/devicetree.h>
#include <zephyr/logging/log.h>
#include <errno.h>

LOG_MODULE_REGISTER(mos_npm1300_ldsw, LOG_LEVEL_INF);

/* Get LDSW1 device from device tree | 从设备树获取LDSW1设备 */
#define LDSW1_NODE DT_NODELABEL(npm1300_ek_ldo1)
#if !DT_NODE_EXISTS(LDSW1_NODE)
#error "nPM1300 LDSW1 (LDO1) node not found in device tree. Check npm1300_config.overlay"
#endif

static const struct device *ldsw1_dev = DEVICE_DT_GET(LDSW1_NODE);
static bool ldsw1_initialized = false;

/**
 * @brief Initialize nPM1300 LDSW1 driver
 * 
 * @return 0 on success, negative error code on failure
 * @return 成功返回0，失败返回负数错误码
 */
int mos_npm1300_ldsw1_init(void)
{
    if (ldsw1_initialized)
    {
        LOG_WRN("LDSW1 driver already initialized");
        return 0;
    }

    if (!device_is_ready(ldsw1_dev))
    {
        LOG_ERR("LDSW1 device not ready");
        return -ENODEV;
    }

    ldsw1_initialized = true;
    LOG_INF("nPM1300 LDSW1 driver initialized");
    
    return 0;
}

/**
 * @brief Enable LDSW1 (turn on load switch)
 * 
 * Powers on the device connected to LDSW1
 * 给连接到LDSW1的设备上电
 * 
 * @return 0 on success, negative error code on failure
 * @return 成功返回0，失败返回负数错误码
 */
int mos_npm1300_ldsw1_enable(void)
{
    if (!ldsw1_initialized)
    {
        LOG_ERR("LDSW1 driver not initialized");
        return -ENODEV;
    }

    if (!device_is_ready(ldsw1_dev))
    {
        LOG_ERR("LDSW1 device not ready");
        return -ENODEV;
    }

    /* Check if already enabled | 检查是否已使能 */
    if (regulator_is_enabled(ldsw1_dev))
    {
        LOG_DBG("LDSW1 already enabled");
        return 0;
    }

    /* Enable LDSW1 | 使能LDSW1 */
    int ret = regulator_enable(ldsw1_dev);
    if (ret != 0)
    {
        LOG_ERR("Failed to enable LDSW1: %d", ret);
        return ret;
    }

    LOG_INF("LDSW1 enabled (load switch ON)");
    return 0;
}

/**
 * @brief Disable LDSW1 (turn off load switch)
 * 
 * Powers off the device connected to LDSW1
 * 给连接到LDSW1的设备断电
 * 
 * @return 0 on success, negative error code on failure
 * @return 成功返回0，失败返回负数错误码
 */
int mos_npm1300_ldsw1_disable(void)
{
    if (!ldsw1_initialized)
    {
        LOG_ERR("LDSW1 driver not initialized");
        return -ENODEV;
    }

    if (!device_is_ready(ldsw1_dev))
    {
        LOG_ERR("LDSW1 device not ready");
        return -ENODEV;
    }

    /* Check if already disabled | 检查是否已禁用 */
    if (!regulator_is_enabled(ldsw1_dev))
    {
        LOG_DBG("LDSW1 already disabled");
        return 0;
    }

    /* Disable LDSW1 | 禁用LDSW1 */
    int ret = regulator_disable(ldsw1_dev);
    if (ret != 0)
    {
        LOG_ERR("Failed to disable LDSW1: %d", ret);
        return ret;
    }

    LOG_INF("LDSW1 disabled (load switch OFF)");
    return 0;
}

/**
 * @brief Check if LDSW1 is enabled
 * 
 * @return true if LDSW1 is enabled, false otherwise
 * @return 如果LDSW1已使能返回true，否则返回false
 */
bool mos_npm1300_ldsw1_is_enabled(void)
{
    if (!ldsw1_initialized)
    {
        return false;
    }

    if (!device_is_ready(ldsw1_dev))
    {
        return false;
    }

    return regulator_is_enabled(ldsw1_dev);
}
