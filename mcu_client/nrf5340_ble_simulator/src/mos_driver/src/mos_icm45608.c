#include "mos_icm45608.h"

#include <errno.h>
#include <hal/nrf_gpio.h>
#include <string.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/i2c.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/pm/device.h>
#include <zephyr/sys/util.h>

LOG_MODULE_REGISTER(mos_icm45608, LOG_LEVEL_INF);

#define ICM45608_NODE DT_ALIAS(icm45608)
#define ICM45608_USER_NODE DT_PATH(zephyr_user)

#if DT_NODE_EXISTS(ICM45608_NODE)
#define ICM45608_DT_READY 1
#define ICM45608_BUS_NODE DT_BUS(ICM45608_NODE)
#else
#define ICM45608_DT_READY 0
#endif

#if DT_NODE_HAS_PROP(ICM45608_USER_NODE, imu_en_gpios)
#define ICM45608_EN_GPIO_AVAILABLE 1
static const struct gpio_dt_spec icm45608_en_gpio = GPIO_DT_SPEC_GET(ICM45608_USER_NODE, imu_en_gpios);
#else
#define ICM45608_EN_GPIO_AVAILABLE 0
#endif

static const struct device *icm45608_i2c_bus;
static uint16_t icm45608_i2c_addr =
#if ICM45608_DT_READY
    DT_REG_ADDR(ICM45608_NODE);
#else
    ICM45608_I2C_ADDR_0;
#endif
static bool icm45608_i2c_addr_valid;
static bool icm45608_initialized;
static bool icm45608_sensor_configured;
static bool icm45608_suspended;

static int icm45608_en_gpio_init(void)
{
    int ret;

    if (!ICM45608_EN_GPIO_AVAILABLE)
    {
        return 0;
    }

    if (!gpio_is_ready_dt(&icm45608_en_gpio))
    {
        LOG_WRN("ICM-45608 EN GPIO not ready during init");
        return 0;
    }

    ret = gpio_pin_configure_dt(&icm45608_en_gpio, GPIO_OUTPUT_INACTIVE);
    if (ret != 0)
    {
        LOG_ERR("ICM-45608 EN GPIO default-low config failed: %d", ret);
        return ret;
    }

    LOG_INF("ICM-45608 EN GPIO configured LOW by driver");
    return 0;
}

static int icm45608_configure_i2c(void)
{
#if ICM45608_DT_READY
    int ret;

    if (icm45608_i2c_bus == NULL)
    {
        icm45608_i2c_bus = DEVICE_DT_GET(ICM45608_BUS_NODE);
    }

    if (icm45608_i2c_bus == NULL || !device_is_ready(icm45608_i2c_bus))
    {
        LOG_ERR("ICM-45608 I2C2 bus not ready");
        return -ENODEV;
    }

    ret = i2c_configure(icm45608_i2c_bus, I2C_SPEED_SET(ICM45608_I2C_SPEED) | I2C_MODE_CONTROLLER);
    if (ret != 0)
    {
        LOG_ERR("ICM-45608 I2C configure failed: %d", ret);
        return ret;
    }

    return 0;
#else
    LOG_ERR("ICM-45608 node alias missing in device tree");
    return -ENODEV;
#endif
}

static int icm45608_set_power(bool enable)
{
    int ret;

    if (!ICM45608_EN_GPIO_AVAILABLE)
    {
        return 0;
    }

    if (!gpio_is_ready_dt(&icm45608_en_gpio))
    {
        LOG_WRN("ICM-45608 EN GPIO not ready");
        return -ENODEV;
    }

    ret = gpio_pin_configure_dt(&icm45608_en_gpio, enable ? GPIO_OUTPUT_ACTIVE : GPIO_OUTPUT_INACTIVE);
    if (ret != 0)
    {
        LOG_ERR("ICM-45608 EN GPIO configure failed: %d", ret);
        return ret;
    }

    LOG_INF("ICM-45608 EN %s", enable ? "HIGH" : "LOW");
    return 0;
}

static int icm45608_try_read_id_at(uint16_t addr, uint8_t *device_id)
{
    const uint8_t reg = ICM45608_REG_WHO_AM_I;

    return i2c_write_read(icm45608_i2c_bus, addr, &reg, sizeof(reg), device_id, sizeof(*device_id));
}

static int icm45608_direct_write_registers(uint8_t reg, const uint8_t *buf, size_t len)
{
    uint8_t tx[4];
    int ret;

    if (buf == NULL || len == 0U || len > (sizeof(tx) - 1U))
    {
        return -EINVAL;
    }

    ret = icm45608_configure_i2c();
    if (ret != 0)
    {
        return ret;
    }

    tx[0] = reg;
    memcpy(&tx[1], buf, len);
    return i2c_write(icm45608_i2c_bus, tx, len + 1U, icm45608_i2c_addr);
}

static int icm45608_direct_read_registers(uint8_t reg, uint8_t *buf, size_t len)
{
    int ret;

    if (buf == NULL || len == 0U)
    {
        return -EINVAL;
    }

    ret = icm45608_configure_i2c();
    if (ret != 0)
    {
        return ret;
    }

    return i2c_write_read(icm45608_i2c_bus, icm45608_i2c_addr, &reg, sizeof(reg), buf, len);
}

static int icm45608_write_mreg(uint16_t reg, const uint8_t *buf, size_t len)
{
    uint8_t addr_data[3];
    int ret;

    if (buf == NULL || len == 0U)
    {
        return -EINVAL;
    }

    addr_data[0] = (uint8_t)(reg >> 8);
    addr_data[1] = (uint8_t)reg;
    addr_data[2] = buf[0];

    k_busy_wait(ICM45608_MREG_IO_DELAY_US);
    ret = icm45608_direct_write_registers(ICM45608_REG_IREG_ADDR_15_8, addr_data, sizeof(addr_data));
    if (ret != 0)
    {
        return ret;
    }

    for (size_t i = 1; i < len; i++)
    {
        k_busy_wait(ICM45608_MREG_IO_DELAY_US);
        ret = icm45608_direct_write_registers(ICM45608_REG_IREG_DATA, &buf[i], 1);
        if (ret != 0)
        {
            return ret;
        }
    }

    return 0;
}

static int icm45608_read_mreg(uint16_t reg, uint8_t *buf, size_t len)
{
    uint8_t addr[2];
    int ret;

    if (buf == NULL || len == 0U)
    {
        return -EINVAL;
    }

    addr[0] = (uint8_t)(reg >> 8);
    addr[1] = (uint8_t)reg;

    k_busy_wait(ICM45608_MREG_IO_DELAY_US);
    ret = icm45608_direct_write_registers(ICM45608_REG_IREG_ADDR_15_8, addr, sizeof(addr));
    if (ret != 0)
    {
        return ret;
    }

    for (size_t i = 0; i < len; i++)
    {
        k_busy_wait(ICM45608_MREG_IO_DELAY_US);
        ret = icm45608_direct_read_registers(ICM45608_REG_IREG_DATA, &buf[i], 1);
        if (ret != 0)
        {
            return ret;
        }
    }

    return 0;
}

static int icm45608_init_i2cm_master(void)
{
    uint8_t aux_ovrd;
    int ret;

    ret = icm45608_read_register(ICM45608_REG_IOC_PAD_SCENARIO_AUX_OVRD, &aux_ovrd);
    if (ret != 0)
    {
        return ret;
    }

    aux_ovrd &= (uint8_t)~ICM45608_AUX1_MODE_OVRD_VAL_MASK;
    aux_ovrd |= ICM45608_AUX1_MODE_OVRD_VAL_I2CM | ICM45608_AUX1_MODE_OVRD_ENABLE;
    return icm45608_write_register(ICM45608_REG_IOC_PAD_SCENARIO_AUX_OVRD, aux_ovrd);
}

static int icm45608_i2cm_force_clock(bool enable, uint8_t *previous)
{
    uint8_t reg_misc1;
    int ret;

    ret = icm45608_read_register(ICM45608_REG_REG_MISC1, &reg_misc1);
    if (ret != 0)
    {
        return ret;
    }

    if (previous != NULL)
    {
        *previous = reg_misc1;
    }

    reg_misc1 &= (uint8_t)~ICM45608_REG_MISC1_OSC_ID_MASK;
    if (enable)
    {
        reg_misc1 |= ICM45608_REG_MISC1_OSC_ID_RCOSC;
    }

    return icm45608_write_register(ICM45608_REG_REG_MISC1, reg_misc1);
}

static int icm45608_start_i2cm_ops(void)
{
    uint8_t control;
    int ret;

    ret = icm45608_read_mreg(ICM45608_MREG_I2CM_CONTROL, &control, sizeof(control));
    if (ret != 0)
    {
        return ret;
    }

    control &= (uint8_t)~ICM45608_I2CM_CONTROL_SPEED_SLOW;
    control |= ICM45608_I2CM_CONTROL_GO;
    return icm45608_write_mreg(ICM45608_MREG_I2CM_CONTROL, &control, sizeof(control));
}

static int icm45608_wait_i2cm_done(void)
{
    uint8_t status = 0;
    int ret;

    for (int i = 0; i < ICM45608_I2CM_TIMEOUT_MS; i++)
    {
        ret = icm45608_read_mreg(ICM45608_MREG_I2CM_STATUS, &status, sizeof(status));
        if (ret != 0)
        {
            return ret;
        }

        if ((status & ICM45608_I2CM_STATUS_ERROR_MASK) != 0U)
        {
            LOG_ERR("ICM-45608 I2CM status error: 0x%02x", status);
            return -EIO;
        }

        if ((status & ICM45608_I2CM_STATUS_DONE) != 0U && (status & ICM45608_I2CM_STATUS_BUSY) == 0U)
        {
            return 0;
        }

        k_sleep(K_MSEC(1));
    }

    LOG_ERR("ICM-45608 I2CM timeout, last status=0x%02x", status);
    return -ETIMEDOUT;
}

static int icm45608_i2cm_read_external_register(uint8_t i2c_addr, uint8_t reg, uint8_t *buf, size_t len)
{
    uint8_t profile[2] = { reg, i2c_addr };
    uint8_t command;
    uint8_t status;
    int ret;

    if (buf == NULL || len == 0U || len > ICM45608_I2CM_MAX_READ_LEN)
    {
        return -EINVAL;
    }

    command = (uint8_t)(ICM45608_I2CM_COMMAND_END | ICM45608_I2CM_COMMAND_READ |
                        (len & ICM45608_I2CM_COMMAND_BURSTLEN_MASK));

    ret = icm45608_write_mreg(ICM45608_MREG_I2CM_DEV_PROFILE0, profile, sizeof(profile));
    if (ret == 0)
    {
        ret = icm45608_write_mreg(ICM45608_MREG_I2CM_COMMAND_0, &command, sizeof(command));
    }
    if (ret == 0)
    {
        ret = icm45608_read_mreg(ICM45608_MREG_I2CM_STATUS, &status, sizeof(status));
    }
    if (ret == 0)
    {
        ret = icm45608_start_i2cm_ops(); // start read
    }
    if (ret == 0)
    {
        ret = icm45608_wait_i2cm_done();
    }
    if (ret == 0)
    {
        ret = icm45608_read_mreg(ICM45608_MREG_I2CM_RD_DATA0, buf, len);
    }

    return ret;
}

static int icm45608_i2cm_write_external_register(uint8_t i2c_addr, uint8_t reg, const uint8_t *buf, size_t len)
{
    uint8_t write_data[ICM45608_I2CM_MAX_WRITE_LEN + 1U];
    uint8_t command;
    uint8_t status;
    int ret;

    if (buf == NULL || len == 0U || len > ICM45608_I2CM_MAX_WRITE_LEN)
    {
        return -EINVAL;
    }

    write_data[0] = reg;
    memcpy(&write_data[1], buf, len);
    command = (uint8_t)(ICM45608_I2CM_COMMAND_END |
                        ((len + 1U) & ICM45608_I2CM_COMMAND_BURSTLEN_MASK));

    ret = icm45608_write_mreg(ICM45608_MREG_I2CM_DEV_PROFILE1, &i2c_addr, sizeof(i2c_addr));
    if (ret == 0)
    {
        ret = icm45608_write_mreg(ICM45608_MREG_I2CM_WR_DATA0, write_data, len + 1U);
    }
    if (ret == 0)
    {
        ret = icm45608_write_mreg(ICM45608_MREG_I2CM_COMMAND_0, &command, sizeof(command));
    }
    if (ret == 0)
    {
        ret = icm45608_read_mreg(ICM45608_MREG_I2CM_STATUS, &status, sizeof(status));
    }
    if (ret == 0)
    {
        ret = icm45608_start_i2cm_ops();
    }
    if (ret == 0)
    {
        ret = icm45608_wait_i2cm_done();
    }

    return ret;
}

static int16_t icm45608_le16_to_s16(const uint8_t *buf)
{
    return (int16_t)(((uint16_t)buf[1] << 8) | buf[0]);
}

static bool icm45608_sample_has_invalid_raw(const icm45608_sample_t *sample)
{
    if (sample->temp_raw == ICM45608_INVALID_SENSOR_RAW)
    {
        return true;
    }

    for (size_t i = 0; i < ARRAY_SIZE(sample->accel_raw); i++)
    {
        if (sample->accel_raw[i] == ICM45608_INVALID_SENSOR_RAW ||
            sample->gyro_raw[i] == ICM45608_INVALID_SENSOR_RAW)
        {
            return true;
        }
    }

    return false;
}

static int icm45608_configure_sensor_data(void)
{
    int ret;

    ret = icm45608_write_register(ICM45608_REG_ACCEL_CONFIG0, ICM45608_ACCEL_CONFIG_50HZ_4G);
    if (ret != 0)
    {
        LOG_ERR("ICM-45608 accel config failed: %d", ret);
        return ret;
    }

    ret = icm45608_write_register(ICM45608_REG_GYRO_CONFIG0, ICM45608_GYRO_CONFIG_50HZ_2000DPS);
    if (ret != 0)
    {
        LOG_ERR("ICM-45608 gyro config failed: %d", ret);
        return ret;
    }

    ret = icm45608_write_register(ICM45608_REG_PWR_MGMT0, ICM45608_PWR_MGMT0_ACCEL_GYRO_LN);
    if (ret != 0)
    {
        LOG_ERR("ICM-45608 accel/gyro enable failed: %d", ret);
        return ret;
    }

    k_sleep(K_MSEC(ICM45608_SENSOR_STARTUP_DELAY_MS));
    icm45608_sensor_configured = true;
    LOG_INF("ICM-45608 accel/gyro configured: accel=50Hz/4g gyro=50Hz/2000dps");

    return 0;
}

static int icm45608_enter_sensor_sleep(void)
{
    uint8_t pwr_mgmt0;
    int ret;

    ret = icm45608_read_register(ICM45608_REG_PWR_MGMT0, &pwr_mgmt0);
    if (ret != 0)
    {
        LOG_WRN("ICM-45608 PWR_MGMT0 read before sleep failed: %d", ret);
        return ret;
    }

    pwr_mgmt0 &= (uint8_t)~ICM45608_PWR_MGMT0_ACCEL_GYRO_MODE_MASK;
    pwr_mgmt0 |= ICM45608_PWR_MGMT0_ACCEL_GYRO_OFF;

    ret = icm45608_write_register(ICM45608_REG_PWR_MGMT0, pwr_mgmt0);
    if (ret != 0)
    {
        LOG_WRN("ICM-45608 PWR_MGMT0 sleep write failed: %d", ret);
        return ret;
    }

    icm45608_sensor_configured = false;
    LOG_INF("ICM-45608 accel/gyro set OFF before sleep");
    return 0;
}

int icm45608_init(void)
{
    uint8_t device_id = 0;
    int ret;

    LOG_INF("ICM-45608 initialization start");

    ret = icm45608_en_gpio_init();
    if (ret != 0)
    {
        return ret;
    }

    ret = icm45608_set_power(true);
    if (ret != 0)
    {
        return ret;
    }
    k_sleep(K_MSEC(ICM45608_POWER_ON_DELAY_MS));

    ret = icm45608_configure_i2c();
    if (ret != 0)
    {
        return ret;
    }

    ret = icm45608_read_device_id(&device_id);
    if (ret != 0)
    {
        LOG_ERR("ICM-45608 WHO_AM_I read failed: %d", ret);
        return ret;
    }

    if (device_id == ICM45608_WHO_AM_I_VAL)
    {
        LOG_INF("ICM-45608 detected at 0x%02x, WHO_AM_I=0x%02x", icm45608_i2c_addr, device_id);
        ret = icm45608_configure_sensor_data();
        if (ret != 0)
        {
            return ret;
        }
    }
    else
    {
        LOG_WRN("ICM-45608 unexpected WHO_AM_I=0x%02x, expected 0x%02x", device_id, ICM45608_WHO_AM_I_VAL);
    }

    icm45608_initialized = true;
    icm45608_suspended = false;
    return 0;
}

bool icm45608_is_ready(void)
{
    return icm45608_initialized && icm45608_i2c_bus != NULL && device_is_ready(icm45608_i2c_bus);
}

int icm45608_read_device_id(uint8_t *device_id)
{
    const uint16_t addrs[] = {
        icm45608_i2c_addr,
        ICM45608_I2C_ADDR_0,
        ICM45608_I2C_ADDR_1,
    };
    int last_ret = -ENODEV;

    if (device_id == NULL)
    {
        return -EINVAL;
    }

    last_ret = icm45608_configure_i2c();
    if (last_ret != 0)
    {
        return last_ret;
    }

    for (size_t i = 0; i < ARRAY_SIZE(addrs); i++)
    {
        bool duplicate = false;

        for (size_t j = 0; j < i; j++)
        {
            if (addrs[j] == addrs[i])
            {
                duplicate = true;
                break;
            }
        }
        if (duplicate)
        {
            continue;
        }

        last_ret = icm45608_try_read_id_at(addrs[i], device_id);
        if (last_ret == 0)
        {
            icm45608_i2c_addr = addrs[i];
            icm45608_i2c_addr_valid = (*device_id == ICM45608_WHO_AM_I_VAL);
            LOG_INF("ICM-45608 WHO_AM_I read at 0x%02x: 0x%02x", icm45608_i2c_addr, *device_id);
            return 0;
        }

        LOG_DBG("ICM-45608 WHO_AM_I read failed at 0x%02x: %d", addrs[i], last_ret);
    }

    return last_ret;
}

int icm45608_i2cm_read_reg(uint8_t i2c_addr, uint8_t reg, uint8_t *buf, size_t len)
{
    uint8_t reg_misc1_prev = 0;
    int ret;
    int restore_ret;

    if (buf == NULL || len == 0U || len > ICM45608_I2CM_MAX_READ_LEN || i2c_addr > 0x7fU)
    {
        return -EINVAL;
    }

    if (icm45608_suspended)
    {
        return -EAGAIN;
    }

    if (!icm45608_i2c_addr_valid)
    {
        uint8_t imu_id = 0;

        ret = icm45608_read_device_id(&imu_id);
        if (ret != 0)
        {
            return ret;
        }
    }

    ret = icm45608_init_i2cm_master();
    if (ret != 0)
    {
        LOG_ERR("ICM-45608 I2CM init failed: %d", ret);
        return ret;
    }

    ret = icm45608_i2cm_force_clock(true, &reg_misc1_prev);
    if (ret != 0)
    {
        LOG_ERR("ICM-45608 I2CM clock force failed: %d", ret);
        return ret;
    }

    ret = icm45608_i2cm_read_external_register(i2c_addr, reg, buf, len);

    restore_ret = icm45608_write_register(ICM45608_REG_REG_MISC1, reg_misc1_prev);
    if (restore_ret != 0)
    {
        LOG_WRN("ICM-45608 REG_MISC1 restore failed: %d", restore_ret);
    }

    return ret;
}

int icm45608_i2cm_write_reg(uint8_t i2c_addr, uint8_t reg, const uint8_t *buf, size_t len)
{
    uint8_t reg_misc1_prev = 0;
    int ret;
    int restore_ret;

    if (buf == NULL || len == 0U || len > ICM45608_I2CM_MAX_WRITE_LEN || i2c_addr > 0x7fU)
    {
        return -EINVAL;
    }

    if (icm45608_suspended)
    {
        return -EAGAIN;
    }

    if (!icm45608_i2c_addr_valid)
    {
        uint8_t imu_id = 0;

        ret = icm45608_read_device_id(&imu_id);
        if (ret != 0)
        {
            return ret;
        }
    }

    ret = icm45608_init_i2cm_master();
    if (ret != 0)
    {
        LOG_ERR("ICM-45608 I2CM init failed: %d", ret);
        return ret;
    }

    ret = icm45608_i2cm_force_clock(true, &reg_misc1_prev);
    if (ret != 0)
    {
        LOG_ERR("ICM-45608 I2CM clock force failed: %d", ret);
        return ret;
    }

    ret = icm45608_i2cm_write_external_register(i2c_addr, reg, buf, len);

    restore_ret = icm45608_write_register(ICM45608_REG_REG_MISC1, reg_misc1_prev);
    if (restore_ret != 0)
    {
        LOG_WRN("ICM-45608 REG_MISC1 restore failed: %d", restore_ret);
    }

    return ret;
}

int icm45608_read_registers(uint8_t reg, uint8_t *buf, size_t len)
{
    int ret;

    if (buf == NULL || len == 0U)
    {
        return -EINVAL;
    }

    ret = icm45608_configure_i2c();
    if (ret != 0)
    {
        return ret;
    }

    if (!icm45608_i2c_addr_valid)
    {
        uint8_t device_id = 0;

        ret = icm45608_read_device_id(&device_id);
        if (ret != 0)
        {
            return ret;
        }
    }

    return i2c_write_read(icm45608_i2c_bus, icm45608_i2c_addr, &reg, sizeof(reg), buf, len);
}

int icm45608_read_register(uint8_t reg, uint8_t *value)
{
    return icm45608_read_registers(reg, value, sizeof(*value));
}

int icm45608_write_register(uint8_t reg, uint8_t value)
{
    uint8_t tx[] = {reg, value};
    int ret;

    ret = icm45608_configure_i2c();
    if (ret != 0)
    {
        return ret;
    }

    if (!icm45608_i2c_addr_valid)
    {
        uint8_t device_id = 0;

        ret = icm45608_read_device_id(&device_id);
        if (ret != 0)
        {
            return ret;
        }
    }

    return i2c_write(icm45608_i2c_bus, tx, sizeof(tx), icm45608_i2c_addr);
}

uint16_t icm45608_get_i2c_addr(void)
{
    return icm45608_i2c_addr;
}

int icm45608_sleep(void)
{
    int ret = 0;

    if (!icm45608_suspended)
    {
        ret = icm45608_enter_sensor_sleep();
        if (ret != 0)
        {
            LOG_WRN("ICM-45608 sensor sleep command failed, continue power off: %d", ret);
        }
    }

    if (icm45608_i2c_bus != NULL && device_is_ready(icm45608_i2c_bus))
    {
        ret = pm_device_action_run(icm45608_i2c_bus, PM_DEVICE_ACTION_SUSPEND);
        if (ret != 0 && ret != -EALREADY)
        {
            LOG_WRN("ICM-45608 I2C2 suspend failed: %d", ret);
        }
    }
    nrf_gpio_cfg_default(NRF_GPIO_PIN_MAP(0, ICM45608_SCL_PIN));
    nrf_gpio_cfg_default(NRF_GPIO_PIN_MAP(0, ICM45608_SDA_PIN));

    ret = icm45608_set_power(false);
    if (ret != 0)
    {
        return ret;
    }

    icm45608_sensor_configured = false;
    icm45608_suspended = true;
    LOG_INF("ICM-45608 sleep prepared: P0.30/P0.31 high-Z (external I2C pull-ups hold idle)");

    return 0;
}

int icm45608_wake(void)
{
    uint8_t device_id = 0;
    int ret;

    ret = icm45608_set_power(true);
    if (ret != 0)
    {
        return ret;
    }
    k_sleep(K_MSEC(ICM45608_POWER_ON_DELAY_MS));

    if (icm45608_i2c_bus != NULL && device_is_ready(icm45608_i2c_bus))
    {
        ret = pm_device_action_run(icm45608_i2c_bus, PM_DEVICE_ACTION_RESUME);
        if (ret != 0 && ret != -EALREADY)
        {
            LOG_WRN("ICM-45608 I2C2 resume failed: %d", ret);
            return ret;
        }
    }

    ret = icm45608_configure_i2c();
    if (ret != 0)
    {
        return ret;
    }

    ret = icm45608_read_device_id(&device_id);
    if (ret != 0)
    {
        LOG_ERR("ICM-45608 WHO_AM_I read after wake failed: %d", ret);
        return ret;
    }

    if (device_id != ICM45608_WHO_AM_I_VAL)
    {
        LOG_ERR("ICM-45608 unexpected WHO_AM_I after wake: 0x%02x, expected 0x%02x",
                device_id, ICM45608_WHO_AM_I_VAL);
        return -ENODEV;
    }

    icm45608_suspended = false;
    icm45608_initialized = true;

    ret = icm45608_configure_sensor_data();
    if (ret != 0)
    {
        LOG_ERR("ICM-45608 sensor reconfigure after wake failed: %d", ret);
        return ret;
    }

    return 0;
}

int icm45608_read_sample(icm45608_sample_t *sample)
{
    uint8_t data[ICM45608_ACCEL_GYRO_TEMP_LEN];
    int ret;

    if (sample == NULL)
    {
        return -EINVAL;
    }

    if (icm45608_suspended)
    {
        return -EAGAIN;
    }

    if (!icm45608_sensor_configured)
    {
        ret = icm45608_configure_sensor_data();
        if (ret != 0)
        {
            return ret;
        }
    }

    ret = icm45608_read_registers(ICM45608_REG_ACCEL_DATA_X1, data, sizeof(data));
    if (ret != 0)
    {
        return ret;
    }

    sample->accel_raw[0] = icm45608_le16_to_s16(&data[0]);
    sample->accel_raw[1] = icm45608_le16_to_s16(&data[2]);
    sample->accel_raw[2] = icm45608_le16_to_s16(&data[4]);
    sample->gyro_raw[0] = icm45608_le16_to_s16(&data[6]);
    sample->gyro_raw[1] = icm45608_le16_to_s16(&data[8]);
    sample->gyro_raw[2] = icm45608_le16_to_s16(&data[10]);
    sample->temp_raw = icm45608_le16_to_s16(&data[12]);

    if (icm45608_sample_has_invalid_raw(sample))
    {
        LOG_WRN("ICM-45608 invalid sample raw: acc=[%d %d %d] gyro=[%d %d %d] temp=%d",
                sample->accel_raw[0], sample->accel_raw[1], sample->accel_raw[2],
                sample->gyro_raw[0], sample->gyro_raw[1], sample->gyro_raw[2],
                sample->temp_raw);
        return -EAGAIN;
    }

    for (size_t i = 0; i < ARRAY_SIZE(sample->accel_raw); i++)
    {
        sample->accel_g[i] = ((float)sample->accel_raw[i] * ICM45608_ACCEL_FSR_G) / 32768.0f;
        sample->gyro_dps[i] = ((float)sample->gyro_raw[i] * ICM45608_GYRO_FSR_DPS) / 32768.0f;
    }
    sample->temp_degc = 25.0f + ((float)sample->temp_raw / 128.0f);

    return 0;
}

int icm45608_read_all(float *accel_x, float *accel_y, float *accel_z,
                      float *gyro_x, float *gyro_y, float *gyro_z)
{
    icm45608_sample_t sample;
    int ret;

    if (accel_x == NULL || accel_y == NULL || accel_z == NULL || gyro_x == NULL || gyro_y == NULL || gyro_z == NULL)
    {
        return -EINVAL;
    }

    if (icm45608_suspended)
    {
        return -EAGAIN;
    }

    ret = icm45608_read_sample(&sample);
    if (ret != 0)
    {
        return ret;
    }

    *accel_x = sample.accel_g[0] * ICM45608_STANDARD_GRAVITY;
    *accel_y = sample.accel_g[1] * ICM45608_STANDARD_GRAVITY;
    *accel_z = sample.accel_g[2] * ICM45608_STANDARD_GRAVITY;
    *gyro_x = sample.gyro_dps[0];
    *gyro_y = sample.gyro_dps[1];
    *gyro_z = sample.gyro_dps[2];

    return 0;
}
