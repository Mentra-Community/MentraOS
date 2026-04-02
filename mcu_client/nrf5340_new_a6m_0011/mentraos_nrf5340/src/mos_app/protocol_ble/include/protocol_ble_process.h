/***
 * @Author       : Cole
 * @Date         : 2025-07-31 10:45:58
 * @LastEditTime : 2025-08-01 17:16:47
 * @FilePath     : protocol_ble_process.h
 * @Description  :
 * @
 * @ Copyright (c) MentraOS Contributors 2025
 * @ SPDX-License-Identifier: Apache-2.0
 */

#ifndef _PROTOCOL_BLE_PROCESS_H_
#define _PROTOCOL_BLE_PROCESS_H_

typedef struct
{
    // uint16_t stream_id;
    // image_stream_type_t type;
    // image_metadata_t meta;
    // uint8_t *image_buffer;
    // uint32_t length;
} image_msg_t;

// bool enqueue_completed_stream(image_stream *stream);
void protocol_ble_process_thread(void);

#endif // !_PROTOCOL_BLE_PROCESS_H_