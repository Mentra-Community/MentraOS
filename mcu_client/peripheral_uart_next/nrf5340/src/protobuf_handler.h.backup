/*
 * Copyright (c) 2024 Mentra
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#ifndef PROTOBUF_HANDLER_H_
#define PROTOBUF_HANDLER_H_

#include <zephyr/types.h>

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
 * @brief Parse protobuf control message (header 0x02)
 *
 * @param protobuf_data Pointer to protobuf data (after 0x02 header)
 * @param len Length of protobuf data
 */
void protobuf_parse_control_message(const uint8_t *protobuf_data, uint16_t len);

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
 * @brief Generate echo response message
 *
 * @param input_data Pointer to input data
 * @param input_len Length of input data
 * @param output_data Pointer to output buffer
 * @param max_output_len Maximum length of output buffer
 * @return Length of generated response, or negative error code
 */
int protobuf_generate_echo_response(const uint8_t *input_data, uint16_t input_len,
				   uint8_t *output_data, uint16_t max_output_len);

#ifdef __cplusplus
}
#endif

#endif /* PROTOBUF_HANDLER_H_ */
