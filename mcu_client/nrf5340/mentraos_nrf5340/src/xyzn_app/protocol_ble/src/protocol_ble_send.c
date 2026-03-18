/*
 * @Author       : XK
 * @Date         : 2025-06-25 11:48:23
 * @LastEditTime : 2025-07-04 18:12:23
 * @FilePath     : protocol_ble_send.c
 * @Description  :
 *
 * Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved.
 */

#include <zephyr/kernel.h>
#include "cJSON.h"
#include "bsp_log.h"
#include "task_ble_receive.h"
#include "protocol_ble_send.h"

#define TAG "PROTOCOL_BLE_SEND"
#define TASK_NAME "PROTOCOL_BLE_SEND"

#define PROTOCOL_BLE_THREAD_STACK_SIZE (4096)
#define PROTOCOL_BLE_LVGL_THREAD_PRIORITY 5
K_THREAD_STACK_DEFINE(protocol_ble_stack_area, PROTOCOL_BLE_THREAD_STACK_SIZE);
static struct k_thread protocol_ble_thread_data;
k_tid_t protocol_ble_thread_handle;

#define ble_protocol_MSG_QUEUE_SIZE 2
K_MSGQ_DEFINE(ble_protocol_msgq, sizeof(ble_protocol_msg_t), ble_protocol_MSG_QUEUE_SIZE, 4);

void handler_image_transfer_complete(const ble_protocol_msg_t *msg)
{
    cJSON *root = cJSON_CreateObject();
    if ((root == NULL) || (!msg))
    {
        BSP_LOGE(TAG, "Failed to create JSON object || msg is NULL");
    }
    cJSON_AddStringToObject(root, "type", "image_transfer_complete");
    cJSON_AddStringToObject(root, "stream_id", msg->data.image_transfer_complete.stream_id);
    cJSON_AddStringToObject(root, "status", msg->data.image_transfer_complete.ok ? "ok" : "incomplete");

    if ((!msg->data.image_transfer_complete.ok) && (msg->data.image_transfer_complete.missing_count > 0))
    {
        // BSP_LOGI(TAG, "JSON missing_chunks!!!");
        // BSP_LOG_BUFFER_HEX(TAG, msg->data.image_transfer_complete.missing_chunks, msg->data.image_transfer_complete.missing_count);
        cJSON *arr = cJSON_AddArrayToObject(root, "missing_chunks");
        for (int i = 0; i < msg->data.image_transfer_complete.missing_count; ++i)
        {
            cJSON_AddItemToArray(arr, cJSON_CreateNumber(msg->data.image_transfer_complete.missing_chunks[i]));
        }
    }
    char *json = cJSON_PrintUnformatted(root);
    if (json == NULL)
    {
        DUG;
        BSP_LOGI(TAG, "cJSON_PrintUnformatted failed");
        cJSON_Delete(root);
        return;
    }
    ble_send_data(json, strlen(json));
    cJSON_free(json);
    cJSON_Delete(root);
}

void handler_battery_status(const ble_protocol_msg_t *msg)
{
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "battery_status");
    cJSON_AddNumberToObject(root, "level", msg->data.battery_status.level);
    cJSON_AddBoolToObject(root, "charging", msg->data.battery_status.charging);
    char *json = cJSON_PrintUnformatted(root);
    ble_send_data(json, strlen(json));
    cJSON_free(json);
    cJSON_Delete(root);
}

void handler_charging_state(const ble_protocol_msg_t *msg)
{
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "charging_state");
    cJSON_AddStringToObject(root, "state", msg->data.charging_state.state);
    char *json = cJSON_PrintUnformatted(root);
    ble_send_data(json, strlen(json));
    cJSON_free(json);
    cJSON_Delete(root);
}

void handler_device_info(const ble_protocol_msg_t *msg)
{
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "device_info");
    cJSON_AddStringToObject(root, "fw", msg->data.device_info.fw);
    cJSON_AddStringToObject(root, "hw", msg->data.device_info.hw);
    cJSON *f = cJSON_AddObjectToObject(root, "features");
    cJSON_AddBoolToObject(f, "camera", msg->data.device_info.features.camera);
    cJSON_AddBoolToObject(f, "display", msg->data.device_info.features.display);
    cJSON_AddBoolToObject(f, "audio_tx", msg->data.device_info.features.audio_tx);
    cJSON_AddBoolToObject(f, "audio_rx", msg->data.device_info.features.audio_rx);
    cJSON_AddBoolToObject(f, "imu", msg->data.device_info.features.imu);
    cJSON_AddBoolToObject(f, "vad", msg->data.device_info.features.vad);
    cJSON_AddBoolToObject(f, "mic_switching", msg->data.device_info.features.mic_switching);
    cJSON_AddNumberToObject(f, "image_chunk_buffer", msg->data.device_info.features.image_chunk_buffer);
    char *json = cJSON_PrintUnformatted(root);
    ble_send_data(json, strlen(json));
    cJSON_free(json);
    cJSON_Delete(root);
}

void handler_pong(const ble_protocol_msg_t *msg)
{
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "pong");
    cJSON_AddStringToObject(root, "msg_id", msg->data.pong.msg_id);
    char *json = cJSON_PrintUnformatted(root);
    ble_send_data(json, strlen(json));
    cJSON_free(json);
    cJSON_Delete(root);
}

void handler_head_position(const ble_protocol_msg_t *msg)
{
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "head_position");
    cJSON_AddNumberToObject(root, "angle", msg->data.head_position.angle);
    char *json = cJSON_PrintUnformatted(root);
    ble_send_data(json, strlen(json));
    cJSON_free(json);
    cJSON_Delete(root);
}

void handler_head_up_angle_set(const ble_protocol_msg_t *msg)
{
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "head_up_angle_set");
    cJSON_AddBoolToObject(root, "success", msg->data.head_up_angle_set.success);
    char *json = cJSON_PrintUnformatted(root);
    ble_send_data(json, strlen(json));
    cJSON_free(json);
    cJSON_Delete(root);
}

void handler_vad_event(const ble_protocol_msg_t *msg)
{
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "vad_event");
    cJSON_AddStringToObject(root, "state", msg->data.vad_event.state);
    char *json = cJSON_PrintUnformatted(root);
    ble_send_data(json, strlen(json));
    cJSON_free(json);
    cJSON_Delete(root);
}

void handler_imu_data(const ble_protocol_msg_t *msg)
{
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "imu_data");
    cJSON_AddStringToObject(root, "msg_id", msg->data.imu_data.msg_id);
    cJSON *a = cJSON_AddObjectToObject(root, "accel");
    cJSON_AddNumberToObject(a, "x", msg->data.imu_data.accel[0]);
    cJSON_AddNumberToObject(a, "y", msg->data.imu_data.accel[1]);
    cJSON_AddNumberToObject(a, "z", msg->data.imu_data.accel[2]);
    cJSON *g = cJSON_AddObjectToObject(root, "gyro");
    cJSON_AddNumberToObject(g, "x", msg->data.imu_data.gyro[0]);
    cJSON_AddNumberToObject(g, "y", msg->data.imu_data.gyro[1]);
    cJSON_AddNumberToObject(g, "z", msg->data.imu_data.gyro[2]);
    cJSON *m = cJSON_AddObjectToObject(root, "mag");
    cJSON_AddNumberToObject(m, "x", msg->data.imu_data.mag[0]);
    cJSON_AddNumberToObject(m, "y", msg->data.imu_data.mag[1]);
    cJSON_AddNumberToObject(m, "z", msg->data.imu_data.mag[2]);
    char *json = cJSON_PrintUnformatted(root);
    ble_send_data(json, strlen(json));
    cJSON_free(json);
    cJSON_Delete(root);
}

void handler_button_event(const ble_protocol_msg_t *msg)
{
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "button_event");
    cJSON_AddStringToObject(root, "button", msg->data.button_event.button);
    cJSON_AddStringToObject(root, "state", msg->data.button_event.state);
    char *json = cJSON_PrintUnformatted(root);
    ble_send_data(json, strlen(json));
    cJSON_free(json);
    cJSON_Delete(root);
}

void handler_factory_reset(const ble_protocol_msg_t *msg)
{
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "factory_reset");
    cJSON_AddStringToObject(root, "msg_id", msg->data.factory_reset.msg_id);
    char *json = cJSON_PrintUnformatted(root);
    ble_send_data(json, strlen(json));
    cJSON_free(json);
    cJSON_Delete(root);
}

void handler_restart_device(const ble_protocol_msg_t *msg)
{
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "restart_device");
    cJSON_AddStringToObject(root, "msg_id", msg->data.restart_device.msg_id);
    char *json = cJSON_PrintUnformatted(root);
    ble_send_data(json, strlen(json));
    cJSON_free(json);
    cJSON_Delete(root);
}

// ==== Handler表 ====
const ble_msg_dispatch_entry_t g_ble_msg_dispatch_table[] = {
    {BLE_MSG_IMAGE_TRANSFER_COMPLETE, handler_image_transfer_complete},
    {BLE_MSG_BATTERY_STATUS, handler_battery_status},
    {BLE_MSG_CHARGING_STATE, handler_charging_state},
    {BLE_MSG_DEVICE_INFO, handler_device_info},
    {BLE_MSG_PONG, handler_pong},
    {BLE_MSG_HEAD_POSITION, handler_head_position},
    {BLE_MSG_HEAD_UP_ANGLE_SET, handler_head_up_angle_set},
    {BLE_MSG_VAD_EVENT, handler_vad_event},
    {BLE_MSG_IMU_DATA, handler_imu_data},
    {BLE_MSG_BUTTON_EVENT, handler_button_event},
    {BLE_MSG_FACTORY_RESET, handler_factory_reset},
    {BLE_MSG_RESTART_DEVICE, handler_restart_device},
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
    BSP_LOGI(TAG, "Unknown BLE msg type: %d", msg->type);
}
bool ble_send_msg_enqueue(ble_msg_type_t type, const void *msg, size_t msg_len)
{
    if (msg == NULL)
    {
        BSP_LOGI(TAG, "Invalid BLE msg type: %d", type);
        return false;
    }
    ble_protocol_msg_t m = {0};
    m.type = type;
    memcpy(&m.data, msg, msg_len); // 只拷贝实际协议体长度
    int err = k_msgq_put(&ble_protocol_msgq, &m, K_NO_WAIT);
    if (err != 0)
    {
        BSP_LOGE(TAG, "Failed to enqueue BLE msg: %d", err);
        return false;
    }
    else
    {
        // BSP_LOGI(TAG, "Enqueued BLE msg: %d", type);
    }
    return true;
}
void ble_protocol_send_init(void *p1, void *p2, void *p3)
{
    BSP_LOGI(TAG, "BLE send thread started!!!");
    BSP_LOGI(TAG, "cJSON version: %s", cJSON_Version());
    ble_protocol_msg_t msg = {0};
    while (1)
    {
        if (k_msgq_get(&ble_protocol_msgq, &msg, K_FOREVER) == 0)
        {
            BSP_LOGI(TAG, "== ble_protocol_thread_entry == Received BLE msg: %d", msg.type);
            if (msg.type <= BLE_MSG_TYPE_MAX)
            {
                ble_msg_dispatch(&msg);
            }
        }
    }
}

void ble_protocol_send_thread(void)
{
    protocol_ble_thread_handle = k_thread_create(&protocol_ble_thread_data,
                                                 protocol_ble_stack_area,
                                                 K_THREAD_STACK_SIZEOF(protocol_ble_stack_area),
                                                 ble_protocol_send_init,
                                                 NULL,
                                                 NULL,
                                                 NULL,
                                                 PROTOCOL_BLE_LVGL_THREAD_PRIORITY,
                                                 0,
                                                 K_NO_WAIT);
    k_thread_name_set(protocol_ble_thread_handle, TASK_NAME);
}
