/*** 
 * @Author       : XK
 * @Date         : 2025-07-05 17:56:52
 * @LastEditTime : 2025-07-07 10:47:05
 * @FilePath     : bsp_icm42688p.h
 * @Description  : 
 * @
 * @Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved. 
 */


#ifndef _BSP_ICM42688P_H
#define _BSP_ICM42688P_H

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/i2c.h>



#define ICM42688P_I2C_ADDR      0x68U   /* SA0 接地 */
#define REG_WHO_AM_I            0x75U
#define ICM42688P_WHO_AM_I_ID   0x47U
#define REG_PWR_MGMT0           0x4EU  /* 电源管理 */
#define REG_GYRO_CONFIG0        0x4FU  /* 陀螺仪配置 */
#define REG_ACCEL_CONFIG0       0x50U  /* 加速度计配置 */
#define REG_ACCEL_DATA_X1       0x1FU  /* 加速度 X MSB */
#define REG_GYRO_DATA_X1        0x25U  /* 陀螺仪 X MSB */


extern struct device *i2c_dev_icm42688p; // I2C device

int bsp_icm42688p_init(void);

int icm42688p_read_reg(uint8_t reg, uint8_t *val);

int icm42688p_write_reg(uint8_t reg, uint8_t val);
#endif /* _BSP_ICM42688P_H */