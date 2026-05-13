#include "mos_imu.h"

#include <errno.h>
#include <stddef.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "mos_icm45608.h"
#include "mos_ict1531x.h"

LOG_MODULE_REGISTER(mos_imu, LOG_LEVEL_INF);

K_MUTEX_DEFINE(mos_imu_lock);
static bool mos_imu_initialized;
static bool mos_imu_sleeping = true;

static void mos_imu_rollback_icm_to_sleep(const char *context)
{
    int sleep_ret = icm45608_sleep();

    if (sleep_ret != 0)
    {
        mos_imu_sleeping = false;
        LOG_ERR("ICM-45608 rollback to sleep failed after %s: %d", context, sleep_ret);
    }
    else
    {
        mos_imu_sleeping = true;
    }
}

int mos_imu_init(void)
{
    int ret;

    k_mutex_lock(&mos_imu_lock, K_FOREVER);

    ret = icm45608_init();
    if (ret != 0)
    {
        LOG_ERR("ICM-45608 init failed: %d", ret);
        k_mutex_unlock(&mos_imu_lock);
        return ret;
    }

    ret = ict1531x_init();
    if (ret != 0)
    {
        LOG_ERR("ICT1531x init failed: %d", ret);
        mos_imu_rollback_icm_to_sleep("ICT1531x init error");
        k_mutex_unlock(&mos_imu_lock);
        return ret;
    }

    mos_imu_initialized = true;
    mos_imu_sleeping = false;
    LOG_INF("IMU subsystem initialized");
    k_mutex_unlock(&mos_imu_lock);
    return 0;
}

bool mos_imu_is_ready(void)
{
    return mos_imu_initialized && !mos_imu_sleeping && icm45608_is_ready();
}

bool mos_imu_is_sleeping(void)
{
    return mos_imu_sleeping;
}

int mos_imu_sleep(void)
{
    int ret;
    int mag_ret;

    k_mutex_lock(&mos_imu_lock, K_FOREVER);

    if (mos_imu_sleeping)
    {
        k_mutex_unlock(&mos_imu_lock);
        return 0;
    }

    mag_ret = ict1531x_sleep();
    if (mag_ret != 0)
    {
        LOG_WRN("ICT1531x sleep failed, continue ICM-45608 sleep: %d", mag_ret);
    }

    ret = icm45608_sleep();
    if (ret == 0)
    {
        mos_imu_sleeping = true;
        LOG_INF("IMU subsystem entered sleep");
    }

    k_mutex_unlock(&mos_imu_lock);
    return ret;
}

int mos_imu_wake(void)
{
    int ret;

    k_mutex_lock(&mos_imu_lock, K_FOREVER);

    if (!mos_imu_sleeping)
    {
        k_mutex_unlock(&mos_imu_lock);
        return 0;
    }

    ret = icm45608_wake();
    if (ret != 0)
    {
        LOG_ERR("ICM-45608 wake failed: %d", ret);
        k_mutex_unlock(&mos_imu_lock);
        return ret;
    }

    ret = ict1531x_init();
    if (ret != 0)
    {
        LOG_ERR("ICT1531x wake init failed: %d", ret);
        mos_imu_rollback_icm_to_sleep("ICT1531x wake init error");
        k_mutex_unlock(&mos_imu_lock);
        return ret;
    }

    mos_imu_initialized = true;
    mos_imu_sleeping = false;
    LOG_INF("IMU subsystem woke up");

    k_mutex_unlock(&mos_imu_lock);
    return 0;
}

int mos_imu_read_sample(mos_imu_sample_t *sample)
{
    icm45608_sample_t driver_sample;
    int ret;

    if (sample == NULL)
    {
        return -EINVAL;
    }

    k_mutex_lock(&mos_imu_lock, K_FOREVER);

    if (mos_imu_sleeping)
    {
        k_mutex_unlock(&mos_imu_lock);
        return -EAGAIN;
    }

    ret = icm45608_read_sample(&driver_sample);
    if (ret != 0)
    {
        k_mutex_unlock(&mos_imu_lock);
        return ret;
    }

    for (size_t i = 0; i < 3; i++)
    {
        sample->accel_raw[i] = driver_sample.accel_raw[i];
        sample->gyro_raw[i] = driver_sample.gyro_raw[i];
        sample->accel_g[i] = driver_sample.accel_g[i];
        sample->gyro_dps[i] = driver_sample.gyro_dps[i];
    }
    sample->temp_raw = driver_sample.temp_raw;
    sample->temp_degc = driver_sample.temp_degc;

    k_mutex_unlock(&mos_imu_lock);
    return 0;
}

int mos_imu_read_accel_gyro(float *accel_x, float *accel_y, float *accel_z,
                            float *gyro_x, float *gyro_y, float *gyro_z)
{
    int ret;

    k_mutex_lock(&mos_imu_lock, K_FOREVER);

    if (mos_imu_sleeping)
    {
        k_mutex_unlock(&mos_imu_lock);
        return -EAGAIN;
    }

    ret = icm45608_read_all(accel_x, accel_y, accel_z, gyro_x, gyro_y, gyro_z);
    k_mutex_unlock(&mos_imu_lock);
    return ret;
}
