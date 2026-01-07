/*
 * @Author       : Cole
 * @Date         : 2025-12-30 17:55:46
 * @LastEditTime : 2026-01-05 13:57:19
 * @FilePath     : cvt213x.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2025
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "cvt213x.h"

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/i2c.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>


LOG_MODULE_REGISTER(CVT213X_DRIVER, LOG_LEVEL_INF);
// I2C1 device from device tree for CVT213X communication

#if DT_NODE_HAS_STATUS(DT_NODELABEL(i2c3), okay)
static const struct device* i2c3_dev = DEVICE_DT_GET(DT_NODELABEL(i2c3));
#else
static const struct device* i2c3_dev = NULL;
#endif

/* Only i2c3 is used for CVT213X in this build */

#define CVT213X_I2C_ADDR_1 0x28
#define CVT213X_I2C_ADDR_2 0x2C

/*
 * Verify CVT213X I2C communication by reading register 0x0014
 * The device is expected to return its i2c id (0x28 or 0x2C) in that register.
 * Try each possible 7-bit address and retry a few times.
 */
int cvt213x_i2c_verify(void)
{
    const uint16_t reg   = 0x0014;
    uint8_t        tx[2] = {(uint8_t)((reg >> 8) & 0xFF), (uint8_t)(reg & 0xFF)};
    uint8_t        rd    = 0;
    int            ret;

    /* Use i2c3 device directly */
    if (!i2c3_dev || !device_is_ready(i2c3_dev))
    {
        LOG_ERR("I2C3 device not ready or not present");
        return -ENODEV;
    }
    const uint8_t dev_addr = CVT213X_I2C_ADDR_1;

    for (int attempt = 0; attempt < 3; attempt++)
    {
        ret = i2c_write_read(i2c3_dev, dev_addr, tx, sizeof(tx), &rd, 1);
        if (ret == 0)
        {
            /* 验证读取到的寄存器值是否为预期的芯片 ID (0x28) */
            if (rd == CVT213X_I2C_ADDR_1)
            {
                LOG_INF("cvt213x i2c verify ok: device 0x%02x read reg 0x%04x = 0x%02x", dev_addr, reg, rd);
                return 0;
            }
            else
            {
                LOG_WRN("cvt213x i2c read returned unexpected value 0x%02x from device 0x%02x", rd, dev_addr);
                return -EIO;
            }
        }
        k_msleep(10);
    }

    LOG_ERR("cvt213x i2c verify failed after retries");
    return -EIO;
}

/* runtime bus switching removed — only i2c3 is used */
/* app_cvt213x_i2c_set_bus removed to keep implementation simple */

int cvt213x_i2c_init(void)
{
    if (!i2c3_dev || !device_is_ready(i2c3_dev))
    {
        LOG_ERR("I2C3 not available or not ready");
        return -ENODEV;
    }

    // Configure I2C for standard speed (100kHz) - suitable for CVT213X
    uint32_t i2c_cfg = I2C_SPEED_SET(I2C_SPEED_STANDARD) | I2C_MODE_CONTROLLER;
    int      ret     = i2c_configure((struct device*)i2c3_dev, i2c_cfg);
    if (ret != 0)
    {
        LOG_ERR("I2C configure failed: %d", ret);
        return ret;
    }
    LOG_INF("I2C initialized for CVT213X using i2c3");

    /* Run a non-fatal verify to give quick feedback */
    // int vret = app_cvt213x_i2c_verify();
    // if (vret == 0)
    // {
    //     LOG_INF("I2C verify ok!!!");
    // }
    // else
    // {
    //     LOG_WRN("I2C verify failed after init: %d", vret);
    // }

    return 0;
}
