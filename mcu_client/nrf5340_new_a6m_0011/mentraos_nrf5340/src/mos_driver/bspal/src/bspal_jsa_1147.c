/*
 * @Author       : Cole
 * @Date         : 2025-07-31 10:40:40
 * @LastEditTime : 2025-08-20 10:22:00
 * @FilePath     : bspal_jsa_1147.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2025
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "bspal_jsa_1147.h"

#include "bal_os.h"
#include "bsp_jsa_1147.h"
#include <zephyr/logging/log.h>
#define LOG_MODULE_NAME BSPAL_JSA_1147
LOG_MODULE_REGISTER(LOG_MODULE_NAME);


static int jsa_1147_read_als(uint32_t *pcount)
{
    uint8_t lo, mid, hi;
    if (jsa_1147_i2c_read_reg(REG_ALS_DATA_L, &lo) < 0)
    {
        LOG_ERR("read ALS low byte failed");
        return MOS_OS_ERROR;
    }
    if (jsa_1147_i2c_read_reg(REG_ALS_DATA_M, &mid) < 0)
    {
        LOG_ERR("read ALS mid byte failed");
        return MOS_OS_ERROR;
    }
    if (jsa_1147_i2c_read_reg(REG_ALS_DATA_H, &hi) < 0)
    {
        LOG_ERR("read ALS high byte failed");
        return MOS_OS_ERROR;
    }
    *pcount = ((uint32_t)hi << 16) | ((uint32_t)mid << 8) | lo;
    return 0;
}
int read_jsa_1147_int_flag(void)
{
    uint8_t flag;
    if (jsa_1147_i2c_read_reg(REG_INT_FLAG, &flag) < 0)
    {
        LOG_ERR("read INT_FLAG failed");
        return MOS_OS_ERROR;
    }
    return flag;
}
int write_jsa_1147_int_flag(uint8_t flag)
{
    if (jsa_1147_i2c_write_reg(REG_INT_FLAG, flag) < 0)
    {
        LOG_ERR("write INT_FLAG failed");
        return MOS_OS_ERROR;
    }
    return 0;
}

static float jsa_1147_count_to_lux(uint32_t als_raw, uint8_t als_gain_sel, float k_struct)
{
    const float gain_table[5] = {1, 2, 4, 8, 16};
    float       als_gain      = gain_table[als_gain_sel & 0x07];
    float       lux           = (float)als_raw / als_gain;
    return lux * k_struct;
}

int bspal_jsa_1147_init(void)
{
    // /* 配置adc 增益
    // config adc gain
    // 0x0: x1 (Default)
    // 0x1: x2
    // 0x2: x4
    // …
    // 0x7: x128*/
    // if (jsa_1147_i2c_write_reg(REG_SUB_GAIN, 1) < 0)
    // {
    //     LOG_ERR("JSA-1147 set gain failed");
    //     return MOS_OS_ERROR;
    // }

    uint8_t itime = 0x18;
    if (jsa_1147_i2c_write_reg(REG_INTE_TIME, itime) < 0)
    {
        LOG_ERR("JSA-1147 set integration time failed");
        return MOS_OS_ERROR;
    }
    uint8_t als_gain = ALS_GAIN_X16;
    if (jsa_1147_i2c_write_reg(REG_ALS_CLR_GAIN, als_gain & 0x07) < 0)
    {
        LOG_ERR("JSA-1147 set als gain failed");
        return MOS_OS_ERROR;
    }
    uint8_t als_coef = 0x80;
    if (jsa_1147_i2c_write_reg(REG_ALS_COEF, als_coef) < 0)
    {
        LOG_ERR("JSA-1147 set als gain failed");
        return MOS_OS_ERROR;
    }
    uint8_t win_loss = 0x40;
    if (jsa_1147_i2c_write_reg(REG_ALS_WIN_LOSS, win_loss) < 0)
    {
        LOG_ERR("JSA-1147 set als gain failed");
        return MOS_OS_ERROR;
    }

    uint8_t sysm_ctrl;
    if (jsa_1147_i2c_read_reg(REG_SYSM_CTRL, &sysm_ctrl) < 0)
    {
        LOG_ERR("read SYSM_CTRL failed ");
        return MOS_OS_ERROR;
    }
    sysm_ctrl |= 0x01;
    if (jsa_1147_i2c_write_reg(REG_SYSM_CTRL, sysm_ctrl) < 0)
    {
        LOG_ERR("JSA-1147 reset failed");
        return MOS_OS_ERROR;
    }
    mos_delay_ms(200);  // wait for reset stable
    LOG_INF("JSA-1147 init ok");
    return 0;
}

void jsa_1147_test(void)
{
    uint32_t als;
    float    lux;

    if (jsa_1147_read_als(&als) == 0)
    {
        lux = jsa_1147_count_to_lux(als, ALS_GAIN_X16, STRUCTURE_K);
        LOG_INF("ALS Raw = %u, Lux ≈ %.1f", als, lux);
    }
    else
    {
        LOG_INF("ERROR: read ALS err!!!");
    }
    // k_sleep(K_SECONDS(1));
}