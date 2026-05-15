#include "mos_yhm4005.h"

#include <errno.h>
#include <hal/nrf_gpio.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/irq.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(mos_yhm4005, LOG_LEVEL_INF);

#if !DT_NODE_EXISTS(DT_PATH(zephyr_user)) || !DT_NODE_HAS_PROP(DT_PATH(zephyr_user), watchdog_int_gpios)
#error "YHM4005 ACMD GPIO not defined. Add watchdog_int-gpios to zephyr,user node"
#endif

enum
{
#if DT_SAME_NODE(DT_GPIO_CTLR(DT_PATH(zephyr_user), watchdog_int_gpios), DT_NODELABEL(gpio0))
    YHM4005_ACMD_DT_PORT = 0,
#elif DT_SAME_NODE(DT_GPIO_CTLR(DT_PATH(zephyr_user), watchdog_int_gpios), DT_NODELABEL(gpio1))
    YHM4005_ACMD_DT_PORT = 1,
#else
#error "YHM4005 ACMD GPIO controller must be gpio0 or gpio1 for nRF GPIO HAL"
#endif
    YHM4005_ACMD_DT_PIN = DT_GPIO_PIN(DT_PATH(zephyr_user), watchdog_int_gpios),
};

static const struct gpio_dt_spec s_acmd_gpio = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), watchdog_int_gpios);
static const uint32_t s_acmd_nrf_pin = NRF_GPIO_PIN_MAP(YHM4005_ACMD_DT_PORT, YHM4005_ACMD_DT_PIN);
static bool s_initialized;
static mos_yhm4005_diag_t s_last_diag;

static void diag_begin(mos_yhm4005_acmd_mode_t mode, uint8_t address);
static void diag_set_error(int error_location);
static void diag_set_ack(int ack, int expected_ack);
static void diag_copy(mos_yhm4005_diag_t *diag);
static bool yhm4005_id_is_valid(uint8_t id);

static void diag_begin(mos_yhm4005_acmd_mode_t mode, uint8_t address)
{
    s_last_diag.mode = mode;
    s_last_diag.address = address;
    s_last_diag.id = 0;
    s_last_diag.delay_b0_us = MOS_YHM4005_DELAY_B0_US;
    s_last_diag.delay_b1_us = MOS_YHM4005_DELAY_B1_US;
    s_last_diag.delay_bz_us = MOS_YHM4005_DELAY_BZ_US;
    s_last_diag.delay_sa_us = MOS_YHM4005_DELAY_SA_US;
    s_last_diag.error_location = 0;
    s_last_diag.read_bit_error1 = 0;
    s_last_diag.read_bit_error2 = 0;
    s_last_diag.last_ack = -1;
    s_last_diag.expected_ack = -1;
}

static void diag_set_error(int error_location)
{
    s_last_diag.error_location = error_location;
}

static void diag_set_ack(int ack, int expected_ack)
{
    s_last_diag.last_ack = ack;
    s_last_diag.expected_ack = expected_ack;
}

static void diag_copy(mos_yhm4005_diag_t *diag)
{
    if (diag != NULL)
    {
        *diag = s_last_diag;
    }
}

static bool yhm4005_id_is_valid(uint8_t id)
{
    return (id & MOS_YHM4005_ID_VALID_MASK) == MOS_YHM4005_ID_VALID_VALUE;
}

static int validate_id(uint8_t id)
{
    if (!yhm4005_id_is_valid(id))
    {
        LOG_ERR("YHM4005 ID mismatch: 0x%02x", id);
        return -ENODEV;
    }

    return 0;
}

static int acmd_output_high(void)
{
    /*
     * Use nRF GPIO HAL for ACMD bit-banging; the pin comes from watchdog_int-gpios in app.overlay.
     * ACMD 单线协议使用 nRF GPIO HAL 直接翻转；引脚来源于 app.overlay 中的 watchdog_int-gpios。
     */
    nrf_gpio_pin_set(s_acmd_nrf_pin);
    nrf_gpio_cfg_output(s_acmd_nrf_pin);
    nrf_gpio_pin_set(s_acmd_nrf_pin);
    return 0;
}

static int acmd_input_pullup(void)
{
    nrf_gpio_cfg_input(s_acmd_nrf_pin, NRF_GPIO_PIN_PULLUP);
    return 0;
}

static int acmd_get_value(int *value)
{
    if (value == NULL)
    {
        return -EINVAL;
    }

    *value = nrf_gpio_pin_read(s_acmd_nrf_pin) & 0x01;
    return 0;
}

static int acmd_drive_low(void)
{
    nrf_gpio_pin_clear(s_acmd_nrf_pin);
    return 0;
}

static int acmd_drive_high(void)
{
    nrf_gpio_pin_set(s_acmd_nrf_pin);
    return 0;
}

static void delay_b0(void)
{
    k_busy_wait(MOS_YHM4005_DELAY_B0_US);
}

static void delay_b1(void)
{
    k_busy_wait(MOS_YHM4005_DELAY_B1_US);
}

static void delay_bz(void)
{
    k_busy_wait(MOS_YHM4005_DELAY_BZ_US);
}

static void delay_sa(void)
{
    k_busy_wait(MOS_YHM4005_DELAY_SA_US);
}

static int drive_clks_b0(void)
{
    int ret;

    ret = acmd_output_high();
    if (ret != 0)
    {
        return ret;
    }

    delay_b0();

    ret = acmd_drive_low();
    if (ret != 0)
    {
        return ret;
    }

    delay_b0();
    return acmd_drive_high();
}

static int drive_clks_b1(void)
{
    int ret;

    ret = acmd_output_high();
    if (ret != 0)
    {
        return ret;
    }

    delay_b0();

    ret = acmd_drive_low();
    if (ret != 0)
    {
        return ret;
    }

    delay_b1();
    return acmd_drive_high();
}

static int drive_clks_bz(void)
{
    int ret;

    ret = acmd_output_high();
    if (ret != 0)
    {
        return ret;
    }

    delay_b0();

    ret = acmd_drive_low();
    if (ret != 0)
    {
        return ret;
    }

    delay_bz();
    return acmd_drive_high();
}

static int drive_bit(int value)
{
    return value == 0 ? drive_clks_b0() : drive_clks_b1();
}

static int drive_z(void)
{
    return drive_clks_bz();
}

static int drive_reset_pulse(void)
{
    int ret;

    ret = acmd_output_high();
    if (ret != 0)
    {
        return ret;
    }

    ret = acmd_drive_low();
    if (ret != 0)
    {
        return ret;
    }

    for (int i = 0; i < 40; i++)
    {
        delay_bz();
    }

    return acmd_drive_high();
}

static int drive_start(void)
{
    return drive_z();
}

static int drive_stop(void)
{
    return drive_z();
}

static int drive_write(void)
{
    return drive_bit(0);
}

static int drive_read(void)
{
    return drive_bit(1);
}

static uint8_t verify_parity(uint8_t data)
{
    uint8_t value = 0;

    for (int i = 0; i < 8; i++)
    {
        value ^= (data >> i) & 0x01;
    }

    return value;
}

static int drive_ack(uint8_t input_value)
{
    return drive_bit(verify_parity(input_value) == 1 ? 1 : 0);
}

static int drive_data(uint8_t data, bool low_bit)
{
    int start_bit = low_bit ? 6 : 7;

    for (int i = start_bit; i >= 0; i--)
    {
        int ret = drive_bit((data >> i) & 0x01);
        if (ret != 0)
        {
            return ret;
        }
    }

    return 0;
}

static bool read_bit(int *value)
{
    int ret;
    int gpio_value;

    if (value == NULL)
    {
        return false;
    }

    ret = acmd_output_high();
    if (ret != 0)
    {
        s_last_diag.read_bit_error1 = 1;
        return false;
    }

    ret = acmd_drive_low();
    if (ret != 0)
    {
        s_last_diag.read_bit_error1 = 1;
        return false;
    }

    delay_b0();

    ret = acmd_input_pullup();
    if (ret != 0)
    {
        s_last_diag.read_bit_error1 = 1;
        return false;
    }

    delay_sa();

    ret = acmd_get_value(&gpio_value);
    if (ret != 0)
    {
        s_last_diag.read_bit_error1 = 1;
        return false;
    }

    *value = (~gpio_value) & 0x01;

    for (int i = 0; i < MOS_YHM4005_WAIT_RELEASE_LOOPS; i++)
    {
        ret = acmd_get_value(&gpio_value);
        if (ret != 0)
        {
            s_last_diag.read_bit_error1 = 1;
            return false;
        }

        if (gpio_value != 0)
        {
            return true;
        }
    }

    s_last_diag.read_bit_error2 = 1;
    return false;
}

static bool wait_ack(int *value)
{
    return read_bit(value);
}

static bool receive_data(uint8_t *value)
{
    uint8_t data = 0;

    if (value == NULL)
    {
        return false;
    }

    for (int i = 7; i >= 0; i--)
    {
        int bit_value;

        if (!read_bit(&bit_value))
        {
            return false;
        }

        data |= (uint8_t)(bit_value << i);
    }

    *value = data;
    return true;
}

static bool acmd_write_normal(uint8_t dev_addr, uint8_t reg, uint8_t len, const uint8_t *data)
{
    int ack;

    if (data == NULL || len == 0)
    {
        return false;
    }

    if ((dev_addr & 0x40) == 0x40)
    {
        return false;
    }

    if (drive_reset_pulse() != 0 || drive_start() != 0 || drive_data(dev_addr, true) != 0 || drive_write() != 0)
    {
        return false;
    }

    if (!wait_ack(&ack) || ack != verify_parity(dev_addr << 1))
    {
        (void)drive_stop();
        return false;
    }

    if (drive_data(reg, false) != 0)
    {
        (void)drive_stop();
        return false;
    }

    if (!wait_ack(&ack) || ack != verify_parity(reg))
    {
        (void)drive_stop();
        return false;
    }

    for (uint8_t i = 0; i < len; i++)
    {
        if (drive_data(data[i], false) != 0)
        {
            (void)drive_stop();
            return false;
        }

        if (!wait_ack(&ack) || ack != verify_parity(data[i]))
        {
            (void)drive_stop();
            return false;
        }
    }

    return drive_stop() == 0;
}

static bool acmd_read_normal(uint8_t dev_addr, uint8_t reg, uint8_t len, uint8_t *data)
{
    int ack;
    int expected_ack;

    diag_begin(MOS_YHM4005_ACMD_MODE_NORMAL, dev_addr);

    if (data == NULL || len == 0)
    {
        return false;
    }

    if ((dev_addr & 0x40) == 0x40)
    {
        diag_set_error(31);
        return false;
    }

    if (drive_reset_pulse() != 0 || drive_start() != 0 || drive_data(dev_addr, true) != 0 || drive_write() != 0)
    {
        diag_set_error(32);
        return false;
    }

    expected_ack = verify_parity(dev_addr << 1);
    if (!wait_ack(&ack))
    {
        (void)drive_stop();
        diag_set_error(32);
        return false;
    }
    diag_set_ack(ack, expected_ack);
    if (ack != expected_ack)
    {
        (void)drive_stop();
        diag_set_error(33);
        return false;
    }

    if (drive_data(reg, false) != 0)
    {
        (void)drive_stop();
        diag_set_error(34);
        return false;
    }

    expected_ack = verify_parity(reg);
    if (!wait_ack(&ack))
    {
        (void)drive_stop();
        diag_set_error(34);
        return false;
    }
    diag_set_ack(ack, expected_ack);
    if (ack != expected_ack)
    {
        (void)drive_stop();
        diag_set_error(35);
        return false;
    }

    if (drive_start() != 0 || drive_data(dev_addr, true) != 0 || drive_read() != 0)
    {
        (void)drive_stop();
        diag_set_error(36);
        return false;
    }

    expected_ack = verify_parity((dev_addr << 1) + 1);
    if (!wait_ack(&ack))
    {
        (void)drive_stop();
        diag_set_error(36);
        return false;
    }
    diag_set_ack(ack, expected_ack);
    if (ack != expected_ack)
    {
        (void)drive_stop();
        diag_set_error(37);
        return false;
    }

    for (uint8_t i = 0; i < len; i++)
    {
        if (!receive_data(&data[i]))
        {
            (void)drive_stop();
            diag_set_error(38);
            return false;
        }

        if (i != (len - 1) && drive_ack(data[i]) != 0)
        {
            (void)drive_stop();
            diag_set_error(38);
            return false;
        }
    }

    return drive_stop() == 0;
}

static int yhm4005_write(uint8_t reg, const uint8_t *data, uint8_t len)
{
    bool ok = false;

    if (data == NULL || len == 0)
    {
        return -EINVAL;
    }

    for (int retry = 0; retry < MOS_YHM4005_RETRY_COUNT; retry++)
    {
        unsigned int key = irq_lock();
        ok = acmd_write_normal(MOS_YHM4005_ADDRESS_NORMAL, reg, len, data);
        irq_unlock(key);

        if (ok)
        {
            return 0;
        }
    }

    LOG_ERR("YHM4005 write reg 0x%02x failed at AW4T normal addr 0x%02x", reg, MOS_YHM4005_ADDRESS_NORMAL);
    return -EIO;
}

static int yhm4005_read_retry(uint8_t reg, uint8_t *data, uint8_t len, int retry_count, bool log_failure)
{
    bool ok = false;

    if (data == NULL || len == 0)
    {
        return -EINVAL;
    }

    for (int retry = 0; retry < retry_count; retry++)
    {
        unsigned int key = irq_lock();
        ok = acmd_read_normal(MOS_YHM4005_ADDRESS_NORMAL, reg, len, data);
        irq_unlock(key);

        if (ok)
        {
            s_last_diag.id = data[0];
            return 0;
        }
    }

    if (log_failure)
    {
        LOG_ERR("YHM4005 read reg 0x%02x failed at AW4T normal addr 0x%02x error_location=%d read_bit_error1=%d read_bit_error2=%d",
                reg,
                MOS_YHM4005_ADDRESS_NORMAL,
                s_last_diag.error_location,
                s_last_diag.read_bit_error1,
                s_last_diag.read_bit_error2);
    }
    return -EIO;
}

static int yhm4005_read(uint8_t reg, uint8_t *data, uint8_t len)
{
    return yhm4005_read_retry(reg, data, len, MOS_YHM4005_RETRY_COUNT, true);
}

static int yhm4005_write_u8(uint8_t reg, uint8_t value)
{
    return yhm4005_write(reg, &value, 1);
}

static int verify_id(void)
{
    int ret;
    uint8_t id = 0;

    ret = mos_yhm4005_read_id(&id);
    if (ret != 0)
    {
        return ret;
    }

    return validate_id(id);
}

int mos_yhm4005_init(void)
{
    int ret;

    if (s_initialized)
    {
        return 0;
    }

    if (!gpio_is_ready_dt(&s_acmd_gpio))
    {
        LOG_ERR("YHM4005 ACMD GPIO port not ready");
        return -ENODEV;
    }

    ret = acmd_output_high();
    if (ret != 0)
    {
        LOG_ERR("YHM4005 ACMD GPIO init failed: %d", ret);
        return ret;
    }

    s_initialized = true;
    LOG_INF("YHM4005 ACMD GPIO initialized through nRF HAL on P%u.%u",
            YHM4005_ACMD_DT_PORT,
            YHM4005_ACMD_DT_PIN);
    return 0;
}

int mos_yhm4005_read_id(uint8_t *id)
{
    int ret;

    if (id == NULL)
    {
        return -EINVAL;
    }

    if (!s_initialized)
    {
        return -ENODEV;
    }

    ret = yhm4005_read(MOS_YHM4005_REG_ID, id, 1);
    if (ret != 0)
    {
        return ret;
    }

    return validate_id(*id);
}

int mos_yhm4005_read_id_diag(uint8_t *id, mos_yhm4005_diag_t *diag)
{
    int ret;

    if (id == NULL)
    {
        return -EINVAL;
    }

    if (!s_initialized)
    {
        return -ENODEV;
    }

    ret = yhm4005_read_retry(MOS_YHM4005_REG_ID, id, 1, MOS_YHM4005_RETRY_COUNT, true);
    diag_copy(diag);
    if (ret != 0)
    {
        return ret;
    }

    return validate_id(*id);
}

int mos_yhm4005_enable(mos_yhm4005_timeout_t timeout, mos_yhm4005_reset_pulse_t reset_pulse)
{
    int ret;
    uint8_t timer_reg;

    if (!s_initialized)
    {
        return -ENODEV;
    }

    if (timeout > MOS_YHM4005_TIMEOUT_2000S || reset_pulse > MOS_YHM4005_RESET_ALWAYS_ACTIVE)
    {
        return -EINVAL;
    }

    ret = verify_id();
    if (ret != 0)
    {
        return ret;
    }

    ret = yhm4005_write_u8(MOS_YHM4005_REG_CTRL, MOS_YHM4005_CTRL_EN_WDI);
    if (ret != 0)
    {
        return ret;
    }

    timer_reg = ((uint8_t)timeout << 3) | (uint8_t)reset_pulse;
    ret = yhm4005_write_u8(MOS_YHM4005_REG_TIMER, timer_reg);
    if (ret != 0)
    {
        return ret;
    }

    ret = yhm4005_write_u8(MOS_YHM4005_REG_DEV_CFG, MOS_YHM4005_DEV_CFG_ACTIVE_LOW_OD);
    if (ret != 0)
    {
        return ret;
    }

    ret = yhm4005_write_u8(MOS_YHM4005_REG_CTRL, MOS_YHM4005_CTRL_EN_WDI | MOS_YHM4005_CTRL_EN_DOG);
    if (ret != 0)
    {
        return ret;
    }

    LOG_INF("YHM4005 enabled: timeout=%us reset_pulse_code=%u",
            mos_yhm4005_timeout_code_to_seconds(timeout),
            (uint8_t)reset_pulse);
    return 0;
}

int mos_yhm4005_disable(void)
{
    int ret;

    if (!s_initialized)
    {
        return -ENODEV;
    }

    ret = yhm4005_write_u8(MOS_YHM4005_REG_CTRL, MOS_YHM4005_CTRL_EN_WDI);
    if (ret != 0)
    {
        return ret;
    }

    LOG_INF("YHM4005 disabled");
    return 0;
}

int mos_yhm4005_feed(void)
{
    int ret;

    if (!s_initialized)
    {
        return -ENODEV;
    }

    ret = acmd_output_high();
    if (ret != 0)
    {
        return ret;
    }

    ret = acmd_drive_low();
    if (ret != 0)
    {
        return ret;
    }

    k_busy_wait(MOS_YHM4005_FEED_LOW_US);

    ret = acmd_drive_high();
    if (ret != 0)
    {
        return ret;
    }
    LOG_INF("YHM4005 fed successfully");
    return 0;
}

bool mos_yhm4005_is_initialized(void)
{
    return s_initialized;
}

int mos_yhm4005_timeout_seconds_to_code(uint32_t seconds, mos_yhm4005_timeout_t *timeout)
{
    if (timeout == NULL)
    {
        return -EINVAL;
    }

    switch (seconds)
    {
        case 1:
            *timeout = MOS_YHM4005_TIMEOUT_1S;
            return 0;
        case 2:
            *timeout = MOS_YHM4005_TIMEOUT_2S;
            return 0;
        case 5:
            *timeout = MOS_YHM4005_TIMEOUT_5S;
            return 0;
        case 10:
            *timeout = MOS_YHM4005_TIMEOUT_10S;
            return 0;
        case 20:
            *timeout = MOS_YHM4005_TIMEOUT_20S;
            return 0;
        case 50:
            *timeout = MOS_YHM4005_TIMEOUT_50S;
            return 0;
        case 100:
            *timeout = MOS_YHM4005_TIMEOUT_100S;
            return 0;
        case 200:
            *timeout = MOS_YHM4005_TIMEOUT_200S;
            return 0;
        case 500:
            *timeout = MOS_YHM4005_TIMEOUT_500S;
            return 0;
        case 1000:
            *timeout = MOS_YHM4005_TIMEOUT_1000S;
            return 0;
        case 2000:
            *timeout = MOS_YHM4005_TIMEOUT_2000S;
            return 0;
        default:
            return -EINVAL;
    }
}

uint32_t mos_yhm4005_timeout_code_to_seconds(mos_yhm4005_timeout_t timeout)
{
    switch (timeout)
    {
        case MOS_YHM4005_TIMEOUT_1S:
            return 1;
        case MOS_YHM4005_TIMEOUT_2S:
            return 2;
        case MOS_YHM4005_TIMEOUT_5S:
            return 5;
        case MOS_YHM4005_TIMEOUT_10S:
            return 10;
        case MOS_YHM4005_TIMEOUT_20S:
            return 20;
        case MOS_YHM4005_TIMEOUT_50S:
            return 50;
        case MOS_YHM4005_TIMEOUT_100S:
            return 100;
        case MOS_YHM4005_TIMEOUT_200S:
            return 200;
        case MOS_YHM4005_TIMEOUT_500S:
            return 500;
        case MOS_YHM4005_TIMEOUT_1000S:
            return 1000;
        case MOS_YHM4005_TIMEOUT_2000S:
            return 2000;
        default:
            return 0;
    }
}
