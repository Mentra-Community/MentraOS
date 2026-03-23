/*
 * @Author       : Cole
 * @Date         : 2025-07-31 10:40:40
 * @LastEditTime : 2025-08-20 09:29:59
 * @FilePath     : bsp_board_mcu.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2025
 *  SPDX-License-Identifier: Apache-2.0
 */
#include <zephyr/logging/log.h>

#include "bsp_icm42688p.h"
#include "bsp_littlefs.h"
#include "mos_fuel_gauge.h"
// #include "bsp_ict_15318.h"
#include "bsp_gx8002.h"
#include "bsp_jsa_1147.h"
#include "bsp_key.h"
#include "bspal_watchdog.h"

#define LOG_MODULE_NAME BSP_BOARD_MCU
LOG_MODULE_REGISTER(LOG_MODULE_NAME);

void my_assert_mcu(int err)
{
    if (err == 0)
    {
        LOG_INF("\t- OK");
    }
    else
    {
        LOG_ERR("\t- FAIL(%d)", err);
    }
    while (err);
}

void bsp_board_mcu_init(void)
{
    int err = 0;
    LOG_INF("-- MCU IO Initialize...");

    LOG_INF("+ bspal_watchdog_init...");
    err = bspal_watchdog_init();
    my_assert_mcu(err);

    LOG_INF("+ littlefs...");
    err = bsp_littlefs_init();
    my_assert_mcu(err);

    // LOG_INF("+ pm1300...");
    // err = pm1300_init();
    // my_assert_mcu(err);

    // LOG_INF("+ icm42688p...");
    // err = bsp_icm42688p_init();
    // my_assert_mcu(err);

    // LOG_INF("+ ict_15318...");
    // err = bsp_ict_15318_iic_init();
    // my_assert_mcu(err);

    // LOG_INF("+ GX8002...");
    // err = bsp_gx8002_init();
    // my_assert_mcu(err);

    // LOG_INF("+ jsa_1147...");
    // err = bsp_jsa_1147_init();
    // my_assert_mcu(err);

    LOG_INF("+ KEY...");
    err = bsp_key_init();
    my_assert_mcu(err);
}