#include "mos_gx8002.h"

#include <errno.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/i2c.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/pm/device.h>
#include <zephyr/sys/util.h>

#include "mos_i2s_slave.h"
#include "vad_interrupt_handler.h"

LOG_MODULE_REGISTER(mos_gx8002, LOG_LEVEL_INF);

#if DT_NODE_EXISTS(DT_NODELABEL(i2c0))
static const struct device *i2c_dev = DEVICE_DT_GET(DT_NODELABEL(i2c0));
#endif

#if DT_NODE_EXISTS(DT_PATH(zephyr_user)) && DT_NODE_HAS_PROP(DT_PATH(zephyr_user), vad_power_gpios)
#define VAD_POWER_GPIO_AVAILABLE 1
static const struct gpio_dt_spec vad_power = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), vad_power_gpios);
#else
#define VAD_POWER_GPIO_AVAILABLE 0
#endif

#if DT_NODE_EXISTS(DT_PATH(zephyr_user)) && DT_NODE_HAS_PROP(DT_PATH(zephyr_user), gx8002_vad_int_gpios)
#define GX8002_VAD_INT_GPIO_AVAILABLE 1
static const struct gpio_dt_spec gx8002_vad_int = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), gx8002_vad_int_gpios);
#else
#define GX8002_VAD_INT_GPIO_AVAILABLE 0
#endif

static struct gpio_callback gx8002_vad_int_cb_data;
static bool gx8002_i2c_initialized = false;
static bool gx8002_i2s_enabled = false;
static bool gx8002_mos_initialized = false;


#if DT_NODE_EXISTS(DT_NODELABEL(i2c0)) && IS_ENABLED(CONFIG_PM_DEVICE)
static void gx8002_i2c0_bus_hang(void)
{
    if ((i2c_dev == NULL) || !device_is_ready(i2c_dev))
    {
        return;
    }

    int hang_ret = pm_device_action_run(i2c_dev, PM_DEVICE_ACTION_SUSPEND);

    if (hang_ret != 0 && hang_ret != -EALREADY)
    {
        LOG_WRN("GX8002 i2c0 suspend failed: %d", hang_ret);
    }
}

static void gx8002_i2c0_bus_resume(void)
{
    if ((i2c_dev == NULL) || !device_is_ready(i2c_dev))
    {
        return;
    }

    int resume_ret = pm_device_action_run(i2c_dev, PM_DEVICE_ACTION_RESUME);

    if (resume_ret != 0 && resume_ret != -EALREADY)
    {
        LOG_WRN("GX8002 i2c0 resume failed: %d", resume_ret);
    }
}
#endif

int mos_gx8002_power_control(bool enable)
{
    if (VAD_POWER_GPIO_AVAILABLE && gpio_is_ready_dt(&vad_power))
    {
        int ret = gpio_pin_configure_dt(&vad_power, GPIO_OUTPUT);

        if (ret == 0)
        {
            if (enable)
            {
                gx8002_i2c0_bus_resume();
            }

            ret = gpio_pin_set_dt(&vad_power, enable ? 1 : 0);

            if (ret == 0 && !enable)
            {
                gx8002_i2c0_bus_hang();// Hang I2C bus after powering down VAD to release lines (sleep pinctrl)
            }
        }

        if (ret == 0)
        {
            LOG_INF("VAD_EN power %s", enable ? "ON" : "OFF");
        }
        return ret;
    }

    return -ENODEV;
}

static int gx8002_i2c_init(void)
{
    if (gx8002_i2c_initialized)
    {
        return 0;
    }

    if (i2c_dev == NULL || !device_is_ready(i2c_dev))
    {
        return -ENODEV;
    }

    int ret = i2c_configure(i2c_dev, I2C_SPEED_SET(I2C_SPEED_STANDARD) | I2C_MODE_CONTROLLER);
    if (ret != 0)
    {
        return ret;
    }

    gx8002_i2c_initialized = true;
    return 0;
}

uint8_t mos_gx8002_iic_write_data(uint8_t slave_address, uint8_t *buf, int buf_len)
{
    if (i2c_dev == NULL || !device_is_ready(i2c_dev) || buf == NULL || buf_len <= 0)
    {
        return 0;
    }

    return i2c_write(i2c_dev, buf, buf_len, slave_address) == 0 ? 1 : 0;
}

uint8_t mos_gx8002_iic_read_data(uint8_t slave_address, uint8_t reg, uint8_t *data)
{
    if (i2c_dev == NULL || !device_is_ready(i2c_dev) || data == NULL)
    {
        return 0;
    }

    return i2c_write_read(i2c_dev, slave_address, &reg, 1, data, 1) == 0 ? 1 : 0;
}

uint8_t mos_gx8002_iic_wait_reply(uint8_t slave_address, uint8_t reg, uint8_t reply, int timeout_ms)
{
    for (int i = 0; i < timeout_ms; ++i)
    {
        uint8_t data = 0;
        if (mos_gx8002_iic_read_data(slave_address, reg, &data) && data == reply)
        {
            return 1;
        }

        k_sleep(K_MSEC(1));
    }

    return 0;
}

static void gx8002_fm_reset(void)
{
    if (!VAD_POWER_GPIO_AVAILABLE || !gpio_is_ready_dt(&vad_power))
    {
        return;
    }

    (void)gpio_pin_configure_dt(&vad_power, GPIO_OUTPUT);
    (void)gpio_pin_set_dt(&vad_power, 0);
    k_sleep(K_MSEC(2000));
    (void)gpio_pin_set_dt(&vad_power, 1);
    k_sleep(K_MSEC(20));
}

static uint8_t gx8002_getversion(uint8_t *version)
{
    uint8_t cmd[2] = {0xC4, 0x68};
    uint8_t regs[4] = {0xA0, 0xA4, 0xA8, 0xAC};
    uint8_t ok = 0;

    for (int attempt = 0; attempt < 3; ++attempt)
    {
        if (attempt > 0)
        {
            k_sleep(K_MSEC(200));
        }

        k_sleep(K_MSEC(1000));

        if (!mos_gx8002_iic_write_data(MOS_GX_CMD_ADDR, cmd, 2))
        {
            continue;
        }

        k_sleep(K_MSEC(500));

        ok = 1;
        for (int i = 0; i < 4; ++i)
        {
            if (!mos_gx8002_iic_read_data(MOS_GX_CMD_ADDR, regs[i], &version[i]))
            {
                ok = 0;
                break;
            }
        }

        if (ok)
        {
            break;
        }
    }

    return ok;
}

static uint8_t gx8002_handshake(void)
{
    uint8_t ping = 0xEF;

    for (int i = 0; i < 200; ++i)
    {
        if (mos_gx8002_iic_write_data(MOS_GX_DATA_ADDR, &ping, 1)
            && mos_gx8002_iic_wait_reply(MOS_GX_CMD_ADDR, 0xA0, 0x78, 10))
        {
            return 1;
        }

        k_sleep(K_MSEC(1));
    }

    return 0;
}

static void gx8002_vad_int_isr(const struct device *dev, struct gpio_callback *cb, uint32_t pins)
{
    ARG_UNUSED(dev);
    ARG_UNUSED(cb);

    static uint32_t isr_count;
    isr_count++;


    // if (vad_interrupt_handler_is_i2s_active())
    // {
    //     return;
    // }


    int disable_ret = mos_gx8002_vad_int_disable();
    int send_ret = vad_interrupt_handler_send_event();

    if (send_ret != 0 && send_ret != -EALREADY)
    {
        (void)mos_gx8002_vad_int_re_enable();
    }

    LOG_INF("GX8002 VAD IRQ: count=%u pins=0x%08x disable_ret=%d send_ret=%d", isr_count, pins, disable_ret, send_ret);
}

int mos_gx8002_vad_int_re_enable(void)
{
    if (!GX8002_VAD_INT_GPIO_AVAILABLE)
    {
        return -ENODEV;
    }

    return gpio_pin_interrupt_configure_dt(&gx8002_vad_int, GPIO_INT_EDGE_FALLING);
}

int mos_gx8002_vad_int_disable(void)
{
    if (!GX8002_VAD_INT_GPIO_AVAILABLE)
    {
        return -ENODEV;
    }

    return gpio_pin_interrupt_configure_dt(&gx8002_vad_int, GPIO_INT_DISABLE);
}

static int gx8002_vad_int_init(void)
{
    if (!GX8002_VAD_INT_GPIO_AVAILABLE || !gpio_is_ready_dt(&gx8002_vad_int))
    {
        LOG_ERR("GX8002 VAD IRQ GPIO unavailable or not ready");
        return -ENODEV;
    }

    int ret = gpio_pin_configure_dt(&gx8002_vad_int, GPIO_INPUT | GPIO_PULL_UP);
    if (ret != 0)
    {
        LOG_ERR("GX8002 VAD IRQ GPIO configure failed: %d", ret);
        return ret;
    }

    gpio_init_callback(&gx8002_vad_int_cb_data, gx8002_vad_int_isr, BIT(gx8002_vad_int.pin));
    ret = gpio_add_callback(gx8002_vad_int.port, &gx8002_vad_int_cb_data);
    if (ret != 0)
    {
        LOG_ERR("GX8002 VAD IRQ add callback failed: %d", ret);
        return ret;
    }

    ret = mos_gx8002_vad_int_re_enable();
    if (ret != 0)
    {
        LOG_ERR("GX8002 VAD IRQ enable failed: %d", ret);
        return ret;
    }

    int level = gpio_pin_get_dt(&gx8002_vad_int);
    LOG_INF("GX8002 VAD IRQ ready: port=%s pin=%u level=%d", gx8002_vad_int.port->name, gx8002_vad_int.pin, level);

    return 0;
}

int mos_gx8002_init(void)
{
    mos_gx8002_power_control(true);

    if (gx8002_mos_initialized)
    {
        return 0;
    }

    gx8002_fm_reset();

    int ret = gx8002_i2c_init();
    if (ret != 0)
    {
        return ret;
    }

    ret = vad_interrupt_handler_init();
    if (ret != 0)
    {
        LOG_ERR("VAD interrupt handler init failed: %d", ret);
        return ret;
    }

    ret = gx8002_i2s_init();
    if (ret != 0)
    {
        LOG_ERR("GX8002 I2S pre-init failed: %d", ret);
        return ret;
    }

    ret = gx8002_vad_int_init();
    if (ret != 0)
    {
        LOG_ERR("GX8002 VAD IRQ init failed: %d", ret);
        return ret;
    }

    LOG_INF("GX8002 MOS init done, VAD interrupt pipeline enabled");

    gx8002_mos_initialized = true;

    return 0;
}

void mos_gx8002_reset(void)
{
    gx8002_fm_reset();
}

uint8_t mos_gx8002_getversion(uint8_t *version)
{
    if (version == NULL)
    {
        return 0;
    }

    return gx8002_getversion(version);
}

uint8_t mos_gx8002_handshake(void)
{
    return gx8002_handshake();
}

uint8_t mos_gx8002_start_i2s(void)
{
    mos_gx8002_reset();
    k_sleep(K_MSEC(100));

    if (!mos_gx8002_handshake())
    {
        return 0;
    }

    return mos_gx8002_enable_i2s();
}

uint8_t mos_gx8002_enable_i2s(void)
{
    uint8_t cmd[2] = {0xC4, 0x71};
    uint8_t ret = mos_gx8002_iic_write_data(MOS_GX_CMD_ADDR, cmd, 2);
    if (ret)
    {
        gx8002_i2s_enabled = true;
    }
    return ret;
}

uint8_t mos_gx8002_disable_i2s(void)
{
    uint8_t cmd[2] = {0xC4, 0x72};
    uint8_t ret = mos_gx8002_iic_write_data(MOS_GX_CMD_ADDR, cmd, 2);
    if (ret)
    {
        gx8002_i2s_enabled = false;
    }
    return ret;
}

uint8_t mos_gx8002_get_mic_state(uint8_t *state)
{
    if (state == NULL)
    {
        return 0;
    }

    uint8_t cmd[2] = {0xC4, 0x70};
    if (!mos_gx8002_iic_write_data(MOS_GX_CMD_ADDR, cmd, 2))
    {
        return 0;
    }

    k_sleep(K_MSEC(200));

    return mos_gx8002_iic_read_data(MOS_GX_CMD_ADDR, 0xA0, state);
}

uint8_t mos_gx8002_is_i2s_enabled(void)
{
    return gx8002_i2s_enabled ? 1 : 0;
}
