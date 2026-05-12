#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/shell/shell.h>

#include "mos_icm45608.h"
#include "mos_ict1531x.h"
#include "mos_imu.h"

LOG_MODULE_REGISTER(shell_imu, LOG_LEVEL_INF);

static bool continuous_read_active;
static uint32_t continuous_read_interval_ms = 1000;
static uint32_t continuous_read_count;
static struct k_work_delayable continuous_read_work;

static int parse_u8(const char *text, uint8_t *value)
{
    char *end = NULL;
    unsigned long parsed;

    if (text == NULL || value == NULL)
    {
        return -EINVAL;
    }

    errno = 0;
    parsed = strtoul(text, &end, 0);
    if (errno != 0 || end == text || *end != '\0' || parsed > 0xffUL)
    {
        return -EINVAL;
    }

    *value = (uint8_t)parsed;
    return 0;
}

static int parse_u32(const char *text, uint32_t *value)
{
    char *end = NULL;
    unsigned long parsed;

    if (text == NULL || value == NULL)
    {
        return -EINVAL;
    }

    errno = 0;
    parsed = strtoul(text, &end, 0);
    if (errno != 0 || end == text || *end != '\0' || parsed > UINT32_MAX)
    {
        return -EINVAL;
    }

    *value = (uint32_t)parsed;
    return 0;
}

static void print_sample(const struct shell *shell, const mos_imu_sample_t *sample)
{
    shell_print(shell, "Accel: X=% .3f Y=% .3f Z=% .3f g | Gyro: X=% .2f Y=% .2f Z=% .2f dps | Temp=% .2f degC",
                (double)sample->accel_g[0], (double)sample->accel_g[1], (double)sample->accel_g[2],
                (double)sample->gyro_dps[0], (double)sample->gyro_dps[1], (double)sample->gyro_dps[2],
                (double)sample->temp_degc);
    shell_print(shell, "Raw:   acc=[%d %d %d] gyro=[%d %d %d] temp=%d",
                sample->accel_raw[0], sample->accel_raw[1], sample->accel_raw[2],
                sample->gyro_raw[0], sample->gyro_raw[1], sample->gyro_raw[2],
                sample->temp_raw);
}

static void continuous_read_work_handler(struct k_work *work)
{
    mos_imu_sample_t sample;
    int ret;

    ARG_UNUSED(work);

    if (!continuous_read_active)
    {
        return;
    }

    ret = mos_imu_read_sample(&sample);
    continuous_read_count++;
    if (ret == 0)
    {
        LOG_INF("ICM-45608 [%u] Accel(g): X=% .3f Y=% .3f Z=% .3f | "
            "Gyro(dps): X=% .2f Y=% .2f Z=% .2f | Temp=% .2f degC",
            continuous_read_count,
            (double)sample.accel_g[0], (double)sample.accel_g[1], (double)sample.accel_g[2],
            (double)sample.gyro_dps[0], (double)sample.gyro_dps[1], (double)sample.gyro_dps[2],
            (double)sample.temp_degc);
    }
    else
    {
        LOG_ERR("ICM-45608 sample read failed [%u]: %d", continuous_read_count, ret);
    }

    if (continuous_read_active)
    {
        k_work_schedule(&continuous_read_work, K_MSEC(continuous_read_interval_ms));
    }
}

static int cmd_imu_help(const struct shell *shell, size_t argc, char **argv)
{
    ARG_UNUSED(argc);
    ARG_UNUSED(argv);

    shell_print(shell, "");
    shell_print(shell, "IMU commands:");
    shell_print(shell, "  imu help");
    shell_print(shell, "  imu status");
    shell_print(shell, "  imu read");
    shell_print(shell, "  imu start [interval_ms]");
    shell_print(shell, "  imu stop");
    shell_print(shell, "  imu sleep");
    shell_print(shell, "  imu wake");
    shell_print(shell, "  imu read_id");
    shell_print(shell, "  imu mag_id");
    shell_print(shell, "  imu mag_reg <addr>");
    shell_print(shell, "  imu read_reg <addr>");
    shell_print(shell, "  imu write_reg <addr> <value>");
    shell_print(shell, "");
    shell_print(shell, "Examples:");
    shell_print(shell, "  imu read");
    shell_print(shell, "  imu start");
    shell_print(shell, "  imu start 1000");
    shell_print(shell, "  imu stop");
    shell_print(shell, "  imu sleep");
    shell_print(shell, "  imu wake");
    shell_print(shell, "  imu read_id");
    shell_print(shell, "  imu mag_id");
    shell_print(shell, "  imu mag_reg 0x01");
    shell_print(shell, "  imu read_reg 0x72");
    shell_print(shell, "");

    return 0;
}

static int cmd_imu_status(const struct shell *shell, size_t argc, char **argv)
{
    uint8_t device_id = 0;
    int ret;

    ARG_UNUSED(argc);
    ARG_UNUSED(argv);

    shell_print(shell, "");
    shell_print(shell, "ICM-45608 IMU status");
    shell_print(shell, "====================");
    shell_print(shell, "Sensor:      ICM-45608");
    shell_print(shell, "I2C pins:    SCL=P0.30 SDA=P0.31");
    shell_print(shell, "Enable pin:  P0.19");
    shell_print(shell, "I2C addr:    0x%02x", icm45608_get_i2c_addr());
    shell_print(shell, "Ready:       %s", mos_imu_is_ready() ? "yes" : "no");
    shell_print(shell, "Power:       %s", mos_imu_is_sleeping() ? "sleep" : "awake");
    shell_print(shell, "Streaming:   %s", continuous_read_active ? "yes" : "no");
    if (continuous_read_active)
    {
        shell_print(shell, "Interval:    %u ms", continuous_read_interval_ms);
        shell_print(shell, "Count:       %u", continuous_read_count);
    }

    if (mos_imu_is_sleeping())
    {
        shell_print(shell, "WHO_AM_I:    skipped while sleeping");
        ret = 0;
    }
    else
    {
        ret = icm45608_read_device_id(&device_id);
        if (ret == 0)
        {
            shell_print(shell, "WHO_AM_I:    0x%02x %s", device_id,
                        device_id == ICM45608_WHO_AM_I_VAL ? "(OK)" : "(unexpected)");
        }
        else
        {
            shell_print(shell, "WHO_AM_I:    read failed (%d)", ret);
        }
    }

    shell_print(shell, "====================");
    shell_print(shell, "");
    return ret;
}

static int cmd_imu_read(const struct shell *shell, size_t argc, char **argv)
{
    mos_imu_sample_t sample;
    int ret;

    ARG_UNUSED(argc);
    ARG_UNUSED(argv);

    if (mos_imu_is_sleeping())
    {
        shell_error(shell, "IMU is sleeping, use 'imu wake' first");
        return -EAGAIN;
    }

    ret = mos_imu_read_sample(&sample);
    if (ret != 0)
    {
        shell_error(shell, "ICM-45608 sample read failed: %d", ret);
        return ret;
    }

    print_sample(shell, &sample);
    return 0;
}

static int cmd_imu_start(const struct shell *shell, size_t argc, char **argv)
{
    uint32_t interval_ms = 1000;
    int ret;

    if (continuous_read_active)
    {
        shell_warn(shell, "ICM-45608 periodic reading already active");
        shell_print(shell, "Use 'imu stop' first");
        return 0;
    }

    if (mos_imu_is_sleeping())
    {
        shell_error(shell, "IMU is sleeping, use 'imu wake' first");
        return -EAGAIN;
    }

    if (argc > 1)
    {
        ret = parse_u32(argv[1], &interval_ms);
        if (ret != 0 || interval_ms == 0U || interval_ms > 60000U)
        {
            shell_error(shell, "Invalid interval: %s (valid: 1-60000 ms)", argv[1]);
            return -EINVAL;
        }
    }

    k_work_init_delayable(&continuous_read_work, continuous_read_work_handler);
    continuous_read_interval_ms = interval_ms;
    continuous_read_count = 0;
    continuous_read_active = true;
    k_work_schedule(&continuous_read_work, K_NO_WAIT);

    shell_print(shell, "ICM-45608 periodic reading started, interval=%u ms", continuous_read_interval_ms);
    shell_print(shell, "Use 'imu stop' to stop");
    return 0;
}

static int cmd_imu_stop(const struct shell *shell, size_t argc, char **argv)
{
    ARG_UNUSED(argc);
    ARG_UNUSED(argv);

    if (!continuous_read_active)
    {
        shell_warn(shell, "ICM-45608 periodic reading is not active");
        return 0;
    }

    continuous_read_active = false;
    (void)k_work_cancel_delayable(&continuous_read_work);
    shell_print(shell, "ICM-45608 periodic reading stopped, total=%u", continuous_read_count);
    return 0;
}

static int cmd_imu_sleep(const struct shell *shell, size_t argc, char **argv)
{
    int ret;

    ARG_UNUSED(argc);
    ARG_UNUSED(argv);

    if (continuous_read_active)
    {
        continuous_read_active = false;
        (void)k_work_cancel_delayable(&continuous_read_work);
    }

    ret = mos_imu_sleep();
    if (ret != 0)
    {
        shell_error(shell, "IMU sleep failed: %d", ret);
        return ret;
    }

    shell_print(shell, "IMU entered sleep");
    return 0;
}

static int cmd_imu_wake(const struct shell *shell, size_t argc, char **argv)
{
    int ret;

    ARG_UNUSED(argc);
    ARG_UNUSED(argv);

    ret = mos_imu_wake();
    if (ret != 0)
    {
        shell_error(shell, "IMU wake failed: %d", ret);
        return ret;
    }

    shell_print(shell, "IMU woke up");
    return 0;
}

static int cmd_imu_read_id(const struct shell *shell, size_t argc, char **argv)
{
    uint8_t device_id = 0;
    int ret;

    ARG_UNUSED(argc);
    ARG_UNUSED(argv);

    if (mos_imu_is_sleeping())
    {
        shell_error(shell, "IMU is sleeping, use 'imu wake' first");
        return -EAGAIN;
    }

    ret = icm45608_read_device_id(&device_id);
    if (ret != 0)
    {
        shell_error(shell, "ICM-45608 WHO_AM_I read failed: %d", ret);
        return ret;
    }

    shell_print(shell, "ICM-45608 WHO_AM_I=0x%02x expected=0x%02x addr=0x%02x",
                device_id, ICM45608_WHO_AM_I_VAL, icm45608_get_i2c_addr());
    return 0;
}

static int cmd_imu_mag_id(const struct shell *shell, size_t argc, char **argv)
{
    uint8_t manuf_id = 0;
    uint8_t device_id = 0;
    int ret;

    ARG_UNUSED(argc);
    ARG_UNUSED(argv);

    if (mos_imu_is_sleeping())
    {
        shell_error(shell, "IMU is sleeping, use 'imu wake' first");
        return -EAGAIN;
    }

    ret = ict1531x_read_manuf_id(&manuf_id);
    if (ret != 0)
    {
        shell_error(shell, "ICT1531x MANUF_ID read through ICM-45608 I2CM failed: %d", ret);
        return ret;
    }

    ret = ict1531x_read_device_id(&device_id);
    if (ret != 0)
    {
        shell_error(shell, "ICT1531x CHIP_ID read through ICM-45608 I2CM failed: %d", ret);
        return ret;
    }

    shell_print(shell, "ICT1531x MANUF_ID=0x%02x expected=0x%02x addr=0x%02x %s",
                manuf_id, ICT1531X_MANUF_ID_VAL, ICT1531X_I2C_ADDR,
                manuf_id == ICT1531X_MANUF_ID_VAL ? "(OK)" : "(unexpected)");
    shell_print(shell, "ICT1531x CHIP_ID=0x%02x expected=0x%02x addr=0x%02x %s",
                device_id, ICT1531X_WHO_AM_I_VAL, ICT1531X_I2C_ADDR,
                device_id == ICT1531X_WHO_AM_I_VAL ? "(OK)" : "(unexpected)");
    return 0;
}

static int cmd_imu_mag_reg(const struct shell *shell, size_t argc, char **argv)
{
    uint8_t reg;
    uint8_t value = 0;
    int ret;

    ARG_UNUSED(argc);

    if (mos_imu_is_sleeping())
    {
        shell_error(shell, "IMU is sleeping, use 'imu wake' first");
        return -EAGAIN;
    }

    ret = parse_u8(argv[1], &reg);
    if (ret != 0)
    {
        shell_error(shell, "Invalid ICT1531x register address: %s", argv[1]);
        return ret;
    }

    ret = ict1531x_read_register(reg, &value, sizeof(value));
    if (ret != 0)
    {
        shell_error(shell, "ICT1531x register 0x%02x read through ICM-45608 I2CM failed: %d", reg, ret);
        return ret;
    }

    shell_print(shell, "ICT1531x reg[0x%02x] = 0x%02x", reg, value);
    return 0;
}

static int cmd_imu_read_reg(const struct shell *shell, size_t argc, char **argv)
{
    uint8_t reg;
    uint8_t value = 0;
    int ret;

    ARG_UNUSED(argc);

    if (mos_imu_is_sleeping())
    {
        shell_error(shell, "IMU is sleeping, use 'imu wake' first");
        return -EAGAIN;
    }

    ret = parse_u8(argv[1], &reg);
    if (ret != 0)
    {
        shell_error(shell, "Invalid register address: %s", argv[1]);
        return ret;
    }

    ret = icm45608_read_register(reg, &value);
    if (ret != 0)
    {
        shell_error(shell, "Read register 0x%02x failed: %d", reg, ret);
        return ret;
    }

    shell_print(shell, "reg[0x%02x] = 0x%02x", reg, value);
    return 0;
}

static int cmd_imu_write_reg(const struct shell *shell, size_t argc, char **argv)
{
    uint8_t reg;
    uint8_t value;
    int ret;

    ARG_UNUSED(argc);

    if (mos_imu_is_sleeping())
    {
        shell_error(shell, "IMU is sleeping, use 'imu wake' first");
        return -EAGAIN;
    }

    ret = parse_u8(argv[1], &reg);
    if (ret != 0)
    {
        shell_error(shell, "Invalid register address: %s", argv[1]);
        return ret;
    }

    ret = parse_u8(argv[2], &value);
    if (ret != 0)
    {
        shell_error(shell, "Invalid register value: %s", argv[2]);
        return ret;
    }

    ret = icm45608_write_register(reg, value);
    if (ret != 0)
    {
        shell_error(shell, "Write register 0x%02x failed: %d", reg, ret);
        return ret;
    }

    shell_print(shell, "reg[0x%02x] <- 0x%02x", reg, value);
    return 0;
}

SHELL_STATIC_SUBCMD_SET_CREATE(sub_imu,
                               SHELL_CMD(help, NULL, "Show IMU commands help", cmd_imu_help),
                               SHELL_CMD(status, NULL, "Show IMU status and read WHO_AM_I", cmd_imu_status),
                               SHELL_CMD(read, NULL, "Read accel/gyro/temp once", cmd_imu_read),
                               SHELL_CMD_ARG(start, NULL, "Start periodic reading: start [interval_ms]", cmd_imu_start, 1, 1),
                               SHELL_CMD(stop, NULL, "Stop periodic reading", cmd_imu_stop),
                               SHELL_CMD(sleep, NULL, "Put IMU subsystem into sleep", cmd_imu_sleep),
                               SHELL_CMD(wake, NULL, "Wake IMU subsystem", cmd_imu_wake),
                               SHELL_CMD(read_id, NULL, "Read ICM-45608 WHO_AM_I", cmd_imu_read_id),
                               SHELL_CMD(mag_id, NULL, "Read ICT1531x CHIP_ID through ICM-45608 I2CM", cmd_imu_mag_id),
                               SHELL_CMD_ARG(mag_reg, NULL, "Read ICT1531x register through ICM-45608 I2CM: mag_reg <addr>", cmd_imu_mag_reg, 2, 0),
                               SHELL_CMD_ARG(read_reg, NULL, "Read register: read_reg <addr>", cmd_imu_read_reg, 2, 0),
                               SHELL_CMD_ARG(write_reg, NULL, "Write register: write_reg <addr> <value>", cmd_imu_write_reg, 3, 0),
                               SHELL_SUBCMD_SET_END);

SHELL_CMD_REGISTER(imu, &sub_imu, "ICM-45608 IMU control commands", cmd_imu_help);
