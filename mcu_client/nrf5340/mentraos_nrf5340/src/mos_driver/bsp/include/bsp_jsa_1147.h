/***
 * @Author       : XK
 * @Date         : 2025-07-14 15:13:06
 * @LastEditTime : 2025-07-14 15:13:09
 * @FilePath     : bsp_jsa_1147.h
 * @Description  :
 * @
 * @Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved.
 */

#ifndef _BSP_JSA_1147_H_
#define _BSP_JSA_1147_H_

#include "bsp_log.h"

#define JSA_1147_I2C_ADDR   0x38
#define REG_PRODUCT_LSB_ID  0xBC    /* 产品 ID 寄存器 */
#define REG_PRODUCT_MSB_ID  0xBD
#define REG_SYSM_CTRL       0x00    // 系统控制寄存器
#define REG_INT_CTRL        0x01
#define REG_INT_FLAG        0x02
#define REG_SUB_GAIN        0x04    // 子系统增益寄存器
#define REG_INTE_TIME       0x05    // 积分时间寄存器
#define REG_ALS_CLR_GAIN    0x06    
#define REG_PERSISTENCE     0x07    // 持续时间/次数 寄存器
#define REG_ALS_LOW_TH_L    0x08     
#define REG_ALS_LOW_TH_H    0x09    // ALS中断下限阈值寄存器
#define REG_ALS_HIGH_TH_L   0x0A    
#define REG_ALS_HIGH_TH_H   0x0B    // ALS中断上限阈值寄存器
#define REG_ALS_COEF        0x13    // ALS系数寄存器
#define REG_ALS_WIN_LOSS    0x2D    // ALS窗口/损失寄存器
#define REG_ALS_DATA_L      0x20    // ALS数据寄存器
#define REG_ALS_DATA_M      0x21    // ALS数据寄存器
#define REG_ALS_DATA_H      0x22    // ALS数据寄存器

// ===== ALS增益设定（bit2~0），默认x1 =====
#define ALS_GAIN_X1     0x00
#define ALS_GAIN_X2     0x01
#define ALS_GAIN_X4     0x02
#define ALS_GAIN_X8     0x03
#define ALS_GAIN_X16    0x04

// ===== 结构K补偿，建议现场定标 =====
#define STRUCTURE_K 0.80f

extern struct gpio_dt_spec jsa_1147_int1;

int bsp_jsa_1147_init(void);

void jsa_1147_int1_isr_enable(void);

void jsa_1147_i2c_start(void);

void jsa_1147_i2c_stop(void);

int jsa_1147_write_byte(uint8_t b);

int jsa_1147_read_byte(uint8_t *p, bool ack);

int jsa_1147_i2c_write_reg(uint8_t reg, uint8_t val);

int jsa_1147_i2c_read_reg(uint8_t reg, uint8_t *pval);

#endif //_BSP_JSA_1147_H_