/*
 * @Author       : Cole
 * @Date         : 2025-07-31 10:40:40
 * @LastEditTime : 2025-08-20 10:25:33
 * @FilePath     : protocol_ble_send.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2025
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "protocol_ble_send.h"
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include "task_ble_receive.h"

#define LOG_MODULE_NAME PROTOCOL_BLE_SEND
LOG_MODULE_REGISTER(LOG_MODULE_NAME);

#define TASK_NAME "PROTOCOL_BLE_SEND"

#define PROTOCOL_BLE_THREAD_STACK_SIZE    (4096)
#define PROTOCOL_BLE_LVGL_THREAD_PRIORITY 5
K_THREAD_STACK_DEFINE(protocol_ble_stack_area, PROTOCOL_BLE_THREAD_STACK_SIZE);
static struct k_thread protocol_ble_thread_data;
k_tid_t                protocol_ble_thread_handle;

#define ble_protocol_MSG_QUEUE_SIZE 2
K_MSGQ_DEFINE(ble_protocol_msgq, sizeof(ble_protocol_msg_t), ble_protocol_MSG_QUEUE_SIZE, 4);



/* ==== Handler list ==== */
const ble_msg_dispatch_entry_t g_ble_msg_dispatch_table[] = {
  
};
const int g_ble_msg_dispatch_table_size = sizeof(g_ble_msg_dispatch_table) / sizeof(g_ble_msg_dispatch_table[0]);

void ble_msg_dispatch(const ble_protocol_msg_t *msg)
{
    for (int i = 0; i < g_ble_msg_dispatch_table_size; ++i)
    {
        if (g_ble_msg_dispatch_table[i].type == msg->type)
        {
            g_ble_msg_dispatch_table[i].handler(msg);
            return;
        }
    }
    LOG_INF("Unknown BLE msg type: %d", msg->type);
}
bool ble_send_msg_enqueue(ble_msg_type_t type, const void *msg, size_t msg_len)
{
    if (msg == NULL)
    {
        LOG_INF("Invalid BLE msg type: %d", type);
        return false;
    }
    ble_protocol_msg_t m = {0};
    m.type               = type;
    memcpy(&m.data, msg, msg_len);  // copy the message data
    int err = k_msgq_put(&ble_protocol_msgq, &m, K_NO_WAIT);
    if (err != 0)
    {
        LOG_ERR("Failed to enqueue BLE msg: %d", err);
        return false;
    }
    else
    {
        // LOG_INF("Enqueued BLE msg: %d", type);
    }
    return true;
}
void ble_protocol_send_init(void *p1, void *p2, void *p3)
{
    LOG_INF("BLE send thread started!!!");
    ble_protocol_msg_t msg = {0};
    while (1)
    {
        if (k_msgq_get(&ble_protocol_msgq, &msg, K_FOREVER) == 0)
        {
            LOG_INF("== ble_protocol_thread_entry == Received BLE msg: %d", msg.type);
            if (msg.type <= BLE_MSG_TYPE_MAX)
            {
                ble_msg_dispatch(&msg);
            }
        }
    }
}

void ble_protocol_send_thread(void)
{
    protocol_ble_thread_handle = k_thread_create(&protocol_ble_thread_data, protocol_ble_stack_area,
                                                 K_THREAD_STACK_SIZEOF(protocol_ble_stack_area), ble_protocol_send_init,
                                                 NULL, NULL, NULL, PROTOCOL_BLE_LVGL_THREAD_PRIORITY, 0, K_NO_WAIT);
    k_thread_name_set(protocol_ble_thread_handle, TASK_NAME);
}
