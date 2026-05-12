#include "mos_ict1531x.h"

#include <errno.h>
#include <zephyr/logging/log.h>

#include "mos_icm45608.h"

LOG_MODULE_REGISTER(mos_ict1531x, LOG_LEVEL_INF);


int ict1531x_init(void)
{
    uint8_t manuf_id = 0;
    uint8_t device_id = 0;
    int ret;

    ret = ict1531x_read_manuf_id(&manuf_id);
    if (ret != 0)
    {
        LOG_ERR("ICT1531x MANUF_ID read failed: %d", ret);
        return ret;
    }

    if (manuf_id != ICT1531X_MANUF_ID_VAL)
    {
        LOG_ERR("ICT1531x unexpected MANUF_ID=0x%02x, expected 0x%02x",
                manuf_id, ICT1531X_MANUF_ID_VAL);
        return -ENODEV;
    }

    ret = ict1531x_read_device_id(&device_id);
    if (ret != 0)
    {
        LOG_ERR("ICT1531x CHIP_ID read failed: %d", ret);
        return ret;
    }

    if (device_id != ICT1531X_WHO_AM_I_VAL)
    {
        LOG_ERR("ICT1531x unexpected CHIP_ID=0x%02x, expected 0x%02x",
                device_id, ICT1531X_WHO_AM_I_VAL);
        return -ENODEV;
    }

    LOG_INF("ICT1531x detected at 0x%02x, MANUF_ID=0x%02x CHIP_ID=0x%02x",
            ICT1531X_I2C_ADDR, manuf_id, device_id);
    return 0;
}

int ict1531x_sleep(void)
{
    uint8_t mode_ctrl;
    int ret;

    ret = ict1531x_read_register(ICT1531X_REG_MODE_CTRL, &mode_ctrl, sizeof(mode_ctrl));
    if (ret != 0)
    {
        LOG_WRN("ICT1531x MODE_CTRL read before sleep failed: %d", ret);
        return ret;
    }

    mode_ctrl &= (uint8_t)~ICT1531X_MODE_CTRL_MODE_MASK;// Clear mode bits
    mode_ctrl |= ICT1531X_MODE_CTRL_MODE_STANDBY;// Set standby mode

    ret = ict1531x_write_register(ICT1531X_REG_MODE_CTRL, &mode_ctrl, sizeof(mode_ctrl));
    if (ret != 0)
    {
        LOG_WRN("ICT1531x MODE_CTRL standby write failed: %d", ret);
        return ret;
    }

    LOG_INF("ICT1531x set to standby before sleep");
    return 0;
}

int ict1531x_read_register(uint8_t reg, uint8_t *buf, size_t len)
{
    return icm45608_i2cm_read_reg(ICT1531X_I2C_ADDR, reg, buf, len);
}

int ict1531x_write_register(uint8_t reg, const uint8_t *buf, size_t len)
{
    return icm45608_i2cm_write_reg(ICT1531X_I2C_ADDR, reg, buf, len);
}

int ict1531x_read_manuf_id(uint8_t *manuf_id)
{
    if (manuf_id == NULL)
    {
        return -EINVAL;
    }

    return ict1531x_read_register(ICT1531X_REG_MANUF_ID, manuf_id, sizeof(*manuf_id));
}

int ict1531x_read_device_id(uint8_t *device_id)
{
    int ret;

    if (device_id == NULL)
    {
        return -EINVAL;
    }

    ret = ict1531x_read_register(ICT1531X_REG_CHIP_ID, device_id, sizeof(*device_id));
    if (ret == 0)
    {
        LOG_INF("ICT1531x CHIP_ID read through ICM-45608 I2CM: 0x%02x", *device_id);
    }

    return ret;
}
