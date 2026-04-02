/*
 * @Author       : Cole
 * @Date         : 2025-07-31 10:40:40
 * @LastEditTime : 2025-08-19 20:38:42
 * @FilePath     : bsp_key.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2025
 *  SPDX-License-Identifier: Apache-2.0
 */



#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include "bsp_key.h"
#include "bal_os.h"
#include "task_interrupt.h"
#include <zephyr/logging/log.h>

#define LOG_MODULE_NAME BSP_KEY
LOG_MODULE_REGISTER(LOG_MODULE_NAME);


// const struct gpio_dt_spec gpio_key1 = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), key1_gpios);
struct gpio_dt_spec         gpio_key1 = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), key1_gpios);
static struct gpio_callback gpio_key1_int_cb_data;  // GPIO回调数据; GPIO callback data

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
        LOG_ERR("Error %d: failed to configure interrupt on pin %d", ret, gpio_key1.pin);
        return MOS_OS_ERROR;
    }
}

int bsp_key_init(void)
{
    LOG_INF("BSP Key Init");
    int ret;
    if (!gpio_is_ready_dt(&gpio_key1))
    {
        LOG_ERR("GPIO gpio_key1 not ready");
        return MOS_OS_ERROR;
    }

    ret = gpio_pin_configure_dt(&gpio_key1, (GPIO_INPUT | GPIO_PULL_UP));
    if (ret != 0)
    {
        LOG_ERR("Error %d: failed to configure pin %d", ret, gpio_key1.pin);
        return MOS_OS_ERROR;
    }

    ret = gpio_pin_interrupt_configure_dt(&gpio_key1, GPIO_INT_EDGE_BOTH);
    if (ret != 0)
    {
        LOG_ERR("Error %d: failed to configure interrupt on pin %d", ret, gpio_key1.pin);
        return MOS_OS_ERROR;
    }
    gpio_init_callback(&gpio_key1_int_cb_data, gpio_key1_int_isr, BIT(gpio_key1.pin));
    ret = gpio_add_callback(gpio_key1.port, &gpio_key1_int_cb_data);
    if (ret != 0)
    {
        LOG_ERR("Error %d: failed to add callback", ret);
        return MOS_OS_ERROR;
    }
    LOG_INF("gpio_key1 interrupt initialized on pin %d", gpio_key1.pin);
    return 0;
}