/*
 * @Author       : XK
 * @Date         : 2025-07-07 10:34:44
 * @LastEditTime : 2025-07-07 14:26:40
 * @FilePath     : bspal_icm42688p.c
 * @Description  :
 *
 * Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved.
 */

#include "bsp_log.h"
#include "bal_os.h"
#include "bsp_icm42688p.h"
#include "bspal_icm42688p.h"

#define TAG "BSPAL_ICM42688P"
sensor_data icm42688p_data;
/* 一次性读取 12 字节：6 字节加速度 + 6 字节角速度 */
int icm_read_motion(int16_t *acc, int16_t *gyr)
{
    uint8_t buf[12];
    int ret = i2c_burst_read(i2c_dev_icm42688p,
                             ICM42688P_I2C_ADDR,
                             REG_ACCEL_DATA_X1,
                             buf, sizeof(buf));
    if (ret)
    {
        BSP_LOGE(TAG, "burst read failed: %d", ret);
        return ret;
    }
    for (int i = 0; i < 3; i++)
    {
        acc[i] = (int16_t)((buf[2 * i] << 8) | buf[2 * i + 1]);
        gyr[i] = (int16_t)((buf[2 * i + 6] << 8) | buf[2 * i + 7]);
    }
    return 0;
}
void bspal_icm42688p_parameter_config(void)
{
    int16_t acc_raw[3], gyr_raw[3];
    /* 唤醒并配置：GYRO_MODE = 11 (LN), ACCEL_MODE = 11 (LN) → 0b0000 1111 = 0x0F */
    icm42688p_write_reg(REG_PWR_MGMT0, 0x0F);
    xyzn_os_delay_ms(50); // 陀螺仪切换到 LN 模式需要 ≥45 ms 稳定 :contentReference[oaicite:4]{index=4}

    /* ACCEL_CONFIG0: ACCEL_UI_FS_SEL=000 (±16g), ACCEL_ODR=0110 (1 kHz) */
    icm42688p_write_reg(REG_ACCEL_CONFIG0, 0x06);
    /* GYRO_CONFIG0:  GYRO_UI_FS_SEL=000 (±2000°/s), GYRO_ODR=0110 (1 kHz) */
    icm42688p_write_reg(REG_GYRO_CONFIG0, 0x06);

    xyzn_os_delay_ms(10);
    icm_read_motion(acc_raw, gyr_raw);
}
void test_icm42688p(void)
{
    int16_t acc_raw[3], gyr_raw[3];
    // float acc_g[3], acc_ms2[3], gyr_dps[3];

    if (icm_read_motion(acc_raw, gyr_raw) == 0)
    {
        /* 1) 按 ±16g/±2000dps 换算到物理量 */
        for (int i = 0; i < 3; i++)
        {
            icm42688p_data.acc_g[i] = acc_raw[i] * (16.0f / 32768.0f);     // 单位：g
            icm42688p_data.acc_ms2[i] = icm42688p_data.acc_g[i] * 9.80665f;               // 单位：m/s²
            icm42688p_data.gyr_dps[i] = gyr_raw[i] * (2000.0f / 32768.0f); // 单位：deg/s
        }

        /* 2) 高精度打印：四位小数显示 g，三位小数显示 m/s²；四位小数显示 deg/s */
        BSP_LOGI(TAG,
                 "ACC: X=%.4f g(%.3f m/s²)  Y=%.4f g(%.3f m/s²)  Z=%.4f g(%.3f m/s²)",
                 icm42688p_data.acc_g[0], icm42688p_data.acc_ms2[0],
                 icm42688p_data.acc_g[1], icm42688p_data.acc_ms2[1],
                 icm42688p_data.acc_g[2], icm42688p_data.acc_ms2[2]);
        BSP_LOGI(TAG,
                 "GYR: X=%.4f dps  Y=%.4f dps  Z=%.4f dps",
                 icm42688p_data.gyr_dps[0],
                 icm42688p_data.gyr_dps[1],
                 icm42688p_data.gyr_dps[2]);
    }
}