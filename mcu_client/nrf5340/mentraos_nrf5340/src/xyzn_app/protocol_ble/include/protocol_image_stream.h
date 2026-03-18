/*** 
 * @Author       : XK
 * @Date         : 2025-06-20 19:54:28
 * @LastEditTime : 2025-06-30 14:05:15
 * @FilePath     : protocol_image_stream.h
 * @Description  : 
 * @
 * @Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved. 
 */
#ifndef __PROTOCOL_IMAGE_STREAM_H__
#define __PROTOCOL_IMAGE_STREAM_H__

#include "xyzn_ble.h"
#include <stdint.h>
#include <stdbool.h>

#define MAX_MSG_ID_LEN              32          // 消息ID最大长度
#define MAX_STREAM_ID_LEN           16          // 图像数据ID最大长度
#define IMAGE_MAX_PATH_LEN          64          // 图像文件路径最大长度
#define IMAGE_MAX_SIZE              (10 * 1024) // 10KB
#define IMAGE_MAX_CHUNKS            64          // 最大块数
#define IMAGE_MOUNT_POINT           "/lfs"      // 文件系统挂载点
#define MAX_STREAMS                 3           // 最大同时接收的图像流数量
#define IMAGE_TIMEOUT_DEFAULT_MS    1000        // 图像数据包总超时时间
#define IMAGE_CHUNK_INTERVAL_MS     30          // 动态调整超时时间
#define IMAGE_TIMEOUT_MARGIN_MS     100         // 超时时间误差
#define IMAGE_MAX_RETRY_COUNT       3           // 图像包 错误/异常块 包重传次数

typedef enum {
    IMAGE_TYPE_NONE = 0,
    IMAGE_TYPE_DISPLAY,
    IMAGE_TYPE_PRELOAD
} image_stream_type_t;
typedef enum {
    STREAM_IDLE = 0,
    STREAM_RESERVED,     // 已经预分配了 buffer，等待 JSON 校验
    STREAM_RECEIVING,
    STREAM_QUEUED,      // 已经接收完毕、已入队
    STREAM_CLEANED,     // 超时失败或已经 free_image_stream()
} stream_state_t;

typedef struct {
    char msg_id[MAX_MSG_ID_LEN];
    char stream_id[MAX_STREAM_ID_LEN];
    int x, y;
    int width, height;
    char encoding[8];
    int total_chunks;
    int total_length;
} display_image_metadata_t;

typedef struct {
    char stream_id[MAX_STREAM_ID_LEN];
    int image_id;
    int width, height;
    char encoding[8];
    int total_chunks;
    int total_length;
} preload_image_metadata_t;
typedef struct {
    image_stream_type_t type;
    union {
        display_image_metadata_t display;
        preload_image_metadata_t preload;
    };
} image_metadata_t;

typedef struct
{
    uint16_t stream_id;             // 图像数据ID
    image_metadata_t meta;
    uint8_t *chunk_received;
    uint8_t *image_buffer;          // 图像缓存
    int64_t last_update_time;
    uint8_t retry_count;            // 记录已重试次数
    bool transfer_failed_reported;  // 标记是否已报告失败
    stream_state_t stream_state;
} image_stream;
void image_stream_timer_init(void);
void image_register_stream_from_json(const char *json_str);
void image_chunk_handler(const ble_image_block *block);
bool check_image_stream_complete(const image_stream *stream);
void image_stream_write_to_flash(const image_stream *stream);

#endif // !__PROTOCOL_IMAGE_STREAM_H__