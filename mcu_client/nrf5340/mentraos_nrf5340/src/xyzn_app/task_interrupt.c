/*
 * @Author       : XK
 * @Date         : 2025-07-11 16:42:05
 * @LastEditTime : 2025-07-18 11:50:52
 * @FilePath     : task_interrupt.c
 * @Description  :
 *
 * Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved.
 */
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include "bal_os.h"
#include "bsp_gx8002.h"
#include "bspal_gx8002.h"
#include "bsp_jsa_1147.h"
#include "bsp_key.h"
#include "bspal_key.h"
#include "task_interrupt.h"

#define TAG "TASK_INTERRUPT"
#define TASK_NAME "TASK_INTERRUPT"

#define TASK_INTERRUPT_THREAD_STACK_SIZE (4096)
#define TASK_INTERRUPT_THREAD_PRIORITY 5
K_THREAD_STACK_DEFINE(task_interrupt_stack_area, TASK_INTERRUPT_THREAD_STACK_SIZE);
static struct k_thread task_interrupt_thread_data;
k_tid_t task_interrupt_thread_handle;

K_MSGQ_DEFINE(bsp_interrupt_queue, sizeof(xyzn_interrupt_queue), 10, 4);

volatile bool debouncing = false;

void gx8002_int_isr(const struct device *dev,
                    struct gpio_callback *cb,
                    uint32_t pins)
{
    BSP_LOGI(TAG, "external interrupt occurs at %x", pins);
    xyzn_interrupt_queue event;
#if 1
    gpio_pin_interrupt_configure_dt(&gx8002_int4, GPIO_INT_DISABLE);
#endif
    event.event = BSP_TYPE_GX8002_INT4;                               // 中断类型
    event.tick = xyzn_os_get_tick();                                  // 获取当前 tick
    xyzn_os_msgq_send(&bsp_interrupt_queue, &event, XYZN_OS_WAIT_ON); // 发送到中断队列
    BSP_LOGI(TAG, "gx8002_int_isr event: %d, tick: %lld", event.event, event.tick);
}
void jsa_1147_int_isr(const struct device *dev,
                      struct gpio_callback *cb,
                      uint32_t pins)
{
    BSP_LOGI(TAG, "external interrupt occurs at %x", pins);
    xyzn_interrupt_queue event;
#if 1
    gpio_pin_interrupt_configure_dt(&jsa_1147_int1, GPIO_INT_DISABLE);
#endif
    event.event = BSP_TYPE_JSA_1147_INT1;                             // 中断类型
    event.tick = xyzn_os_get_tick();                                  // 获取当前 tick
    xyzn_os_msgq_send(&bsp_interrupt_queue, &event, XYZN_OS_WAIT_ON); // 发送到中断队列
    BSP_LOGI(TAG, "jsa_1147_int event: %d, tick: %lld", event.event, event.tick);
}

void gpio_key1_int_isr(const struct device *dev,
                       struct gpio_callback *cb,
                       uint32_t pins)
{
    BSP_LOGI(TAG, "external interrupt occurs at %x", pins);
    if (debouncing)
    {
        BSP_LOGI(TAG, "Debouncing in progress, ignoring interrupt");
        return; // 忽略中断
    }
    debouncing = true; // 设置防抖动标志
    xyzn_interrupt_queue event;
#if 0
    gpio_pin_interrupt_configure_dt(&gpio_key1, GPIO_INT_DISABLE);
#endif
    event.event = BSP_TYPE_KEY1;                                      // 中断类型
    event.tick = xyzn_os_get_tick();                                  // 获取当前 tick
    xyzn_os_msgq_send(&bsp_interrupt_queue, &event, XYZN_OS_WAIT_ON); // 发送到中断队列
    BSP_LOGI(TAG, "gpio_key1_int_isr event: %d, tick: %lld", event.event, event.tick);
}

void task_interrupt(void *p1, void *p2, void *p3)
{
    xyzn_interrupt_queue event; // 事件
    uint64_t tick;
    bspal_key_init();
    BSP_LOGI(TAG, "task_interrupt start");
    while (1)
    {
        if (xyzn_os_msgq_receive(&bsp_interrupt_queue, &event, XYZN_OS_WAIT_FOREVER) == XYZN_OS_EOK)
        {
            // BSP_LOGI(TAG, "event: %d, tick: %llu", event.event, event.tick);
            tick = xyzn_os_get_tick(); // 获取当前 tick

            switch (event.event)
            {
            case BSP_TYPE_GX8002_INT4:
            {
                gx8002_int_isr_enable();
                int event_id = gx8002_read_voice_event();
                if (event_id <= 0)
                {
                    BSP_LOGE(TAG, "gx8002 int4 err event_id:%d", event_id);
                }
                else
                {
                    BSP_LOGI(TAG, "gx8002 int4 ok event_id:%d", event_id);
                }
                BSP_LOGI(TAG, "gx8002 int4  tick[%lld]:%lld", tick, event.tick);
            }
            break;

            case BSP_TYPE_JSA_1147_INT1:
            {
                jsa_1147_int1_isr_enable();
                uint8_t flags;
                if (read_jsa_1147_int_flag(&flags) != 0)
                {
                    BSP_LOGE(TAG, "jsa_1147 int1 err flags:%d", flags);
                }
                else
                {
                    BSP_LOGI(TAG, "jsa_1147 int1 ok flags:%d", flags);
                    write_jsa_1147_int_flag(&flags);
                }
                BSP_LOGI(TAG, "jsa_1147 int1 tick[%lld]:%lld", tick, event.tick);
            }
            break;
            case BSP_TYPE_KEY1:
            {
                // gpio_key1_int_isr_enable();

                bspal_debounce_timer_start();
                BSP_LOGI(TAG, "gpio_key1_int_isr tick[%lld]:%lld", tick, event.tick);
            }
            break;

            default:
                break;
            }
        }
    }
}
void task_interrupt_thread(void)
{
    task_interrupt_thread_handle = k_thread_create(&task_interrupt_thread_data,
                                                   task_interrupt_stack_area,
                                                   K_THREAD_STACK_SIZEOF(task_interrupt_stack_area),
                                                   task_interrupt,
                                                   NULL,
                                                   NULL,
                                                   NULL,
                                                   TASK_INTERRUPT_THREAD_PRIORITY,
                                                   0,
                                                   XYZN_OS_NO_WAIT);
    k_thread_name_set(task_interrupt_thread_handle, TASK_NAME);
}
