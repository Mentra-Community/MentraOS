/*
 * @Author       : XK
 * @Date         : 2025-07-07 20:20:24
 * @LastEditTime : 2025-07-15 17:56:45
 * @FilePath     : bsp_ict_15318.c
 * @Description  :
 *
 * Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved.
 */

#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/device.h>
#include <zephyr/drivers/i2c.h>
#include "bal_os.h"
#include "bsp_ict_15318.h"
#include "bsp_log.h"

#define TAG "BSP_ICT_15318"
#define ICT_15318_I2C_SOFT_MODE 1 // 0:硬件I2C 1:软件I2C

#if ICT_15318_I2C_SOFT_MODE
const struct gpio_dt_spec ict_15318_i2c_sda = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), ict_15318_sda_gpios);
const struct gpio_dt_spec ict_15318_i2c_scl = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), ict_15318_scl_gpios);

/* I2C bit-bang 时序延时 (µs) */
#define ict_15318_SW_I2C_DELAY_US 6    /* 根据总线速率微调 */
#define ict_15318_SW_I2C_TIMEOUT 1000U /* ACK 等待最大循环 */

/* --- GPIO 配置 & 操作 --- */
static int ict_15318_sda_out(void)
{
    return gpio_pin_configure_dt(&ict_15318_i2c_sda, GPIO_OUTPUT);
}
static int ict_15318_sda_in(void)
{
    return gpio_pin_configure_dt(&ict_15318_i2c_sda, GPIO_INPUT | GPIO_PULL_UP);
}
static int ict_15318_scl_out(void)
{
    return gpio_pin_configure_dt(&ict_15318_i2c_scl, GPIO_OUTPUT);
}
static int ict_15318_scl_in(void)
{
    return gpio_pin_configure_dt(&ict_15318_i2c_scl, GPIO_INPUT | GPIO_PULL_UP);
}
static void ict_15318_sda_high(void)
{
    gpio_pin_set_raw(ict_15318_i2c_sda.port, ict_15318_i2c_sda.pin, 1);
}
static void ict_15318_sda_low(void)
{
    gpio_pin_set_raw(ict_15318_i2c_sda.port, ict_15318_i2c_sda.pin, 0);
}
static void ict_15318_scl_high(void)
{
    gpio_pin_set_raw(ict_15318_i2c_scl.port, ict_15318_i2c_scl.pin, 1);
}
static void ict_15318_scl_low(void)
{
    gpio_pin_set_raw(ict_15318_i2c_scl.port, ict_15318_i2c_scl.pin, 0);
}
static int ict_15318_sda_read(void)
{
    return gpio_pin_get_raw(ict_15318_i2c_sda.port, ict_15318_i2c_sda.pin);
}

void ict_15318_i2c_start(void)
{
    ict_15318_sda_high();
    ict_15318_scl_high();
    xyzn_os_busy_wait(ict_15318_SW_I2C_DELAY_US);
    ict_15318_sda_low();
    xyzn_os_busy_wait(ict_15318_SW_I2C_DELAY_US);
    ict_15318_scl_low();
    xyzn_os_busy_wait(ict_15318_SW_I2C_DELAY_US);
}

void ict_15318_i2c_stop(void)
{
    ict_15318_sda_low();
    xyzn_os_busy_wait(ict_15318_SW_I2C_DELAY_US);
    ict_15318_scl_high();
    xyzn_os_busy_wait(ict_15318_SW_I2C_DELAY_US);
    ict_15318_sda_high();
    xyzn_os_busy_wait(ict_15318_SW_I2C_DELAY_US);
}

/* 发送一字节并等待 ACK */
int ict_15318_write_byte(uint8_t b)
{
    ict_15318_sda_out();
    xyzn_os_busy_wait(ict_15318_SW_I2C_DELAY_US);
    /* 发送 8 bit */
    for (int i = 7; i >= 0; i--)
    {
        ict_15318_scl_low();
        if (b & (1 << i))
            ict_15318_sda_high();
        else
            ict_15318_sda_low();
        xyzn_os_busy_wait(ict_15318_SW_I2C_DELAY_US);

        ict_15318_scl_high();
        xyzn_os_busy_wait(ict_15318_SW_I2C_DELAY_US);
    }

    /* 第 9 个时钟，用于 ACK */
    ict_15318_scl_low();
    ict_15318_sda_in(); /* 切输入，等从机拉 ACK */
    xyzn_os_busy_wait(ict_15318_SW_I2C_DELAY_US);

    ict_15318_scl_high();
    xyzn_os_busy_wait(ict_15318_SW_I2C_DELAY_US / 2);

    uint32_t t = 0;
    while (ict_15318_sda_read() && t++ < ict_15318_SW_I2C_TIMEOUT)
    {
        xyzn_os_busy_wait(1);
    }

    xyzn_os_busy_wait(ict_15318_SW_I2C_DELAY_US / 2);
    ict_15318_scl_low();
    ict_15318_sda_out();

    if (t >= ict_15318_SW_I2C_TIMEOUT)
    {
        BSP_LOGE(TAG, "I2C ACK timeout");
        return XYZN_OS_ERROR;
    }
    return 0;
}

/* 读一字节，并在最后阶段发 ACK/NACK */
int ict_15318_read_byte(uint8_t *p, bool ack)
{
    uint8_t val = 0;
    ict_15318_sda_in();
    xyzn_os_busy_wait(ict_15318_SW_I2C_DELAY_US);

    for (int i = 7; i >= 0; i--)
    {
        ict_15318_scl_low();
        xyzn_os_busy_wait(ict_15318_SW_I2C_DELAY_US);

        ict_15318_scl_high();
        xyzn_os_busy_wait(ict_15318_SW_I2C_DELAY_US / 2);
        if (ict_15318_sda_read())
            val |= (1 << i);
        xyzn_os_busy_wait(ict_15318_SW_I2C_DELAY_US / 2);
    }

    /* 第 9 个时钟，主机 ACK/NACK */
    ict_15318_scl_low();
    ict_15318_sda_out();
    if (ack)
        ict_15318_sda_low();
    else
        ict_15318_sda_high();
    xyzn_os_busy_wait(ict_15318_SW_I2C_DELAY_US);

    ict_15318_scl_high();
    xyzn_os_busy_wait(ict_15318_SW_I2C_DELAY_US);

    ict_15318_scl_low();
    xyzn_os_busy_wait(ict_15318_SW_I2C_DELAY_US);
    ict_15318_sda_high();
    xyzn_os_busy_wait(ict_15318_SW_I2C_DELAY_US);

    *p = val;
    return 0;
}

/**
 * @brief   单字节写寄存器
 * @return  0: OK, <0: 错误
 */
int ict_15318_i2c_write_reg(uint8_t reg, uint8_t val)
{
    int ret;
    ict_15318_i2c_start();
    ret = ict_15318_write_byte((ICT_15318_I2C_ADDR << 1) | 0x00); /* 写模式 */
    if (ret)
        goto out;
    ret = ict_15318_write_byte(reg);
    if (ret)
        goto out;
    ret = ict_15318_write_byte(val);
out:
    ict_15318_i2c_stop();
    return ret;
}

/**
 * @brief   单字节读寄存器
 * @return  0: OK, <0: 错误
 */
int ict_15318_i2c_read_reg(uint8_t reg, uint8_t *pval)
{
    int ret;
    /* 1 发寄存器地址 */
    ict_15318_i2c_start();
    ret = ict_15318_write_byte((ICT_15318_I2C_ADDR << 1) | 0x00);
    if (ret)
        goto out;
    ret = ict_15318_write_byte(reg);
    if (ret)
        goto out;
    /* 2 Re-START + 读 */
    ict_15318_i2c_start();
    ret = ict_15318_write_byte((ICT_15318_I2C_ADDR << 1) | 0x01);
    if (ret)
        goto out;
    ret = ict_15318_read_byte(pval, false); /* 最后一个字节发 NACK */
out:
    BSP_LOGI(TAG, "ict_15318_i2c_read_reg reg:0x%02x, val:0x%02x, ret:%d", reg, *pval, ret);
    ict_15318_i2c_stop();
    return ret;
}

int ict_15318_read_id(void)
{
    uint8_t manu = 0xFF, chip = 0xFF;
    if (!ict_15318_i2c_read_reg(ICT_15318_REG_MANU_ID, &manu))
    {
        BSP_LOGI(TAG, "ict_15318_read_id manu failed");
        return XYZN_OS_ERROR;
    }
    if (!ict_15318_i2c_read_reg(ICT_15318_REG_CHIP_ID, &chip))
    {
        BSP_LOGI(TAG, "ict_15318_read_id chip failed");
        return XYZN_OS_ERROR;
    }
    if (manu == 0 || chip == 0 || manu == 0xFF || chip == 0xFF)
    {
        BSP_LOGE(TAG, "ict_15318 ID mismatch: manu=0x%02X chip=0x%02X", manu, chip);
        return XYZN_OS_ERROR;
    }
    BSP_LOGI(TAG, "ict_15318 detected:  manu[0XE7]=0x%02X chip[0X45]=0x%02X", manu, chip); // Manufacturer=0xE7, Chip=0x45
    return 0;
}
int bsp_ict_15318_iic_init(void)
{

    int err = 0;
    if (!gpio_is_ready_dt(&ict_15318_i2c_sda))
    {
        BSP_LOGE(TAG, "GPIO ict_15318_i2c_sda not ready");
        return XYZN_OS_ERROR;
    }
    if (!gpio_is_ready_dt(&ict_15318_i2c_scl))
    {
        BSP_LOGE(TAG, "GPIO ict_15318_i2c_scl not ready");
        return XYZN_OS_ERROR;
    }
    err = gpio_pin_configure_dt(&ict_15318_i2c_sda, GPIO_OUTPUT);
    if (err != 0)
    {
        BSP_LOGE(TAG, "ict_15318_i2c_sda config error: %d", err);
        return err;
    }
    err = gpio_pin_set_raw(ict_15318_i2c_sda.port, ict_15318_i2c_sda.pin, 1);
    if (err != 0)
    {
        BSP_LOGE(TAG, "ict_15318_i2c_sda set error: %d", err);
        return err;
    }
    err = gpio_pin_configure_dt(&ict_15318_i2c_scl, GPIO_OUTPUT);
    if (err != 0)
    {
        BSP_LOGE(TAG, "ict_15318_i2c_scl config error: %d", err);
        return err;
    }
    err = gpio_pin_set_raw(ict_15318_i2c_scl.port, ict_15318_i2c_scl.pin, 1);
    if (err != 0)
    {
        BSP_LOGE(TAG, "ict_15318_i2c_scl set error: %d", err);
        return err;
    }
    xyzn_os_delay_ms(10);

    err = ict_15318_read_id();
    if (err != 0)
    {
        BSP_LOGE(TAG, "ict_15318_read_id error: %d", err);
        return err;
    }
    BSP_LOGI(TAG, "bsp_ict_15318_iic_init OK");
    return err;
}

#else
struct device *i2c_dev_ict_15318; // I2C device

int bsp_ict_15318_iic_init(void)
{
    int rc;
    uint8_t manu = 0xFF, chip = 0xFF;
    i2c_dev_ict_15318 = device_get_binding(DT_NODE_FULL_NAME(DT_ALIAS(myimu3)));
    if (!i2c_dev_ict_15318)
    {
        BSP_LOGE(TAG, "I2C Device driver not found");
        return XYZN_OS_ERROR;
    }
    uint32_t i2c_cfg = I2C_SPEED_SET(I2C_SPEED_STANDARD) | I2C_MODE_CONTROLLER;
    if (i2c_configure(i2c_dev_ict_15318, i2c_cfg))
    {
        BSP_LOGE(TAG, "I2C config failed");
        return XYZN_OS_ERROR;
    }
    // rc = i2c_reg_read_byte(i2c_dev_ict_15318, ICT_15318_I2C_ADDR, ICT_15318_REG_MANU_ID, &manu);
    // if (rc != 0)
    // {
    //     BSP_LOGE(TAG, "Failed to read manu (%d)", rc);
    //     return rc;
    // }
    rc = i2c_reg_read_byte(i2c_dev_ict_15318, ICT_15318_I2C_ADDR, ICT_15318_REG_CHIP_ID, &chip);
    if (rc != 0)
    {
        BSP_LOGE(TAG, "Failed to read chip (%d)", rc);
        return rc;
    }
    BSP_LOGI(TAG, "ict_15318 ID: manu=0x%02X, chip=0x%02X", manu, chip); // Manufacturer=0xE7, Chip=0x45
    return rc;
}

#endif