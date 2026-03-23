/*
 * @Author       : Cole
 * @Date         : 2025-07-25 11:26:39
 * @LastEditTime : 2025-07-30 23:21:14
 * @FilePath     : task_ble_receive.c
 * @Description  :
 *
 * Copyright (c) 2025 MentraOS Organization. All rights reserved.
 */

#include <pb_encode.h>
#include <pb_decode.h>
#include "mentraos_ble.pb.h"
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/sys/ring_buffer.h>
#include "main.h"
#include "xyzn_crc.h"

#include "xyzn_ble_service.h"
#include "protocol_image_stream.h"
#include "xyzn_lvgl_display.h"
#include "task_ble_receive.h"

#define TAG "TASK_BLE_RECEIVE"
#define TASK_NAME "TASK_BLE"

#define TASK_BLE_THREAD_STACK_SIZE (4096)
#define TASK_BLE_THREAD_PRIORITY 4
K_THREAD_STACK_DEFINE(task_ble_stack_area, TASK_BLE_THREAD_STACK_SIZE);
static struct k_thread task_ble_thread_data;
k_tid_t task_ble_thread_handle;

K_SEM_DEFINE(my_ble_data_sem, 0, 1);

#define BLE_RINGBUF_SIZE 2048
RING_BUF_DECLARE(my_ble_ringbuf, BLE_RINGBUF_SIZE);

#define BLE_CACHE_SIZE 1024
static uint8_t cache_buf[BLE_CACHE_SIZE]; // ble cache buffer

static pb_cb_t g_pb_cb = NULL;
static audio_cb_t g_audio_cb = NULL;
static image_cb_t g_image_cb = NULL;

/**
 * @brief ble send data function
 * @param data Pointer to the data to send
 * @param len Length of the data to send
 * @return 0 on success, -1 on failure
 */
int ble_send_data(const uint8_t *data, uint16_t len)
{
    if ((!data || len == 0)) //|| !get_ble_connected_status())
    {
        BSP_LOGE(TAG, "Invalid data or length || ble not connected");
        return -1;
    }
    BSP_LOGI(TAG, "<--Sending data to BLE-->: len=%d", len);
    // BSP_LOGI(TAG, "Data: %s", data);
    BSP_LOG_BUFFER_HEXDUMP(TAG, data, len, 0);
    uint16_t offset = 0;
    uint16_t mtu = get_ble_payload_mtu();
    while (offset < len)
    {
        uint16_t chunk_len = MIN(len - offset, mtu);
        int retry = 0;
        int err;
        do
        {
            err = custom_nus_send(NULL, &data[offset], chunk_len);
            if (err == 0)
                break;
            BSP_LOGE(TAG, " Chunk send failed (offset=%u len=%u), retry %d", offset, chunk_len, retry);
        } while (++retry < 3); // max 3 retries
        // BSP_LOG_BUFFER_HEXDUMP(TAG, &data[offset], chunk_len, 0);
        if (err != 0)
        {
            BSP_LOGE(TAG, "Final failure at offset=%u", offset);
            return -1;
        }
        offset += chunk_len;
        k_msleep(2); // delay 2ms to avoid flooding the BLE interface
    }

    return 0;
}
#if 0
uint32_t parse_single_packet(const uint8_t *data, uint32_t len, ble_packet *out)
{
    // 检查输入参数是否合法
    if (len < 1 || !data || !out)
    {
        DUG;
        return 0;
    }
    memset(out, 0, sizeof(*out));

    BSP_LOGI(TAG, "Received opcode: %d", data[0]);
    switch (data[0])
    {
    case BLE_OPCODE_PING:
    {
        if (len < 2 || data[1] != CMD_START)
            return 0;

        uint32_t json_start = 1;
        bool parsing = false;
        int brace_count = 0;
        for (uint32_t i = 1; i < len; i++)
        {
            if (data[i] == CMD_START) // 如果遇到CMD_START，表示开始解析JSON
            {
                if (!parsing)
                {
                    parsing = true;
                    json_start = i;
                }
                brace_count++;
            }
            else if (data[i] == CMD_END) // 如果遇到CMD_END，表示结束解析JSON
            {
                brace_count--;
                // 如果解析状态为true，并且括号计数为0，表示JSON解析完成
                if (parsing && brace_count == 0 && i + 1 <= len)
                {
                    uint32_t json_len = i - json_start + 1; // 计算JSON长度

                    if (json_len >= sizeof(out->payload.ping.raw_json)) // 检查JSON长度是否超过最大长度
                        return 0;

                    memcpy(out->payload.ping.raw_json, &data[json_start], json_len); // 复制JSON数据到输出参数
                    out->payload.ping.raw_json[json_len] = 0;
                    out->raw_len = json_len + json_start;

                    cJSON *root = cJSON_Parse(out->payload.ping.raw_json);
                    if (!root)
                    {
                        BSP_LOGE(TAG, "cJSON parse error");
                        return 0;
                    }
                    cJSON *type = cJSON_GetObjectItem(root, "type");
                    cJSON *msg_id = cJSON_GetObjectItem(root, "msg_id");

                    if (!cJSON_IsString(type) || !cJSON_IsString(msg_id))
                    {
                        cJSON_Delete(root);
                        BSP_LOGE(TAG, "Missing or invalid type/msg_id error !!!");
                        return 0;
                    }
                    out->opcode = data[0];
                    strncpy(out->payload.ping.type, type->valuestring, sizeof(out->payload.ping.type) - 1);
                    strncpy(out->payload.ping.msg_id, msg_id->valuestring, sizeof(out->payload.ping.msg_id) - 1);
                    cJSON_Delete(root);
                    return out->raw_len;
                }
            }
        }
        return 0;
    }
    case BLE_OPCODE_AUDIO_BLOCK:
    {
        // 解析音频数据包
        if (len < 2)
            return 0;
        // 设置音频流ID
        out->payload.audio.stream_id = data[1];
        // 设置LC3数据长度
        out->payload.audio.lc3_len = len - 2;
        // 检查LC3数据长度是否超过最大长度
        if (out->payload.audio.lc3_len > MAX_LC3_FRAME_SIZE)
            return 0;
        out->opcode = data[0];
        // 复制LC3数据到输出参数
        memcpy(out->payload.audio.lc3_data, &data[2], out->payload.audio.lc3_len);
        // 设置原始数据长度
        out->raw_len = len;
        return len;
    }
    case BLE_OPCODE_IMAGE_BLOCK:
    {
        // [0xB0][stream_id_hi][stream_id_lo][CRC16_H][CRC16_L][chunk_index][chunk_data...]
        if (len < 6) // 最小长度：1+2+2+1 = 6 字节
        {
            DUG;
            return 0;
        }
        uint8_t chunk_len = len - 6; // 数据包长度减去固定头部长度
        if (chunk_len > MAX_IMAGE_CHUNK_SIZE)
        {
            DUG;
            return 0;
        }
        // 先校验 CRC
        uint16_t crc16 = (data[3] << 8) | data[4];
        uint16_t crc_host = xyzn_crc16_ccitt(data + 5, chunk_len);
        if (crc_host != crc16)
        {
            BSP_LOGW(TAG, "CRC error: got 0x%04X, expect 0x%04X", crc16, crc_host);
            return 0; // 丢弃
        }

        // 校验通过后，才填充 out
        out->payload.image.stream_id = (data[1] << 8) | data[2];
        out->opcode = data[0];
        out->payload.image.crc16 = crc16;
        out->payload.image.chunk_index = data[5];
        out->payload.image.chunk_len = chunk_len;
        memcpy(out->payload.image.chunk_data, &data[6], chunk_len);
        out->raw_len = len;
        return len;
    }

    default:
        DUG;
        return 0;
    }
}

void handle_ble_packet(const ble_packet *pkt)
{
    // 根据数据包的操作码进行不同的处理
    switch (pkt->opcode)
    {
    case BLE_OPCODE_PING:
        BSP_LOGI(TAG, "JSON: type=%s, msg_id=%s", pkt->payload.ping.type, pkt->payload.ping.msg_id);

        if (strcmp(pkt->payload.ping.type, "disconnect") == 0)
        {
            // 终止连接并清理资源
            BSP_LOGI(TAG, "ble master Disconnecting...");
            // handle_disconnect();
        }
        else if (strcmp(pkt->payload.ping.type, "request_battery_state") == 0)
        {
            // 报告当前电池百分比，以及是否立即充电
            BSP_LOGI(TAG, "request_battery_state");
        }
        else if (strcmp(pkt->payload.ping.type, "request_device_info") == 0)
        {
            // 报告设备信息
            BSP_LOGI(TAG, "request_device_info");
        }
        else if (strcmp(pkt->payload.ping.type, "enter_pairing_mode") == 0)
        {
            // 进入配对状态
            BSP_LOGI(TAG, "enter_pairing_mode");
        }
        else if (strcmp(pkt->payload.ping.type, "request_head_position") == 0)
        {
            // 报告佩戴者当前的头部倾斜角度（以度为单位）
            BSP_LOGI(TAG, "request_head_position");
        }
        else if (strcmp(pkt->payload.ping.type, "set_head_up_angle") == 0)
        {
            // 配置平视检测角度（以度为单位）
            BSP_LOGI(TAG, "request_head_orientation");
        }
        else if (strcmp(pkt->payload.ping.type, "ping") == 0)
        {
            // 验证连接是否仍处于活动状态
            BSP_LOGI(TAG, "ping");

            static uint8_t data[600] = {0}; // test
            for (uint32_t i = 0; i < 600; i++)
            {
                data[i] = i;
            }
            ble_send_data(data, sizeof(data));
        }
        else if (strcmp(pkt->payload.ping.type, "set_mic_state") == 0)
        {
            // 设置麦克风状态 打开或关闭板载麦克风
            BSP_LOGI(TAG, "set_mic_state");
        }
        else if (strcmp(pkt->payload.ping.type, "set_vad_enabled") == 0)
        {
            // 启用或禁用语音活动检测（VAD）
            BSP_LOGI(TAG, "set_vad_enabled");
        }
        else if (strcmp(pkt->payload.ping.type, "configure_vad") == 0)
        {
            // 调整 VAD 灵敏度阈值 （0–100）
            BSP_LOGI(TAG, "configure_vad");
        }
        else if (strcmp(pkt->payload.ping.type, "display_text") == 0)
        {
            // 显示文本
            BSP_LOGI(TAG, "display_text");
        }
        else if (strcmp(pkt->payload.ping.type, "display_image") == 0)
        {
            // 发送要在显示器上渲染的位图图像
            BSP_LOGI(TAG, "display_image");
            image_register_stream_from_json(pkt->payload.ping.raw_json);
        }
        else if (strcmp(pkt->payload.ping.type, "preload_image") == 0)
        {
            // 将图像预加载到flash中以供以后使用
            BSP_LOGI(TAG, "preload_image");
            image_register_stream_from_json(pkt->payload.ping.raw_json);
        }
        else if (strcmp(pkt->payload.ping.type, "display_cached_image") == 0)
        {
            // 显示先前预加载的图像
            BSP_LOGI(TAG, "display_cached_image");
        }
        else if (strcmp(pkt->payload.ping.type, "clear_cached_image") == 0)
        {
            // 清除先前预加载的图像
            BSP_LOGI(TAG, "clear_cached_image");
        }
        break;
    case BLE_OPCODE_AUDIO_BLOCK:
        BSP_LOGI(TAG, "AUDIO: stream_id=%u, len=%u",
                 pkt->payload.audio.stream_id,
                 (unsigned)pkt->payload.audio.lc3_len);
        break;
    case BLE_OPCODE_IMAGE_BLOCK:
    {
        // [0xB0][stream_id_hi][stream_id_lo][CRC16_H][CRC16_L][chunk_index][chunk_data...]
        BSP_LOGI(TAG, "IMAGE: stream_id=0x%04X, crc = %d chunk=%u, len=%u",
                 pkt->payload.image.stream_id,
                 pkt->payload.image.crc16,
                 pkt->payload.image.chunk_index,
                 pkt->payload.image.chunk_len);
        image_chunk_handler(&pkt->payload.image);
    }
    break;
    default:
        BSP_LOGI(TAG, "Unknown packet");
        break;
    }
}
#endif // 0
/**
 * @brief 将接收到的BLE数据放入环形缓冲区- Put the received BLE data into the circular buffer.
 * @param data 接收到的数据- Pointer to the received data
 * @param len 数据长度- Length of the data
 */
void ble_receive_fragment(const uint8_t *data, uint32_t len)
{
    // 检查BLE环形缓冲区是否有足够的空间来存储接收到的数据
    // check if the ring buffer has enough space to store the received data
    if (len == 0 || data == NULL)
    {
        BSP_LOGE(TAG, "Invalid data or length");
        return;
    }
    if (ring_buf_space_get(&my_ble_ringbuf) < len)
    {
        BSP_LOGI(TAG, "BLE ring buffer overflow");
        return;
    }
    ring_buf_put(&my_ble_ringbuf, data, len);
    k_sem_give(&my_ble_data_sem);
}

/**
 * @brief 重新启动广播并设置新的间隔 - Restart advertising and set new interval
 * @param min_interval_ms 最小间隔（毫秒） - Minimum interval (ms)
 * @param max_interval_ms 最大间隔（毫秒）- Maximum interval (ms)
 */
void restart_adv_with_new_interval(uint16_t min_interval_ms, uint16_t max_interval_ms)
{
    BSP_LOGI(TAG, "Restart advertising with new interval: %d ms - %d ms", min_interval_ms, max_interval_ms);

    ble_interval_set(min_interval_ms, max_interval_ms);
    int err = bt_le_adv_stop();
    if (err != 0)
    {
        BSP_LOGE(TAG, "Advertising failed to stop (err %d)", err);
    }
}

#define MAX_TEXT_LEN 128
static char text_buf[MAX_TEXT_LEN + 1];
static bool decode_string(pb_istream_t *stream, const pb_field_t *field, void **arg)
{
    // BSP_LOGI(TAG, ">>> decode_string called, bytes_left=%zu\n", stream->bytes_left);
    // char *buf = *(char **)arg;
    char *buf = (char *)(*arg);
    size_t to_read = stream->bytes_left;
    if (to_read > MAX_TEXT_LEN)
    {
        to_read = MAX_TEXT_LEN;
    }
    if (!pb_read(stream, (uint8_t *)buf, to_read))
    {
        return false;
    }
    buf[to_read] = '\0';
    BSP_LOGI(TAG, "Decoded string: %s", buf);
    return true;
}

void my_protobuf_handler(const uint8_t *data, size_t len)
{
    // mentraos_ble_DisplayText msg = mentraos_ble_DisplayText_init_zero;
    // msg.text.funcs.decode = decode_string;
    // msg.text.arg = text_buf; // 这里传入 text_buf 的地址

    // BSP_LOGI(TAG, "Received protobuf data, len=%d", len);
    // BSP_LOG_BUFFER_HEXDUMP(TAG, data, len, 0);

    // pb_istream_t stream = pb_istream_from_buffer(data, len);
    // if (!pb_decode(&stream, mentraos_ble_DisplayText_fields, &msg))
    // {
    //     BSP_LOGE(TAG, "Protobuf decode failed: %s", PB_GET_ERROR(&stream));
    //     return;
    // }

    mentraos_ble_PhoneToGlasses msg = mentraos_ble_PhoneToGlasses_init_zero;
    msg.payload.display_text.text.funcs.decode = decode_string;
    msg.payload.display_text.text.arg = text_buf;

    pb_istream_t stream = pb_istream_from_buffer(data, len);
    if (!pb_decode(&stream, mentraos_ble_PhoneToGlasses_fields, &msg))
    {
        BSP_LOGE(TAG, "Protobuf decode failed!");
        return;
    }
    switch (msg.which_payload)
    {
    case mentraos_ble_PhoneToGlasses_display_text_tag:
    {
        // fallback: 直接试DisplayText
        mentraos_ble_DisplayText dt = mentraos_ble_DisplayText_init_zero;
        dt.text.funcs.decode = decode_string;
        dt.text.arg = text_buf;
        stream = pb_istream_from_buffer(data + 3, len - 3); // 跳过前3个字节 ,skip the first 3 bytes
        if (!pb_decode(&stream, mentraos_ble_DisplayText_fields, &dt))
        {
            BSP_LOGE(TAG, "Protobuf decode failed: %s", PB_GET_ERROR(&stream));
            return;
        }
        BSP_LOGI(TAG, "DisplayText: x=%u y=%u size=%u color=0x%X text=%s\n",
                 msg.payload.display_text.x,
                 msg.payload.display_text.y,
                 msg.payload.display_text.size,
                 msg.payload.display_text.color,
                 text_buf);
        BSP_LOGI(TAG, "DISPLAY_TEXT:X=%u y=%u size=%u color=0x%x, text=%s\n", dt.x, dt.y, dt.size, dt.color, (char *)dt.text.arg);
        // BSP_LOGI(TAG, "Neither PhoneToGlasses nor DisplayText decode succeeded!");
        // handle_display_text(&msg.payload.display_text);
        handle_display_text(&dt);
    }
    break;

    case mentraos_ble_PhoneToGlasses_display_image_tag:
        // handle_display_image(&msg.payload.display_image);
        break;

    case mentraos_ble_PhoneToGlasses_mic_state_tag:
        // handle_set_mic_state(&msg.payload.mic_state);
        break;

    default:
        // BSP_LOGW(TAG, "Unknown PhoneToGlasses tag: %d", msg.which_payload);
        break;
    }
}
void register_ble_cbs(pb_cb_t pb_cb,
                      audio_cb_t audio_cb,
                      image_cb_t image_cb)
{
    g_pb_cb = pb_cb;
    g_audio_cb = audio_cb;
    g_image_cb = image_cb;
}

static int detect_and_process_packet(const uint8_t *buf, unsigned int len)
{
    if (len < 3)
    {
        BSP_LOGE(TAG, "Received empty BLE packet error !!!");
        return 0;
    }

    uint8_t hdr = buf[0];
    const uint8_t *payload = buf + 1;
    size_t payload_len = len - 1;

    switch (hdr)
    {
    case BLE_PROTOBUF_HDR:
        if (g_pb_cb)
        {
            g_pb_cb(payload, payload_len);
        }
        else
        {
            BSP_LOGW(TAG, "No Protobuf CB registered");
        }
        break;

    case BLE_AUDIO_HDR:
        if (payload_len < 1)
        {
            BSP_LOGE(TAG, "Audio packet too short");
            return 0;
        }
        if (g_audio_cb)
        {
            uint8_t stream_id = payload[0];
            g_audio_cb(stream_id, payload + 1, payload_len - 1);
        }
        else
        {
            BSP_LOGW(TAG, "No Audio CB registered");
        }
        break;

    case BLE_IMAGE_HDR:
        if (payload_len < 3)
        {
            BSP_LOGE(TAG, "Image packet too short");
            return 0;
        }
        if (g_image_cb)
        {
            uint16_t stream_id = (payload[0] << 8) | payload[1];
            uint8_t idx = payload[2];
            g_image_cb(stream_id, idx, payload + 3, payload_len - 3);
        }
        else
        {
            BSP_LOGW(TAG, "No Image CB registered");
        }
        break;

    default:
        BSP_LOGW(TAG, "Unknown BLE header: 0x%02X", hdr);
        return -1;
        break;
    }
    return len; // return the length of the processed packet
}

void ble_thread_entry(void *p1, void *p2, void *p3)
{
    uint32_t buflen = 0;
    int64_t last_active = 0;
    uint32_t count = 0;

    if (ble_init_sem_take() != 0) // wiait for BLE initialization
    {
        BSP_LOGE(TAG, "Failed to initialize BLE err");
        return;
    }
    // ble_data_test1(); // test function to send data

    register_ble_cbs(my_protobuf_handler, NULL, NULL); // my_audio_handler, my_image_handler);
    while (1)
    {
        // BSP_LOGI(TAG, "ble_process_thread %d", count++);
        // if (10 == count)
        // {
        //     restart_adv_with_new_interval(500, 500);

        //     ble_name_update_data("xyzn_test_01");
        // }
        k_sem_take(&my_ble_data_sem, K_FOREVER);

        while (buflen < BLE_CACHE_SIZE)
        {
            uint32_t read = ring_buf_get(&my_ble_ringbuf, &cache_buf[buflen], BLE_CACHE_SIZE - buflen);
            if (read <= 0)
                break;
            buflen += read;
            last_active = k_uptime_get();
        }
        BSP_LOGI(TAG, "Total buffered length: %u [%d]", (unsigned)buflen, ring_buf_space_get(&my_ble_ringbuf));
        BSP_LOG_BUFFER_HEXDUMP(TAG, cache_buf, buflen, 0);
        unsigned int offset = 0;
#if 0 // test
      uint8_t buff1[] = {
          0x02, 0xf2, 0x01, 0x24, 0x0a, 0x16, 0x48, 0x65,
          0x6c, 0x6c, 0x6f, 0x20, 0x77, 0x6f, 0x72, 0x6c,
          0x64, 0x20, 0x31, 0x35, 0x34, 0x33, 0x38, 0x38,
          0x35, 0x35, 0x35, 0x37, 0x10, 0x90, 0x4e, 0x18,
          0x14, 0x20, 0x14, 0x28, 0x84, 0x02, 0x30, 0x14};
      memcpy(cache_buf, buff1, sizeof(buff1));
      buflen = sizeof(buff1);
#endif
        while (offset < buflen)
        {
            int ret = detect_and_process_packet(cache_buf + offset, buflen - offset);
            if (ret > 0)
            {
                // 成功处理一个完整包
                // successful processing of a complete packet
                offset += ret;
            }
            else if (ret == 0)
            {
                // 半包：剩余字节不足，等下次继续读
                // half packet: remaining bytes are insufficient, continue reading next time
                break;
            }
            else
            {
                // ret < 0：头部非法，跳过一个字节重试
                // ret < 0: illegal header, skip one byte and retry
                BSP_LOGW(TAG, "Illegal header at offset %u, skipping one byte", offset);
                offset += 1;
            }
        }

        // 将剩余的半包搬到缓冲区头部
        // Move the remaining half packet to the buffer head
        if (offset > 0)
        {
            memmove(cache_buf, cache_buf + offset, buflen - offset);
            buflen -= offset;
        }
    }
}
void ble_protocol_receive_thread(void)
{
    task_ble_thread_handle = k_thread_create(&task_ble_thread_data,
                                             task_ble_stack_area,
                                             K_THREAD_STACK_SIZEOF(task_ble_stack_area),
                                             ble_thread_entry,
                                             NULL,
                                             NULL,
                                             NULL,
                                             TASK_BLE_THREAD_PRIORITY,
                                             0,
                                             K_NO_WAIT);
    k_thread_name_set(task_ble_thread_handle, TASK_NAME);
}
