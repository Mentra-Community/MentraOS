/***
 * @Author       : XK
 * @Date         : 2025-07-07 10:34:59
 * @LastEditTime : 2025-07-07 10:38:44
 * @FilePath     : bspal_icm42688p.h
 * @Description  :
 * @
 * @Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved.
 */

#ifndef __BSPAL_ICM42688P_H__
#define __BSPAL_ICM42688P_H__


typedef struct {
    float acc_g[3];    /* accel in g */
    float acc_ms2[3];  /* accel in m/s² */
    float gyr_dps[3];  /* gyro in deg/s */
}sensor_data;
extern sensor_data icm42688p_data;

void test_icm42688p(void);

void bspal_icm42688p_parameter_config(void);
#endif /* __BSPAL_ICM42688P_H__ */