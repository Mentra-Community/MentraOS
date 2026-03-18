/*
 * @Author       : XK
 * @Date         : 2025-07-15 10:03:08
 * @LastEditTime : 2025-07-15 10:03:11
 * @FilePath     : bsp_key.c
 * @Description  :
 *
 * Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved.
 */

#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/device.h>
#include "task_interrupt.h"
#include "bal_os.h"

#include "bsp_key.h"

#define TAG "BSP_KEY"

// const struct gpio_dt_spec gpio_key1 = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), key1_gpios);
struct gpio_dt_spec gpio_key1 = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), key1_gpios);
static struct gpio_callback gpio_key1_int_cb_data; // 中断回调函数

bool gpio_key1_read(void)
{
    int value = gpio_pin_get_raw(gpio_key1.port, gpio_key1.pin);
    return value == 0 ? true : false; 
}

void gpio_key1_int_isr_enable(void)
{
    int ret;
    ret = gpio_pin_interrupt_configure_dt(&gpio_key1, GPIO_INT_EDGE_BOTH);
    if (ret != 0)
    {
        BSP_LOGE(TAG, "Error %d: failed to configure interrupt on pin %d",
                 ret, gpio_key1.pin);
        return XYZN_OS_ERROR;
    }
}
int bsp_key_init(void)
{
    BSP_LOGI(TAG, "BSP Key Init");
    int ret;
    if (!gpio_is_ready_dt(&gpio_key1))
    {
        BSP_LOGE(TAG, "GPIO gpio_key1 not ready");
        return XYZN_OS_ERROR;
    }

    ret = gpio_pin_configure_dt(&gpio_key1, (GPIO_INPUT | GPIO_PULL_UP));
    if (ret != 0)
    {
        BSP_LOGE(TAG, "Error %d: failed to configure pin %d",
                 ret, gpio_key1.pin);
        return XYZN_OS_ERROR;
    }

    ret = gpio_pin_interrupt_configure_dt(&gpio_key1, GPIO_INT_EDGE_BOTH);
    if (ret != 0)
    {
        BSP_LOGE(TAG, "Error %d: failed to configure interrupt on pin %d",
                 ret, gpio_key1.pin);
        return XYZN_OS_ERROR;
    }
    gpio_init_callback(&gpio_key1_int_cb_data, gpio_key1_int_isr, BIT(gpio_key1.pin));
    ret = gpio_add_callback(gpio_key1.port, &gpio_key1_int_cb_data);
    if (ret != 0)
    {
        BSP_LOGE(TAG, "Error %d: failed to add callback", ret);
        return XYZN_OS_ERROR;
    }
    BSP_LOGI(TAG, "gpio_key1 interrupt initialized on pin %d", gpio_key1.pin);
    return 0;
}