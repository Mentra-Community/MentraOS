/*
 * @Author       : XK
 * @Date         : 2025-07-05 17:56:38
 * @LastEditTime : 2025-07-10 17:13:41
 * @FilePath     : bsp_icm42688p.c
 * @Description  :
 *
 * Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved.
 */
#include "bal_os.h"
#include "bsp_log.h"
#include "bsp_icm42688p.h"

#define TAG "ICM42688P"

struct device *i2c_dev_icm42688p; // I2C device

/* 向单个寄存器写入一个字节 */
int icm42688p_write_reg(uint8_t reg, uint8_t val)
{
    uint8_t buf[2] = {reg, val};
    int rc = i2c_write(i2c_dev_icm42688p, buf, sizeof(buf), ICM42688P_I2C_ADDR);
    if (rc)
    {
        BSP_LOGE(TAG, "I2C write reg 0x%02X failed: %d", reg, rc);
    }
    return rc;
}

/* 从单个寄存器读出一个字节 */
int icm42688p_read_reg(uint8_t reg, uint8_t *val)
{
    int rc = i2c_write_read(i2c_dev_icm42688p,
                            ICM42688P_I2C_ADDR,
                            &reg, 1,
                            val, 1);
    if (rc)
    {
        BSP_LOGE(TAG, "I2C read reg 0x%02X failed: %d", reg, rc);
    }
    return rc;
}

/* 读取 WHO_AM_I 寄存器示例 */
int bsp_icm42688p_check_id(void)
{
    uint8_t who = 0;
    int rc = icm42688p_read_reg(REG_WHO_AM_I, &who); /* WHO_AM_I 寄存器地址 */
    if (rc == 0)
    {
        BSP_LOGI(TAG, "ICM42688P WHO_AM_I = 0x%02X", who);
        if (who != ICM42688P_WHO_AM_I_ID)
        {
            /* 0x47 是 ICM-42688P 的默认 ID */
            BSP_LOGE(TAG, "Unexpected WHO_AM_I err");
            return XYZN_OS_ERROR;
        }
    }
    return rc;
}

int bsp_icm42688p_init(void)
{
    i2c_dev_icm42688p = device_get_binding(DT_NODE_FULL_NAME(DT_ALIAS(myimu6)));
    if (!i2c_dev_icm42688p)
    {
        BSP_LOGE(TAG, "I2C Device driver not found");
        return XYZN_OS_ERROR;
    }
    uint32_t i2c_cfg = I2C_SPEED_SET(I2C_SPEED_FAST) | I2C_MODE_CONTROLLER;
    if (i2c_configure(i2c_dev_icm42688p, i2c_cfg))
    {
        BSP_LOGE(TAG, "I2C config failed");
        return XYZN_OS_ERROR;
    }
    if (bsp_icm42688p_check_id())
    {
        BSP_LOGE(TAG, "ICM42688P check id failed");
        return XYZN_OS_ERROR;
    }
    return 0;
}
