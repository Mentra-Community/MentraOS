#ifndef MOS_IMU_H_
#define MOS_IMU_H_

#include <stdbool.h>
#include <stdint.h>

typedef struct
{
    int16_t accel_raw[3];
    int16_t gyro_raw[3];
    int16_t temp_raw;
    float accel_g[3];
    float gyro_dps[3];
    float temp_degc;
} mos_imu_sample_t;

int mos_imu_init(void);
bool mos_imu_is_ready(void);
bool mos_imu_is_sleeping(void);

int mos_imu_sleep(void);
int mos_imu_wake(void);

int mos_imu_read_sample(mos_imu_sample_t *sample);
int mos_imu_read_accel_gyro(float *accel_x, float *accel_y, float *accel_z,
                            float *gyro_x, float *gyro_y, float *gyro_z);

#endif /* MOS_IMU_H_ */
