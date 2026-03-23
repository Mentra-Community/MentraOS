/***
 * @Author       : Cole
 * @Date         : 2025-07-31 10:40:40
 * @LastEditTime : 2025-07-31 17:23:31
 * @FilePath     : task_interrupt.h
 * @Description  :
 * @
 * @ Copyright (c) MentraOS Contributors 2025
 * @ SPDX-License-Identifier: Apache-2.0
 */

#ifndef _TASK_INTERRUPT_H_
#define _TASK_INTERRUPT_H_
#include <zephyr/kernel.h>
#include <zephyr/drivers/gpio.h>

typedef struct mos_interrupt
{
    uint32_t event;
    uint64_t tick;
    /* data */
} mos_interrupt_queue;

typedef enum
{
    BSP_TYPE_UNKNOWN = 0,
    BSP_TYPE_GX8002_INT4 = 1,
    BSP_TYPE_JSA_1147_INT1 = 2,
    BSP_TYPE_KEY1 = 3,
    BSP_TYPE_MAX_COUNT
} mos_interrupt_type_t;

void task_interrupt_thread(void);

void gx8002_int_isr(const struct device *dev, struct gpio_callback *cb, uint32_t pins);

void jsa_1147_int_isr(const struct device *dev, struct gpio_callback *cb, uint32_t pins);

void gpio_key1_int_isr(const struct device *dev, struct gpio_callback *cb, uint32_t pins);
#endif /* _TASK_INTERRUPT_H_ */
