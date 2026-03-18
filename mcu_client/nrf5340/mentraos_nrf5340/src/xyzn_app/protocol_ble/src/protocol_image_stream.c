/*
 * @Author       : XK
 * @Date         : 2025-06-20 19:54:07
 * @LastEditTime : 2025-07-26 15:49:07
 * @FilePath     : protocol_image_stream.c
 * @Description  :
 *
 * Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved.
 */

#include <zephyr/kernel.h>
#include <zephyr/fs/fs.h>
#include <cJSON.h>
#include "bal_os.h"
#include "bsp_log.h"
#include "task_ble_receive.h"
#include "protocol_ble_process.h"
#include "protocol_ble_send.h"
#include "protocol_image_stream.h"

#define TAG "IMAGE_STREAM"

static image_stream stream_cache[MAX_STREAMS];

struct k_timer image_timeout_timer;

static bool image_timer_started = false; // 记录定时器是否已经启动

void image_stream_cleanup_timeout(struct k_timer *timer_id);

void image_stream_timer_init(void)
{
    xyzn_os_timer_create(&image_timeout_timer, image_stream_cleanup_timeout);
}
void image_stream_timer_start(bool auto_reload, int64_t period)
{
    // if (!image_timer_started)
    {
        xyzn_os_timer_start(&image_timeout_timer, auto_reload, period);
        image_timer_started = true;
        BSP_LOGI(TAG, "Image stream timeout timer started");
    }
}

void image_stream_timer_stop(void)
{
    if (image_timer_started)
    {
        xyzn_os_timer_stop(&image_timeout_timer);
        image_timer_started = false;
        BSP_LOGI(TAG, "Image stream timeout timer stopped");
    }
}

void free_image_stream(image_stream *stream)
{
    if (!stream)
    {
        DUG;
        return;
    }
    if (stream->chunk_received)
    {
        xyzn_free(stream->chunk_received);
        stream->chunk_received = NULL;
    }
    if (stream->image_buffer)
    {
        xyzn_free(stream->image_buffer);
        stream->image_buffer = NULL;
    }
    memset(stream, 0, sizeof(image_stream));
    BSP_LOGI(TAG, "Free image stream: %p", stream);
}
static void image_build_filename(uint16_t stream_id, char *out, uint32_t out_size)
{
    if (!out || out_size < sizeof(IMAGE_MOUNT_POINT) + 12)
    {
        BSP_LOGE(TAG, "Invalid buffer or size too small: out=%p, size=%zu err!", out, out_size);
        if (out && out_size > 0)
        {
            out[0] = 0; // 保守输出空字符串
        }
        return;
    }
    memset(out, 0, out_size);
    int written = snprintf(out, out_size, IMAGE_MOUNT_POINT "/img_%04X.webp", stream_id);
    if (written < 0 || (uint32_t)written >= out_size)
    {
        BSP_LOGE(TAG, "Filename truncated or snprintf err!");
        out[0] = 0;
    }
}

static image_stream *find_or_create_stream(uint16_t stream_id)
{
    for (int i = 0; i < MAX_STREAMS; i++)
    {
        if (stream_cache[i].stream_state == STREAM_IDLE)
        {
            memset(&stream_cache[i], 0, sizeof(image_stream));
            stream_cache[i].stream_state = STREAM_RESERVED;
            stream_cache[i].stream_id = stream_id;
            stream_cache[i].last_update_time = xyzn_os_uptime_get();
            BSP_LOGI(TAG, "create image stream: %p", &stream_cache[i]);
            return &stream_cache[i];
        }
    }
    return NULL;
}

image_stream *image_stream_get(uint16_t stream_id)
{
    for (int i = 0; i < MAX_STREAMS; i++)
    {
        if (stream_cache[i].stream_state == STREAM_RECEIVING && stream_cache[i].stream_id == stream_id)
        {
            return &stream_cache[i];
        }
    }
    return NULL;
}

/**
 * @brief 动态分配图像流
 */
bool alloc_image_stream(image_stream *stream, int total_chunks, int total_length)
{
    // 检查stream和meta是否为空
    if (!stream ||
        total_chunks <= 0 || total_chunks > IMAGE_MAX_CHUNKS ||
        total_length <= 0 || total_length > IMAGE_MAX_SIZE)
    {
        DUG;
        return false;
    }
    stream->chunk_received = (uint8_t *)xyzn_malloc(total_chunks);
    stream->image_buffer = (uint8_t *)xyzn_malloc(total_length);
    if (!stream->chunk_received || !stream->image_buffer)
    {
        if (stream->chunk_received)
            xyzn_free(stream->chunk_received);
        if (stream->image_buffer)
            xyzn_free(stream->image_buffer);
        stream->chunk_received = NULL;
        stream->image_buffer = NULL;
        return false;
    }
    BSP_LOGI(TAG, "Alloc image stream: %p, chunks=%d, length=%d", stream, total_chunks, total_length);
    memset(stream->chunk_received, 0, total_chunks);
    memset(stream->image_buffer, 0, total_length);

    return true;
}

static void print_display_image_metadata(const display_image_metadata_t *meta)
{
    if (!meta)
        return;
    BSP_LOGI(TAG, "===== display_image meta =====");
    BSP_LOGI(TAG, "msg_id:      %s", meta->msg_id);
    BSP_LOGI(TAG, "stream_id:   %s", meta->stream_id);
    BSP_LOGI(TAG, "x:           %d", meta->x);
    BSP_LOGI(TAG, "y:           %d", meta->y);
    BSP_LOGI(TAG, "width:       %d", meta->width);
    BSP_LOGI(TAG, "height:      %d", meta->height);
    BSP_LOGI(TAG, "encoding:    %s", meta->encoding);
    BSP_LOGI(TAG, "total_chunks:%d", meta->total_chunks);
    BSP_LOGI(TAG, "total_length:%d", meta->total_length);
}
static void print_preload_image_metadata(const preload_image_metadata_t *meta)
{
    if (!meta)
        return;
    BSP_LOGI(TAG, "===== preload_image meta =====");
    BSP_LOGI(TAG, "stream_id:   %s", meta->stream_id);
    BSP_LOGI(TAG, "image_id:    %d", meta->image_id);
    BSP_LOGI(TAG, "width:       %d", meta->width);
    BSP_LOGI(TAG, "height:      %d", meta->height);
    BSP_LOGI(TAG, "encoding:    %s", meta->encoding);
    BSP_LOGI(TAG, "total_chunks:%d", meta->total_chunks);
    BSP_LOGI(TAG, "total_length:%d", meta->total_length);
}

/**
 * @brief 从json字符串中解析出stream_id、meta.x、meta.y、meta.width、meta.height、meta.encoding、meta.total_chunks等字段，并注册一个image_stream
 * @param json_str json字符串
 */
void image_register_stream_from_json(const char *json_str)
{
    if (!json_str)
        return;

    cJSON *root = cJSON_Parse(json_str);
    if (!root)
    {
        BSP_LOGE(TAG, "JSON parse failed: %s ", cJSON_GetErrorPtr());
        return;
    }

    const cJSON *type_item = cJSON_GetObjectItemCaseSensitive(root, "type");
    const cJSON *stream_id_item = cJSON_GetObjectItemCaseSensitive(root, "stream_id");
    if (!cJSON_IsString(type_item) ||
        !cJSON_IsString(stream_id_item) ||
        strlen(stream_id_item->valuestring) < 1)
    {
        BSP_LOGE(TAG, "Invalid or missing type/stream_id ");
        cJSON_Delete(root);
        return;
    }
    image_stream_type_t stream_type = IMAGE_TYPE_NONE;
    if (strcmp(type_item->valuestring, "display_image") == 0)
    {
        stream_type = IMAGE_TYPE_DISPLAY;
    }
    else if (strcmp(type_item->valuestring, "preload_image") == 0)
    {
        stream_type = IMAGE_TYPE_PRELOAD;
    }
    if (stream_type == IMAGE_TYPE_NONE)
    {
        DUG;
        cJSON_Delete(root);
        return;
    }

    uint16_t stream_id = (uint16_t)strtoul(stream_id_item->valuestring, NULL, 16);
    if (stream_id < 0 || stream_id > 0xFFFF)
    {
        DUG;
        cJSON_Delete(root);
        return;
    }
    image_stream *stream = find_or_create_stream(stream_id);
    if (!stream)
    {
        DUG;
        cJSON_Delete(root);
        return;
    }
    int total_chunks = 0, total_length = 0;
    if (stream_type == IMAGE_TYPE_DISPLAY)
    {
        display_image_metadata_t meta = {0};
        // 解析 display_image 字段
        const cJSON *msg_id_item = cJSON_GetObjectItemCaseSensitive(root, "msg_id");
        const cJSON *x_item = cJSON_GetObjectItemCaseSensitive(root, "x");
        const cJSON *y_item = cJSON_GetObjectItemCaseSensitive(root, "y");
        const cJSON *width_item = cJSON_GetObjectItemCaseSensitive(root, "width");
        const cJSON *height_item = cJSON_GetObjectItemCaseSensitive(root, "height");
        const cJSON *encoding_item = cJSON_GetObjectItemCaseSensitive(root, "encoding");
        const cJSON *total_chunks_item = cJSON_GetObjectItemCaseSensitive(root, "total_chunks");
        const cJSON *total_length_item = cJSON_GetObjectItemCaseSensitive(root, "total_length");

        if (!cJSON_IsString(msg_id_item) ||
            !cJSON_IsNumber(x_item) ||
            !cJSON_IsNumber(y_item) ||
            !cJSON_IsNumber(width_item) ||
            !cJSON_IsNumber(height_item) ||
            !cJSON_IsString(encoding_item) ||
            !cJSON_IsNumber(total_chunks_item) ||
            !cJSON_IsNumber(total_length_item))
        {
            DUG;
            cJSON_Delete(root);
            return;
        }
        strncpy(meta.msg_id, msg_id_item->valuestring, sizeof(meta.msg_id) - 1);
        strncpy(meta.stream_id, stream_id_item->valuestring, sizeof(meta.stream_id) - 1);
        strncpy(meta.encoding, encoding_item->valuestring, sizeof(meta.encoding) - 1);
        meta.x = x_item->valueint;
        meta.y = y_item->valueint;
        meta.width = width_item->valueint;
        meta.height = height_item->valueint;
        meta.total_chunks = total_chunks = total_chunks_item->valueint;
        meta.total_length = total_length = total_length_item->valueint;

        memcpy(&stream->meta.display, &meta, sizeof(meta));
        print_display_image_metadata(&meta); // test
    }
    else if (stream_type == IMAGE_TYPE_PRELOAD)
    {
        preload_image_metadata_t meta = {0};
        // 解析 preload_image 字段
        const cJSON *image_id_item = cJSON_GetObjectItemCaseSensitive(root, "image_id");
        const cJSON *width_item = cJSON_GetObjectItemCaseSensitive(root, "width");
        const cJSON *height_item = cJSON_GetObjectItemCaseSensitive(root, "height");
        const cJSON *encoding_item = cJSON_GetObjectItemCaseSensitive(root, "encoding");
        const cJSON *total_chunks_item = cJSON_GetObjectItemCaseSensitive(root, "total_chunks");
        const cJSON *total_length_item = cJSON_GetObjectItemCaseSensitive(root, "total_length");
        if (!cJSON_IsNumber(image_id_item) ||
            !cJSON_IsNumber(width_item) ||
            !cJSON_IsNumber(height_item) ||
            !cJSON_IsString(encoding_item) ||
            !cJSON_IsNumber(total_chunks_item) ||
            !cJSON_IsNumber(total_length_item))
        {
            DUG;
            cJSON_Delete(root);
            return;
        }
        strncpy(meta.stream_id, stream_id_item->valuestring, sizeof(meta.stream_id) - 1);
        strncpy(meta.encoding, encoding_item->valuestring, sizeof(meta.encoding) - 1);
        meta.image_id = image_id_item->valueint;
        meta.width = width_item->valueint;
        meta.height = height_item->valueint;
        meta.total_chunks = total_chunks = total_chunks_item->valueint;
        meta.total_length = total_length = total_length_item->valueint;
        memcpy(&stream->meta.preload, &meta, sizeof(meta));
        print_preload_image_metadata(&meta); // test
    }
    stream->meta.type = stream_type;
    if (!alloc_image_stream(stream, total_chunks, total_length)) // 分配图像流缓冲区
    {
        DUG;
        free_image_stream(stream);
        cJSON_Delete(root);
        return;
    }
    BSP_LOGI(TAG, "stream->last_update_time: %lld", stream->last_update_time);
    stream->last_update_time = xyzn_os_uptime_get();
    stream->retry_count = 0;
    stream->transfer_failed_reported = false;
    stream->stream_state = STREAM_RECEIVING; // 标记数据流准备接收
    image_stream_timer_start(false, 1000);   // 启动定时器

    cJSON_Delete(root);
}
static inline int stream_total_chunks(const image_stream *stream)
{
    if (stream->meta.type == IMAGE_TYPE_DISPLAY)
        return stream->meta.display.total_chunks;
    else if (stream->meta.type == IMAGE_TYPE_PRELOAD)
        return stream->meta.preload.total_chunks;
    return 0;
}
static inline int stream_total_length(const image_stream *stream)
{
    if (stream->meta.type == IMAGE_TYPE_DISPLAY)
        return stream->meta.display.total_length;
    else if (stream->meta.type == IMAGE_TYPE_PRELOAD)
        return stream->meta.preload.total_length;
    return 0;
}
// 检查流是否完整
bool check_image_stream_complete(const image_stream *stream)
{
    if (!stream)
    {
        DUG;
        return false;
    }
    int n = stream_total_chunks(stream);
    for (int i = 0; i < n; i++)
    {
        if (stream->chunk_received[i] == 0)
            return false;
    }
    return true;
}
// 函数：将图像流写入闪存
// 参数：stream：图像流结构体指针
// 将完整图像写入 flash（LittleFS）
void image_stream_write_to_flash(const image_stream *stream)
{
    if (!stream)
    {
        DUG;
        return;
    }
    char path[IMAGE_MAX_PATH_LEN] = {0};
    image_build_filename(stream->stream_id, path, sizeof(path));

    struct fs_file_t file;
    fs_file_t_init(&file);

    if (fs_open(&file, path, FS_O_CREATE | FS_O_WRITE) < 0)
    {
        BSP_LOGE(TAG, "Failed to open file: %s", path);
        return;
    }

    // 写入所有chunk对应的字节数
    ssize_t written = fs_write(&file, stream->image_buffer, stream_total_length(stream));
    fs_close(&file);

    if (written <= 0)
    {
        BSP_LOGE(TAG, "Failed to write image to flash");
    }
    else
    {
        BSP_LOGI(TAG, "Image saved to %s (%zd bytes)", path, written);
    }
}

void send_image_transfer_complete_blemsg(const image_stream *stream, bool ok, uint8_t *missing, int missing_count)
{
    msg_image_transfer_complete_t pack = {0};
    if (stream->meta.type == IMAGE_TYPE_DISPLAY)
        strncpy(pack.stream_id, stream->meta.display.stream_id, sizeof(pack.stream_id) - 1);
    else if (stream->meta.type == IMAGE_TYPE_PRELOAD)
        strncpy(pack.stream_id, stream->meta.preload.stream_id, sizeof(pack.stream_id) - 1);
    else
        snprintf(pack.stream_id, sizeof(pack.stream_id), "%04X", stream->stream_id);

    pack.ok = ok;
    pack.missing_count = missing_count;
    if (!ok && missing && missing_count > 0)
    {
        memcpy(pack.missing_chunks, missing, missing_count);
    }
    BSP_LOGI(TAG, "BLE_SEND_MSG => missing_chunks!!!");
    BSP_LOG_BUFFER_HEX(TAG, pack.missing_chunks, missing_count);

    BLE_SEND_MSG(BLE_MSG_IMAGE_TRANSFER_COMPLETE, pack);
}
void image_stream_cleanup_timeout(struct k_timer *timer_id)
{
    BSP_LOGI(TAG, "image_stream_cleanup_timeout!!!");
    int64_t now = xyzn_os_uptime_get();
    for (int i = 0; i < MAX_STREAMS; i++)
    {
        image_stream *stream = &stream_cache[i];
        if (stream->stream_state != STREAM_RECEIVING) // 如果流状态不是接收中，则跳过
            continue;

        int missing_count = 0;
        uint8_t missing_chunks[IMAGE_MAX_CHUNKS] = {0}; // 存储缺失块的索引
        int total_chunks = stream_total_chunks(stream);
        // 遍历当前流的每个块
        for (int j = 0; j < total_chunks && missing_count < IMAGE_MAX_CHUNKS; j++)
        {
            if ((stream->chunk_received[j] == 0) && (missing_count < IMAGE_MAX_CHUNKS))
            {
                missing_chunks[missing_count++] = j; // 记录缺失块的索引
            }
        }
        BSP_LOGI(TAG, "stream[%d],stream_id: 0x%04X missing_count:%d", i, stream->stream_id, missing_count);
        int64_t timeout_ms = IMAGE_TIMEOUT_DEFAULT_MS;
        if (missing_count == 0)
        {
            image_stream_timer_stop(); // 如果缺失块数量为 0，则停止定时器
            BSP_LOGI(TAG, "Transfer complete: stream 0x%04X OK", stream->stream_id);
            return;
        }
        else if (missing_count == 1) // 如果缺失块数量为 1
        {
            timeout_ms = IMAGE_CHUNK_INTERVAL_MS + IMAGE_TIMEOUT_MARGIN_MS;
        }
        else if (missing_count <= 5) // 如果缺失块数量小于等于 5
        {
            timeout_ms = missing_count * IMAGE_CHUNK_INTERVAL_MS + IMAGE_TIMEOUT_MARGIN_MS;
        }
        else // 如果缺失块数量大于 5
        {
            int64_t time = missing_count * IMAGE_CHUNK_INTERVAL_MS + IMAGE_TIMEOUT_MARGIN_MS * 2;
            timeout_ms = time > IMAGE_TIMEOUT_DEFAULT_MS ? IMAGE_TIMEOUT_DEFAULT_MS : time; // 限制最大超时时间
        }
        BSP_LOGI(TAG, "stream->last_update_time: %lld", stream->last_update_time);
        BSP_LOGI(TAG, "now: %lld", now);
        BSP_LOGI(TAG, "timeout_ms: %lld ,now - stream->last_update_time:%lld", timeout_ms, now - stream->last_update_time);
        // 如果重试次数小于最大重试次数
        if (stream->retry_count < IMAGE_MAX_RETRY_COUNT)
        {
            stream->retry_count++;
            // 更新上次更新时间
            stream->last_update_time = now;
            BSP_LOGW(TAG, "Retry %d for stream 0x%04X, missing %d chunks",
                     stream->retry_count, stream->stream_id, missing_count);
            send_image_transfer_complete_blemsg(stream, false, missing_chunks, missing_count); // 发送ble消息
            image_stream_timer_start(false, timeout_ms);                                       // 重新启动定时器,填入下次超时时间
        }
        else if (!stream->transfer_failed_reported) // 如果重试次数大于等于最大重试次数且传输失败,才认为传输失败
        {
            BSP_LOGE(TAG, "Transfer failed: stream 0x%04X missing %d chunks error",
                     stream->stream_id, missing_count);
            stream->transfer_failed_reported = true;
            image_stream_timer_stop(); // 停止定时器
            free_image_stream(stream); // 释放数据流
            stream = NULL;
        }
    }
}
// 获取总块数
static inline int get_stream_total_chunks(const image_stream *stream)
{
    if (!stream)
    {
        DUG;
        return 0;
    }
    switch (stream->meta.type)
    {
    case IMAGE_TYPE_DISPLAY:
        return stream->meta.display.total_chunks;
    case IMAGE_TYPE_PRELOAD:
        return stream->meta.preload.total_chunks;
    default:
        return 0;
    }
}
// 获取总长度
static inline int get_stream_total_length(const image_stream *stream)
{
    if (!stream)
    {
        DUG;
        return 0;
    }
    switch (stream->meta.type)
    {
    case IMAGE_TYPE_DISPLAY:
        return stream->meta.display.total_length;
    case IMAGE_TYPE_PRELOAD:
        return stream->meta.preload.total_length;
    default:
        return 0;
    }
}
#if 0
void image_chunk_handler(const ble_image_block *block)
{
    if (!block)
    {
        DUG;
        return;
    }
    image_stream *stream = image_stream_get(block->stream_id);
    if (!stream)
    {
        BSP_LOGW(TAG, "收到未注册流的数据块，直接丢弃: stream_id=%04X", block->stream_id);
        return;
    }
    int total_chunks = get_stream_total_chunks(stream);
    int total_length = get_stream_total_length(stream);
    if (block->chunk_index >= total_chunks)
    {
        DUG;
        return;
    }
    // 重复包检测
    if (stream->chunk_received && stream->chunk_received[block->chunk_index])
    {
        BSP_LOGW(TAG, "接受重复数据块 chunk: %d stream:0x%04X, ignored....", block->chunk_index, stream->stream_id);
        return; // 直接丢弃，不覆盖已接收数据
    }
    // 计算块偏移量
    int chunk_size = (total_length + total_chunks - 1) / total_chunks; // 计算每块大小,取最大值
    uint32_t offset = block->chunk_index * chunk_size;

    // 最后一块可能长度 < chunk_size，实际写入需防越界
    if (offset + block->chunk_len > total_length)
    {
        DUG;
        return;
    }
    if (block->chunk_index < total_chunks - 1)
    {
        if (block->chunk_len != chunk_size)
        {
            DUG;
            BSP_LOGI(TAG, "非最后一包 chunk_len[%d] != chunk_size[%d], stream_id:0x%04X",
                     block->chunk_len, chunk_size, stream->stream_id);
            return;
        }
    }
    else
    {
        if (block->chunk_len > chunk_size)
        {
            // 非法！数据长度不能比最大包还大
            DUG;
            BSP_LOGI(TAG, "最后一包 chunk_len[%d] > chunk_size[%d], stream_id:0x%04X",
                     block->chunk_len, chunk_size, stream->stream_id);
            return;
        }
    }

    memcpy(&stream->image_buffer[offset], block->chunk_data, block->chunk_len);
    stream->chunk_received[block->chunk_index] = 1;
    stream->last_update_time = xyzn_os_uptime_get();

    // 检查是否全部接收完毕
    if (check_image_stream_complete(stream))
    {
        BSP_LOGI(TAG, "image_stream receive ok, stream_id:0x%04X", stream->stream_id);

        if (enqueue_completed_stream(stream))
        {
            DUG; // 如果队列已满，则丢弃该流
        }
        stream->stream_state = STREAM_QUEUED;
        send_image_transfer_complete_blemsg(stream, true, NULL, 0); // 发送ble消息
        // free_image_stream(stream);
    }
}
#endif
void test_image_json(void)
{
    /**
     {
    "encoding":"jpg",
    "height":640,
    "msg_id":"img_start_1",
    "stream_id":"F7",
    "total_chunks":15,
    "total_length":7355,
    "type":"display_image",
    "width":480
    ,"x":10,
    "y":10
    }
    */
    image_stream_timer_init();
    const char *json_str =
        "{"
        "\"encoding\":\"jpg\","
        "\"height\":640,"
        "\"msg_id\":\"img_start_1\","
        "\"stream_id\":\"F7\","
        "\"total_chunks\":15,"
        "\"total_length\":7355,"
        "\"type\":\"display_image\","
        "\"width\":480,"
        "\"x\":10,"
        "\"y\":10"
        "}";
    image_register_stream_from_json(json_str);
}