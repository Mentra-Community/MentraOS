/*
 * @Author       : Cole
 * @Date         : 2025-11-19 20:05:11
 * @LastEditTime : 2026-02-05 10:19:31
 * @FilePath     : mos_lsm6dsv16x.c
 * @Description  : LSM6DSV16X 6-axis IMU sensor driver wrapper
 *
 *  Copyright (c) MentraOS Contributors 2025
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "mos_lsm6dsv16x.h"

#include <hal/nrf_gpio.h>
#include <math.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/i2c.h>
#include <zephyr/drivers/sensor.h>
#include <zephyr/drivers/sensor_data_types.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/pm/device.h>
#include <zephyr/sys/util.h>

LOG_MODULE_REGISTER(mos_lsm6dsv16x, LOG_LEVEL_INF);

/* LSM6DSV16X INT1 pin: P1.15 | 中断引脚 INT1：P1.15 */
#define LSM6DSV16X_INT1_PIN 15

/* I2C2 pins for LSM6DSV16X | LSM6DSV16X 使用的 I2C2 引脚 */
#define I2C2_SCL_PIN 30  // P0.30
#define I2C2_SDA_PIN 31  // P0.31

// Device tree node (alias points to i2c2 bus) | 设备树节点（别名指向 i2c2 总线）
#define LSM6DSV16X_NODE DT_ALIAS(lsm6dsv16x)

// I2C address | I2C地址
#define LSM6DSV16X_I2C_ADDR_0 0x6a  // AD0 = GND
#define LSM6DSV16X_I2C_ADDR_1 0x6b  // AD0 = VDD

// WHO_AM_I register | WHO_AM_I寄存器
#define LSM6DSV16X_REG_WHO_AM_I 0x0F
#define LSM6DSV16X_WHO_AM_I_VAL 0x70  // Expected value for LSM6DSV16X

// Global sensor device pointer | 全局传感器设备指针
static const struct device* lsm6dsv16x_dev = NULL;
static const struct device* i2c_bus = NULL;
static bool lsm6dsv16x_suspended = false;

/* Shared user node for IMU GPIOs | IMU GPIO 统一使用的 user 节点 */
#define USER_NODE DT_PATH(zephyr_user)

/* IMU INT1 GPIO (interrupt input, e.g. P1.15) | IMU中断GPIO（如P1.15） */
static const struct gpio_dt_spec imu_int1_gpio = GPIO_DT_SPEC_GET(USER_NODE, imu_int1_gpios);
static bool imu_int1_gpio_initialized = false;

int lsm6dsv16x_init(void)
{
#if DT_NODE_EXISTS(LSM6DSV16X_NODE)
    int ret;
    uint8_t device_id = 0;

    LOG_INF("========================================");
    LOG_INF("🔍 LSM6DSV16X Sensor Initialization");
    LOG_INF("========================================");

    lsm6dsv16x_dev = DEVICE_DT_GET(LSM6DSV16X_NODE);
    if (lsm6dsv16x_dev == NULL || !device_is_ready(lsm6dsv16x_dev))
    {
        LOG_ERR("❌ LSM6DSV16X device not available or not ready");
        return -ENODEV;
    }
    ret = i2c_configure(lsm6dsv16x_dev, I2C_SPEED_SET(I2C_SPEED_FAST) | I2C_MODE_CONTROLLER);
    if (ret != 0)
    {
        LOG_ERR("❌ Failed to configure I2C bus: %d", ret);
        return ret;
    }

    /* Initialize INT1 GPIO | 初始化 INT1 中断引脚 */
    if (!imu_int1_gpio_initialized)
    {
        ret = gpio_pin_configure_dt(&imu_int1_gpio, GPIO_INPUT | GPIO_PULL_DOWN);
        if (ret != 0)
        {
            LOG_WRN("⚠️  Failed to configure IMU INT1 GPIO: %d", ret);
        }
        else
        {
            imu_int1_gpio_initialized = true;
            LOG_INF("✅ INT1 GPIO configured");
        }
    }

    ret = lsm6dsv16x_read_device_id(&device_id);
    if (ret != 0)
    {
        LOG_ERR("❌ Failed to read device ID: %d", ret);
        LOG_ERR("   This indicates a hardware connection problem.");
        return ret;
    }

    if (device_id == LSM6DSV16X_WHO_AM_I_VAL)
    {
        LOG_INF("✅ Device ID verified: 0x%02x (LSM6DSV16X)", device_id);
    }
    else
    {
        LOG_WRN("⚠️  Unexpected device ID: 0x%02x (expected 0x%02x)", device_id, LSM6DSV16X_WHO_AM_I_VAL);
    }
    LOG_INF("========================================");
    LOG_INF("✅ LSM6DSV16X initialization complete");
    LOG_INF("========================================");

    lsm6dsv16x_suspended = false;
    return 0;
#else
    LOG_ERR("❌ LSM6DSV16X device not found in device tree");
    LOG_ERR("   Please check device tree overlay configuration");
    return -ENODEV;
#endif
}

bool lsm6dsv16x_is_ready(void)
{
    if (lsm6dsv16x_dev == NULL)
    {
        return false;
    }
    return device_is_ready(lsm6dsv16x_dev);
}

/**
 * @brief Read accelerometer data | 读取加速度计数据
 */
int lsm6dsv16x_read_accel(float* accel_x, float* accel_y, float* accel_z)
{
    struct sensor_value accel[3];
    int ret;

    if (lsm6dsv16x_dev == NULL || !device_is_ready(lsm6dsv16x_dev))
    {
        LOG_ERR("LSM6DSV16X device not initialized");
        return -ENODEV;
    }

    if (lsm6dsv16x_suspended)
    {
        LOG_WRN("LSM6DSV16X is suspended, accel read skipped");
        return -EAGAIN;
    }

    if (accel_x == NULL || accel_y == NULL || accel_z == NULL)
    {
        return -EINVAL;
    }

    // Fetch sensor sample | 获取传感器采样
    ret = sensor_sample_fetch_chan(lsm6dsv16x_dev, SENSOR_CHAN_ACCEL_XYZ);
    if (ret != 0)
    {
        LOG_ERR("Failed to fetch accelerometer data: %d", ret);
        return ret;
    }

    // Read accelerometer channels | 读取加速度计通道
    ret = sensor_channel_get(lsm6dsv16x_dev, SENSOR_CHAN_ACCEL_X, &accel[0]);
    if (ret != 0)
    {
        LOG_ERR("Failed to read accel X: %d", ret);
        return ret;
    }

    ret = sensor_channel_get(lsm6dsv16x_dev, SENSOR_CHAN_ACCEL_Y, &accel[1]);
    if (ret != 0)
    {
        LOG_ERR("Failed to read accel Y: %d", ret);
        return ret;
    }

    ret = sensor_channel_get(lsm6dsv16x_dev, SENSOR_CHAN_ACCEL_Z, &accel[2]);
    if (ret != 0)
    {
        LOG_ERR("Failed to read accel Z: %d", ret);
        return ret;
    }

    // Convert to float (m/s²) | 转换为浮点数（m/s²）
    *accel_x = sensor_value_to_double(&accel[0]);
    *accel_y = sensor_value_to_double(&accel[1]);
    *accel_z = sensor_value_to_double(&accel[2]);

    LOG_DBG("Accel: X=%.2f, Y=%.2f, Z=%.2f m/s²", (double)*accel_x, (double)*accel_y, (double)*accel_z);

    return 0;
}

/**
 * @brief Read gyroscope data | 读取陀螺仪数据
 */
int lsm6dsv16x_read_gyro(float* gyro_x, float* gyro_y, float* gyro_z)
{
    struct sensor_value gyro[3];
    int ret;

    if (lsm6dsv16x_dev == NULL || !device_is_ready(lsm6dsv16x_dev))
    {
        LOG_ERR("LSM6DSV16X device not initialized");
        return -ENODEV;
    }

    if (lsm6dsv16x_suspended)
    {
        LOG_WRN("LSM6DSV16X is suspended, gyro read skipped");
        return -EAGAIN;
    }

    if (gyro_x == NULL || gyro_y == NULL || gyro_z == NULL)
    {
        return -EINVAL;
    }

    // Fetch sensor sample | 获取传感器采样
    ret = sensor_sample_fetch_chan(lsm6dsv16x_dev, SENSOR_CHAN_GYRO_XYZ);
    if (ret != 0)
    {
        LOG_ERR("Failed to fetch gyroscope data: %d", ret);
        return ret;
    }

    // Read gyroscope channels | 读取陀螺仪通道
    ret = sensor_channel_get(lsm6dsv16x_dev, SENSOR_CHAN_GYRO_X, &gyro[0]);
    if (ret != 0)
    {
        LOG_ERR("Failed to read gyro X: %d", ret);
        return ret;
    }

    ret = sensor_channel_get(lsm6dsv16x_dev, SENSOR_CHAN_GYRO_Y, &gyro[1]);
    if (ret != 0)
    {
        LOG_ERR("Failed to read gyro Y: %d", ret);
        return ret;
    }

    ret = sensor_channel_get(lsm6dsv16x_dev, SENSOR_CHAN_GYRO_Z, &gyro[2]);
    if (ret != 0)
    {
        LOG_ERR("Failed to read gyro Z: %d", ret);
        return ret;
    }

    // Convert to float (dps) | 转换为浮点数（度/秒）
    *gyro_x = sensor_value_to_double(&gyro[0]);
    *gyro_y = sensor_value_to_double(&gyro[1]);
    *gyro_z = sensor_value_to_double(&gyro[2]);

    LOG_DBG("Gyro: X=%.2f, Y=%.2f, Z=%.2f dps", (double)*gyro_x, (double)*gyro_y, (double)*gyro_z);

    return 0;
}

/**
 * @brief Read both accelerometer and gyroscope data | 同时读取加速度计和陀螺仪数据
 * @note This function fetches data once and reads both channels to avoid duplicate fetches
 * @note 此函数只获取一次数据并读取两个通道，避免重复获取
 */
int lsm6dsv16x_read_all(float* accel_x, float* accel_y, float* accel_z, float* gyro_x, float* gyro_y, float* gyro_z)
{
    struct sensor_value accel[3];
    struct sensor_value gyro[3];
    int                 ret;

    if (lsm6dsv16x_dev == NULL)
    {
        LOG_ERR("LSM6DSV16X device pointer is NULL");
        return -ENODEV;
    }

    if (lsm6dsv16x_suspended)
    {
        LOG_WRN("LSM6DSV16X is suspended, read_all skipped");
        return -EAGAIN;
    }

    if (!device_is_ready(lsm6dsv16x_dev))
    {
        LOG_ERR("LSM6DSV16X device not ready");
        return -ENODEV;
    }

    if (accel_x == NULL || accel_y == NULL || accel_z == NULL || gyro_x == NULL || gyro_y == NULL || gyro_z == NULL)
    {
        return -EINVAL;
    }

    // Fetch all sensor data at once | 一次性获取所有传感器数据
    ret = sensor_sample_fetch(lsm6dsv16x_dev);
    if (ret != 0)
    {
        LOG_ERR("Failed to fetch sensor data: %d", ret);
        return ret;
    }

    // Read accelerometer channels directly (without re-fetching) | 直接读取加速度计通道（不重新获取）
    ret = sensor_channel_get(lsm6dsv16x_dev, SENSOR_CHAN_ACCEL_X, &accel[0]);
    if (ret != 0)
    {
        LOG_ERR("Failed to read accel X: %d", ret);
        return ret;
    }

    ret = sensor_channel_get(lsm6dsv16x_dev, SENSOR_CHAN_ACCEL_Y, &accel[1]);
    if (ret != 0)
    {
        LOG_ERR("Failed to read accel Y: %d", ret);
        return ret;
    }

    ret = sensor_channel_get(lsm6dsv16x_dev, SENSOR_CHAN_ACCEL_Z, &accel[2]);
    if (ret != 0)
    {
        LOG_ERR("Failed to read accel Z: %d", ret);
        return ret;
    }

    // Read gyroscope channels directly (without re-fetching) | 直接读取陀螺仪通道（不重新获取）
    ret = sensor_channel_get(lsm6dsv16x_dev, SENSOR_CHAN_GYRO_X, &gyro[0]);
    if (ret != 0)
    {
        LOG_ERR("Failed to read gyro X: %d", ret);
        return ret;
    }

    ret = sensor_channel_get(lsm6dsv16x_dev, SENSOR_CHAN_GYRO_Y, &gyro[1]);
    if (ret != 0)
    {
        LOG_ERR("Failed to read gyro Y: %d", ret);
        return ret;
    }

    ret = sensor_channel_get(lsm6dsv16x_dev, SENSOR_CHAN_GYRO_Z, &gyro[2]);
    if (ret != 0)
    {
        LOG_ERR("Failed to read gyro Z: %d", ret);
        return ret;
    }

    // Convert to float | 转换为浮点数
    *accel_x = sensor_value_to_double(&accel[0]);
    *accel_y = sensor_value_to_double(&accel[1]);
    *accel_z = sensor_value_to_double(&accel[2]);

    *gyro_x = sensor_value_to_double(&gyro[0]);
    *gyro_y = sensor_value_to_double(&gyro[1]);
    *gyro_z = sensor_value_to_double(&gyro[2]);

    LOG_DBG("Accel: X=%.2f, Y=%.2f, Z=%.2f m/s² | Gyro: X=%.2f, Y=%.2f, Z=%.2f dps", (double)*accel_x, (double)*accel_y,
            (double)*accel_z, (double)*gyro_x, (double)*gyro_y, (double)*gyro_z);

    return 0;
}

/**
 * @brief Set accelerometer sampling frequency | 设置加速度计采样频率
 * @param freq_hz 采样频率（单位：赫兹） | Sampling frequency (in Hz)
 */
int lsm6dsv16x_set_accel_odr(uint16_t freq_hz)
{
    struct sensor_value odr;
    int                 ret;

    if (lsm6dsv16x_dev == NULL || !device_is_ready(lsm6dsv16x_dev))
    {
        LOG_ERR("LSM6DSV16X device not initialized");
        return -ENODEV;
    }

    odr.val1 = freq_hz;
    odr.val2 = 0;

    ret = sensor_attr_set(lsm6dsv16x_dev, SENSOR_CHAN_ACCEL_XYZ, SENSOR_ATTR_SAMPLING_FREQUENCY, &odr);
    if (ret != 0)
    {
        LOG_ERR("Failed to set accelerometer ODR: %d", ret);
        return ret;
    }

    LOG_INF("Accelerometer ODR set to %d Hz", freq_hz);
    return 0;
}

/**
 * @brief Set gyroscope sampling frequency | 设置陀螺仪采样频率
 */
int lsm6dsv16x_set_gyro_odr(uint16_t freq_hz)
{
    struct sensor_value odr;
    int                 ret;

    if (lsm6dsv16x_dev == NULL || !device_is_ready(lsm6dsv16x_dev))
    {
        LOG_ERR("LSM6DSV16X device not initialized");
        return -ENODEV;
    }

    odr.val1 = freq_hz;
    odr.val2 = 0;

    ret = sensor_attr_set(lsm6dsv16x_dev, SENSOR_CHAN_GYRO_XYZ, SENSOR_ATTR_SAMPLING_FREQUENCY, &odr);
    if (ret != 0)
    {
        LOG_ERR("Failed to set gyroscope ODR: %d", ret);
        return ret;
    }

    LOG_INF("Gyroscope ODR set to %d Hz", freq_hz);
    return 0;
}

/**
 * @brief Set accelerometer full scale range | 设置加速度计量程
 */
int lsm6dsv16x_set_accel_range(uint8_t range_g)
{
    struct sensor_value range;
    int                 ret;

    if (lsm6dsv16x_dev == NULL || !device_is_ready(lsm6dsv16x_dev))
    {
        LOG_ERR("LSM6DSV16X device not initialized");
        return -ENODEV;
    }

    // Convert g to m/s² | 将g转换为m/s²
    range.val1 = range_g * 9.80665f;
    range.val2 = 0;

    ret = sensor_attr_set(lsm6dsv16x_dev, SENSOR_CHAN_ACCEL_XYZ, SENSOR_ATTR_FULL_SCALE, &range);
    if (ret != 0)
    {
        LOG_ERR("Failed to set accelerometer range: %d", ret);
        return ret;
    }

    LOG_INF("Accelerometer range set to ±%d g", range_g);
    return 0;
}

/**
 * @brief Set gyroscope full scale range | 设置陀螺仪量程
 */
int lsm6dsv16x_set_gyro_range(uint16_t range_dps)
{
    struct sensor_value range;
    int                 ret;

    if (lsm6dsv16x_dev == NULL || !device_is_ready(lsm6dsv16x_dev))
    {
        LOG_ERR("LSM6DSV16X device not initialized");
        return -ENODEV;
    }

    range.val1 = range_dps;
    range.val2 = 0;

    ret = sensor_attr_set(lsm6dsv16x_dev, SENSOR_CHAN_GYRO_XYZ, SENSOR_ATTR_FULL_SCALE, &range);
    if (ret != 0)
    {
        LOG_ERR("Failed to set gyroscope range: %d", ret);
        return ret;
    }

    LOG_INF("Gyroscope range set to ±%d dps", range_dps);
    return 0;
}

/**
 * @brief Read device ID (WHO_AM_I register) | 读取器件ID（WHO_AM_I寄存器）
 */
int lsm6dsv16x_read_device_id(uint8_t* device_id)
{
    uint8_t reg = LSM6DSV16X_REG_WHO_AM_I;
    int     ret;

    LOG_INF("========================================");
    LOG_INF("🔍 lsm6dsv16x_read_device_id() called");
    LOG_INF("========================================");

    if (device_id == NULL)
    {
        LOG_ERR("device_id pointer is NULL");
        return -EINVAL;
    }

    LOG_INF("🔍 Attempting to read LSM6DSV16X device ID...");

    if (i2c_bus == NULL)
    {
        LOG_INF("Getting I2C bus device from device tree...");
        if (lsm6dsv16x_dev != NULL)
        {
            i2c_bus = lsm6dsv16x_dev;
        }
        else
        {
            i2c_bus = DEVICE_DT_GET(LSM6DSV16X_NODE);
        }
        if (i2c_bus == NULL)
        {
            LOG_ERR("❌ Failed to get I2C bus device from device tree");
            LOG_ERR("   Check device tree configuration for LSM6DSV16X alias");
            return -ENODEV;
        }
        LOG_INF("I2C bus device obtained: %s", i2c_bus->name);
    }
    else
    {
        LOG_INF("Using existing I2C bus device: %s", i2c_bus->name);
    }

    if (!device_is_ready(i2c_bus))
    {
        LOG_ERR("❌ I2C bus device not ready: %s", i2c_bus->name);
        LOG_ERR("   I2C bus may not be initialized yet");
        return -ENODEV;
    }

    LOG_INF("✅ I2C bus ready: %s", i2c_bus->name);

    // Try first I2C address | 尝试第一个I2C地址
    LOG_INF("Trying I2C address 0x%02x...", LSM6DSV16X_I2C_ADDR_0);
    ret = i2c_write_read(i2c_bus, LSM6DSV16X_I2C_ADDR_0, &reg, 1, device_id, 1);
    if (ret == 0)
    {
        LOG_INF("✅ Device ID read from 0x%02x: 0x%02x (expected: 0x%02x)", LSM6DSV16X_I2C_ADDR_0, *device_id,
                LSM6DSV16X_WHO_AM_I_VAL);
        if (*device_id == LSM6DSV16X_WHO_AM_I_VAL)
        {
            LOG_INF("✅ LSM6DSV16X detected at I2C address 0x%02x", LSM6DSV16X_I2C_ADDR_0);
            return 0;
        }
        else
        {
            LOG_WRN("⚠️  Unexpected device ID: 0x%02x (expected 0x%02x)", *device_id, LSM6DSV16X_WHO_AM_I_VAL);
        }
    }
    else
    {
        LOG_DBG("I2C read failed at 0x%02x: %d", LSM6DSV16X_I2C_ADDR_0, ret);
    }

    // Try second I2C address only if first failed | 仅在第一个失败时尝试第二个地址
    LOG_INF("Trying I2C address 0x%02x...", LSM6DSV16X_I2C_ADDR_1);
    ret = i2c_write_read(i2c_bus, LSM6DSV16X_I2C_ADDR_1, &reg, 1, device_id, 1);
    if (ret == 0)
    {
        LOG_INF("✅ Device ID read from 0x%02x: 0x%02x (expected: 0x%02x)", LSM6DSV16X_I2C_ADDR_1, *device_id,
                LSM6DSV16X_WHO_AM_I_VAL);
        if (*device_id == LSM6DSV16X_WHO_AM_I_VAL)
        {
            LOG_INF("✅ LSM6DSV16X detected at I2C address 0x%02x", LSM6DSV16X_I2C_ADDR_1);
            return 0;  // Success | 成功
        }
        else
        {
            LOG_WRN("⚠️  Unexpected device ID: 0x%02x (expected 0x%02x)", *device_id, LSM6DSV16X_WHO_AM_I_VAL);
        }
    }
    else
    {
        LOG_DBG("I2C read failed at 0x%02x: %d", LSM6DSV16X_I2C_ADDR_1, ret);
    }

    return ret;
}

/**
 * @brief Get sensor device pointer | 获取传感器设备指针
 */
const struct device* lsm6dsv16x_get_device(void)
{
    return lsm6dsv16x_dev;
}

/**
 * @brief Suspend IMU for low power | 休眠以降低功耗
 */
int lsm6dsv16x_sleep(void)
{
    int ret;

    if (lsm6dsv16x_dev == NULL || !device_is_ready(lsm6dsv16x_dev))
    {
        LOG_ERR("LSM6DSV16X device not initialized");
        return -ENODEV;
    }

    if (lsm6dsv16x_suspended)
    {
        return 0;
    }

    if (!IS_ENABLED(CONFIG_PM_DEVICE))
    {
        LOG_WRN("CONFIG_PM_DEVICE is disabled, skip IMU suspend");
        return 0;
    }

    ret = pm_device_action_run(lsm6dsv16x_dev, PM_DEVICE_ACTION_SUSPEND);
    if (ret != 0)
    {
        LOG_ERR("Failed to suspend LSM6DSV16X: %d", ret);
        return ret;
    }

    ret = gpio_pin_configure_dt(&imu_int1_gpio, GPIO_INPUT | GPIO_PULL_DOWN);
    if (ret != 0)
    {
        LOG_WRN("Failed to pull down IMU INT1 during sleep: %d", ret);
    }

    nrf_gpio_cfg_input(I2C2_SCL_PIN, NRF_GPIO_PIN_PULLDOWN);
    nrf_gpio_cfg_input(I2C2_SDA_PIN, NRF_GPIO_PIN_PULLDOWN);

    lsm6dsv16x_suspended = true;
    LOG_INF("LSM6DSV16X suspended, INT1 and I2C2 pins pulled down");
    return 0;
}

/**
 * @brief Resume IMU from low power | 从休眠恢复
 */
int lsm6dsv16x_wake(void)
{
    int ret;

    if (lsm6dsv16x_dev == NULL || !device_is_ready(lsm6dsv16x_dev))
    {
        LOG_ERR("LSM6DSV16X device not initialized");
        return -ENODEV;
    }

    if (!lsm6dsv16x_suspended)
    {
        return 0;
    }

    if (!IS_ENABLED(CONFIG_PM_DEVICE))
    {
        LOG_WRN("CONFIG_PM_DEVICE is disabled, skip IMU resume");
        return 0;
    }

    ret = pm_device_action_run(lsm6dsv16x_dev, PM_DEVICE_ACTION_RESUME);
    if (ret != 0)
    {
        LOG_ERR("Failed to resume LSM6DSV16X: %d", ret);
        return ret;
    }

    ret = gpio_pin_configure_dt(&imu_int1_gpio, GPIO_INPUT | GPIO_PULL_DOWN);
    if (ret != 0)
    {
        LOG_WRN("Failed to restore IMU INT1 pull-down: %d", ret);
    }
    ret = i2c_configure(i2c_bus, I2C_SPEED_SET(I2C_SPEED_FAST) | I2C_MODE_CONTROLLER);
    if (ret != 0)
    {
        LOG_WRN("Failed to restore I2C2 configuration: %d", ret);
    }

    lsm6dsv16x_suspended = false;
    LOG_INF("LSM6DSV16X resumed, INT1 and I2C2 pins restored");
    return 0;
}
