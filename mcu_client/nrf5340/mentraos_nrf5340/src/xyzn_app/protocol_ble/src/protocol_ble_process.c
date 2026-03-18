/*
 * @Author       : XK
 * @Date         : 2025-06-26 19:33:56
 * @LastEditTime : 2025-06-27 18:39:28
 * @FilePath     : protocol_ble_process.c
 * @Description  :
 *
 * Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved.
 */
#include "protocol_image_cache.h"
#include "protocol_ble_process.h"
#include "bsp_log.h"

#define TAG "PROTOCOL_BLE_PROCESS"
#define TASK_NAME "PROTOCOL_BLE_PROCESS"

#define PROCESS_THREAD_STACK_SIZE (4096)
#define PROCESS_THREAD_PRIORITY 5
K_THREAD_STACK_DEFINE(process_stack_area, PROCESS_THREAD_STACK_SIZE);
static struct k_thread process_thread_data;
k_tid_t process_thread_handle;

#define IMG_MSGQ_SIZE 5
K_MSGQ_DEFINE(img_msgq, sizeof(image_msg_t), IMG_MSGQ_SIZE, 4);

/**
 * @brief 将一个完整接收的 stream 封装成消息入队
 *
 * @param stream 已经接收完所有 chunk 的 image_stream
 * @return true  入队成功
 * @return false 入队失败（队列满或参数错误）
 */
bool enqueue_completed_stream(image_stream *stream)
{
    if (!stream || !stream->image_buffer)
    {
        BSP_LOGE(TAG, "enqueue: 无效的 stream");
        return false;
    }
    image_msg_t msg = {
        .stream_id = stream->stream_id,
        .type = stream->meta.type,
        .meta = stream->meta, /* 联合体浅拷贝 */
        .image_buffer = stream->image_buffer,
        .length = (stream->meta.type == IMAGE_TYPE_DISPLAY
                       ? stream->meta.display.total_length
                       : stream->meta.preload.total_length),
    };

    int ret = k_msgq_put(&img_msgq, &msg, K_NO_WAIT);
    if (ret != 0)
    {
        BSP_LOGE(TAG, "enqueue: msgq 已满，stream_id=0x%04X 丢弃", stream->stream_id);
        return false;
    }

    BSP_LOGI(TAG, "enqueue: stream_id=0x%04X 入队成功", stream->stream_id);
    return true;
}
void protocol_ble_process_init(void *p1, void *p2, void *p3)
{
    BSP_LOGI(TAG, "protocol_ble_process_thread start!!!");
    image_msg_t msg;
    while (1)
    {
        k_msgq_get(&img_msgq, &msg, K_FOREVER);

        BSP_LOGI(TAG, "消费者处理 stream %04X, type=%d, len=%u", msg.stream_id, msg.type, msg.length);
        if (msg.type == IMAGE_TYPE_PRELOAD)
        {
            // /* 使用 preload metadata 写 flash */
            // preload_image_metadata_t *p = &msg.meta.preload;
            // image_stream_write_to_flash(
            //     p->stream_id, /* 或者 image_id，看你 API */
            //     msg.image_buffer,
            //     msg.length);
        }
        else if (msg.type == IMAGE_TYPE_DISPLAY)
        {
            /* 直接显示：带上坐标、大小、编码等 */
            // image_display_directly(
            //     msg.image_buffer,
            //     msg.length,
            //     msg.length,
            //     msg.meta.display.x,
            //     msg.meta.display.y,
            //     msg.meta.display.width,
            //     msg.meta.display.height,
            //     msg.meta.display.encoding);

            image_cache_insert(msg.stream_id, msg.image_buffer, msg.length, &msg.meta.display);
        }

        /* 处理完毕，释放底层 stream 资源 */
        image_stream *stream = image_stream_get(msg.stream_id);
        if (stream)
        {
            free_image_stream(stream);
            BSP_LOGI(TAG, "stream %04X 已释放", msg.stream_id);
        }
        else
        {
            BSP_LOGW(TAG, "无法找到 stream %04X，可能已被释放", msg.stream_id);
        }
    }
}
void protocol_ble_process_thread(void)
{
    process_thread_handle = k_thread_create(&process_thread_data,
                                            process_stack_area,
                                            K_THREAD_STACK_SIZEOF(process_stack_area),
                                            protocol_ble_process_init,
                                            NULL,
                                            NULL,
                                            NULL,
                                            PROCESS_THREAD_PRIORITY,
                                            0,
                                            K_NO_WAIT);
    k_thread_name_set(process_thread_handle, TASK_NAME);
}
