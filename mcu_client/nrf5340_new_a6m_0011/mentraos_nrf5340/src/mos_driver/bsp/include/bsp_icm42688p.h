/*** 
 * @Author       : Cole
 * @Date         : 2025-08-18 19:27:06
 * @LastEditTime : 2025-08-19 13:48:25
 * @FilePath     : bsp_icm42688p.h
 * @Description  :/
 * @
 * @ Copyright (c) MentraOS Contributors 2025 
 * @ SPDX-License-Identifier: Apache-2.0
 */

#ifndef _BSP_ICM42688P_H_
#define _BSP_ICM42688P_H_

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/i2c.h>

#define ICM42688P_I2C_ADDR      0x68U   
#define REG_WHO_AM_I            0x75U
#define ICM42688P_WHO_AM_I_ID   0x47U
#define REG_PWR_MGMT0           0x4EU   
#define REG_GYRO_CONFIG0        0x4FU  
#define REG_ACCEL_CONFIG0       0x50U   
#define REG_ACCEL_DATA_X1       0x1FU   
#define REG_GYRO_DATA_X1        0x25U   

extern struct device *i2c_dev_icm42688p; // I2C device

int bsp_icm42688p_init(void);

int icm42688p_read_reg(uint8_t reg, uint8_t *val);

int icm42688p_write_reg(uint8_t reg, uint8_t val);
#endif /* _BSP_ICM42688P_H_ */