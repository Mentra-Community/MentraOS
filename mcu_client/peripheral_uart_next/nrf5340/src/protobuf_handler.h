/*
 * Copyright (c) 2024 Mentra
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#ifndef PROTOBUF_HANDLER_H_
#define PROTOBUF_HANDLER_H_

#include <zephyr/types.h>
#include <pb_decode.h>
#include <pb_encode.h>
#include "mentraos_ble.pb.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief Analyze incoming BLE message and determine protocol type
 *
 * @param data Pointer to received data
 * @param len Length of received data
 */
void protobuf_analyze_message(const uint8_t *data, uint16_t len);

/**
 * @brief Parse protobuf control message (header 0x02) using nanopb
 *
 * @param protobuf_data Pointer to protobuf data (after 0x02 header)
 * @param len Length of protobuf data
 */
void protobuf_parse_control_message(const uint8_t *protobuf_data, uint16_t len);

/**
 * @brief Decode PhoneToGlasses message using nanopb
 *
 * @param data Pointer to protobuf data
 * @param len Length of protobuf data
 * @param msg Pointer to message structure to fill
 * @return true if decoding successful, false otherwise
 */
bool decode_phone_to_glasses_message(const uint8_t *data, uint16_t len, 
                                    mentraos_ble_PhoneToGlasses *msg);

/**
 * @brief Encode GlassesToPhone message using nanopb
 *
 * @param msg Pointer to message structure to encode
 * @param buffer Pointer to output buffer
 * @param buffer_size Size of output buffer
 * @param bytes_written Pointer to store number of bytes written
 * @return true if encoding successful, false otherwise
 */
bool encode_glasses_to_phone_message(const mentraos_ble_GlassesToPhone *msg,
                                    uint8_t *buffer, size_t buffer_size,
                                    size_t *bytes_written);

/**
 * @brief Parse audio chunk message (header 0xA0)
 *
 * @param data Pointer to complete message data (including 0xA0 header)
 * @param len Length of complete message
 */
void protobuf_parse_audio_chunk(const uint8_t *data, uint16_t len);

/**
 * @brief Parse image chunk message (header 0xB0)
 *
 * @param data Pointer to complete message data (including 0xB0 header)
 * @param len Length of complete message
 */
void protobuf_parse_image_chunk(const uint8_t *data, uint16_t len);

/**
 * @brief Generate echo response message using protobuf
 *
 * @param input_data Pointer to input data
 * @param input_len Length of input data
 * @param output_data Pointer to output buffer
 * @param max_output_len Maximum length of output buffer
 * @return Length of generated response, or negative error code
 */
int protobuf_generate_echo_response(const uint8_t *input_data, uint16_t input_len,
   uint8_t *output_data, uint16_t max_output_len);

/**
 * @brief Get current battery level
 *
 * @return Current battery level (0-100%)
 */
uint32_t protobuf_get_battery_level(void);

/**
 * @brief Set battery level
 *
 * @param level Battery level (0-100%, will be clamped)
 */
void protobuf_set_battery_level(uint32_t level);

/**
 * @brief Increase battery level by 5%
 */
void protobuf_increase_battery_level(void);

/**
 * @brief Decrease battery level by 5%
 */
void protobuf_decrease_battery_level(void);

/**
 * @brief Send proactive battery level notification via BLE
 */
void protobuf_send_battery_notification(void);

#ifdef __cplusplus
}
#endif

#endif /* PROTOBUF_HANDLER_H_ */
