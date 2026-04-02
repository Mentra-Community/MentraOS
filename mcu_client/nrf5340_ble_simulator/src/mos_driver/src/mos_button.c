/*
 * @Author       : Cole
 * @Date         : 2026-01-24 11:14:00
 * @LastEditTime : 2026-01-28 19:01:48
 * @FilePath     : mos_button.c
 * @Description  : 
 * 
 *  Copyright (c) MentraOS Contributors 2026 
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "mos_button.h"

#include <zephyr/device.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/devicetree.h>
#include <zephyr/logging/log.h>
#include <zephyr/kernel.h>
#include <hal/nrf_gpio.h>
#include "interrupt_handler.h"

LOG_MODULE_REGISTER(mos_button, LOG_LEVEL_INF);

/* Device tree node for button GPIO | 按键GPIO的设备树节点 */
#define BUTTON_NODE DT_PATH(zephyr_user)

#if !DT_NODE_EXISTS(BUTTON_NODE) || !DT_NODE_HAS_PROP(BUTTON_NODE, button_gpios)
#error "Button GPIO not defined in device tree. Add 'button-gpios = <&gpio0 23 GPIO_ACTIVE_LOW>;' to zephyr,user node"
#endif

/* GPIO device spec | GPIO设备规格 */
static const struct gpio_dt_spec button_gpio = GPIO_DT_SPEC_GET(BUTTON_NODE, button_gpios);

/* Button state and callback | 按键状态和回调 */
static bool                    button_initialized = false;
static mos_button_callback_t   button_callback   = NULL;  // Legacy callback (deprecated, use interrupt handler)

/* GPIO callback structure | GPIO回调结构 */
static struct gpio_callback button_cb_data;

/**
 * @brief GPIO interrupt callback | GPIO中断回调
 * 
 * Disables interrupt first, then sends button interrupt event to interrupt handler framework
 * 先禁用中断，然后发送按键中断事件到中断处理框架
 */
static void button_gpio_callback(const struct device* dev, struct gpio_callback* cb, uint32_t pins)
{
    ARG_UNUSED(dev);
    ARG_UNUSED(cb);
    ARG_UNUSED(pins);

    /* Check if button GPIO is available | 检查按键GPIO是否可用 */
    if (!gpio_is_ready_dt(&button_gpio))
    {
        LOG_ERR("Button GPIO not ready");
        return;
    }

    /* Disable interrupt to prevent repeated triggering | 禁用中断以避免重复触发 */
    int ret = gpio_pin_interrupt_configure_dt(&button_gpio, GPIO_INT_DISABLE);
    if (ret != 0)
    {
        LOG_ERR("Failed to disable button interrupt: %d", ret);
        return;
    }

    /* Check if interrupt handler framework is initialized | 检查中断处理框架是否已初始化 */
    if (!interrupt_handler_is_initialized())
    {
        LOG_ERR("Interrupt handler not initialized");
        return;
    }

    /* Create interrupt event | 创建中断事件 */
    interrupt_event_t event = {
        .event = INTERRUPT_TYPE_BUTTON_PRESSED,
        .tick  = k_uptime_get(),
        .data  = NULL,  // Can be used to pass button state if needed
    };

    /* Send event to interrupt handler framework | 发送事件到中断处理框架 */
    ret = interrupt_handler_send_event(&event);
    if (ret != 0)
    {
        LOG_ERR("Failed to send button interrupt event: %d", ret);
    }
    else
    {
        LOG_DBG("Button PRESSED interrupt event sent successfully");
    }
}

int mos_button_init(void)
{
    int ret;

    if (button_initialized)
    {
        LOG_WRN("Button already initialized");
        return 0;
    }

    if (!gpio_is_ready_dt(&button_gpio))
    {
        LOG_ERR("GPIO device not ready");
        return -ENODEV;
    }
    ret = gpio_pin_configure_dt(&button_gpio, GPIO_INPUT | GPIO_PULL_UP);
    if (ret != 0)
    {
        LOG_ERR("Failed to configure button GPIO: %d", ret);
        return ret;
    }

    gpio_init_callback(&button_cb_data, button_gpio_callback, BIT(button_gpio.pin));
    ret = gpio_add_callback(button_gpio.port, &button_cb_data);
    if (ret != 0)
    {
        LOG_ERR("Failed to add GPIO callback: %d", ret);
        return ret;
    }

    /* Enable interrupt for falling edge only | 仅使能下降沿中断 */
    ret = gpio_pin_interrupt_configure_dt(&button_gpio, GPIO_INT_EDGE_FALLING);
    if (ret != 0)
    {
        LOG_ERR("Failed to configure GPIO interrupt: %d", ret);
        return ret;
    }

    button_initialized = true;
    LOG_INF("Button driver initialized (P0.%d)", button_gpio.pin);

    return 0;
}

bool mos_button_is_pressed(void)
{
    if (!button_initialized)
    {
        return false;
    }
    int val = gpio_pin_get(button_gpio.port, button_gpio.pin);
    LOG_INF("Button state: %d", val);
    return (val == 0);
}

mos_button_state_t mos_button_get_state(void)
{
    return mos_button_is_pressed() ? MOS_BUTTON_STATE_PRESSED : MOS_BUTTON_STATE_RELEASED;
}

int mos_button_register_callback(mos_button_callback_t callback)
{
    if (callback == NULL)
    {
        return -EINVAL;
    }

    button_callback = callback;
    LOG_INF("Button callback registered");
    return 0;
}

void mos_button_unregister_callback(void)
{
    button_callback = NULL;
    LOG_INF("Button callback unregistered");
}

int mos_button_configure_wakeup(void)
{
    int ret;

    if (!button_initialized)
    {
        LOG_ERR("Button not initialized");
        return -ENODEV;
    }

    /* Disable interrupt before reconfiguring | 重新配置前禁用中断 */
    ret = gpio_pin_interrupt_configure_dt(&button_gpio, GPIO_INT_DISABLE);
    if (ret != 0)
    {
        LOG_ERR("Failed to disable GPIO interrupt: %d", ret);
        return ret;
    }

    /* Remove callback | 移除回调 */
    gpio_remove_callback(button_gpio.port, &button_cb_data);

    /* Reconfigure as input with pull-up for System OFF wakeup | 重新配置为输入模式，上拉，用于System OFF唤醒 */
    ret = gpio_pin_configure_dt(&button_gpio, GPIO_INPUT | GPIO_PULL_UP);
    if (ret != 0)
    {
        LOG_ERR("Failed to reconfigure button GPIO: %d", ret);
        return ret;
    }
    uint32_t pin = button_gpio.pin;
    nrf_gpio_cfg_input(pin, NRF_GPIO_PIN_PULLUP);
    nrf_gpio_cfg_sense_set(pin, NRF_GPIO_PIN_SENSE_LOW);

    LOG_INF("Button configured for System OFF wakeup (SENSE_LOW - will wake on press) (P0.%d)", pin);
    return 0;
}

int mos_button_re_enable_interrupt(void)
{
    int ret;

    if (!button_initialized)
    {
        LOG_ERR("Button not initialized");
        return -ENODEV;
    }

    if (!gpio_is_ready_dt(&button_gpio))
    {
        LOG_ERR("Button GPIO not ready");
        return -ENODEV;
    }

    /* Re-enable interrupt for falling edge only | 重新使能下降沿中断 */
    ret = gpio_pin_interrupt_configure_dt(&button_gpio, GPIO_INT_EDGE_FALLING);
    if (ret != 0)
    {
        LOG_ERR("Failed to re-enable button interrupt: %d", ret);
        return ret;
    }

    return 0;
}

int mos_button_configure_for_polling(void)
{
    int ret;

    if (!button_initialized)
    {
        LOG_ERR("Button not initialized");
        return -ENODEV;
    }

    if (!gpio_is_ready_dt(&button_gpio))
    {
        LOG_ERR("Button GPIO not ready");
        return -ENODEV;
    }

    /* Ensure interrupt is disabled first | 首先确保中断已禁用 */
    ret = gpio_pin_interrupt_configure_dt(&button_gpio, GPIO_INT_DISABLE);
    if (ret != 0)
    {
        LOG_ERR("Failed to disable button interrupt: %d", ret);
        return ret;
    }

    ret = gpio_pin_configure_dt(&button_gpio, GPIO_INPUT);
    if (ret != 0)
    {
        LOG_ERR("Failed to configure button GPIO for polling: %d", ret);
        return ret;
    }
    
    /* Small delay to allow GPIO to stabilize after reconfiguration | 小延迟以允许GPIO在重新配置后稳定 */
    k_sleep(K_MSEC(1));

    LOG_DBG("Button GPIO configured for polling (input mode, pull-up, no interrupt)");
    return 0;
}
