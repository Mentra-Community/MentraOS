/* app_cvt213x_shim.c
 * Minimal stubs for platform-specific functions used by CVT213X porting layer.
 * These are harmless defaults so the project builds under Zephyr; replace with
 * real implementations if hardware-specific behavior is required.
 */

#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/i2c.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include "app_cvt213x_shim.h"

LOG_MODULE_REGISTER(cvt213x_shim, LOG_LEVEL_DBG);

/* Use the dedicated I2C controller for CVT213X: i2c3 is required by this
 * project. Do not fall back to other buses — fail at runtime if missing. */
#if DT_NODE_HAS_STATUS(DT_NODELABEL(i2c3), okay)
static const struct device* cvt_i2c_dev = DEVICE_DT_GET(DT_NODELABEL(i2c3));
#else
#warning "CVT213X: DT node 'i2c3' not present; enable i2c3 in your devicetree"
static const struct device* cvt_i2c_dev = NULL;
#endif

static const struct gpio_dt_spec cvt_int = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), cvt213x_int_gpios);

int cvt213x_hal_i2c_init(void)
{
    if (!cvt_i2c_dev || !device_is_ready(cvt_i2c_dev))
    {
        LOG_ERR("cvt213x_hal_i2c_init: i2c device not ready");
        return -ENODEV;
    }

    uint32_t cfg = I2C_SPEED_SET(I2C_SPEED_STANDARD) | I2C_MODE_CONTROLLER;
    int      ret = i2c_configure((struct device*)cvt_i2c_dev, cfg);
    if (ret)
    {
        LOG_ERR("cvt213x_hal_i2c_init: i2c_configure failed %d", ret);
    }
    return ret;
}

int cvt213x_hal_irq_init(void)
{
    if (!cvt_int.port || !device_is_ready(cvt_int.port))
    {
        LOG_ERR("cvt213x_hal_irq_init: int gpio not ready");
        return -ENODEV;
    }

    int rc = gpio_pin_configure_dt(&cvt_int, GPIO_INPUT);
    if (rc)
    {
        LOG_ERR("cvt213x_hal_irq_init: gpio_pin_configure_dt failed %d", rc);
        return rc;
    }
    return 0;
}

uint8_t cvt213x_hal_irq_get_level(int chipIndex)
{
    ARG_UNUSED(chipIndex);

    if (!cvt_int.port || !device_is_ready(cvt_int.port))
    {
        LOG_WRN("cvt213x_hal_irq_get_level: int gpio not ready; returning 0");
        return 0;
    }

    int val = gpio_pin_get_raw(cvt_int.port, cvt_int.pin);
    /* Normalize to 0/1 */
    return (uint8_t)(val ? 1 : 0);
}

/* Hardware I2C helpers implemented on top of Zephyr I2C */
int cvt213x_hw_i2c_write(uint8_t addr, uint16_t reg, uint8_t* buff, uint32_t size)
{
    if (!cvt_i2c_dev || !device_is_ready(cvt_i2c_dev))
    {
        LOG_ERR("cvt213x: i2c device not ready");
        return -ENODEV;
    }

    /* Compose register (big-endian) + payload */
    uint8_t tx_buf[2 + size];
    tx_buf[0] = (uint8_t)((reg >> 8) & 0xFF);
    tx_buf[1] = (uint8_t)(reg & 0xFF);
    if (size > 0 && buff != NULL)
    {
        memcpy(&tx_buf[2], buff, size);
    }

    int ret = i2c_write(cvt_i2c_dev, tx_buf, 2 + size, addr);
    if (ret)
    {
        LOG_WRN("cvt213x: i2c_write failed: %d", ret);
    }
    return ret;
}

int cvt213x_hw_i2c_read(uint8_t addr, uint16_t reg, uint8_t* buff, uint32_t size)
{
    if (!cvt_i2c_dev || !device_is_ready(cvt_i2c_dev))
    {
        LOG_ERR("cvt213x: i2c device not ready");
        return -ENODEV;
    }

    uint8_t reg_be[2];
    reg_be[0] = (uint8_t)((reg >> 8) & 0xFF);
    reg_be[1] = (uint8_t)(reg & 0xFF);

    int ret = i2c_write_read(cvt_i2c_dev, addr, reg_be, sizeof(reg_be), buff, size);
    if (ret)
    {
        LOG_WRN("cvt213x: i2c_read failed: %d", ret);
    }
    return ret;
}

/* Backwards-compatible wrappers (old SW names kept for other usage) */
int cvt213x_sw_i2c_write(uint8_t addr, uint16_t reg, uint8_t* buff, uint32_t size)
{
    return cvt213x_hw_i2c_write(addr, reg, buff, size);
}

int cvt213x_sw_i2c_read(uint8_t addr, uint16_t reg, uint8_t* buff, uint32_t size)
{
    return cvt213x_hw_i2c_read(addr, reg, buff, size);
}

/* Flash emulation stubs */
void cm_write(const void* buf, int page, int len)
{
    (void)buf;
    (void)page;
    (void)len;
}

void cm_sync(void)
{
}

void cm_read(void* buf, int page, int len)
{
    (void)buf;
    (void)page;
    (void)len;
}

/* Bluetooth SPP stub */
int bt_spp_tx(const void* packet, int len)
{
    (void)packet;
    (void)len;
    return 0;
}

/* Message queue stub */
void msg_enqueue(int e)
{
    (void)e;
}
