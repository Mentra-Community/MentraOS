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

/**
 * @brief Get current battery charging state
 *
 * @return true if charging, false if not charging
 */
bool protobuf_get_charging_state(void);

/**
 * @brief Set battery charging state
 *
 * @param charging true for charging, false for not charging
 */
void protobuf_set_charging_state(bool charging);

/**
 * @brief Toggle battery charging state (charging <-> not charging)
 */
void protobuf_toggle_charging_state(void);

/**
 * @brief Get current brightness level
 *
 * @return Current brightness level (0-100%)
 */
uint32_t protobuf_get_brightness_level(void);


void protobuf_process_display_height_config(const mentraos_ble_DisplayHeightConfig* config);

/**
 * @brief Set brightness level and update LED 3
 * Note: Manual brightness setting automatically disables auto brightness
 *
 * @param level Brightness level (0-100%, will be clamped)
 */
void protobuf_set_brightness_level(uint32_t level);

/**
 * @brief Get current auto brightness state
 *
 * @return true if auto brightness is enabled, false otherwise
 */
bool protobuf_get_auto_brightness_enabled(void);

/**
 * @brief Process brightness configuration message
 * Note: This will automatically disable auto brightness mode
 *
 * @param brightness_config Pointer to brightness configuration message
 */
void protobuf_process_brightness_config(const mentraos_ble_BrightnessConfig *brightness_config);

/**
 * @brief Process auto brightness configuration message
 *
 * @param auto_brightness_config Pointer to auto brightness configuration message
 */
void protobuf_process_auto_brightness_config(const mentraos_ble_AutoBrightnessConfig *auto_brightness_config);

/**
 * @brief Process microphone state configuration message
 *
 * @param mic_state Pointer to microphone state configuration message
 */
void protobuf_process_mic_state_config(const mentraos_ble_MicStateConfig *mic_state);

/**
 * @brief Process display text message
 *
 * @param display_text Pointer to display text message
 */
void protobuf_process_display_text(const mentraos_ble_DisplayText *display_text);

/**
 * @brief Process display scrolling text message
 *
 * @param scrolling_text Pointer to display scrolling text message
 */
void protobuf_process_display_scrolling_text(const mentraos_ble_DisplayScrollingText *scrolling_text);

/**
 * @brief Parse brightness value from text message
 *
 * @param text Pointer to text string containing brightness information
 */
void protobuf_parse_text_brightness(const char *text);

// Clear display functionality (temporary implementation until protobuf definition is updated)
void protobuf_process_clear_display(void);

/**
 * @brief Initialize ping/pong connectivity monitoring system
 *
 * Sets up periodic ping timer to send ping requests to phone every 10 seconds.
 * Phone should respond with pong messages. After 3 failed attempts, glasses
 * will enter sleep/disconnect mode.
 */
void protobuf_init_ping_monitoring(void);

/**
 * @brief Send pong response to phone after receiving ping (DEPRECATED)
 *
 * @deprecated This function is from the old ping/pong direction where phone
 * sent pings and glasses responded. Now glasses send pings and phone responds.
 * @param ping_request Pointer to PingRequest message from phone
 */
void protobuf_send_pong_response(mentraos_ble_PingRequest *ping_request);

#ifdef __cplusplus
}
#endif

#endif /* PROTOBUF_HANDLER_H_ */
