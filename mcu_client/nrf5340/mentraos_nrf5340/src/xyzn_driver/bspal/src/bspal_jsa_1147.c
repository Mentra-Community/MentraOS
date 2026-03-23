/*
 * @Author       : XK
 * @Date         : 2025-07-14 16:15:34
 * @LastEditTime : 2025-07-14 19:58:24
 * @FilePath     : bspal_jsa_1147.c
 * @Description  :
 *
 * Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved.
 */
#include "bal_os.h"
#include "bspal_jsa_1147.h"
#include "bsp_jsa_1147.h"

#define TAG "BSPAL_JSA_1147"

/* 读取 24 bit ALS 数据 */
static int jsa_1147_read_als(uint32_t *pcount)
{
    uint8_t lo, mid, hi;
    if (jsa_1147_i2c_read_reg(REG_ALS_DATA_L, &lo) < 0)
    {
        BSP_LOGE(TAG, "read ALS low byte failed");
        return XYZN_OS_ERROR;
    }
    if (jsa_1147_i2c_read_reg(REG_ALS_DATA_M, &mid) < 0)
    {
        BSP_LOGE(TAG, "read ALS mid byte failed");
        return XYZN_OS_ERROR;
    }
    if (jsa_1147_i2c_read_reg(REG_ALS_DATA_H, &hi) < 0)
    {
        BSP_LOGE(TAG, "read ALS high byte failed");
        return XYZN_OS_ERROR;
    }
    *pcount = ((uint32_t)hi << 16) | ((uint32_t)mid << 8) | lo;
    return 0;
}
int read_jsa_1147_int_flag(void)
{
    uint8_t flag;
    if (jsa_1147_i2c_read_reg(REG_INT_FLAG, &flag) < 0)
    {
        BSP_LOGE(TAG, "read INT_FLAG failed");
        return XYZN_OS_ERROR;
    }
    return flag; // 返回中断标志位
}
int write_jsa_1147_int_flag(uint8_t flag)
{
    if (jsa_1147_i2c_write_reg(REG_INT_FLAG, flag) < 0)
    {
        BSP_LOGE(TAG, "write INT_FLAG failed");
        return XYZN_OS_ERROR;
    }
    return 0;
}

// ===== lux换算函数（结构K补偿）=====
static float jsa_1147_count_to_lux(uint32_t als_raw, uint8_t als_gain_sel, float k_struct)
{
    const float gain_table[5] = {1, 2, 4, 8, 16};
    float als_gain = gain_table[als_gain_sel & 0x07];
    float lux = (float)als_raw / als_gain;
    return lux * k_struct;
}

/* 初始化传感器：复位 + 设置增益 + 积分时间 + 启动连续测量 */
int bspal_jsa_1147_init(void)
{

    // /* 配置adc 增益
    // 0x0: x1 (Default)
    // 0x1: x2
    // 0x2: x4
    // …
    // 0x7: x128*/
    // if (jsa_1147_i2c_write_reg(REG_SUB_GAIN, 1) < 0)
    // {
    //     BSP_LOGE(TAG, "JSA-1147 set gain failed");
    //     return XYZN_OS_ERROR;
    // }

    uint8_t itime = 0x18;
    if (jsa_1147_i2c_write_reg(REG_INTE_TIME, itime) < 0) // 积分时间只影响灵敏度，不进换算
    {
        BSP_LOGE(TAG, "JSA-1147 set integration time failed");
        return XYZN_OS_ERROR;
    }
    uint8_t als_gain = ALS_GAIN_X16; // 只设ALS增益，CLEAR位全0
    if (jsa_1147_i2c_write_reg(REG_ALS_CLR_GAIN, als_gain & 0x07) < 0)
    {
        BSP_LOGE(TAG, "JSA-1147 set als gain failed");
        return XYZN_OS_ERROR;
    }
    uint8_t als_coef = 0x80; // 暗电流补偿
    if (jsa_1147_i2c_write_reg(REG_ALS_COEF, als_coef) < 0)
    {
        BSP_LOGE(TAG, "JSA-1147 set als gain failed");
        return XYZN_OS_ERROR;
    }
    uint8_t win_loss = 0x40; // 窗口损耗补偿
    if (jsa_1147_i2c_write_reg(REG_ALS_WIN_LOSS, win_loss) < 0)
    {
        BSP_LOGE(TAG, "JSA-1147 set als gain failed");
        return XYZN_OS_ERROR;
    }
    /* 启动连续 ALS 模式：写 0x01 ( ALS_CONT=1) */
    uint8_t sysm_ctrl;
    if (jsa_1147_i2c_read_reg(REG_SYSM_CTRL, &sysm_ctrl) < 0)
    {
        BSP_LOGE(TAG, "read SYSM_CTRL failed ");
        return XYZN_OS_ERROR;
    }
    sysm_ctrl |= 0x01;
    if (jsa_1147_i2c_write_reg(REG_SYSM_CTRL, sysm_ctrl) < 0)
    {
        BSP_LOGE(TAG, "JSA-1147 reset failed");
        return XYZN_OS_ERROR;
    }
    xyzn_os_delay_ms(200); /* 等待完成 */
#if 0
    uint32_t als; /* 读取 ALS 数据 */
    jsa_1147_read_als(&als);

    /* 设置阈值 */
    uint16_t low_th = (als > 50 ? als - 50 : 0);
    uint16_t high_th = als + 50;
    // uint16_t low_th = 10000;
    // uint16_t high_th = 65000;
    jsa_1147_i2c_write_reg(REG_ALS_LOW_TH_L, low_th & 0xFF);
    jsa_1147_i2c_write_reg(REG_ALS_LOW_TH_H, low_th >> 8);
    jsa_1147_i2c_write_reg(REG_ALS_HIGH_TH_L, high_th & 0xFF);
    jsa_1147_i2c_write_reg(REG_ALS_HIGH_TH_H, high_th >> 8);

    /* 中断持久化设置：连续两次超限才触发 */
    jsa_1147_i2c_write_reg(REG_PERSISTENCE, 1);

    /* 使能 ALS 阈值中断 */
    /* EN_AINT=1 (bit0), EN_CINT=0, 保持其它位 0 */
    jsa_1147_i2c_write_reg(REG_INT_CTRL, 0x01);

    //clenr interrupt flag
    uint8_t flag = read_jsa_1147_int_flag(); 
    write_jsa_1147_int_flag(flag);
#endif
    BSP_LOGI(TAG, "JSA-1147 init ok");
    return 0;
}

void jsa_1147_test(void)
{
    uint32_t als;
    float lux;

    if (jsa_1147_read_als(&als) == 0)
    {
        lux = jsa_1147_count_to_lux(als, ALS_GAIN_X16, STRUCTURE_K);
        BSP_LOGI(TAG, "ALS Raw = %u, Lux ≈ %.1f", als, lux);
    }
    else
    {
        BSP_LOGI(TAG, "ERROR: 读取 ALS 失败");
    }
    // k_sleep(K_SECONDS(1));
}