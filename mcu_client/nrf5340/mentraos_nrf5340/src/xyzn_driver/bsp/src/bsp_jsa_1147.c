/*
 * @Author       : XK
 * @Date         : 2025-07-14 15:12:28
 * @LastEditTime : 2025-07-14 16:22:13
 * @FilePath     : bsp_jsa_1147.c
 * @Description  :
 *
 * Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved.
 */

#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/device.h>
#include "bal_os.h"
#include "bsp_log.h"
#include "task_interrupt.h"
#include "bsp_jsa_1147.h"


#define TAG "BSP_JSA_1147"

#define JSA_1147_I2C_SOFT_MODE 1 // 0:硬件I2C 1:软件I2C

struct gpio_dt_spec jsa_1147_int1 = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), jsa_1147_int1_gpios);

static struct gpio_callback jsa_1147_int1_cb_data;
int bsp_jsa_1147_interrupt_init(void); // 中断初始化

#if JSA_1147_I2C_SOFT_MODE

const struct gpio_dt_spec jsa_1147_i2c_sda = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), jsa_1147_sda_gpios);
const struct gpio_dt_spec jsa_1147_i2c_scl = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), jsa_1147_scl_gpios);

#define JSA_1147_SW_I2C_DELAY_US 6    /* 根据总线速率微调 */
#define JSA_1147_SW_I2C_TIMEOUT 1000U /* ACK 等待最大循环 */

/* --- GPIO 配置 & 操作 --- */
static int jsa_1147_sda_out(void)
{
    return gpio_pin_configure_dt(&jsa_1147_i2c_sda, GPIO_OUTPUT);
}
static int jsa_1147_sda_in(void)
{
    return gpio_pin_configure_dt(&jsa_1147_i2c_sda, GPIO_INPUT | GPIO_PULL_UP);
}
static int jsa_1147_scl_out(void)
{
    return gpio_pin_configure_dt(&jsa_1147_i2c_scl, GPIO_OUTPUT);
}
static int jsa_1147_scl_in(void)
{
    return gpio_pin_configure_dt(&jsa_1147_i2c_scl, GPIO_INPUT | GPIO_PULL_UP);
}
static void jsa_1147_sda_high(void)
{
    gpio_pin_set_raw(jsa_1147_i2c_sda.port, jsa_1147_i2c_sda.pin, 1);
}
static void jsa_1147_sda_low(void)
{
    gpio_pin_set_raw(jsa_1147_i2c_sda.port, jsa_1147_i2c_sda.pin, 0);
}
static void jsa_1147_scl_high(void)
{
    gpio_pin_set_raw(jsa_1147_i2c_scl.port, jsa_1147_i2c_scl.pin, 1);
}
static void jsa_1147_scl_low(void)
{
    gpio_pin_set_raw(jsa_1147_i2c_scl.port, jsa_1147_i2c_scl.pin, 0);
}
static int jsa_1147_sda_read(void)
{
    return gpio_pin_get_raw(jsa_1147_i2c_sda.port, jsa_1147_i2c_sda.pin);
}

void jsa_1147_i2c_start(void)
{
    jsa_1147_sda_high();
    jsa_1147_scl_high();
    xyzn_os_busy_wait(JSA_1147_SW_I2C_DELAY_US);
    jsa_1147_sda_low();
    xyzn_os_busy_wait(JSA_1147_SW_I2C_DELAY_US);
    jsa_1147_scl_low();
    xyzn_os_busy_wait(JSA_1147_SW_I2C_DELAY_US);
}

void jsa_1147_i2c_stop(void)
{
    jsa_1147_sda_low();
    xyzn_os_busy_wait(JSA_1147_SW_I2C_DELAY_US);
    jsa_1147_scl_high();
    xyzn_os_busy_wait(JSA_1147_SW_I2C_DELAY_US);
    jsa_1147_sda_high();
    xyzn_os_busy_wait(JSA_1147_SW_I2C_DELAY_US);
}

/* 发送一字节并等待 ACK */
int jsa_1147_write_byte(uint8_t b)
{
    jsa_1147_sda_out();
    xyzn_os_busy_wait(JSA_1147_SW_I2C_DELAY_US);
    /* 发送 8 bit */
    for (int i = 7; i >= 0; i--)
    {
        jsa_1147_scl_low();
        if (b & (1 << i))
            jsa_1147_sda_high();
        else
            jsa_1147_sda_low();
        xyzn_os_busy_wait(JSA_1147_SW_I2C_DELAY_US);

        jsa_1147_scl_high();
        xyzn_os_busy_wait(JSA_1147_SW_I2C_DELAY_US);
    }

    /* 第 9 个时钟，用于 ACK */
    jsa_1147_scl_low();
    jsa_1147_sda_in(); /* 切输入，等从机拉 ACK */
    xyzn_os_busy_wait(JSA_1147_SW_I2C_DELAY_US);

    jsa_1147_scl_high();
    xyzn_os_busy_wait(JSA_1147_SW_I2C_DELAY_US / 2);

    uint32_t t = 0;
    while (jsa_1147_sda_read() && t++ < JSA_1147_SW_I2C_TIMEOUT)
    {
        xyzn_os_busy_wait(1);
    }

    xyzn_os_busy_wait(JSA_1147_SW_I2C_DELAY_US / 2);
    jsa_1147_scl_low();
    jsa_1147_sda_out();

    if (t >= JSA_1147_SW_I2C_TIMEOUT)
    {
        BSP_LOGE(TAG, "I2C ACK timeout");
        return XYZN_OS_ERROR;
    }
    return 0;
}

/* 读一字节，并在最后阶段发 ACK/NACK */
int jsa_1147_read_byte(uint8_t *p, bool ack)
{
    uint8_t val = 0;
    jsa_1147_sda_in();
    xyzn_os_busy_wait(JSA_1147_SW_I2C_DELAY_US);

    for (int i = 7; i >= 0; i--)
    {
        jsa_1147_scl_low();
        xyzn_os_busy_wait(JSA_1147_SW_I2C_DELAY_US);

        jsa_1147_scl_high();
        xyzn_os_busy_wait(JSA_1147_SW_I2C_DELAY_US / 2);
        if (jsa_1147_sda_read())
            val |= (1 << i);
        xyzn_os_busy_wait(JSA_1147_SW_I2C_DELAY_US / 2);
    }

    /* 第 9 个时钟，主机 ACK/NACK */
    jsa_1147_scl_low();
    jsa_1147_sda_out();
    if (ack)
        jsa_1147_sda_low();
    else
        jsa_1147_sda_high();
    xyzn_os_busy_wait(JSA_1147_SW_I2C_DELAY_US);

    jsa_1147_scl_high();
    xyzn_os_busy_wait(JSA_1147_SW_I2C_DELAY_US);

    jsa_1147_scl_low();
    xyzn_os_busy_wait(JSA_1147_SW_I2C_DELAY_US);
    jsa_1147_sda_high();
    xyzn_os_busy_wait(JSA_1147_SW_I2C_DELAY_US);

    *p = val;
    return 0;
}

/**
 * @brief   单字节写寄存器
 * @return  0: OK, <0: 错误
 */
int jsa_1147_i2c_write_reg(uint8_t reg, uint8_t val)
{
    int ret;
    jsa_1147_i2c_start();
    ret = jsa_1147_write_byte((JSA_1147_I2C_ADDR << 1) | 0x00); /* 写模式 */
    if (ret)
        goto out;
    ret = jsa_1147_write_byte(reg);
    if (ret)
        goto out;
    ret = jsa_1147_write_byte(val);
out:
    jsa_1147_i2c_stop();
    return ret;
}

/**
 * @brief   单字节读寄存器
 * @return  0: OK, <0: 错误
 */
int jsa_1147_i2c_read_reg(uint8_t reg, uint8_t *pval)
{
    int ret;
    /* 1) 发寄存器地址 */
    jsa_1147_i2c_start();
    ret = jsa_1147_write_byte((JSA_1147_I2C_ADDR << 1) | 0x00);
    if (ret)
        goto out;
    ret = jsa_1147_write_byte(reg);
    if (ret)
        goto out;
    /* 2) Re-START + 读 */
    jsa_1147_i2c_start();
    ret = jsa_1147_write_byte((JSA_1147_I2C_ADDR << 1) | 0x01);
    if (ret)
        goto out;
    ret = jsa_1147_read_byte(pval, false); /* 最后一个字节发 NACK */
out:
    jsa_1147_i2c_stop();
    return ret;
}
int jsa_1147_get_manufacturer_id(void)
{
    uint8_t manuf_id;

    int err = jsa_1147_i2c_read_reg(REG_PRODUCT_LSB_ID, &manuf_id);
    if ((err < 0) || (manuf_id != 0x11))
    {
        BSP_LOGE(TAG, "Failed to read manufacturer ID: %d", err);
        return XYZN_OS_ERROR;
    }
    else
    {
        BSP_LOGI(TAG, "Manufacturer ID: 0x%02X", manuf_id);
    }

    err = jsa_1147_i2c_read_reg(REG_PRODUCT_MSB_ID, &manuf_id);
    if ((err < 0) || (manuf_id != 0x11))
    {
        BSP_LOGE(TAG, "Failed to read manufacturer ID: %d", err);
        return XYZN_OS_ERROR;
    }
    else
    {
        BSP_LOGI(TAG, "Manufacturer ID: 0x%02X", manuf_id);
    }
    return 0;
}
int bsp_jsa_1147_init(void)
{
    BSP_LOGI(TAG, "bsp_jsa_1147_init");
    int err = 0;
    if (!gpio_is_ready_dt(&jsa_1147_i2c_sda))
    {
        BSP_LOGE(TAG, "GPIO jsa_1147_i2c_sda not ready");
        return XYZN_OS_ERROR;
    }
    if (!gpio_is_ready_dt(&jsa_1147_i2c_scl))
    {
        BSP_LOGE(TAG, "GPIO jsa_1147_i2c_scl not ready");
        return XYZN_OS_ERROR;
    }
    err = gpio_pin_configure_dt(&jsa_1147_i2c_sda, GPIO_OUTPUT);
    if (err != 0)
    {
        BSP_LOGE(TAG, "jsa_1147_i2c_sda config error: %d", err);
        return err;
    }
    err = gpio_pin_set_raw(jsa_1147_i2c_sda.port, jsa_1147_i2c_sda.pin, 1);
    if (err != 0)
    {
        BSP_LOGE(TAG, "jsa_1147_i2c_sda set error: %d", err);
        return err;
    }
    err = gpio_pin_configure_dt(&jsa_1147_i2c_scl, GPIO_OUTPUT);
    if (err != 0)
    {
        BSP_LOGE(TAG, "jsa_1147_i2c_scl config error: %d", err);
        return err;
    }
    err = gpio_pin_set_raw(jsa_1147_i2c_scl.port, jsa_1147_i2c_scl.pin, 1);
    if (err != 0)
    {
        BSP_LOGE(TAG, "jsa_1147_i2c_scl set error: %d", err);
        return err;
    }
    // xyzn_os_delay_ms(10);
    err = bsp_jsa_1147_interrupt_init(); // 中断初始化
    if (err != 0)
    {
        BSP_LOGE(TAG, "bsp_jsa_1147_interrupt_init error: %d", err);
        return err;
    }
    err = jsa_1147_get_manufacturer_id();
    if (err != 0)
    {
        BSP_LOGE(TAG, "jsa_1147_get_version error: %d", err);
        return err;
    }
    return err;
}
#else
struct device *i2c_dev_jsa_1147; // I2C device

void jsa_1147_get_version(void)
{
    // uint8_t version[4] = {0};
    // uint8_t reg = 0xA0;
    // uint8_t write_version[2] = {0xC4, 0x68};

    // int rc = i2c_write(i2c_dev_jsa_1147, write_version, sizeof(write_version), jsa_1147_I2C_ADDR);
    // if (rc)
    // {
    //     BSP_LOGE(TAG, "I2C write reg 0x%02X failed: %d", JSA_1147_I2C_ADDR, rc);
    // }
    // /* 等待处理 */
    // xyzn_os_delay_ms(200);

    // /* 2) 依次读取 4 字节版本号 */
    // for (int i = 0; i < 4; i++)
    // {
    //     int rc = i2c_write(i2c_dev_jsa_1147, &reg, 1, jsa_1147_I2C_ADDR);
    //     if (rc)
    //     {
    //         BSP_LOGE(TAG, "I2C write reg 0x%02X failed: %d", reg, rc);
    //     }
    //     rc = i2c_read(i2c_dev_jsa_1147, &version[i], 1, JSA_1147_I2C_ADDR);
    //     if (rc)
    //     {
    //         BSP_LOGE(TAG, "I2C read reg 0x%02X failed: %d", jsa_1147_I2C_ADDR, rc);
    //     }
    //     reg += 4;
    // }

    // /* 3) 输出版本信息 */
    // BSP_LOGI(TAG, "JSA_1147 Version: %02X.%02X.%02X.%02X", version[0], version[1], version[2], version[3]);
}
int bsp_jsa_1147_sensor_init(void)
{
    // BSP_LOGI(TAG, "bsp_jsa_1147_sensor_init");
    // int rc;
    // xyzn_os_delay_ms(1000);
    // i2c_dev_jsa_1147 = device_get_binding(DT_NODE_FULL_NAME(DT_ALIAS(myvda)));
    // if (!i2c_dev_jsa_1147)
    // {
    //     BSP_LOGE(TAG, "I2C Device driver not found");
    //     return XYZN_OS_ERROR;
    // }
    // uint32_t i2c_cfg = I2C_SPEED_SET(I2C_SPEED_STANDARD) | I2C_MODE_CONTROLLER;
    // if (i2c_configure(i2c_dev_jsa_1147, i2c_cfg))
    // {
    //     BSP_LOGE(TAG, "I2C config failed");
    //     return XYZN_OS_ERROR;
    // }
    // xyzn_os_delay_ms(50);
    // jsa_1147_get_version();

    return rc;
}

#endif

void jsa_1147_int1_isr_enable(void)
{
    int ret;
    ret = gpio_pin_interrupt_configure_dt(&jsa_1147_int1, GPIO_INT_EDGE_FALLING); // 下边缘触发
    if (ret != 0)
    {
        BSP_LOGE(TAG, "Error %d: failed to configure interrupt on pin %d",
                 ret, jsa_1147_int1.pin);
    }
}
int bsp_jsa_1147_interrupt_init(void)
{
    int ret;
    ret = gpio_pin_configure_dt(&jsa_1147_int1, (GPIO_INPUT | GPIO_PULL_UP));
    if (ret != 0)
    {
        BSP_LOGE(TAG, "Error %d: failed to configure pin %d", ret, jsa_1147_int1.pin);
    }
    ret = gpio_pin_interrupt_configure_dt(&jsa_1147_int1, GPIO_INT_EDGE_FALLING); // 下边缘触发
    if (ret != 0)
    {
        BSP_LOGE(TAG, "Error %d: failed to configure interrupt on pin %d", ret, jsa_1147_int1.pin);
    }
    gpio_init_callback(&jsa_1147_int1_cb_data, jsa_1147_int_isr, BIT(jsa_1147_int1.pin));
    ret = gpio_add_callback(jsa_1147_int1.port, &jsa_1147_int1_cb_data);
    if (ret != 0)
    {
        BSP_LOGE(TAG, "Error %d: failed to add callback", ret);
    }
    BSP_LOGI(TAG, "JSA_1147 interrupt initialized on pin %d", jsa_1147_int1.pin);
    return 0;
}