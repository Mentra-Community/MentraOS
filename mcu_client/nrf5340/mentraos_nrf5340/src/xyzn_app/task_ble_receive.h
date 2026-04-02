/*** 
 * @Author       : Cole
 * @Date         : 2025-07-25 11:26:39
 * @LastEditTime : 2025-07-30 10:40:53
 * @FilePath     : task_ble_receive.h
 * @Description  : 
 * @
 * @Copyright (c) 2025 MentraOS Organization. All rights reserved.
 */

#ifndef __TASK_BLE_RECEIVE_H__
#define __TASK_BLE_RECEIVE_H__
#include "bsp_log.h"
#include "mentraos_ble.pb.h"


#define BLE_PROTOBUF_HDR   0x02
#define BLE_AUDIO_HDR      0xA0
#define BLE_IMAGE_HDR      0xB0


typedef void (*pb_cb_t)(const uint8_t *payload, size_t payload_len);
typedef void (*audio_cb_t)(uint8_t stream_id, const uint8_t *audio, size_t audio_len);
typedef void (*image_cb_t)(uint16_t stream_id, uint8_t idx, const uint8_t *image, size_t image_len);





#endif // __TASK_BLE_RECEIVE_H__