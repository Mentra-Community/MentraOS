/*** 
 * @Author       : XK
 * @Date         : 2025-07-11 16:42:20
 * @LastEditTime : 2025-07-15 10:17:23
 * @FilePath     : task_interrupt.h
 * @Description  : 
 * @
 * @Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved. 
 */

#ifndef _TASK_INTERRUPT_H_
#define _TASK_ INTERRUPT_H_

#include "bsp_log.h"

typedef struct xyzn_interrupt
{
    uint32_t event;
    uint64_t tick;
    /* data */
} xyzn_interrupt_queue;

typedef enum
{
    BSP_TYPE_UNKNOWN = 0,
    BSP_TYPE_GX8002_INT4 = 1,
    BSP_TYPE_JSA_1147_INT1 = 2,
    BSP_TYPE_KEY1 = 3,
    BSP_TYPE_MAX_COUNT
} xyzn_interrupt_type_t;

void task_interrupt_thread(void);

void gx8002_int_isr(const struct device *dev, struct gpio_callback *cb, uint32_t pins);

void jsa_1147_int_isr(const struct device *dev, struct gpio_callback *cb,uint32_t pins);

void gpio_key1_int_isr(const struct device *dev, struct gpio_callback *cb, uint32_t pins);
#endif /* _TASK_INTERRUPT_H_ */
