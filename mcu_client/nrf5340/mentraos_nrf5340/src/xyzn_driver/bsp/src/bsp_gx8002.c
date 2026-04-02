/*
 * @Author       : XK
 * @Date         : 2025-07-08 19:02:15
 * @LastEditTime : 2025-07-14 14:51:12
 * @FilePath     : bsp_gx8002.c
 * @Description  :
 *
 * Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved.
 */
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/device.h>
#include <zephyr/drivers/i2c.h>
#include "task_interrupt.h"
#include "bal_os.h"
#include "bsp_gx8002.h"

#define TAG "BSP_GX8002"

#define GX8002_I2C_SOFT_MODE 1 // 0:硬件I2C 1:软件I2C

const struct gpio_dt_spec es_power_en = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), es_power_en_gpios); // 1.8v power
const struct gpio_dt_spec mic_pwr_en = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), mic_pwr_en_gpios);   // 0.9v power
// const struct gpio_dt_spec gx8002_int4 = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), gx8002_int4_gpios);
struct gpio_dt_spec gx8002_int4 = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), gx8002_int4_gpios);

static struct gpio_callback gx8002_int_cb_data;
int bsp_gx8002_interrupt_init(void); // 中断初始化

#if GX8002_I2C_SOFT_MODE
const struct gpio_dt_spec gx8002_i2c_sda = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), gx8002_sda_gpios);
const struct gpio_dt_spec gx8002_i2c_scl = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), gx8002_scl_gpios);

#define GX8002_SW_I2C_DELAY_US 6    /* 根据总线速率微调 */
#define GX8002_SW_I2C_TIMEOUT 1000U /* ACK 等待最大循环 */

/* --- GPIO 配置 & 操作 --- */
static int gx8002_sda_out(void)
{
    return gpio_pin_configure_dt(&gx8002_i2c_sda, GPIO_OUTPUT);
}
static int gx8002_sda_in(void)
{
    return gpio_pin_configure_dt(&gx8002_i2c_sda, GPIO_INPUT | GPIO_PULL_UP);
}
static int gx8002_scl_out(void)
{
    return gpio_pin_configure_dt(&gx8002_i2c_scl, GPIO_OUTPUT);
}
static int gx8002_scl_in(void)
{
    return gpio_pin_configure_dt(&gx8002_i2c_scl, GPIO_INPUT | GPIO_PULL_UP);
}
static void gx8002_sda_high(void)
{
    gpio_pin_set_raw(gx8002_i2c_sda.port, gx8002_i2c_sda.pin, 1);
}
static void gx8002_sda_low(void)
{
    gpio_pin_set_raw(gx8002_i2c_sda.port, gx8002_i2c_sda.pin, 0);
}
static void gx8002_scl_high(void)
{
    gpio_pin_set_raw(gx8002_i2c_scl.port, gx8002_i2c_scl.pin, 1);
}
static void gx8002_scl_low(void)
{
    gpio_pin_set_raw(gx8002_i2c_scl.port, gx8002_i2c_scl.pin, 0);
}
static int gx8002_sda_read(void)
{
    return gpio_pin_get_raw(gx8002_i2c_sda.port, gx8002_i2c_sda.pin);
}

void gx8002_i2c_start(void)
{
    gx8002_sda_high();
    gx8002_scl_high();
    xyzn_os_busy_wait(GX8002_SW_I2C_DELAY_US);
    gx8002_sda_low();
    xyzn_os_busy_wait(GX8002_SW_I2C_DELAY_US);
    gx8002_scl_low();
    xyzn_os_busy_wait(GX8002_SW_I2C_DELAY_US);
}

void gx8002_i2c_stop(void)
{
    gx8002_sda_low();
    xyzn_os_busy_wait(GX8002_SW_I2C_DELAY_US);
    gx8002_scl_high();
    xyzn_os_busy_wait(GX8002_SW_I2C_DELAY_US);
    gx8002_sda_high();
    xyzn_os_busy_wait(GX8002_SW_I2C_DELAY_US);
}

/* 发送一字节并等待 ACK */
int gx8002_write_byte(uint8_t b)
{
    gx8002_sda_out();
    xyzn_os_busy_wait(GX8002_SW_I2C_DELAY_US);
    /* 发送 8 bit */
    for (int i = 7; i >= 0; i--)
    {
        gx8002_scl_low();
        if (b & (1 << i))
            gx8002_sda_high();
        else
            gx8002_sda_low();
        xyzn_os_busy_wait(GX8002_SW_I2C_DELAY_US);

        gx8002_scl_high();
        xyzn_os_busy_wait(GX8002_SW_I2C_DELAY_US);
    }

    /* 第 9 个时钟，用于 ACK */
    gx8002_scl_low();
    gx8002_sda_in(); /* 切输入，等从机拉 ACK */
    xyzn_os_busy_wait(GX8002_SW_I2C_DELAY_US);

    gx8002_scl_high();
    xyzn_os_busy_wait(GX8002_SW_I2C_DELAY_US / 2);

    uint32_t t = 0;
    while (gx8002_sda_read() && t++ < GX8002_SW_I2C_TIMEOUT)
    {
        xyzn_os_busy_wait(1);
    }

    xyzn_os_busy_wait(GX8002_SW_I2C_DELAY_US / 2);
    gx8002_scl_low();
    gx8002_sda_out();

    if (t >= GX8002_SW_I2C_TIMEOUT)
    {
        BSP_LOGE(TAG, "I2C ACK timeout");
        return XYZN_OS_ERROR;
    }
    return 0;
}

/* 读一字节，并在最后阶段发 ACK/NACK */
int gx8002_read_byte(uint8_t *p, bool ack)
{
    uint8_t val = 0;
    gx8002_sda_in();
    xyzn_os_busy_wait(GX8002_SW_I2C_DELAY_US);

    for (int i = 7; i >= 0; i--)
    {
        gx8002_scl_low();
        xyzn_os_busy_wait(GX8002_SW_I2C_DELAY_US);

        gx8002_scl_high();
        xyzn_os_busy_wait(GX8002_SW_I2C_DELAY_US / 2);
        if (gx8002_sda_read())
            val |= (1 << i);
        xyzn_os_busy_wait(GX8002_SW_I2C_DELAY_US / 2);
    }

    /* 第 9 个时钟，主机 ACK/NACK */
    gx8002_scl_low();
    gx8002_sda_out();
    if (ack)
        gx8002_sda_low();
    else
        gx8002_sda_high();
    xyzn_os_busy_wait(GX8002_SW_I2C_DELAY_US);

    gx8002_scl_high();
    xyzn_os_busy_wait(GX8002_SW_I2C_DELAY_US);

    gx8002_scl_low();
    xyzn_os_busy_wait(GX8002_SW_I2C_DELAY_US);
    gx8002_sda_high();
    xyzn_os_busy_wait(GX8002_SW_I2C_DELAY_US);

    *p = val;
    return 0;
}

/**
 * @brief   单字节写寄存器
 * @return  0: OK, <0: 错误
 */
int gx8002_i2c_write_reg(uint8_t reg, uint8_t val)
{
    int ret;
    gx8002_i2c_start();
    ret = gx8002_write_byte((GX8002_I2C_ADDR << 1) | 0x00); /* 写模式 */
    if (ret)
        goto out;
    ret = gx8002_write_byte(reg);
    if (ret)
        goto out;
    ret = gx8002_write_byte(val);
out:
    gx8002_i2c_stop();
    return ret;
}

/**
 * @brief   单字节读寄存器
 * @return  0: OK, <0: 错误
 */
int gx8002_i2c_read_reg(uint8_t reg, uint8_t *pval)
{
    int ret;
    /* 1 发寄存器地址 */
    gx8002_i2c_start();
    ret = gx8002_write_byte((GX8002_I2C_ADDR << 1) | 0x00);
    if (ret)
        goto out;
    ret = gx8002_write_byte(reg);
    if (ret)
        goto out;
    /* 2 Re-START + 读 */
    gx8002_i2c_start();
    ret = gx8002_write_byte((GX8002_I2C_ADDR << 1) | 0x01);
    if (ret)
        goto out;
    ret = gx8002_read_byte(pval, false); /* 最后一个字节发 NACK */
out:
    gx8002_i2c_stop();
    return ret;
}
int gx8002_get_version(void)
{
    uint8_t version[4] = {0};
    uint8_t reg = 0xA0;

    /* 1 发送版本查询命令 */
    gx8002_i2c_write_reg(0xC4, 0x68);

    /* 等待处理 */
    xyzn_os_delay_ms(200);

    /* 2 依次读取 4 字节版本号 */
    for (int i = 0; i < 4; i++)
    {
        gx8002_i2c_start();
        gx8002_write_byte((GX8002_I2C_ADDR << 1) | 0);
        gx8002_write_byte(reg);
        gx8002_i2c_stop();
        // xyzn_os_delay_ms(1);

        gx8002_i2c_start();
        gx8002_write_byte((GX8002_I2C_ADDR << 1) | 1);
        gx8002_read_byte(&version[i], false);
        gx8002_i2c_stop();
        // xyzn_os_delay_ms(1);
        reg += 4;
    }
    if ((version[0] == 0x00) && (version[1] == 0x00) &&
        (version[2] == 0x00)) //&& (version[3] == 0x02))
    {
        /* 3 输出版本信息 */
        BSP_LOGI(TAG, "GX8002 Version: %02X.%02X.%02X.%02X", version[0], version[1], version[2], version[3]);
        return 0;
    }
    BSP_LOGE(TAG, "GX8002 Version read error!!!");
    BSP_LOGI(TAG, "GX8002 Version: %02X.%02X.%02X.%02X", version[0], version[1], version[2], version[3]);
    return XYZN_OS_ERROR;
}
int bsp_gx8002_init(void)
{
    BSP_LOGI(TAG, "bsp_gx8002_init");
    int err = 0;
    if (!gpio_is_ready_dt(&gx8002_i2c_sda))
    {
        BSP_LOGE(TAG, "GPIO gx8002_i2c_sda not ready");
        return XYZN_OS_ERROR;
    }
    if (!gpio_is_ready_dt(&gx8002_i2c_scl))
    {
        BSP_LOGE(TAG, "GPIO gx8002_i2c_scl not ready");
        return XYZN_OS_ERROR;
    }
    if (!gpio_is_ready_dt(&es_power_en))
    {
        BSP_LOGE(TAG, "GPIO es_power_en not ready");
        return XYZN_OS_ERROR;
    }
    if (!gpio_is_ready_dt(&mic_pwr_en))
    {
        BSP_LOGE(TAG, "GPIO mic_pwr_en not ready");
        return XYZN_OS_ERROR;
    }
    err = gpio_pin_configure_dt(&es_power_en, GPIO_OUTPUT_HIGH | GPIO_PULL_UP);
    if (err != 0)
    {
        BSP_LOGE(TAG, "es_power_en config error: %d", err);
        return err;
    }
    xyzn_os_delay_ms(10);
    err = gpio_pin_configure_dt(&mic_pwr_en, GPIO_OUTPUT_HIGH | GPIO_PULL_UP);
    if (err != 0)
    {
        BSP_LOGE(TAG, "mic_pwr_en config error: %d", err);
        return err;
    }
    xyzn_os_delay_ms(2000);
    err = gpio_pin_configure_dt(&gx8002_i2c_sda, GPIO_OUTPUT);
    if (err != 0)
    {
        BSP_LOGE(TAG, "gx8002_i2c_sda config error: %d", err);
        return err;
    }
    err = gpio_pin_set_raw(gx8002_i2c_sda.port, gx8002_i2c_sda.pin, 1);
    if (err != 0)
    {
        BSP_LOGE(TAG, "gx8002_i2c_sda set error: %d", err);
        return err;
    }
    err = gpio_pin_configure_dt(&gx8002_i2c_scl, GPIO_OUTPUT);
    if (err != 0)
    {
        BSP_LOGE(TAG, "gx8002_i2c_scl config error: %d", err);
        return err;
    }
    err = gpio_pin_set_raw(gx8002_i2c_scl.port, gx8002_i2c_scl.pin, 1);
    if (err != 0)
    {
        BSP_LOGE(TAG, "gx8002_i2c_scl set error: %d", err);
        return err;
    }
    xyzn_os_delay_ms(10);
    err = bsp_gx8002_interrupt_init(); // 中断初始化
    if (err != 0)
    {
        BSP_LOGE(TAG, "bsp_gx8002_interrupt_init error: %d", err);
        return err;
    }
    err = gx8002_get_version();
    if (err != 0)
    {
        BSP_LOGE(TAG, "gx8002_get_version error: %d", err);
        return err;
    }
    return err;
}
#else
struct device *i2c_dev_gx8002; // I2C device

void gx8002_get_version(void)
{
    uint8_t version[4] = {0};
    uint8_t reg = 0xA0;
    uint8_t write_version[2] = {0xC4, 0x68};

    int rc = i2c_write(i2c_dev_gx8002, write_version, sizeof(write_version), GX8002_I2C_ADDR);
    if (rc)
    {
        BSP_LOGE(TAG, "I2C write reg 0x%02X failed: %d", GX8002_I2C_ADDR, rc);
    }
    /* 等待处理 */
    xyzn_os_delay_ms(200);

    /* 2) 依次读取 4 字节版本号 */
    for (int i = 0; i < 4; i++)
    {
        int rc = i2c_write(i2c_dev_gx8002, &reg, 1, GX8002_I2C_ADDR);
        if (rc)
        {
            BSP_LOGE(TAG, "I2C write reg 0x%02X failed: %d", reg, rc);
        }
        rc = i2c_read(i2c_dev_gx8002, &version[i], 1, GX8002_I2C_ADDR);
        if (rc)
        {
            BSP_LOGE(TAG, "I2C read reg 0x%02X failed: %d", GX8002_I2C_ADDR, rc);
        }
        reg += 4;
    }

    /* 3) 输出版本信息 */
    BSP_LOGI(TAG, "GX8002 Version: %02X.%02X.%02X.%02X", version[0], version[1], version[2], version[3]);
}
int bsp_gx8002_init(void)
{
    BSP_LOGI(TAG, "bsp_gx8002_init");
    int rc;
    if (!gpio_is_ready_dt(&es_power_en))
    {
        BSP_LOGE(TAG, "GPIO es_power_en not ready");
        return XYZN_OS_ERROR;
    }
    if (!gpio_is_ready_dt(&mic_pwr_en))
    {
        BSP_LOGE(TAG, "GPIO mic_pwr_en not ready");
        return XYZN_OS_ERROR;
    }
    rc = gpio_pin_configure_dt(&es_power_en, GPIO_OUTPUT);
    if (rc != 0)
    {
        BSP_LOGE(TAG, "es_power_en config error: %d", rc);
        return rc;
    }
    rc = gpio_pin_set_raw(es_power_en.port, es_power_en.pin, 1);
    if (rc != 0)
    {
        BSP_LOGE(TAG, "es_power_en set error: %d", rc);
        return rc;
    }
    xyzn_os_delay_ms(10);
    rc = gpio_pin_configure_dt(&mic_pwr_en, GPIO_OUTPUT);
    if (rc != 0)
    {
        BSP_LOGE(TAG, "mic_pwr_en config error: %d", rc);
        return rc;
    }
    rc = gpio_pin_set_raw(mic_pwr_en.port, mic_pwr_en.pin, 1);
    if (rc != 0)
    {
        BSP_LOGE(TAG, "mic_pwr_en set error: %d", rc);
        return rc;
    }
    xyzn_os_delay_ms(1000);
    i2c_dev_gx8002 = device_get_binding(DT_NODE_FULL_NAME(DT_ALIAS(myvda)));
    if (!i2c_dev_gx8002)
    {
        BSP_LOGE(TAG, "I2C Device driver not found");
        return XYZN_OS_ERROR;
    }
    uint32_t i2c_cfg = I2C_SPEED_SET(I2C_SPEED_STANDARD) | I2C_MODE_CONTROLLER;
    if (i2c_configure(i2c_dev_gx8002, i2c_cfg))
    {
        BSP_LOGE(TAG, "I2C config failed");
        return XYZN_OS_ERROR;
    }
    xyzn_os_delay_ms(50);
    gx8002_get_version();

    return rc;
}

#endif

void gx8002_int_isr_enable(void)
{
    int ret;
    ret = gpio_pin_interrupt_configure_dt(&gx8002_int4, GPIO_INT_EDGE_FALLING); // 下边缘触发
    if (ret != 0)
    {
        BSP_LOGE(TAG, "Error %d: failed to configure interrupt on pin %d",
                 ret, gx8002_int4.pin);
        return XYZN_OS_ERROR;
    }
}
int bsp_gx8002_interrupt_init(void)
{
    int ret;
    ret = gpio_pin_configure_dt(&gx8002_int4, (GPIO_INPUT | GPIO_PULL_UP));
    if (ret != 0)
    {
        BSP_LOGE(TAG, "Error %d: failed to configure pin %d",
                 ret, gx8002_int4.pin);
        return XYZN_OS_ERROR;
    }
    ret = gpio_pin_interrupt_configure_dt(&gx8002_int4, GPIO_INT_EDGE_FALLING); // 下边缘触发
    if (ret != 0)
    {
        BSP_LOGE(TAG, "Error %d: failed to configure interrupt on pin %d",
                 ret, gx8002_int4.pin);
        return XYZN_OS_ERROR;
    }
    gpio_init_callback(&gx8002_int_cb_data, gx8002_int_isr, BIT(gx8002_int4.pin));
    ret = gpio_add_callback(gx8002_int4.port, &gx8002_int_cb_data);
    if (ret != 0)
    {
        BSP_LOGE(TAG, "Error %d: failed to add callback", ret);
        return XYZN_OS_ERROR;
    }
    BSP_LOGI(TAG, "GX8002 interrupt initialized on pin %d", gx8002_int4.pin);
    return 0;
}