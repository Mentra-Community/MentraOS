/***
 * @Author       : XK
 * @Date         : 2025-06-25 11:48:42
 * @LastEditTime : 2025-06-25 11:48:46
 * @FilePath     : protocol_ble_send.h
 * @Description  :
 * @
 * @Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved.
 */

#ifndef _PROTOCOL_BLE_SEND_H
#define _PROTOCOL_BLE_SEND_H

#include <stdint.h>
#include <stdbool.h>

// ==== 基本宏 ====
#define MAX_STR_LEN 64
#define MAX_TEXT_LEN 128
#define MAX_FEATURES_COUNT 8
#define MAX_MISSING_CHUNKS 64

#define BLE_SEND_MSG(type, pack) ble_send_msg_enqueue(type, &(pack), sizeof(pack))

typedef enum
{
    BLE_MSG_IMAGE_TRANSFER_COMPLETE = 0,     // 图片传输完成 image_transfer_complete
    BLE_MSG_BATTERY_STATUS,                  // 电池状态
    BLE_MSG_CHARGING_STATE,                  // 充电状态
    BLE_MSG_DEVICE_INFO,                     // 设备信息
    BLE_MSG_PONG,                            // 心跳回应
    BLE_MSG_HEAD_POSITION,                   // 头部位置
    BLE_MSG_HEAD_UP_ANGLE_SET,               // 头部角度设置
    BLE_MSG_VAD_EVENT,                       // 语音识别事件
    BLE_MSG_IMU_DATA,                        // IMU数据
    BLE_MSG_BUTTON_EVENT,                    // 按钮事件
    BLE_MSG_FACTORY_RESET,                   // 工厂重置
    BLE_MSG_RESTART_DEVICE,                  // 重启设备
    BLE_MSG_TEXT_DISPLAY,                    // 文本显示
    BLE_MSG_DRAW_LINE,                       // 绘制线条
    BLE_MSG_DRAW_RECT,                       // 绘制矩形
    BLE_MSG_DRAW_CIRCLE,                     // 绘制圆形
    BLE_MSG_COMMIT,                          // 提交
    BLE_MSG_DISPLAY_VERTICAL_SCROLLING_TEXT, // 垂直滚动文本
    BLE_MSG_DISPLAY_CACHED_IMAGE,            // 显示缓存图像
    BLE_MSG_CLEAR_CACHED_IMAGE,              //
    BLE_MSG_SET_BRIGHTNESS,
    BLE_MSG_SET_AUTO_BRIGHTNESS,
    BLE_MSG_SET_AUTO_BRIGHTNESS_MULTIPLIER,
    BLE_MSG_TURN_OFF_DISPLAY,
    BLE_MSG_TURN_ON_DISPLAY,
    BLE_MSG_SET_DISPLAY_DISTANCE,
    BLE_MSG_SET_DISPLAY_HEIGHT,
    BLE_MSG_HEAD_GESTURE,
    BLE_MSG_REQUEST_HEAD_GESTURE_EVENT,
    BLE_MSG_SET_MIC_STATE,
    BLE_MSG_SET_VAD_ENABLED,
    BLE_MSG_CONFIGURE_VAD,
    BLE_MSG_REQUEST_ENABLE_IMU,
    BLE_MSG_REQUEST_IMU_SINGLE,
    BLE_MSG_REQUEST_IMU_STREAM,
    BLE_MSG_REQUEST_BATTERY_STATE,
    BLE_MSG_REQUEST_GLASSES_INFO,
    BLE_MSG_ENTER_PAIRING_MODE,
    BLE_MSG_PING,
    BLE_MSG_DISPLAY_IMAGE,
    BLE_MSG_PRELOAD_IMAGE,
    BLE_MSG_FACTORY_RESET_CMD,
    BLE_MSG_TYPE_MAX
} ble_msg_type_t;

// ==== 协议结构体 ====
// 只需维护这部分
typedef struct
{
    char stream_id[8];
    bool ok;
    uint8_t missing_chunks[MAX_MISSING_CHUNKS];
    uint8_t missing_count;
} msg_image_transfer_complete_t;

typedef struct
{
    uint8_t level;
    bool charging;
} msg_battery_status_t;
typedef struct
{
    char state[16];
} msg_charging_state_t;

typedef struct
{
    char fw[MAX_STR_LEN], hw[MAX_STR_LEN];
    struct
    {
        bool camera, display, audio_tx, audio_rx, imu, vad, mic_switching;
        uint8_t image_chunk_buffer;
    } features;
} msg_device_info_t;

typedef struct
{
    char msg_id[MAX_STR_LEN];
} msg_pong_t;
typedef struct
{
    int angle;
} msg_head_position_t;
typedef struct
{
    bool success;
} msg_head_up_angle_set_t;
typedef struct
{
    char state[16];
} msg_vad_event_t;
typedef struct
{
    float accel[3], gyro[3], mag[3];
    char msg_id[MAX_STR_LEN];
} msg_imu_data_t;
typedef struct
{
    char button[16], state[8];
} msg_button_event_t;
typedef struct
{
    char msg_id[MAX_STR_LEN];
} msg_factory_reset_t, msg_restart_device_t, msg_commit_t;
typedef struct
{
    char msg_id[MAX_STR_LEN], text[MAX_TEXT_LEN], color[16], font_code[16];
    int x, y, size;
} msg_text_display_t;
typedef struct
{
    char msg_id[MAX_STR_LEN], color[16];
    int stroke, x1, y1, x2, y2;
} msg_draw_line_t;
typedef struct
{
    char msg_id[MAX_STR_LEN], color[16];
    int stroke, x, y, width, height;
} msg_draw_rect_t;
typedef struct
{
    char msg_id[MAX_STR_LEN], color[16];
    int stroke, x, y, radius;
} msg_draw_circle_t;
typedef struct
{
    char msg_id[MAX_STR_LEN], text[MAX_TEXT_LEN], color[16], font_code[16], align[8];
    int x, y, width, height, size, line_spacing, speed, pause_ms;
    bool loop;
} msg_display_vertical_scrolling_text_t;
typedef struct
{
    char msg_id[MAX_STR_LEN];
    int image_id, x, y, width, height;
} msg_display_cached_image_t;
typedef struct
{
    char msg_id[MAX_STR_LEN];
    int image_id;
} msg_clear_cached_image_t;
typedef struct
{
    char msg_id[MAX_STR_LEN];
    int value;
} msg_set_brightness_t;
typedef struct
{
    char msg_id[MAX_STR_LEN];
    bool enabled;
} msg_set_auto_brightness_t, msg_set_mic_state_t, msg_set_vad_enabled_t, msg_request_enable_imu_t, msg_request_imu_stream_t;
typedef struct
{
    char msg_id[MAX_STR_LEN];
    float multiplier;
} msg_set_auto_brightness_multiplier_t;
typedef struct
{
    char msg_id[MAX_STR_LEN];
    int distance_cm;
} msg_set_display_distance_t;
typedef struct
{
    char msg_id[MAX_STR_LEN];
    int height;
} msg_set_display_height_t;
typedef struct
{
    char gesture[16];
} msg_head_gesture_t;
typedef struct
{
    char msg_id[MAX_STR_LEN], gesture[16];
    bool enabled;
} msg_request_head_gesture_event_t;
typedef struct
{
    char msg_id[MAX_STR_LEN];
} msg_request_imu_single_t;

// ==== 统一协议体 ====
typedef struct
{
    ble_msg_type_t type;
    union
    {
        msg_image_transfer_complete_t image_transfer_complete;
        msg_battery_status_t battery_status;
        msg_charging_state_t charging_state;
        msg_device_info_t device_info;
        msg_pong_t pong;
        msg_head_position_t head_position;
        msg_head_up_angle_set_t head_up_angle_set;
        msg_vad_event_t vad_event;
        msg_imu_data_t imu_data;
        msg_button_event_t button_event;
        msg_factory_reset_t factory_reset;
        msg_restart_device_t restart_device;
        msg_text_display_t text_display;
        msg_draw_line_t draw_line;
        msg_draw_rect_t draw_rect;
        msg_draw_circle_t draw_circle;
        msg_commit_t commit;
        msg_display_vertical_scrolling_text_t display_vertical_scrolling_text;
        msg_display_cached_image_t display_cached_image;
        msg_clear_cached_image_t clear_cached_image;
        msg_set_brightness_t set_brightness;
        msg_set_auto_brightness_t set_auto_brightness;
        msg_set_auto_brightness_multiplier_t set_auto_brightness_multiplier;
        msg_set_display_distance_t set_display_distance;
        msg_set_display_height_t set_display_height;
        msg_head_gesture_t head_gesture;
        msg_request_head_gesture_event_t request_head_gesture_event;
        msg_set_mic_state_t set_mic_state;
        msg_set_vad_enabled_t set_vad_enabled;
        // msg_configure_vad_t                   configure_vad;
        msg_request_enable_imu_t request_enable_imu;
        msg_request_imu_single_t request_imu_single;
        msg_request_imu_stream_t request_imu_stream;
        // ...补齐所有协议体
    } data;
} ble_protocol_msg_t;

typedef void (*ble_msg_handler_t)(const ble_protocol_msg_t *msg);

typedef struct
{
    ble_msg_type_t type;
    ble_msg_handler_t handler;
} ble_msg_dispatch_entry_t;

// 导出接口
void ble_protocol_init(void);
void ble_msg_dispatch(const ble_protocol_msg_t *msg);
bool ble_send_msg_enqueue(ble_msg_type_t type, const void *msg, size_t msg_len);
void ble_protocol_send_thread(void);
#endif // _PROTOCOL_BLE_SEND_H
